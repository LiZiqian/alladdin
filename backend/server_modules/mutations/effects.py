"""写入服务共用的样机快照与占用协调。
调用方持有事务；占用必须聚合所有项目，不能从当前页或未来预约推导即时状态。"""
from __future__ import annotations

import sqlite3

from server_modules import (
    record_writers,
    sample_queries,
    task_queries,
    task_reservations,
)


# 任务编辑页可能持有旧档案，只允许更新流程拥有的字段；SN、IMEI、
# 板号等身份字段必须经过样机档案的独立编辑入口。
TASK_SAMPLE_MUTABLE_FIELDS = (
    "status", "updatedAt", "problemRecords",
    "location", "owner", "borrower", "borrowDate", "currentProjectId",
    "currentStageId", "currentTaskId", "currentTestItem",
)


def _persist_destroyed_sample_snapshots(
    conn: sqlite3.Connection,
    *,
    sample_ids: set[str],
    destroyed_at: str,
) -> None:
    """Capture terminal-task sample identity before physical archive deletion."""
    if not sample_ids:
        return
    placeholders = ",".join("?" for _ in sample_ids)
    sample_rows = conn.execute(
        f"""
        SELECT r.id, r.category_id, r.sample_no, r.sn, r.imei, r.board_sn, r.data_json,
               c.name AS category_name
        FROM sample_records AS r
        LEFT JOIN sample_categories AS c ON c.id = r.category_id
        WHERE r.id IN ({placeholders}) AND r.deleted_at IS NULL
        """,
        tuple(sorted(sample_ids)),
    ).fetchall()
    snapshots: dict[str, dict] = {}
    for row in sample_rows:
        sample_id = str(row["id"] or "")
        sample = record_writers.json_obj(row["data_json"], {})
        sample_no = str(row["sample_no"] or sample.get("sampleNo") or "")
        sn = str(row["sn"] or sample.get("sn") or "")
        imei = str(row["imei"] or sample.get("imei") or "")
        board_sn = str(row["board_sn"] or sample.get("boardSn") or "")
        snapshots[sample_id] = {
            "id": sample_id,
            "categoryId": str(row["category_id"] or sample.get("categoryId") or ""),
            "categoryName": str(row["category_name"] or ""),
            "code": sample_no or sn or imei or board_sn or sample_id,
            "sampleNo": sample_no or sn or imei or board_sn or sample_id,
            "sn": sn,
            "imei": imei,
            "boardSn": board_sn,
            "capturedAt": destroyed_at,
            "destroyedAt": destroyed_at,
        }

    task_rows = conn.execute(
        f"""
        SELECT DISTINCT t.id, t.data_json, pts.sample_id
        FROM project_task_samples AS pts
        JOIN project_tasks AS t ON t.id = pts.task_id
        WHERE pts.sample_id IN ({placeholders})
          AND (t.flow_status IN ('正常完成', '异常终止') OR {task_queries.task_archived_sql('t.data_json')})
        """,
        tuple(sorted(sample_ids)),
    ).fetchall()
    tasks: dict[str, dict] = {}
    for row in task_rows:
        task_id = str(row["id"] or "")
        sample_id = str(row["sample_id"] or "")
        snapshot = snapshots.get(sample_id)
        if not task_id or not snapshot:
            continue
        task = tasks.setdefault(task_id, record_writers.json_obj(row["data_json"], {}))
        snapshot_map = task.get("sampleSnapshots")
        if not isinstance(snapshot_map, dict):
            snapshot_map = {}
            task["sampleSnapshots"] = snapshot_map
        existing = snapshot_map.get(sample_id)
        if isinstance(existing, dict):
            snapshot_map[sample_id] = {
                **snapshot,
                **existing,
                "destroyedAt": existing.get("destroyedAt") or destroyed_at,
            }
        else:
            snapshot_map[sample_id] = dict(snapshot)

    for task_id, task in tasks.items():
        conn.execute(
            "UPDATE project_tasks SET data_json = ?, updated_at = ? WHERE id = ?",
            (record_writers.json_dumps(task), destroyed_at, task_id),
        )


def _operational_sample_write_payloads(conn: sqlite3.Connection, sample_payloads: list[dict], *, preserve_sample_state: bool = False) -> list[dict]:
    """Merge workflow-controlled fields into current sample records.

    Task, project and stage requests originate from pages that may hold stale
    copies of a sample. They must never become alternate sample-archive editors:
    sample identity, category, source metadata and unrelated archive fields
    remain authoritative in SQLite.
    """
    sample_ids = [str(sample.get("id") or "") for sample in sample_payloads]
    if not sample_ids:
        return []
    placeholders = ",".join("?" for _ in sample_ids)
    rows = conn.execute(
        f"SELECT * FROM sample_records WHERE deleted_at IS NULL AND id IN ({placeholders})",
        tuple(sample_ids),
    ).fetchall()
    current_by_id = {
        str(row["id"] or ""): sample_queries.sample_from_db_row(row)
        for row in rows
        if str(row["id"] or "")
    }
    merged_payloads: list[dict] = []
    for incoming in sample_payloads:
        sample_id = str(incoming.get("id") or "")
        current = current_by_id[sample_id]
        for field in (() if preserve_sample_state else TASK_SAMPLE_MUTABLE_FIELDS):
            if field in incoming:
                current[field] = incoming[field]
        current["id"] = sample_id
        current["categoryId"] = str(current.get("categoryId") or "")
        merged_payloads.append(current)
    return merged_payloads


def reconcile_task_sample_occupancy(conn: sqlite3.Connection, sample_ids, *, only_reserved: bool = False) -> None:
    """Derive current usage from every project, never from a paged client view.

    A future reservation must not replace live execution. Explicit destinations
    (analysis/returned) remain unavailable and are rechecked on the next start.
    """
    ids = sorted({str(sid) for sid in sample_ids if sid})
    occupancy = task_reservations.open_reservations(conn, ids)
    # Archive edits only reconcile actual reservations. Unreserved samples may
    # carry manually managed usage states and must retain that existing behavior.
    if only_reserved:
        ids = [sid for sid in ids if occupancy.get(sid)]
    for offset in range(0, len(ids), 400):
        batch = ids[offset:offset + 400]
        placeholders = ",".join("?" for _ in batch)
        rows = conn.execute(f"SELECT * FROM sample_records WHERE deleted_at IS NULL AND id IN ({placeholders})", batch).fetchall()
        for row in rows:
            sample = sample_queries.sample_from_db_row(row)
            before = {key: sample.get(key) for key in ("status", "currentProjectId", "currentStageId", "currentTaskId", "currentTestItem")}
            task_reservations.apply_primary_usage(sample, occupancy.get(str(row["id"]), []))
            if any(sample.get(key) != value for key, value in before.items()):
                record_writers.update_sample_record(conn, sample)
