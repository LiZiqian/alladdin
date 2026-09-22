"""任务/阶段归属、样机载荷与关联事件校验。
状态和关联关系以数据库为准；校验失败由服务入口返回，不能局部提交。"""
from __future__ import annotations

import sqlite3

from server_modules import (
    status_normalization,
    task_mutation_rules,
    task_queries,
)


def _task_sample_event_scope_failure(
    conn: sqlite3.Connection,
    sample_events: list[dict],
    *,
    project_id: str,
    stage_id: str,
    task_id: str,
) -> dict | None:
    """Bind newly created sample events to the task mutation that creates them."""
    event_ids = {
        str(event.get("id") or "")
        for event in sample_events
        if isinstance(event, dict) and str(event.get("id") or "")
    }
    existing_ids: set[str] = set()
    if event_ids:
        placeholders = ",".join("?" for _ in event_ids)
        rows = conn.execute(
            f"SELECT id FROM sample_events WHERE id IN ({placeholders})",
            tuple(sorted(event_ids)),
        ).fetchall()
        existing_ids = {str(row["id"] or "") for row in rows}

    expected = {
        "projectId": project_id,
        "stageId": stage_id,
        "taskId": task_id,
    }
    for event in sample_events:
        event_id = str(event.get("id") or "")
        if event_id and event_id in existing_ids:
            continue
        for field, expected_id in expected.items():
            supplied_id = str(event.get(field) or "")
            if supplied_id and supplied_id != expected_id:
                return {
                    "status": 409,
                    "error_code": "TASK_SAMPLE_EVENT_OWNERSHIP_CONFLICT",
                    "error": "样机事件归属与当前任务不一致，已拒绝写入串线履历。",
                    "eventId": event_id,
                    "field": field,
                    "expectedId": expected_id,
                    "suppliedId": supplied_id,
                }
            event[field] = expected_id
    return None


def _task_scope_failure(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    project_id: str,
    stage_id: str,
) -> dict | None:
    task_row = conn.execute(
        """
        SELECT project_id, stage_id
        FROM project_tasks
        WHERE id = ? AND deleted_at IS NULL
        """,
        (task_id,),
    ).fetchone()
    if task_row and (
        str(task_row["project_id"] or "") != project_id
        or str(task_row["stage_id"] or "") != stage_id
    ):
        return {
            "status": 409,
            "error_code": "TASK_SCOPE_CONFLICT",
            "error": "任务归属与请求中的项目或阶段不一致，已拒绝跨范围写入。",
            "taskId": task_id,
            "actualProjectId": str(task_row["project_id"] or ""),
            "actualStageId": str(task_row["stage_id"] or ""),
        }

    stage_row = conn.execute(
        """
        SELECT project_id
        FROM project_stages
        WHERE id = ? AND deleted_at IS NULL
        """,
        (stage_id,),
    ).fetchone()
    if not stage_row:
        return {
            "status": 404,
            "error_code": "STAGE_NOT_FOUND",
            "error": f"阶段不存在: {stage_id}",
            "stageId": stage_id,
        }
    if str(stage_row["project_id"] or "") != project_id:
        return {
            "status": 409,
            "error_code": "TASK_SCOPE_CONFLICT",
            "error": "阶段不属于请求中的项目，已拒绝跨项目写入任务。",
            "taskId": task_id,
            "stageId": stage_id,
            "actualProjectId": str(stage_row["project_id"] or ""),
        }
    return None


def _stage_mutation_scope_failure(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    stage_id: str,
    create_if_missing: bool,
    delete_stage: bool,
) -> dict | None:
    project_row = conn.execute(
        "SELECT 1 FROM project_records WHERE id = ? AND deleted_at IS NULL",
        (project_id,),
    ).fetchone()
    if not project_row:
        return {
            "status": 404,
            "error_code": "PROJECT_NOT_FOUND",
            "error": f"项目不存在: {project_id}",
            "projectId": project_id,
        }
    stage_row = conn.execute(
        "SELECT project_id FROM project_stages WHERE id = ? AND deleted_at IS NULL",
        (stage_id,),
    ).fetchone()
    if not stage_row:
        if create_if_missing and not delete_stage:
            return None
        return {
            "status": 404,
            "error_code": "STAGE_NOT_FOUND",
            "error": f"阶段不存在: {stage_id}",
            "stageId": stage_id,
        }
    actual_project_id = str(stage_row["project_id"] or "")
    if actual_project_id != project_id:
        return {
            "status": 409,
            "error_code": "STAGE_SCOPE_CONFLICT",
            "error": "阶段不属于请求中的项目，已拒绝跨项目修改。",
            "stageId": stage_id,
            "projectId": project_id,
            "actualProjectId": actual_project_id,
        }
    return None


def _task_related_sample_ids(task: dict) -> set[str]:
    ids = set(task_mutation_rules.task_sample_ids(task))

    def add_items(items: object) -> None:
        if not isinstance(items, list):
            return
        for item in items:
            if not isinstance(item, dict):
                continue
            sample_id = str(item.get("sampleId") or item.get("sid") or item.get("id") or "")
            if sample_id:
                ids.add(sample_id)

    add_items(task.get("removedSampleRecords"))
    add_items(task.get("sampleFaultRecords"))
    result_draft = task.get("resultDraft")
    if isinstance(result_draft, dict):
        add_items(result_draft.get("samples"))
    result_uploads = task.get("resultUploads")
    if isinstance(result_uploads, list):
        for upload in result_uploads:
            if isinstance(upload, dict):
                add_items(upload.get("samples"))
    return ids


