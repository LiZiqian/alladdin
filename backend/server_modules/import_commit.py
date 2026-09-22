from __future__ import annotations

from contextlib import closing

import copy
import hashlib
import json
from collections import defaultdict
from typing import Callable

from server_modules import sample_constraints, sample_queries, task_reservations


FINISHED_TASK_STATUSES = {"正常完成", "异常终止"}


def stable_json(data: object) -> str:
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def content_hash(data: object) -> str:
    return hashlib.sha256(stable_json(data).encode("utf-8")).hexdigest()[:16]


def apply_import_field_choices(target: dict, incoming: dict, fields, choices: dict) -> None:
    """Apply the exact side selected in preview, including an absent field."""
    for field in fields:
        if choices.get(field, "current") != "incoming":
            continue
        if field in incoming:
            target[field] = copy.deepcopy(incoming[field])
        else:
            target.pop(field, None)


def find_incoming_stage(incoming_projects_by_id: dict, stage_id: str) -> dict | None:
    """在导入数据中查找指定 ID 的 stage"""
    for project in incoming_projects_by_id.values():
        for stage in (project.get("stages") or []):
            if stage.get("id") == stage_id:
                return stage
    return None


def find_incoming_task(incoming_projects_by_id: dict, task_id: str) -> dict | None:
    """在导入数据中查找指定 ID 的 task"""
    for project in incoming_projects_by_id.values():
        for stage in (project.get("stages") or []):
            for task in (stage.get("tasks") or []):
                if task.get("id") == task_id:
                    return task
    return None


def register_imported_stage_tree(stage: dict,
                                 stage_id_map: dict[str, str],
                                 task_id_map: dict[str, str]) -> tuple[int, int, str | None]:
    """Register IDs for an imported full stage subtree."""
    stage_id = str(stage.get("id") or "")
    if stage_id:
        stage_id_map[stage_id] = stage_id
    task_count = 0
    for task in stage.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        task_count += 1
        task_id = str(task.get("id") or "")
        if task_id:
            task_id_map[task_id] = task_id
    return 1, task_count, stage_id or None


def register_imported_project_tree(project: dict,
                                   stage_id_map: dict[str, str],
                                   task_id_map: dict[str, str]) -> tuple[int, int, set[str]]:
    """Register IDs for an imported full project subtree."""
    stage_count = 0
    task_count = 0
    stage_ids: set[str] = set()
    for stage in project.get("stages") or []:
        if not isinstance(stage, dict):
            continue
        added_stage_count, added_task_count, stage_id = register_imported_stage_tree(stage, stage_id_map, task_id_map)
        stage_count += added_stage_count
        task_count += added_task_count
        if stage_id:
            stage_ids.add(stage_id)
    return stage_count, task_count, stage_ids


def remap_log_ids(log: dict,
                  project_id_map: dict,
                  stage_id_map: dict,
                  task_id_map: dict,
                  sample_id_map: dict) -> None:
    """重映射单条日志中的 ID 引用"""
    for field, id_map in [
        ("sampleId", sample_id_map),
        ("sid", sample_id_map),
        ("projectId", project_id_map),
        ("stageId", stage_id_map),
        ("taskId", task_id_map),
    ]:
        old_value = log.get(field)
        if old_value and old_value in id_map:
            log[field] = id_map[old_value]


