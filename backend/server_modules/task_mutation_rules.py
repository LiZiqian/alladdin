from __future__ import annotations

import json
import sqlite3

from server_modules import sample_queries, status_normalization, task_queries, task_reservations


def json_obj(text: str | None, fallback: object | None = None):
    try:
        return json.loads(text or "")
    except Exception:
        return fallback


def detect_task_mutation_occupancy_conflicts(
    conn: sqlite3.Connection,
    task_id: str,
    task: dict,
    project_id: str,
    stage_id: str,
) -> list[dict]:
    if not task_reservations.is_open(task):
        return []
    target_sample_ids = {str(item) for item in (task.get("sampleIds") or []) if str(item)}
    if not target_sample_ids:
        return []
    occupancy = task_reservations.open_reservations(conn, target_sample_ids, exclude_task_id=task_id)
    conflicts = []
    for sample_id, other_tasks in occupancy.items():
        tasks = [{**other, "reason": reason} for other in other_tasks if (reason := task_reservations.conflict_reason(task, other))]
        if not tasks:
            continue
        conflicts.append({
            "sampleId": sample_id,
            "tasks": [
                task_reservations.task_reference({**task, "id": task_id}, project_id, stage_id),
                *tasks,
            ],
        })
    return conflicts


def detect_completed_task_sample_current_state_locks(
    conn: sqlite3.Connection,
    task_id: str,
    sample_ids: set[str],
) -> list[dict]:
    target_sample_ids = {str(item) for item in sample_ids if str(item)}
    if not target_sample_ids:
        return []
    placeholders = ",".join("?" for _ in target_sample_ids)
    rows = conn.execute(
        f"""
        SELECT pts.sample_id, pts.task_id, pts.project_id, pts.stage_id, pts.test_item, pts.status, pts.flow_status
        FROM project_task_samples pts JOIN project_tasks t ON t.id = pts.task_id
        WHERE pts.sample_id IN ({placeholders})
          AND pts.task_id != ?
          AND t.deleted_at IS NULL AND t.flow_status NOT IN ('正常完成', '异常终止')
          AND {task_queries.task_visibility_sql('t.data_json')}
        """,
        (*target_sample_ids, task_id),
    ).fetchall()
    conflicts_by_sample: dict[str, list[dict]] = {}
    for row in rows:
        sample_id = str(row["sample_id"] or "")
        if not sample_id:
            continue
        conflicts_by_sample.setdefault(sample_id, []).append({
            "taskId": str(row["task_id"] or ""),
            "projectId": str(row["project_id"] or ""),
            "stageId": str(row["stage_id"] or ""),
            "testItem": str(row["test_item"] or ""),
            "status": str(row["status"] or ""),
            "flowStatus": str(row["flow_status"] or ""),
        })
    return [
        {"sampleId": sample_id, "tasks": tasks}
        for sample_id, tasks in conflicts_by_sample.items()
    ]


def task_sample_ids(task: dict) -> set[str]:
    return {str(item) for item in (task.get("sampleIds") or []) if str(item)}


def task_sample_ids_failure(task: dict) -> dict | None:
    # Empty assignments are valid; JSON and link-table identities must agree.
    ids = task.get("sampleIds", [])
    if (not isinstance(ids, list)
            or any(not isinstance(sid, str) or not sid.strip() or sid != sid.strip() for sid in ids)
            or len(ids) != len(set(ids))):
        return {"status": 400, "error_code": "TASK_SAMPLE_IDS_INVALID",
                "error": "sampleIds 必须是不重复的非空样机 ID 字符串数组"}
    return None


def existing_task_sample_ids(conn: sqlite3.Connection, task_id: str) -> set[str]:
    row = conn.execute(
        "SELECT sample_ids_json FROM project_tasks WHERE id = ? AND deleted_at IS NULL",
        (task_id,),
    ).fetchone()
    if not row:
        return set()
    sample_ids = json_obj(row["sample_ids_json"], [])
    if not isinstance(sample_ids, list):
        return set()
    return {str(item) for item in sample_ids if str(item)}


def existing_finished_task(conn: sqlite3.Connection, task_id: str) -> dict | None:
    row = conn.execute(
        "SELECT id, status, data_json FROM project_tasks WHERE id = ? AND deleted_at IS NULL",
        (task_id,),
    ).fetchone()
    if not row:
        return None
    task = json_obj(row["data_json"], {}) or {}
    task["id"] = row["id"]
    task["status"] = row["status"] or task.get("status") or ""
    if task_queries.task_flow_status(task) in ("正常完成", "异常终止"):
        return task
    return None


def existing_task(conn: sqlite3.Connection, task_id: str) -> dict | None:
    row = conn.execute(
        """
        SELECT id, status, flow_status, updated_at, data_json
        FROM project_tasks
        WHERE id = ? AND deleted_at IS NULL
        """,
        (task_id,),
    ).fetchone()
    if not row:
        return None
    task = json_obj(row["data_json"], {}) or {}
    task["id"] = str(row["id"] or task_id)
    task["status"] = str(row["status"] or task.get("status") or "")
    task["updatedAt"] = str(row["updated_at"] or task.get("updatedAt") or "")
    task["flowStatus"] = str(row["flow_status"] or task_queries.task_flow_status(task))
    return task


