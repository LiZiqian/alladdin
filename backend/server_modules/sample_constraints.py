from __future__ import annotations

import json
import sqlite3

from server_modules import sample_queries, task_queries


def json_obj(text: str | None, fallback: object | None = None):
    try:
        return json.loads(text or "")
    except Exception:
        return fallback


def sample_identity_value(value: object) -> str:
    return str(value or "").strip()


def sample_identity_key(value: object) -> str:
    return sample_identity_value(value).lower()


def sample_identity_fields(sample: dict) -> list[dict]:
    return [
        {"field": "sn", "label": "SN", "value": sample_identity_value(sample.get("sn"))},
        {"field": "imei", "label": "IMEI", "value": sample_identity_value(sample.get("imei"))},
        {"field": "boardSn", "label": "主板SN", "value": sample_identity_value(sample.get("boardSn"))},
    ]


def sample_display_code(sample: dict) -> str:
    sn = sample_identity_value(sample.get("sn"))
    imei = sample_identity_value(sample.get("imei"))
    board_sn = sample_identity_value(sample.get("boardSn"))
    if sn:
        return f"SN#{sn[-6:]}"
    if imei:
        return f"IMEI#{imei[-6:]}"
    if board_sn:
        return f"主板SN#{board_sn[-6:]}"
    return sample_identity_value(sample.get("sampleNo")) or "未录入SN/IMEI/主板SN"


def list_sample_destroy_impact_scope(conn: sqlite3.Connection, query: dict[str, list[str]]) -> dict:
    sample_id = task_queries.first_query_value(query, "sampleId", "").strip()
    category_id = task_queries.first_query_value(query, "categoryId", "").strip()
    if not sample_id and not category_id:
        raise ValueError("缺少 sampleId 或 categoryId")

    sample_ids: set[str] = set()
    if sample_id:
        row = conn.execute(
            "SELECT id FROM sample_records WHERE id = ? AND deleted_at IS NULL",
            (sample_id,),
        ).fetchone()
        if not row:
            raise KeyError("样机不存在")
        sample_ids.add(sample_id)

    if category_id:
        cat = conn.execute(
            "SELECT id FROM sample_categories WHERE id = ? AND deleted_at IS NULL",
            (category_id,),
        ).fetchone()
        if not cat:
            raise KeyError("样机池不存在")
        rows = conn.execute(
            "SELECT id FROM sample_records WHERE category_id = ? AND deleted_at IS NULL",
            (category_id,),
        ).fetchall()
        sample_ids.update(str(row["id"] or "") for row in rows if row["id"])

    project_ids: set[str] = set()
    stage_ids: set[str] = set()
    task_ids: set[str] = set()
    related_sample_ids: set[str] = set(sample_ids)

    if category_id:
        project_rows = conn.execute(
            "SELECT id, data_json FROM project_records WHERE deleted_at IS NULL"
        ).fetchall()
        for row in project_rows:
            project = json_obj(row["data_json"], {}) or {}
            if str(project.get("defaultSampleCategoryId") or "") == category_id:
                project_ids.add(str(row["id"] or ""))

    if sample_ids:
        ids = sorted(sample_ids)
        placeholders = ",".join("?" for _ in ids)
        link_rows = conn.execute(
            f"""
            SELECT DISTINCT t.id, t.project_id, t.stage_id, t.sample_ids_json
            FROM project_task_samples pts
            JOIN project_tasks t ON t.id = pts.task_id
            WHERE pts.sample_id IN ({placeholders}) AND t.deleted_at IS NULL
            """,
            ids,
        ).fetchall()
        for row in link_rows:
            task_ids.add(str(row["id"] or ""))
            project_ids.add(str(row["project_id"] or ""))
            stage_ids.add(str(row["stage_id"] or ""))
            for sid in json_obj(row["sample_ids_json"], []) or []:
                if str(sid or "").strip():
                    related_sample_ids.add(str(sid))

    if sample_id:
        # Completed tasks may only retain destroyed samples inside removedSampleRecords.
        like_rows = conn.execute(
            """
            SELECT id, project_id, stage_id, sample_ids_json, data_json
            FROM project_tasks
            WHERE deleted_at IS NULL AND data_json LIKE ?
            """,
            (f"%{sample_id}%",),
        ).fetchall()
        for row in like_rows:
            task = json_obj(row["data_json"], {}) or {}
            removed = task.get("removedSampleRecords") if isinstance(task.get("removedSampleRecords"), list) else []
            if not any(str(item.get("sampleId") or item.get("sid") or "") == sample_id for item in removed if isinstance(item, dict)):
                continue
            task_ids.add(str(row["id"] or ""))
            project_ids.add(str(row["project_id"] or ""))
            stage_ids.add(str(row["stage_id"] or ""))
            for sid in json_obj(row["sample_ids_json"], []) or []:
                if str(sid or "").strip():
                    related_sample_ids.add(str(sid))

    sample_category_ids: set[str] = set()
    if category_id:
        sample_category_ids.add(category_id)
    if related_sample_ids:
        ids = sorted(related_sample_ids)
        placeholders = ",".join("?" for _ in ids)
        rows = conn.execute(
            f"""
            SELECT DISTINCT category_id
            FROM sample_records
            WHERE id IN ({placeholders}) AND deleted_at IS NULL
            """,
            ids,
        ).fetchall()
        sample_category_ids.update(str(row["category_id"] or "") for row in rows if row["category_id"])

    return {
        "sampleId": sample_id,
        "categoryId": category_id,
        "sampleIds": sorted(sample_ids),
        "relatedSampleIds": sorted(related_sample_ids),
        "projectIds": sorted(x for x in project_ids if x),
        "stageIds": sorted(x for x in stage_ids if x),
        "taskIds": sorted(x for x in task_ids if x),
        "sampleCategoryIds": sorted(x for x in sample_category_ids if x),
    }