def apply_id_maps(data: dict,
                  project_id_map: dict,
                  stage_id_map: dict,
                  task_id_map: dict,
                  sample_id_map: dict) -> None:
    """统一重映射所有交叉引用 ID（传入的 data 原地修改）"""
    def remap_records(value):
        if isinstance(value, dict):
            remap_log_ids(value, project_id_map, stage_id_map, task_id_map, sample_id_map)
            for child in value.values():
                if isinstance(child, (dict, list)):
                    remap_records(child)
        elif isinstance(value, list):
            for child in value:
                remap_records(child)

    for project in data.get("projects") or []:
        for stage in project.get("stages") or []:
            stage["projectId"] = project.get("id")
            for task in stage.get("tasks") or []:
                task["projectId"] = project.get("id")
                task["stageId"] = stage.get("id")
                if task.get("sampleIds"):
                    task["sampleIds"] = list(dict.fromkeys(sample_id_map.get(sample_id, sample_id) for sample_id in task["sampleIds"]))
                for key in ("logs", "removedSampleRecords", "sampleFaultRecords", "resultUploads", "resultDraft", "issueRecord"):
                    remap_records(task.get(key))
                snapshots = task.get("sampleSnapshots")
                if isinstance(snapshots, dict):
                    mapped = {}
                    for sid, snapshot in snapshots.items():
                        target_sid = sample_id_map.get(sid, sid)
                        if isinstance(snapshot, dict):
                            snapshot["id"] = target_sid
                            if "sampleId" in snapshot:
                                snapshot["sampleId"] = target_sid
                        mapped.setdefault(target_sid, snapshot)
                    task["sampleSnapshots"] = mapped

    for category in (data.get("sampleLibrary") or {}).get("categories") or []:
        for sample in category.get("samples") or []:
            current_project_id = sample.get("currentProjectId")
            if current_project_id and current_project_id in project_id_map:
                sample["currentProjectId"] = project_id_map[current_project_id]
            current_stage_id = sample.get("currentStageId")
            if current_stage_id and current_stage_id in stage_id_map:
                sample["currentStageId"] = stage_id_map[current_stage_id]
            current_task_id = sample.get("currentTaskId")
            if current_task_id and current_task_id in task_id_map:
                sample["currentTaskId"] = task_id_map[current_task_id]
            for key in ("photos", "files", "logs", "problemRecords"):
                remap_records(sample.get(key))


def detect_import_identity_conflicts(data: dict, affected_ids: set[str] | None = None) -> list[dict]:
    by_key = {}
    conflicts = []
    for category in (data.get("sampleLibrary") or {}).get("categories") or []:
        for sample in category.get("samples") or []:
            sid = str(sample.get("id") or "")
            own_keys = set()
            for item in sample_constraints.sample_identity_fields(sample):
                key = sample_constraints.sample_identity_key(item["value"])
                if not key:
                    continue
                if key in own_keys and (affected_ids is None or sid in affected_ids):
                    conflicts.append({"sampleId": sid, "conflictingSampleId": sid, "identity": item["value"]})
                own_keys.add(key)
            if sample_queries.sample_is_reassembled(sample):
                continue
            for key in own_keys:
                for previous in by_key.get(key, []):
                    if affected_ids is None or sid in affected_ids or previous in affected_ids:
                        conflicts.append({"sampleId": sid, "conflictingSampleId": previous, "identity": key})
                by_key.setdefault(key, []).append(sid)
            if len(conflicts) >= 20:
                return conflicts[:20]
    return conflicts


def preserve_existing_import_events(conn, data: dict) -> int:
    """Append colliding external events without overwriting local audit history."""
    library = data.get("sampleLibrary") or {}
    logs = library.get("logs") or []
    if not library.get("eventsExternalized"):
        return len(logs)
    event_ids = sorted({str(log.get("id") or "") for log in logs if isinstance(log, dict)} - {""})
    by_id = dict.fromkeys(event_ids)
    for offset in range(0, len(event_ids), 400):
        batch = event_ids[offset:offset + 400]
        placeholders = ",".join("?" for _ in batch)
        for row in conn.execute(f"SELECT id, data_json FROM sample_events WHERE id IN ({placeholders})", batch):
            by_id[row["id"]] = json.loads(row["data_json"])
    appended = []
    for raw in logs:
        if not isinstance(raw, dict):
            continue
        log = copy.deepcopy(raw)
        original_id = str(log.get("id") or "")
        derived_id = f"event_import_{content_hash(log)}"
        candidate = original_id or derived_id
        suffix = 0
        while True:
            log["id"] = candidate
            if candidate not in by_id:
                row = conn.execute("SELECT data_json FROM sample_events WHERE id = ?", (candidate,)).fetchone()
                by_id[candidate] = json.loads(row["data_json"]) if row else None
            existing = by_id[candidate]
            if existing is None:
                by_id[candidate] = log
                appended.append(log)
                break
            if stable_json(existing) == stable_json(log):
                break
            candidate = derived_id if suffix == 0 else f"{derived_id}_{suffix}"
            suffix += 1
    library["logs"] = appended
    return len(appended)


