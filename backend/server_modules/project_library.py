from __future__ import annotations

import copy
import sqlite3
import uuid
from dataclasses import dataclass
from typing import Callable

from server_modules import record_writers, status_normalization, task_queries, problem_records


@dataclass(frozen=True)
class ProjectLibraryContext:
    now_iso: Callable[[], str]
    json_dumps: Callable[[object], str]


def sync_project_library(ctx: ProjectLibraryContext, conn: sqlite3.Connection, data: dict, *, allow_empty: bool = False) -> bool:
    projects = data.get("projects") or []
    if data.get("projectsExternalized") and not projects and not allow_empty:
        return False

    ts = ctx.now_iso()
    active_project_ids: list[str] = []
    active_stage_ids: list[str] = []
    active_task_ids: list[str] = []

    for project_order, project in enumerate(projects):
        if not isinstance(project, dict):
            continue
        project = status_normalization.normalize_project_payload(project)
        project_id = str(project.get("id") or f"project_{uuid.uuid4().hex}")
        project["id"] = project_id
        active_project_ids.append(project_id)
        project_json = copy.deepcopy(project)
        project_json.pop("stages", None)
        project_json.pop("samplePersonCounts", None)
        conn.execute(
            """
            INSERT INTO project_records
            (id, name, code, owner, sort_order, data_json, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                code = excluded.code,
                owner = excluded.owner,
                sort_order = excluded.sort_order,
                data_json = excluded.data_json,
                updated_at = excluded.updated_at,
                deleted_at = NULL
            """,
            (
                project_id,
                str(project.get("name") or "Untitled Project"),
                str(project.get("code") or ""),
                str(project.get("owner") or project.get("leader") or project.get("manager") or ""),
                project_order,
                ctx.json_dumps(project_json),
                str(project.get("createdAt") or ts),
                str(project.get("updatedAt") or ts),
            ),
        )

        for stage_order, stage in enumerate(project.get("stages", []) or []):
            if not isinstance(stage, dict):
                continue
            stage = status_normalization.normalize_stage_payload(stage)
            stage_id = str(stage.get("id") or f"stage_{uuid.uuid4().hex}")
            stage["id"] = stage_id
            stage["projectId"] = project_id
            active_stage_ids.append(stage_id)
            stage_json = copy.deepcopy(stage)
            stage_json.pop("tasks", None)
            stage_json.pop("usedSampleRuns", None)
            stage_json.pop("runningSampleCount", None)
            stage_json.pop("progressTaskCounts", None)
            conn.execute(
                """
                INSERT INTO project_stages
                (id, project_id, name, sort_order, data_json, created_at, updated_at, deleted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                ON CONFLICT(id) DO UPDATE SET
                    project_id = excluded.project_id,
                    name = excluded.name,
                    sort_order = excluded.sort_order,
                    data_json = excluded.data_json,
                    updated_at = excluded.updated_at,
                    deleted_at = NULL
                """,
                (
                    stage_id,
                    project_id,
                    str(stage.get("name") or "Untitled Stage"),
                    stage_order,
                    ctx.json_dumps(stage_json),
                    str(stage.get("createdAt") or ts),
                    str(stage.get("updatedAt") or ts),
                ),
            )

            for task in stage.get("tasks", []) or []:
                if not isinstance(task, dict):
                    continue
                task = status_normalization.normalize_task_payload(task)
                task_id = str(task.get("id") or f"task_{uuid.uuid4().hex}")
                task["id"] = task_id
                task["projectId"] = project_id
                task["stageId"] = stage_id
                problem_records.preserve_task_created_at(conn, task)
                active_task_ids.append(task_id)
                sample_ids = [str(x) for x in (task.get("sampleIds") or [])]
                task_json = copy.deepcopy(task)
                task_logs = task_json.pop("logs", []) if isinstance(task_json.get("logs"), list) else []
                conn.execute(
                    """
                    INSERT INTO project_tasks
                    (id, project_id, stage_id, progress_id, category, test_item, sku_index, status, flow_status, owner,
                     sample_ids_json, data_json, created_at, updated_at, completed_at, deleted_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                    ON CONFLICT(id) DO UPDATE SET
                        project_id = excluded.project_id,
                        stage_id = excluded.stage_id,
                        progress_id = excluded.progress_id,
                        category = excluded.category,
                        test_item = excluded.test_item,
                        sku_index = excluded.sku_index,
                        status = excluded.status,
                        flow_status = excluded.flow_status,
                        owner = excluded.owner,
                        sample_ids_json = excluded.sample_ids_json,
                        data_json = excluded.data_json,
                        updated_at = excluded.updated_at,
                        completed_at = excluded.completed_at,
                        deleted_at = NULL
                    """,
                    (
                        task_id,
                        project_id,
                        stage_id,
                        str(task.get("progressId") or ""),
                        str(task.get("category") or ""),
                        str(task.get("testItem") or ""),
                        task_queries.to_int(task.get("skuIndex")),
                        status_normalization.normalize_task_stored_status(task),
                        task_queries.task_flow_status(task),
                        str(task.get("owner") or ""),
                        ctx.json_dumps(sample_ids),
                        ctx.json_dumps(task_json),
                        str(task.get("createdAt") or ts),
                        str(task.get("updatedAt") or ts),
                        str(task.get("completedAt") or task.get("endDate") or ""),
                    ),
                )
                record_writers.replace_task_sample_links(conn, task_id, project_id, stage_id, task, sample_ids)
                conn.execute("DELETE FROM task_logs WHERE task_id = ?", (task_id,))
                seen_log_ids: set[str] = set()
                for log in task_logs:
                    if not isinstance(log, dict):
                        continue
                    log = log
                    log_id = str(log.get("id") or f"tasklog_{uuid.uuid4().hex}")
                    if log_id in seen_log_ids:
                        continue
                    seen_log_ids.add(log_id)
                    log["id"] = log_id
                    log["taskId"] = task_id
                    log["projectId"] = project_id
                    log["stageId"] = stage_id
                    conn.execute(
                        """
                        INSERT INTO task_logs
                        (id, task_id, project_id, stage_id, time, action, user, data_json)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            log_id,
                            task_id,
                            project_id,
                            stage_id,
                            str(log.get("time") or ""),
                            str(log.get("action") or ""),
                            str(log.get("user") or ""),
                            ctx.json_dumps(log),
                        ),
                    )

    if active_task_ids:
        placeholders = ",".join("?" for _ in active_task_ids)
        conn.execute(f"DELETE FROM task_logs WHERE task_id NOT IN ({placeholders})", active_task_ids)
        conn.execute(f"DELETE FROM project_task_samples WHERE task_id NOT IN ({placeholders})", active_task_ids)
        conn.execute(f"DELETE FROM project_tasks WHERE id NOT IN ({placeholders})", active_task_ids)
    else:
        conn.execute("DELETE FROM task_logs")
        conn.execute("DELETE FROM project_task_samples")
        conn.execute("DELETE FROM project_tasks")

    if active_stage_ids:
        placeholders = ",".join("?" for _ in active_stage_ids)
        conn.execute(f"DELETE FROM project_stages WHERE id NOT IN ({placeholders})", active_stage_ids)
    else:
        conn.execute("DELETE FROM project_stages")

    if active_project_ids:
        placeholders = ",".join("?" for _ in active_project_ids)
        conn.execute(f"DELETE FROM project_records WHERE id NOT IN ({placeholders})", active_project_ids)
    else:
        conn.execute("DELETE FROM project_records")

    return True