def compact_sample_identity_row(row: sqlite3.Row) -> dict:
    sample = sample_queries.sample_from_db_row(row)
    return {
        "id": str(sample.get("id") or ""),
        "categoryId": str(sample.get("categoryId") or ""),
        "categoryName": str(row["category_name"] or "") if "category_name" in row.keys() else "",
        "sampleNo": str(sample.get("sampleNo") or ""),
        "sn": str(sample.get("sn") or ""),
        "imei": str(sample.get("imei") or ""),
        "boardSn": str(sample.get("boardSn") or ""),
        "isReassembled": sample_queries.sample_is_reassembled(sample),
        "status": str(sample.get("status") or ""),
        "code": sample_display_code(sample),
    }


def sample_identity_match_field(sample: dict, key: str) -> dict | None:
    for item in sample_identity_fields(sample):
        if item["value"] and item["value"].lower() == key:
            return item
    return None


def sample_identity_write_failure(conn: sqlite3.Connection, samples: list[dict]) -> dict | None:
    """Validate every supplied identity under the caller's write transaction.

    Existing records follow the same uniqueness contract as newly created ones.
    Reassembled samples are exempt by the current business rule.
    """
    incoming: dict[str, dict] = {}
    for sample in samples:
        if not isinstance(sample, dict) or not str(sample.get("id") or ""):
            return {"status": 400, "error": "每台样机必须是包含 id 的 JSON 对象"}
        sample_id = str(sample["id"])
        if sample_id in incoming:
            return {"status": 400, "error": "样机载荷中存在重复 id"}
        incoming[sample_id] = sample
    if not incoming:
        return None

    def keys(sample: dict) -> set[str]:
        return {sample_identity_key(field["value"]) for field in sample_identity_fields(sample) if field["value"]}

    checked_ids = {
        sample_id for sample_id, sample in incoming.items()
        if not sample_queries.sample_is_reassembled(sample)
    }
    if not checked_ids:
        return None

    def conflict(sample_id: str, other_id: str, value: str) -> dict:
        return {
            "status": 409, "error_code": "SAMPLE_IDENTITY_CONFLICT",
            "error": "SN、IMEI 或主板 SN 与其他非重组样机重复，请刷新查重结果后重试。",
            "sampleId": sample_id, "conflictSampleId": other_id, "identity": value,
        }

    incoming_by_key: dict[str, str] = {}
    for sample_id, sample in incoming.items():
        if sample_queries.sample_is_reassembled(sample):
            continue
        for key in keys(sample):
            other_id = incoming_by_key.get(key)
            if other_id:
                return conflict(sample_id, other_id, key)
            incoming_by_key[key] = sample_id

    changed_by_key = {key: sample_id for sample_id in checked_ids for key in keys(incoming[sample_id])}
    values = list(changed_by_key)
    for offset in range(0, len(values), 250):
        batch = values[offset:offset + 250]
        placeholders = ",".join("?" for _ in batch)
        rows = conn.execute(
            f"""
            SELECT r.id, r.sn, r.imei, r.board_sn
            FROM sample_records r JOIN sample_categories c ON c.id = r.category_id
            WHERE r.deleted_at IS NULL AND c.deleted_at IS NULL AND COALESCE(r.is_reassembled, 0) = 0
              AND (TRIM(r.sn) COLLATE NOCASE IN ({placeholders})
                   OR TRIM(r.imei) COLLATE NOCASE IN ({placeholders})
                   OR TRIM(r.board_sn) COLLATE NOCASE IN ({placeholders}))
            """,
            [*batch, *batch, *batch],
        ).fetchall()
        for row in rows:
            other_id = str(row["id"])
            if other_id in incoming:
                continue
            for value in (row["sn"], row["imei"], row["board_sn"]):
                key = sample_identity_key(value)
                if key in changed_by_key:
                    return conflict(changed_by_key[key], other_id, key)
    return None