def validate_import_commit_state(data: dict, project_ids: set[str]) -> list[str]:
    """Validate imported project subtrees before writing them to storage."""
    if not project_ids:
        return []
    target_project_ids = {str(project_id) for project_id in project_ids if project_id}
    sample_ids = {
        str(sample.get("id"))
        for category in (data.get("sampleLibrary") or {}).get("categories") or []
        for sample in (category.get("samples") or [])
        if isinstance(sample, dict) and sample.get("id")
    }
    errors: list[str] = []

    for project in data.get("projects") or []:
        if not isinstance(project, dict):
            continue
        project_id = str(project.get("id") or "")
        if project_id not in target_project_ids:
            continue
        seen_stage_ids: set[str] = set()
        for stage in project.get("stages") or []:
            if not isinstance(stage, dict):
                continue
            stage_id = str(stage.get("id") or "")
            if stage_id:
                if stage_id in seen_stage_ids:
                    errors.append(f"项目 {project_id} 内阶段 ID 重复: {stage_id}")
                seen_stage_ids.add(stage_id)
            seen_task_ids: set[str] = set()
            for task in stage.get("tasks") or []:
                if not isinstance(task, dict):
                    continue
                task_id = str(task.get("id") or "")
                if task_id:
                    if task_id in seen_task_ids:
                        errors.append(f"阶段 {stage_id or '(无ID)'} 内任务 ID 重复: {task_id}")
                    seen_task_ids.add(task_id)
                for sample_id in task.get("sampleIds") or []:
                    sid = str(sample_id or "")
                    if sid and sid not in sample_ids:
                        errors.append(f"任务 {task_id or '(无ID)'} 引用不存在的样机: {sid}")
                if len(errors) >= 20:
                    return errors
    return errors


def sample_index_by_id(data: dict) -> dict[str, dict]:
    samples: dict[str, dict] = {}
    for category in (data.get("sampleLibrary") or {}).get("categories") or []:
        for sample in category.get("samples") or []:
            if isinstance(sample, dict) and sample.get("id"):
                samples[str(sample.get("id"))] = sample
    return samples


def rewrite_import_photo_references(data: dict, *, url_for_asset: Callable, thumbnail_asset_id: Callable) -> None:
    """Resolve result/history photo references against the committed asset owners."""
    photos = {}
    for sid, sample in sample_index_by_id(data).items():
        for photo in sample.get("photos") or []:
            pid = str(photo.get("id") or "")
            if not pid:
                continue
            thumb_path = photo.get("thumbRelativePath") or ""
            thumb_url = url_for_asset(sid, photo.get("thumbId") or thumbnail_asset_id(pid)) if thumb_path else ""
            photos[pid] = {"url": url_for_asset(sid, pid), "relativePath": photo.get("relativePath") or "",
                           "thumbRelativePath": thumb_path, "thumbUrl": thumb_url}

    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in ("photos", "resultPhotos") and isinstance(child, list):
                    for ref in child:
                        if not isinstance(ref, dict):
                            continue
                        canonical = photos.get(str(ref.get("id") or ""))
                        if canonical:
                            for field, replacement in canonical.items():
                                if field in ref:
                                    ref[field] = replacement
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(data.get("projects") or [])
    visit((data.get("sampleLibrary") or {}).get("logs") or [])


