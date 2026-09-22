from __future__ import annotations

import copy
import json
import sqlite3

from server_modules import task_queries


def json_obj(text: str | None, fallback: object | None = None):
    try:
        return json.loads(text or "")
    except Exception:
        return copy.deepcopy(fallback)


def load_project_library(conn: sqlite3.Connection) -> list[dict]:
    project_rows = conn.execute(
        """
        SELECT id, name, code, owner, data_json
        FROM project_records
        WHERE deleted_at IS NULL
        ORDER BY sort_order, id
        """
    ).fetchall()
    projects: list[dict] = []
    project_map: dict[str, dict] = {}
    for row in project_rows:
        project = json_obj(row["data_json"], {}) or {}
        project.update({
            "id": row["id"],
            "name": row["name"] or project.get("name") or "",
            "code": row["code"] or project.get("code") or "",
            "owner": row["owner"] or project.get("owner") or "",
            "stages": [],
        })
        projects.append(project)
        project_map[row["id"]] = project

    stage_rows = conn.execute(
        """
        SELECT id, project_id, name, data_json
        FROM project_stages
        WHERE deleted_at IS NULL
        ORDER BY sort_order, id
        """
    ).fetchall()
    stage_map: dict[str, dict] = {}
    for row in stage_rows:
        project = project_map.get(row["project_id"])
        if not project:
            continue
        stage = json_obj(row["data_json"], {}) or {}
        stage.update({
            "id": row["id"],
            "projectId": row["project_id"],
            "name": row["name"] or stage.get("name") or "",
            "tasks": [],
        })
        project.setdefault("stages", []).append(stage)
        stage_map[row["id"]] = stage

    task_rows = conn.execute(
        """
        SELECT id, project_id, stage_id, progress_id, category, test_item, sku_index, status, owner,
               sample_ids_json, data_json, completed_at
        FROM project_tasks
        WHERE deleted_at IS NULL
        ORDER BY created_at, id
        """
    ).fetchall()
    logs_by_task = task_queries.load_task_logs_for(conn, [str(row["id"]) for row in task_rows])
    loaded_tasks: list[dict] = []
    for row in task_rows:
        stage = stage_map.get(row["stage_id"])
        if not stage:
            continue
        task = task_queries.task_from_db_row(row)
        task["logs"] = logs_by_task.get(row["id"], [])
        loaded_tasks.append(task)
        stage.setdefault("tasks", []).append(task)
    task_queries.attach_task_sample_snapshots(conn, loaded_tasks)

    return projects


def sample_person_counts(conn: sqlite3.Connection) -> dict[str, dict[str, int]]:
    """Count current ownership without loading sample JSON or paged client data.

    Keep raw identity strings, including employee-number leading zeros; the
    frontend applies its shared member identity normalization to these keys.
    """
    counts = {"owner": {}, "borrower": {}}
    active_categories = {str(row["id"]) for row in conn.execute("SELECT id FROM sample_categories WHERE deleted_at IS NULL")}
    for field in counts:
        rows = conn.execute(
            f"""
            SELECT r.category_id, r.{field} AS person, COUNT(*) AS count
            FROM sample_records r
            WHERE r.deleted_at IS NULL
              AND TRIM(COALESCE(r.{field}, '')) <> ''
            GROUP BY r.category_id, r.{field}
            """
        ).fetchall()
        # Group by category first to use the existing covering owner/borrower
        # indexes; grouping only by person would fetch every full sample row.
        for row in rows:
            if str(row["category_id"]) not in active_categories:
                continue
            person = str(row["person"])
            counts[field][person] = counts[field].get(person, 0) + int(row["count"])
    return counts


