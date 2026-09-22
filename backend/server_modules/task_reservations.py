"""Shared rules for dated sample reservations and exclusive live execution.

Plans use inclusive calendar dates. Missing/invalid dates cannot prove that two
reservations are disjoint. Running and blocked tasks hold the physical sample
until explicitly finished or released, even after their planned end date.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import date

from server_modules import status_normalization


TERMINAL = {"正常完成", "异常终止"}
EXECUTING = {"进行中", "阻塞中"}


def plan_range(task: dict) -> tuple[str, str] | None:
    start = str(task.get("planStartDate") or task.get("planDate") or "").strip()
    end = str(task.get("planEndDate") or task.get("endDate") or "").strip()
    try:
        for value in (start, end):
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                return None
            date.fromisoformat(value)
    except ValueError:
        return None
    return (start, end) if start <= end else None


def is_open(task: dict) -> bool:
    return not task.get("archived") and not task.get("deletedAt") and status_normalization.normalize_task_flow_status(task) not in TERMINAL


def conflict_reason(left: dict, right: dict) -> str:
    if not is_open(left) or not is_open(right):
        return ""
    if all(status_normalization.normalize_task_flow_status(task) in EXECUTING for task in (left, right)):
        return "样机仍在其他任务中执行或阻塞，须先结束或释放"
    left_range, right_range = plan_range(left), plan_range(right)
    if not left_range or not right_range:
        return "已有预约；双方须填写完整有效的计划时间才能错峰复用"
    if left_range[0] <= right_range[1] and right_range[0] <= left_range[1]:
        return "计划时间重叠（开始日和结束日均计入）"
    return ""


def task_reference(task: dict, project_id: str = "", stage_id: str = "") -> dict:
    return {
        "taskId": str(task.get("id") or task.get("taskId") or ""),
        "projectId": str(project_id or task.get("projectId") or ""),
        "stageId": str(stage_id or task.get("stageId") or ""),
        "testItem": str(task.get("testItem") or ""),
        "status": status_normalization.normalize_task_flow_status(task),
        "planStartDate": str(task.get("planStartDate") or task.get("planDate") or ""),
        "planEndDate": str(task.get("planEndDate") or task.get("endDate") or ""),
    }


def open_reservations(conn: sqlite3.Connection, sample_ids, *, exclude_task_id: str = "") -> dict[str, list[dict]]:
    ids = sorted({str(sid) for sid in sample_ids if sid})
    result: dict[str, list[dict]] = {}
    # Bound SQLite parameters even for a large task or import.
    for offset in range(0, len(ids), 400):
        batch = ids[offset:offset + 400]
        placeholders = ",".join("?" for _ in batch)
        rows = conn.execute(f"""
            SELECT pts.sample_id, t.id, t.project_id, t.stage_id, t.data_json
            FROM project_task_samples pts JOIN project_tasks t ON t.id = pts.task_id
            WHERE pts.sample_id IN ({placeholders}) AND t.id != ?
              AND t.deleted_at IS NULL AND t.flow_status NOT IN ('正常完成', '异常终止')
            ORDER BY t.id
        """, (*batch, exclude_task_id)).fetchall()
        for row in rows:
            task = json.loads(row["data_json"] or "{}")
            if not is_open(task):
                continue
            task["id"] = row["id"]
            result.setdefault(str(row["sample_id"]), []).append(task_reference(task, row["project_id"], row["stage_id"]))
    return result


def sample_status_block_reason(sample: dict, reservations: list[dict], *, already_assigned: bool = False) -> str:
    status = status_normalization.normalize_sample_usage_status(sample.get("status"))
    if status == "闲置":
        return ""
    if status in ("在位等待", "测试中") and (reservations or already_assigned):
        return ""
    return f"当前状态为「{status}」，不能加入或启动测试任务"


def primary_reservation(reservations: list[dict]) -> dict | None:
    return min(reservations, key=lambda task: (
        {"进行中": 0, "阻塞中": 1}.get(task["status"], 2),
        task.get("planStartDate") or "9999-12-31",
        task["taskId"],
    ), default=None)


def apply_primary_usage(sample: dict, reservations: list[dict]) -> None:
    usage = primary_reservation(reservations)
    status = status_normalization.normalize_sample_usage_status(sample.get("status"))
    if usage and status not in ("取走分析", "已退库"):
        sample.update({
            "status": "测试中" if usage["status"] == "进行中" else "在位等待",
            "currentProjectId": usage["projectId"], "currentStageId": usage["stageId"],
            "currentTaskId": usage["taskId"], "currentTestItem": usage["testItem"],
        })
    else:
        if status in ("测试中", "在位等待"):
            sample["status"] = "闲置"
        sample.update(currentProjectId=None, currentStageId=None, currentTaskId=None, currentTestItem="")


def reconcile_state_reservations(data: dict) -> None:
    occupancy: dict[str, list[dict]] = {}
    for project in data.get("projects") or []:
        for stage in project.get("stages") or []:
            for task in stage.get("tasks") or []:
                if is_open(task):
                    for sid in set(task.get("sampleIds") or []):
                        occupancy.setdefault(str(sid), []).append(task_reference(task, project.get("id"), stage.get("id")))
    for category in (data.get("sampleLibrary") or {}).get("categories") or []:
        for sample in category.get("samples") or []:
            reservations = occupancy.get(str(sample.get("id") or ""), [])
            if reservations:
                apply_primary_usage(sample, reservations)