def merge_import_sample_subrecords(current_data: dict,
                                   incoming: dict,
                                   sample_id_map: dict[str, str]) -> tuple[int, int]:
    """Merge photo metadata and problem records for imported or mapped samples."""
    current_samples = sample_index_by_id(current_data)
    incoming_samples = sample_index_by_id(incoming)
    photos_added = 0
    problems_added = 0

    for incoming_sample_id, target_sample_id in sample_id_map.items():
        incoming_sample = incoming_samples.get(incoming_sample_id)
        target_sample = current_samples.get(target_sample_id)
        if not incoming_sample or not target_sample:
            continue

        existing_photo_ids = {
            str(photo.get("id"))
            for photo in (target_sample.get("photos") or [])
            if isinstance(photo, dict) and photo.get("id")
        }
        existing_photo_hashes = {
            content_hash(photo)
            for photo in (target_sample.get("photos") or [])
            if isinstance(photo, dict)
        }
        for photo in incoming_sample.get("photos") or []:
            if not isinstance(photo, dict):
                continue
            photo_id = str(photo.get("id") or "")
            photo_hash = content_hash(photo)
            if (photo_id and photo_id in existing_photo_ids) or photo_hash in existing_photo_hashes:
                continue
            target_sample.setdefault("photos", []).append(copy.deepcopy(photo))
            if photo_id:
                existing_photo_ids.add(photo_id)
            existing_photo_hashes.add(photo_hash)
            photos_added += 1

        existing_files = {item["id"] for item in target_sample.get("files") or []}
        for item in incoming_sample.get("files") or []:
            if item["id"] not in existing_files:
                target_sample.setdefault("files", []).append(copy.deepcopy(item))
                existing_files.add(item["id"])

        existing_problem_hashes = {
            content_hash(record)
            for record in (target_sample.get("problemRecords") or [])
            if isinstance(record, dict)
        }
        for record in incoming_sample.get("problemRecords") or []:
            if not isinstance(record, dict):
                continue
            # The same problem can acquire additional evidence on either copy.
            # Merge links by stable problem identity instead of duplicating rows.
            matching = next((old for old in target_sample.get("problemRecords") or []
                             if isinstance(old, dict) and record.get("id") and old.get("id") == record["id"]
                             and all(old.get(key, "") == record.get(key, "") for key in ("description", "source", "taskLabel"))), None)
            if matching is not None:
                if "photoIds" in matching or "photoIds" in record:
                    matching["photoIds"] = list(dict.fromkeys([*(matching.get("photoIds") or []), *(record.get("photoIds") or [])]))
                continue
            record_hash = content_hash(record)
            if record_hash in existing_problem_hashes:
                continue
            target_sample.setdefault("problemRecords", []).append(copy.deepcopy(record))
            existing_problem_hashes.add(record_hash)
            problems_added += 1

    return photos_added, problems_added


def hydrate_import_target_photos(current_data: dict,
                                 incoming: dict,
                                 sample_id_map: dict[str, str],
                                 existing_sample_ids: set[str],
                                 *,
                                 connect_db: Callable,
                                 begin_read_snapshot: Callable,
                                 load_sample_photos: Callable) -> None:
    """Load current photos only for existing samples that will receive imported photos."""
    incoming_samples = sample_index_by_id(incoming)
    target_ids: set[str] = set()
    for incoming_sample_id, target_sample_id in sample_id_map.items():
        if str(target_sample_id) not in existing_sample_ids:
            continue
        incoming_sample = incoming_samples.get(str(incoming_sample_id))
        if incoming_sample and any(isinstance(photo, dict) for photo in (incoming_sample.get("photos") or [])):
            target_ids.add(str(target_sample_id))
    if not target_ids:
        return

    current_samples = sample_index_by_id(current_data)
    with closing(connect_db()) as conn:
        began = begin_read_snapshot(conn)
        try:
            for target_sample_id in sorted(target_ids):
                sample = current_samples.get(target_sample_id)
                if not sample or sample.get("photosLoaded") is True:
                    continue
                photos = load_sample_photos(conn, target_sample_id)
                sample["photos"] = photos
                sample["photoCount"] = len(photos)
                sample["photosLoaded"] = True
        finally:
            if began and getattr(conn, "in_transaction", False):
                conn.execute("COMMIT")