def load_stage_sample_summaries(conn: sqlite3.Connection, stage_ids) -> list[dict]:
    """Count visible tasks and sample uses independently of page filters/cache."""
    ids = sorted({str(value) for value in stage_ids if str(value or "").strip()})
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    stages = {
        str(row["id"]): {
            "id": str(row["id"]), "taskCount": 0, "statusCounts": {},
            "usedSampleRuns": 0, "runningSampleCount": 0, "progressTaskCounts": {},
        }
        for row in conn.execute(
            f"SELECT id FROM project_stages WHERE id IN ({placeholders}) AND deleted_at IS NULL", ids
        )
    }
    # Keep task totals independent of the sample join: unassigned tasks count
    # once, and multi-sample tasks must not multiply the task/status counters.
    status_rows = conn.execute(
        f"""
        SELECT stage_id, COALESCE(flow_status, '待下发') AS flow_status,
               COALESCE(progress_id, '') AS progress_id, COUNT(*) AS count
        FROM project_tasks
        WHERE stage_id IN ({placeholders}) AND deleted_at IS NULL AND {task_queries.task_visibility_sql()}
        GROUP BY stage_id, COALESCE(flow_status, '待下发'), COALESCE(progress_id, '')
        """,
        ids,
    ).fetchall()
    for row in status_rows:
        stage = stages.get(str(row["stage_id"]))
        if stage is not None:
            count = int(row["count"] or 0)
            status = str(row["flow_status"] or "待下发")
            stage["statusCounts"][status] = stage["statusCounts"].get(status, 0) + count
            stage["taskCount"] += count
            progress_id = str(row["progress_id"] or "")
            if progress_id:
                stage["progressTaskCounts"][progress_id] = stage["progressTaskCounts"].get(progress_id, 0) + count
    rows = conn.execute(
        f"""
        SELECT t.stage_id,
               COUNT(CASE WHEN COALESCE(t.flow_status, '待下发') <> '待下发' THEN 1 END) AS used_sample_runs,
               COUNT(DISTINCT CASE WHEN t.flow_status = '进行中' THEN links.sample_id END) AS running_sample_count
        FROM project_tasks t
        JOIN project_task_samples links ON links.task_id = t.id
        WHERE t.stage_id IN ({placeholders}) AND t.deleted_at IS NULL
          AND {task_queries.task_visibility_sql('t.data_json')}
        GROUP BY t.stage_id
        """,
        ids,
    ).fetchall()
    for row in rows:
        stage = stages.get(str(row["stage_id"]))
        if stage is not None:
            stage["usedSampleRuns"] = int(row["used_sample_runs"] or 0)
            stage["runningSampleCount"] = int(row["running_sample_count"] or 0)
    # A sample removed during execution still contributed one test run. Count
    # each task/sample pair once, even after repeated removal or re-adding it.
    removed_rows = conn.execute(
        f"""
        SELECT stage_id, COUNT(*) AS removed_sample_runs FROM (
            SELECT DISTINCT t.stage_id, t.id,
                TRIM(CAST(COALESCE(NULLIF(json_extract(r.value, '$.sampleId'), ''),
                    json_extract(r.value, '$.sid')) AS TEXT)) AS sample_id
            FROM project_tasks t,
                 json_each(CASE WHEN json_type(t.data_json, '$.removedSampleRecords') = 'array'
                    THEN json_extract(t.data_json, '$.removedSampleRecords') ELSE '[]' END) r
            WHERE t.stage_id IN ({placeholders}) AND t.deleted_at IS NULL
              AND COALESCE(t.flow_status, '待下发') <> '待下发'
              AND {task_queries.task_visibility_sql('t.data_json')}
              AND r.type = 'object'
        ) removed
        WHERE COALESCE(sample_id, '') <> ''
          AND NOT EXISTS (SELECT 1 FROM project_task_samples links
                          WHERE links.task_id = removed.id AND links.sample_id = removed.sample_id)
        GROUP BY stage_id
        """, ids,
    ).fetchall()
    for row in removed_rows:
        if str(row["stage_id"]) in stages:
            stages[str(row["stage_id"])]["usedSampleRuns"] += int(row["removed_sample_runs"])
    return [stages[sid] for sid in ids if sid in stages]