def task_action_state_conflict(
    conn: sqlite3.Connection,
    task_id: str,
    action: str,
    incoming_task: dict,
    *,
    is_delete: bool = False,
) -> dict | None:
    current = existing_task(conn, task_id)
    if not current:
        return None

    current_flow = task_queries.task_flow_status(current)
    incoming_flow = task_queries.task_flow_status(incoming_task)
    terminal = {"正常完成", "异常终止"}

    def conflict(reason: str) -> dict:
        return {
            "taskId": task_id,
            "taskStatus": current_flow,
            "incomingStatus": incoming_flow,
            "taskUpdatedAt": str(current.get("updatedAt") or ""),
            "reason": reason,
        }

    if is_delete:
        if current_flow != "待下发":
            return conflict("只有服务器当前仍为待下发的任务才允许物理删除。")
        return None

    same_state_actions = {
        "create_task_config": {"待下发"},
        "save_task_config": {"待下发"},
        "assign_task_samples": {"待下发"},
        "reassign_task_samples": {"待下发"},
        "set_task_plan": {"待下发"},
        "temp_change_task": {"进行中", "阻塞中"},
        "save_task_result_draft": {"进行中", "阻塞中"},
        "update_issue_record": {"待下发", "进行中", "阻塞中", *terminal},
        "upload_task_result": terminal,
    }
    if action in same_state_actions:
        if current_flow not in same_state_actions[action]:
            return conflict("服务器当前任务状态不允许执行该操作。")
        if incoming_flow != current_flow:
            return conflict("请求中的任务状态已落后于服务器。")
        return None

    transitions = {
        "start_task": ({"待下发"}, {"进行中"}),
        "restart_task": ({"阻塞中"}, {"进行中"}),
        "block_task": ({"进行中"}, {"阻塞中"}),
        "finish_task_result": ({"进行中", "阻塞中"}, terminal),
        "archive_task_delete": ({"进行中", "阻塞中", *terminal}, terminal),
    }
    if action in transitions:
        allowed_current, allowed_incoming = transitions[action]
        if current_flow not in allowed_current or incoming_flow not in allowed_incoming:
            return conflict("任务状态转换与服务器当前状态不一致。")
        return None

    # 状态改变只允许上面列出的业务动作；通用元数据写入不能绕过转换规则。
    if action in {"task_mutation", "task_batch_mutation"} and incoming_flow == current_flow:
        return None
    return conflict("不支持该任务变更动作，请使用当前业务接口的动作类型。")


def sample_record_status(sample: dict) -> str:
    return status_normalization.normalize_sample_usage_status(sample.get("status") if isinstance(sample, dict) else "")


def detect_task_mutation_sample_status_blockers(
    conn: sqlite3.Connection,
    tasks: list[tuple[str, dict]],
    *,
    check_all: bool = False,
) -> list[dict]:
    added_by_sample: dict[str, list[dict]] = {}
    for task_id, task in tasks:
        if task_queries.task_flow_status(task) in ("正常完成", "异常终止"):
            continue
        added_ids = task_sample_ids(task) if check_all else task_sample_ids(task) - existing_task_sample_ids(conn, task_id)
        for sample_id in added_ids:
            added_by_sample.setdefault(sample_id, []).append({
                "taskId": task_id,
                "testItem": str(task.get("testItem") or ""),
                "status": str(task.get("status") or ""),
            })
    if not added_by_sample:
        return []
    occupancy = task_reservations.open_reservations(conn, added_by_sample)
    placeholders = ",".join("?" for _ in added_by_sample)
    rows = conn.execute(
        f"""
        SELECT id, sample_no, sn, imei, board_sn, is_reassembled, status, data_json
        FROM sample_records
        WHERE deleted_at IS NULL AND id IN ({placeholders})
        """,
        tuple(added_by_sample.keys()),
    ).fetchall()
    blockers = []
    for row in rows:
        sample = json_obj(row["data_json"], {}) or {}
        sample["id"] = row["id"]
        sample["sampleNo"] = row["sample_no"] or sample.get("sampleNo") or ""
        sample["sn"] = row["sn"] or sample.get("sn") or ""
        sample["imei"] = row["imei"] or sample.get("imei") or ""
        sample["boardSn"] = row["board_sn"] or sample.get("boardSn") or ""
        sample["isReassembled"] = bool(row["is_reassembled"]) if row["is_reassembled"] is not None else sample_queries.sample_is_reassembled(sample)
        sample["status"] = row["status"] or sample.get("status") or ""
        status = sample_record_status(sample)
        reason = task_reservations.sample_status_block_reason(sample, occupancy.get(str(row["id"]), []))
        if not reason:
            continue
        blockers.append({
            "sampleId": str(row["id"] or ""),
            "sampleNo": str(sample.get("sampleNo") or ""),
            "sn": str(sample.get("sn") or ""),
            "imei": str(sample.get("imei") or ""),
            "status": status,
            "reason": reason,
            "tasks": added_by_sample.get(str(row["id"] or ""), []),
        })
    return blockers