def merge_import_sample_events(current_data: dict,
                               incoming: dict,
                               project_id_map: dict[str, str],
                               stage_id_map: dict[str, str],
                               task_id_map: dict[str, str],
                               sample_id_map: dict[str, str]) -> int:
    """Merge library-level sample events after import ID maps are known."""
    library = current_data.setdefault("sampleLibrary", {})
    logs = library.get("logs")
    if not isinstance(logs, list):
        logs = []
        library["logs"] = logs

    target_sample_ids = set(sample_index_by_id(current_data).keys())
    existing_hashes = {
        content_hash(log)
        for log in logs
        if isinstance(log, dict)
    }
    added = 0

    for raw in (incoming.get("sampleLibrary") or {}).get("logs") or []:
        if not isinstance(raw, dict):
            continue
        incoming_sample_id = str(raw.get("sampleId") or "")
        if incoming_sample_id and incoming_sample_id not in sample_id_map:
            continue

        log = copy.deepcopy(raw)
        remap_log_ids(log, project_id_map, stage_id_map, task_id_map, sample_id_map)
        target_sample_id = str(log.get("sampleId") or "")
        if target_sample_id and target_sample_id not in target_sample_ids:
            continue

        event_hash = content_hash(log)
        if event_hash in existing_hashes:
            continue
        logs.append(log)
        existing_hashes.add(event_hash)
        added += 1

    return added


def merge_project_sub_data(target: dict, source: dict) -> None:
    """将 source 项目的阶段/任务追加合并到 target 项目（不覆盖主字段）"""
    target_stages = {stage["id"]: stage for stage in (target.get("stages") or [])}
    for stage in source.get("stages") or []:
        stage_id = stage.get("id", "")
        if stage_id and stage_id in target_stages:
            target_tasks = {task["id"]: task for task in (target_stages[stage_id].get("tasks") or [])}
            for task in stage.get("tasks") or []:
                task_id = task.get("id", "")
                if task_id and task_id not in target_tasks:
                    target_stages[stage_id].setdefault("tasks", []).append(copy.deepcopy(task))
        else:
            target.setdefault("stages", []).append(copy.deepcopy(stage))

    existing_members = {(member.get("employeeNo"), member.get("name")) for member in (target.get("members") or [])}
    for member in source.get("members") or []:
        key = (member.get("employeeNo"), member.get("name"))
        if key not in existing_members:
            target.setdefault("members", []).append(copy.deepcopy(member))
            existing_members.add(key)

    existing_locations = set(target.get("locations") or [])
    for location in source.get("locations") or []:
        if location not in existing_locations:
            target.setdefault("locations", []).append(location)
            existing_locations.add(location)


def detect_sample_occupancy_conflicts(data: dict) -> list[dict]:
    """Apply the same reservation/execution rules as interactive task writes."""
    if not isinstance(data, dict):
        return []
    occupancy: dict[str, list[dict]] = defaultdict(list)
    for project in data.get("projects", []) or []:
        if not isinstance(project, dict):
            continue
        for stage in project.get("stages", []) or []:
            if not isinstance(stage, dict):
                continue
            for task in stage.get("tasks", []) or []:
                if not isinstance(task, dict):
                    continue
                if not task_reservations.is_open(task):
                    continue
                sample_ids = task.get("sampleIds") or []
                if not isinstance(sample_ids, list):
                    continue
                for sample_id in set(map(str, sample_ids)):
                    sample_id = str(sample_id)
                    if not sample_id:
                        continue
                    occupancy[sample_id].append(task_reservations.task_reference(task, project.get("id"), stage.get("id")))
    conflicts = []
    for sample_id, tasks in occupancy.items():
        conflicting = set()
        for index, task in enumerate(tasks):
            for other_index in range(index + 1, len(tasks)):
                if task_reservations.conflict_reason(task, tasks[other_index]):
                    conflicting.update((index, other_index))
        if conflicting:
            conflicts.append({"sampleId": sample_id, "tasks": [tasks[index] for index in sorted(conflicting)]})
    return conflicts
