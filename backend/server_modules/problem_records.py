"""Preserve problem creation timestamps when records are edited or imported."""
from __future__ import annotations

import copy
import json


def preserve_created_at(records, previous) -> None:
    saved = {item["id"]: item for item in (previous or [])
             if isinstance(item, dict) and item.get("id")}
    for item in records or []:
        if not isinstance(item, dict) or item.get("id") not in saved:
            continue
        original = saved[item["id"]]
        if "createdAt" in original:
            item["createdAt"] = copy.deepcopy(original["createdAt"])
        else:
            # Unknown historical dates must not become the date of a later edit.
            item.pop("createdAt", None)


def task_problem_entries(task) -> dict:
    entries = {}
    for container in [task.get("resultDraft"), *(task.get("resultUploads") or [])]:
        if not isinstance(container, dict):
            continue
        for item in container.get("samples") or []:
            if isinstance(item, dict) and item.get("problemRecords"):
                sid = str(item.get("sampleId") or item.get("sid") or "")
                entries.setdefault(sid, []).extend(item["problemRecords"])
    return entries


def preserve_task_created_at(conn, task, previous=None) -> None:
    entries = task_problem_entries(task)
    if not entries:
        return
    if previous is None:
        row = conn.execute("SELECT data_json FROM project_tasks WHERE id=?", (task.get("id"),)).fetchone()
        previous = json.loads(row["data_json"]) if row else {}
    saved = task_problem_entries(previous)
    for sid, records in entries.items():
        row = conn.execute("SELECT data_json FROM sample_records WHERE id=?", (sid,)).fetchone()
        archive = json.loads(row["data_json"]).get("problemRecords", []) if row else []
        preserve_created_at(records, saved.get(sid, []) + archive)