def check_sample_identity_conflicts(conn: sqlite3.Connection, payload: dict) -> dict:
    raw_samples = payload.get("samples")
    if not isinstance(raw_samples, list):
        raw_samples = [payload]
    default_category_id = str(payload.get("categoryId") or payload.get("excludeCategoryId") or "")
    entries: list[dict] = []
    values: list[str] = []
    seen_values: set[str] = set()
    for pos, raw in enumerate(raw_samples):
        if not isinstance(raw, dict):
            continue
        sample = dict(raw)
        sample["_index"] = raw.get("index", pos)
        sample["_categoryId"] = str(raw.get("categoryId") or default_category_id or "")
        sample["_excludeSampleId"] = str(raw.get("excludeSampleId") or "")
        if sample_queries.sample_is_reassembled(sample):
            continue
        for field in sample_identity_fields(sample):
            key = field["value"].lower()
            if not key:
                continue
            entry = {"sample": sample, "field": field, "key": key}
            entries.append(entry)
            if key not in seen_values:
                seen_values.add(key)
                values.append(key)

    results = [{
        "index": raw.get("index", pos) if isinstance(raw, dict) else pos,
        "hasConflict": False,
        "conflict": None,
    } for pos, raw in enumerate(raw_samples)]
    if not entries:
        return {"results": results, "conflicts": [], "count": 0}

    entries_by_key: dict[str, list[dict]] = {}
    for entry in entries:
        entries_by_key.setdefault(entry["key"], []).append(entry)

    conflicts_by_index: dict[object, dict] = {}
    chunk_size = 250
    for start in range(0, len(values), chunk_size):
        chunk = values[start:start + chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        rows = conn.execute(
            f"""
            SELECT r.id, r.category_id, c.name AS category_name,
                   r.sample_no, r.sn, r.imei, r.board_sn, r.is_reassembled,
                   r.status, r.has_problem, r.effective_status, r.location, r.owner, r.borrower, r.data_json
            FROM sample_records r
            JOIN sample_categories c ON c.id = r.category_id
            WHERE r.deleted_at IS NULL
              AND c.deleted_at IS NULL
              AND COALESCE(r.is_reassembled, 0) = 0
              AND (
                r.sn COLLATE NOCASE IN ({placeholders})
                OR r.imei COLLATE NOCASE IN ({placeholders})
                OR r.board_sn COLLATE NOCASE IN ({placeholders})
              )
            ORDER BY c.sort_order, c.id, r.created_at, r.id
            """,
            [*chunk, *chunk, *chunk],
        ).fetchall()
        for row in rows:
            existing = compact_sample_identity_row(row)
            existing_fields = sample_identity_fields(existing)
            for existing_field in existing_fields:
                existing_key = existing_field["value"].lower()
                if not existing_key or existing_key not in entries_by_key:
                    continue
                for entry in entries_by_key[existing_key]:
                    incoming = entry["sample"]
                    index = incoming["_index"]
                    if index in conflicts_by_index:
                        continue
                    if incoming.get("_excludeSampleId") and str(existing["id"]) == incoming["_excludeSampleId"]:
                        continue
                    category_id = str(incoming.get("_categoryId") or "")
                    scope = "category" if category_id and str(existing["categoryId"]) == category_id else "global"
                    conflicts_by_index[index] = {
                        "index": index,
                        "scope": scope,
                        "categoryId": existing["categoryId"],
                        "categoryName": existing["categoryName"],
                        "sample": existing,
                        "conflictId": existing_field["value"],
                        "incomingField": entry["field"]["field"],
                        "incomingLabel": entry["field"]["label"],
                        "existingField": existing_field["field"],
                        "existingLabel": existing_field["label"],
                    }

    for result in results:
        index = result["index"]
        conflict = conflicts_by_index.get(index)
        if conflict:
            result["hasConflict"] = True
            result["conflict"] = conflict

    conflicts = [result["conflict"] for result in results if result.get("conflict")]
    return {"results": results, "conflicts": conflicts, "count": len(conflicts)}