def load_project_detail(conn: sqlite3.Connection, project_id: str, *, include_tasks: bool = False) -> dict | None:
    project_row = conn.execute(
        """
        SELECT id, name, code, owner, data_json
        FROM project_records
        WHERE id = ? AND deleted_at IS NULL
        """,
        (project_id,),
    ).fetchone()
    if not project_row:
        return None

    project = json_obj(project_row["data_json"], {}) or {}
    project.update({
        "id": project_row["id"],
        "name": project_row["name"] or project.get("name") or "",
        "code": project_row["code"] or project.get("code") or "",
        "owner": project_row["owner"] or project.get("owner") or "",
        "stages": [],
        "samplePersonCounts": sample_person_counts(conn),
    })

    stage_rows = conn.execute(
        """
        SELECT id, project_id, name, data_json
        FROM project_stages
        WHERE project_id = ? AND deleted_at IS NULL
        ORDER BY sort_order, id
        """,
        (project_id,),
    ).fetchall()
    stage_map: dict[str, dict] = {}
    for row in stage_rows:
        stage = json_obj(row["data_json"], {}) or {}
        stage.update({
            "id": row["id"],
            "projectId": row["project_id"],
            "name": row["name"] or stage.get("name") or "",
            "tasks": [],
        })
        project.setdefault("stages", []).append(stage)
        stage_map[row["id"]] = stage

    if stage_map:
        stage_ids = list(stage_map)
        for summary in load_stage_sample_summaries(conn, stage_ids):
            stage_map[summary["id"]].update(summary)
        stage_placeholders = ",".join("?" for _ in stage_ids)
        for stage in stage_map.values():
            stage["ownerNames"] = []

        owner_rows = conn.execute(
            f"""
            SELECT stage_id, owner
            FROM project_tasks
            WHERE stage_id IN ({stage_placeholders}) AND deleted_at IS NULL AND COALESCE(owner, '') <> '' AND {task_queries.task_visibility_sql()}
            GROUP BY stage_id, owner
            ORDER BY owner
            """,
            stage_ids,
        ).fetchall()
        for row in owner_rows:
            stage = stage_map.get(row["stage_id"])
            if not stage:
                continue
            stage.setdefault("ownerNames", []).append(str(row["owner"] or ""))

    if not include_tasks or not stage_map:
        return project

    task_rows = conn.execute(
        f"""
        SELECT id, project_id, stage_id, progress_id, category, test_item, sku_index, status, owner,
               sample_ids_json, data_json, completed_at
        FROM project_tasks
        WHERE project_id = ? AND deleted_at IS NULL AND {task_queries.task_visibility_sql()}
        ORDER BY created_at, id
        """,
        (project_id,),
    ).fetchall()
    logs_by_task = task_queries.load_task_logs_for(conn, [str(row["id"]) for row in task_rows])
    loaded_tasks: list[dict] = []
    for row in task_rows:
        stage = stage_map.get(row["stage_id"])
        if not stage:
            continue
        task = task_queries.task_from_db_row(row)
        task["logs"] = logs_by_task.get(row["id"], [])
        loaded_tasks.append(task)
        stage.setdefault("tasks", []).append(task)
    task_queries.attach_task_sample_snapshots(conn, loaded_tasks)
    return project


def list_project_summary(conn: sqlite3.Connection) -> list[dict]:
    project_rows = conn.execute(
        """
        SELECT id, name, code, owner, data_json
        FROM project_records
        WHERE deleted_at IS NULL
        ORDER BY sort_order, id
        """
    ).fetchall()
    stage_rows = conn.execute(
        """
        SELECT project_id, COUNT(*) AS count
        FROM project_stages
        WHERE deleted_at IS NULL
        GROUP BY project_id
        """
    ).fetchall()
    task_rows = conn.execute(
        f"""
        SELECT project_id, COUNT(*) AS count
        FROM project_tasks
        WHERE deleted_at IS NULL AND {task_queries.task_visibility_sql()}
        GROUP BY project_id
        """
    ).fetchall()
    stages_by_project = {str(row["project_id"]): int(row["count"] or 0) for row in stage_rows}
    tasks_by_project = {str(row["project_id"]): int(row["count"] or 0) for row in task_rows}

    projects = []
    for row in project_rows:
        project = json_obj(row["data_json"], {}) or {}
        projects.append({
            "id": row["id"],
            "name": row["name"] or project.get("name") or "",
            "code": row["code"] or project.get("code") or "",
            "owner": row["owner"] or project.get("owner") or "",
            "defaultSampleCategoryId": project.get("defaultSampleCategoryId") or "",
            "stageCount": stages_by_project.get(str(row["id"]), 0),
            "taskCount": tasks_by_project.get(str(row["id"]), 0),
        })
    return projects
