"""Stable problem/photo links and deletion protection for shared evidence."""
from __future__ import annotations

import json


def problem_photo_ids(records) -> set[str]:
    return {pid for record in (records or []) if isinstance(record, dict)
            for pid in (record.get("photoIds") if isinstance(record.get("photoIds"), list) else [])
            if isinstance(pid, str) and pid}


def references_photo(value, photo_id: str) -> bool:
    if isinstance(value, dict):
        if isinstance(value.get("photoIds"), list) and photo_id in value["photoIds"]:
            return True
        for key in ("photos", "resultPhotos"):
            if isinstance(value.get(key), list) and any(isinstance(ref, dict) and ref.get("id") == photo_id for ref in value[key]):
                return True
        return any(references_photo(child, photo_id) for child in value.values() if isinstance(child, (dict, list)))
    if isinstance(value, list):
        return any(references_photo(child, photo_id) for child in value)
    return False


def photo_reference_reason(conn, sample_id: str, photo_id: str) -> str:
    row = conn.execute("SELECT data_json FROM sample_records WHERE id = ? AND deleted_at IS NULL", (sample_id,)).fetchone()
    if row and references_photo(json.loads(row["data_json"]).get("problemRecords"), photo_id):
        return "图片仍被样机问题引用，请先移除关联并保存。"
    for row in conn.execute("SELECT data_json FROM sample_events WHERE sample_id = ?", (sample_id,)):
        if references_photo(json.loads(row["data_json"]), photo_id):
            return "图片已用于样机历史记录，不能彻底删除；可从当前问题中移除关联。"
    # Removed samples are not in the occupancy index, so include historical result
    # references as well. This scan is only performed for explicit asset deletion.
    for row in conn.execute("SELECT data_json FROM project_tasks WHERE instr(data_json, ?) > 0", (photo_id,)):
        if references_photo(json.loads(row["data_json"]), photo_id):
            return "图片已用于任务结果或草稿，不能彻底删除；可从当前问题中移除关联。"
    return ""


def validate_problem_photos(conn, sample_id: str, records) -> None:
    """Every current problem link must resolve to this sample's live photo."""
    for photo_id in problem_photo_ids(records):
        exists = conn.execute("""SELECT 1 FROM sample_assets
            WHERE id = ? AND sample_id = ? AND kind = 'photo' AND deleted_at IS NULL""", (photo_id, sample_id)).fetchone()
        if not exists:
            raise ValueError("关联图片不存在或不属于当前样机，请重新选择图片。")


def validate_task_problem_photos(conn, task) -> None:
    def entries(value):
        result = {}
        if not isinstance(value, dict):
            return result
        containers = [value.get("resultDraft")] + list(value.get("resultUploads") or [])
        for container in containers:
            if not isinstance(container, dict):
                continue
            for item in container.get("samples") or []:
                if isinstance(item, dict):
                    sid = str(item.get("sampleId") or item.get("sid") or "")
                    result.setdefault(sid, []).extend(item.get("problemRecords") or [])
        return result
    for sid, records in entries(task).items():
        validate_problem_photos(conn, sid, records)