def _task_sample_payload_failure(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    action: str,
    task: dict,
    sample_payloads: list[dict],
    sample_events: list[dict],
    is_delete: bool,
) -> dict | None:
    payload_ids: list[str] = []
    for sample in sample_payloads:
        sample_id = str(sample.get("id") or "")
        if not sample_id:
            return {"status": 400, "error": "samples 中每台样机都必须包含 id"}
        payload_ids.append(sample_id)
    if len(payload_ids) != len(set(payload_ids)):
        return {"status": 400, "error": "samples 中存在重复样机 id"}

    old_ids = task_mutation_rules.existing_task_sample_ids(conn, task_id)
    new_ids = task_mutation_rules.task_sample_ids(task)
    assignment_actions = {
        "assign_task_samples",
        "reassign_task_samples",
        "create_task_config",
        "save_task_config",
        "temp_change_task",
    }
    fixed_assignment_actions = {
        "set_task_plan",
        "save_task_result_draft",
        "update_issue_record",
        "start_task",
        "restart_task",
        "block_task",
        "task_start",
        "finish_task_result",
        "upload_task_result",
        "archive_task_delete",
        "delete_task",
    }
    if action in fixed_assignment_actions and old_ids != new_ids:
        return {
            "status": 409,
            "error_code": "TASK_SAMPLE_ASSIGNMENT_CONFLICT",
            "error": "该任务操作不允许同时改变样机分配，已拒绝保存。",
            "missingSampleIds": sorted(old_ids - new_ids),
            "unexpectedSampleIds": sorted(new_ids - old_ids),
        }

    payload_id_set = set(payload_ids)
    if action in {"set_task_plan", "save_task_result_draft", "update_issue_record"}:
        required_ids = set()
        allowed_ids = set()
    elif action in assignment_actions:
        required_ids = old_ids | new_ids if old_ids != new_ids else set()
        allowed_ids = set(required_ids)
    elif action in {"start_task", "restart_task", "block_task", "task_start", "delete_task"} or is_delete:
        required_ids = set(old_ids)
        allowed_ids = set(old_ids)
    elif action == "archive_task_delete":
        current = task_mutation_rules.existing_task(conn, task_id) or {}
        current_flow = status_normalization.normalize_task_flow_status(current)
        required_ids = set() if current_flow in ("正常完成", "异常终止") else set(old_ids)
        allowed_ids = set(required_ids)
    elif action in {"finish_task_result", "upload_task_result"}:
        allowed_ids = _task_related_sample_ids(task) | old_ids
        required_ids = set()
        if action == "finish_task_result" and old_ids:
            placeholders = ",".join("?" for _ in old_ids)
            locked_rows = conn.execute(
                f"""
                SELECT DISTINCT pts.sample_id
                FROM project_task_samples pts JOIN project_tasks other ON other.id = pts.task_id
                WHERE pts.sample_id IN ({placeholders})
                  AND pts.task_id != ?
                  AND other.deleted_at IS NULL AND other.flow_status IN ('进行中', '阻塞中')
                  AND {task_queries.task_visibility_sql('other.data_json')}
                """,
                (*old_ids, task_id),
            ).fetchall()
            locked_ids = {str(row["sample_id"] or "") for row in locked_rows}
            required_ids = old_ids - locked_ids
    else:
        required_ids = old_ids | new_ids if old_ids != new_ids else set()
        allowed_ids = old_ids | new_ids

    missing_ids = required_ids - payload_id_set
    unexpected_ids = payload_id_set - allowed_ids
    if missing_ids or unexpected_ids:
        return {
            "status": 409,
            "error_code": "TASK_SAMPLE_PAYLOAD_MISMATCH",
            "error": "任务与样机载荷不完整或包含无关样机，已拒绝部分写入。",
            "missingSampleIds": sorted(missing_ids),
            "unexpectedSampleIds": sorted(unexpected_ids),
        }

    if payload_id_set:
        placeholders = ",".join("?" for _ in payload_id_set)
        existing_rows = conn.execute(
            f"SELECT id FROM sample_records WHERE deleted_at IS NULL AND id IN ({placeholders})",
            tuple(payload_id_set),
        ).fetchall()
        existing_ids = {str(row["id"] or "") for row in existing_rows}
        missing_records = payload_id_set - existing_ids
        if missing_records:
            return {
                "status": 409,
                "error_code": "SAMPLE_NOT_FOUND",
                "error": "任务引用的样机档案不存在，已拒绝保存。",
                "sampleIds": sorted(missing_records),
            }

    event_sample_ids = {
        str(event.get("sampleId") or "")
        for event in sample_events
        if isinstance(event, dict)
    }
    if "" in event_sample_ids or not event_sample_ids.issubset(payload_id_set):
        return {
            "status": 409,
            "error_code": "TASK_SAMPLE_EVENT_SCOPE_CONFLICT",
            "error": "样机事件超出本次任务允许写入的样机范围，已拒绝保存。",
            "unexpectedSampleIds": sorted(event_sample_ids - payload_id_set),
        }
    return None
