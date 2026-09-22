from __future__ import annotations

import sqlite3

from server_modules import project_queries, sample_queries, task_queries


DEFAULT_ROW_LIMIT = 100


def sorted_nonempty_ids(values) -> list[str]:
    return sorted({str(value) for value in values if str(value or "").strip()})


def limited_nonempty_ids(values, *, limit: int = DEFAULT_ROW_LIMIT) -> tuple[list[str], bool]:
    result: list[str] = []
    seen: set[str] = set()
    truncated = False
    for value in values or []:
        item = str(value or "").strip()
        if not item or item in seen:
            continue
        seen.add(item)
        if len(result) >= limit:
            truncated = True
            continue
        result.append(item)
    return result, truncated


def load_task_rows_for_mutation(conn: sqlite3.Connection, task_ids, *, row_limit: int = DEFAULT_ROW_LIMIT) -> tuple[list[dict], bool]:
    ids, truncated = limited_nonempty_ids(task_ids, limit=row_limit)
    if not ids:
        return [], truncated
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"""
        SELECT id, project_id, stage_id, progress_id, category, test_item, sku_index, status, owner,
               sample_ids_json, data_json, completed_at
        FROM project_tasks
        WHERE deleted_at IS NULL AND id IN ({placeholders})
        """,
        ids,
    ).fetchall()
    logs_by_task = task_queries.load_task_logs_for(conn, ids)
    tasks: list[dict] = []
    for row in rows:
        task = task_queries.task_from_db_row(row)
        task["logs"] = logs_by_task.get(str(row["id"] or ""), [])
        tasks.append(task)
    task_queries.attach_task_sample_snapshots(conn, tasks)
    by_id: dict[str, dict] = {}
    for task in tasks:
        by_id[str(task.get("id") or "")] = task
    return [by_id[item] for item in ids if item in by_id], truncated


def load_sample_rows_for_mutation(conn: sqlite3.Connection, sample_ids, *, row_limit: int = DEFAULT_ROW_LIMIT) -> tuple[list[dict], bool]:
    ids, truncated = limited_nonempty_ids(sample_ids, limit=row_limit)
    if not ids:
        return [], truncated
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"""
        SELECT id, category_id, sample_no, sn, imei, board_sn, is_reassembled, status, has_problem,
               effective_status, location, owner, borrower, data_json
        FROM sample_records
        WHERE deleted_at IS NULL AND id IN ({placeholders})
        """,
        ids,
    ).fetchall()
    by_id = {str(row["id"] or ""): sample_queries.sample_from_db_row(row) for row in rows}
    sample_queries.attach_sample_tested_item_names(conn, list(by_id.values()))
    photo_counts = sample_queries.load_sample_photo_counts_for(conn, list(by_id.keys()))
    for sid, sample in by_id.items():
        sample["photoCount"] = photo_counts.get(sid, 0)
    return [by_id[item] for item in ids if item in by_id], truncated


def build_mutation_affected_summary(conn: sqlite3.Connection,
                                    *,
                                    project_ids=None,
                                    stage_ids=None,
                                    task_ids=None,
                                    sample_category_ids=None,
                                    sample_ids=None,
                                    row_limit: int = DEFAULT_ROW_LIMIT) -> dict:
    project_id_list = sorted_nonempty_ids(project_ids or [])
    stage_id_list = sorted_nonempty_ids(stage_ids or [])
    task_id_list = sorted_nonempty_ids(task_ids or [])
    sample_category_id_list = sorted_nonempty_ids(sample_category_ids or [])
    sample_id_list = sorted_nonempty_ids(sample_ids or [])

    project_id_set = set(project_id_list)
    category_id_set = set(sample_category_id_list)
    tasks, tasks_truncated = load_task_rows_for_mutation(conn, task_id_list, row_limit=row_limit)
    samples, samples_truncated = load_sample_rows_for_mutation(conn, sample_id_list, row_limit=row_limit)

    if samples:
        for sample in samples:
            cid = str(sample.get("categoryId") or "")
            if cid:
                category_id_set.add(cid)
        sample_category_id_list = sorted_nonempty_ids(category_id_set)

    project_summaries = [
        item for item in project_queries.list_project_summary(conn)
        if str(item.get("id") or "") in project_id_set
    ] if project_id_set else []
    category_summaries = [
        item for item in sample_queries.list_sample_categories_summary(conn)
        if str(item.get("id") or "") in category_id_set
    ] if category_id_set else []

    summary = {
        "summaryVersion": 1,
        "rowLimit": row_limit,
        "projectIds": project_id_list,
        "stageIds": stage_id_list,
        "taskIds": task_id_list,
        "sampleCategoryIds": sample_category_id_list,
        "sampleIds": sample_id_list,
        "projectSummaries": project_summaries,
        "stageSummaries": project_queries.load_stage_sample_summaries(conn, stage_id_list),
        "sampleCategorySummaries": category_summaries,
        "tasks": tasks,
        "samples": samples,
        "tasksTruncated": tasks_truncated,
        "samplesTruncated": samples_truncated,
    }
    if sample_id_list or sample_category_id_list:
        summary["samplePersonCounts"] = project_queries.sample_person_counts(conn)
    return summary


def build_import_mutation_summary(current_data: dict,
                                  project_id_map: dict,
                                  stage_id_map: dict,
                                  task_id_map: dict,
                                  sample_id_map: dict,
                                  touched_structure_project_ids: set[str],
                                  sample_category_id_map: dict | None = None) -> dict:
    """Return the smallest frontend sync scope after a successful bundle import."""
    project_ids = {str(value) for value in project_id_map.values() if value}
    project_ids.update(str(value) for value in touched_structure_project_ids if value)
    stage_ids = {str(value) for value in stage_id_map.values() if value}
    task_ids = {str(value) for value in task_id_map.values() if value}
    sample_ids = {str(value) for value in sample_id_map.values() if value}
    sample_category_ids: set[str] = {
        str(value)
        for value in (sample_category_id_map or {}).values()
        if str(value or "").strip()
    }

    for project in current_data.get("projects") or []:
        if not isinstance(project, dict):
            continue
        pid = str(project.get("id") or "")
        project_touched = pid in project_ids
        for stage in project.get("stages") or []:
            if not isinstance(stage, dict):
                continue
            sid = str(stage.get("id") or "")
            if project_touched and sid:
                stage_ids.add(sid)
            if sid in stage_ids and pid:
                project_ids.add(pid)
            for task in stage.get("tasks") or []:
                if not isinstance(task, dict):
                    continue
                tid = str(task.get("id") or "")
                if tid and tid in task_ids:
                    if sid:
                        stage_ids.add(sid)
                    if pid:
                        project_ids.add(pid)

    for category in (current_data.get("sampleLibrary") or {}).get("categories") or []:
        if not isinstance(category, dict):
            continue
        cid = str(category.get("id") or "")
        for sample in category.get("samples") or []:
            if not isinstance(sample, dict):
                continue
            sid = str(sample.get("id") or "")
            if sid and sid in sample_ids and cid:
                sample_category_ids.add(cid)

    return {
        "summaryVersion": 1,
        "projectIds": sorted_nonempty_ids(project_ids),
        "stageIds": sorted_nonempty_ids(stage_ids),
        "taskIds": sorted_nonempty_ids(task_ids),
        "sampleCategoryIds": sorted_nonempty_ids(sample_category_ids),
        "sampleIds": sorted_nonempty_ids(sample_ids),
        "requiresFullState": False,
    }
