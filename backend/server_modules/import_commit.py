from __future__ import annotations

import copy
import hashlib
import json
from collections import defaultdict
from typing import Callable

from server_modules import sample_constraints, sample_queries


FINISHED_TASK_STATUSES = {"正常完成", "异常终止"}


def stable_json(data: object) -> str:
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def content_hash(data: object) -> str:
    return hashlib.sha256(stable_json(data).encode("utf-8")).hexdigest()[:16]


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
    for project in data.get("projects") or []:
        for stage in project.get("stages") or []:
            for task in stage.get("tasks") or []:
                if task.get("sampleIds"):
                    task["sampleIds"] = [sample_id_map.get(sample_id, sample_id) for sample_id in task["sampleIds"]]
                for log in task.get("logs") or []:
                    remap_log_ids(log, project_id_map, stage_id_map, task_id_map, sample_id_map)
                for record in task.get("removedSampleRecords") or []:
                    old_sample_id = record.get("sampleId")
                    if old_sample_id and old_sample_id in sample_id_map:
                        record["sampleId"] = sample_id_map[old_sample_id]
                for record in task.get("sampleFaultRecords") or []:
                    old_sample_id = record.get("sampleId")
                    if old_sample_id and old_sample_id in sample_id_map:
                        record["sampleId"] = sample_id_map[old_sample_id]
                for upload in task.get("resultUploads") or []:
                    if not isinstance(upload, dict):
                        continue
                    for sample_ref in upload.get("samples") or []:
                        if not isinstance(sample_ref, dict):
                            continue
                        old_sample_id = sample_ref.get("sampleId")
                        if old_sample_id and old_sample_id in sample_id_map:
                            sample_ref["sampleId"] = sample_id_map[old_sample_id]

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


def remap_import_photo_contexts(
    data: dict,
    project_id_map: dict[str, str],
    stage_id_map: dict[str, str],
    task_id_map: dict[str, str],
) -> None:
    """Remap portable asset ownership, failing closed for skipped scopes."""
    for category in (data.get("sampleLibrary") or {}).get("categories") or []:
        if not isinstance(category, dict):
            continue
        for sample in category.get("samples") or []:
            if not isinstance(sample, dict):
                continue
            for photo in sample.get("photos") or []:
                if not isinstance(photo, dict):
                    continue
                project_id = str(photo.get("projectId") or "")
                stage_id = str(photo.get("stageId") or "")
                task_id = str(photo.get("taskId") or "")
                if project_id == "__restricted__":
                    photo.update({"projectId": "__restricted__", "stageId": "", "taskId": ""})
                    continue
                if not any((project_id, stage_id, task_id)):
                    continue
                if (
                    not project_id
                    or project_id not in project_id_map
                    or (stage_id and stage_id not in stage_id_map)
                    or (task_id and task_id not in task_id_map)
                ):
                    photo.update({"projectId": "__restricted__", "stageId": "", "taskId": ""})
                    continue
                photo.update({
                    "projectId": project_id_map[project_id],
                    "stageId": stage_id_map.get(stage_id, "") if stage_id else "",
                    "taskId": task_id_map.get(task_id, "") if task_id else "",
                })


def validate_import_commit_state(data: dict, project_ids: set[str]) -> list[str]:
    """Validate imported project subtrees before writing them to storage."""
    target_project_ids = {str(project_id) for project_id in project_ids if project_id}
    errors: list[str] = []
    sample_ids: set[str] = set()
    seen_photo_owners: dict[str, str] = {}
    for category in (data.get("sampleLibrary") or {}).get("categories") or []:
        if not isinstance(category, dict):
            continue
        category_id = str(category.get("id") or "")
        for sample in category.get("samples") or []:
            if not isinstance(sample, dict):
                continue
            sample_id = str(sample.get("id") or "")
            if sample_id:
                if sample_id in sample_ids:
                    errors.append(f"样机 ID 重复: {sample_id}")
                sample_ids.add(sample_id)
            for photo in sample.get("photos") or []:
                if not isinstance(photo, dict):
                    continue
                photo_id = str(photo.get("id") or "")
                if not photo_id:
                    errors.append(f"样机 {sample_id or '(无ID)'} 包含缺少 ID 的照片")
                    continue
                previous_owner = seen_photo_owners.get(photo_id)
                if previous_owner is not None:
                    errors.append(f"照片 ID {photo_id} 重复，涉及样机 {previous_owner} 和 {sample_id}")
                else:
                    seen_photo_owners[photo_id] = sample_id

    seen_event_ids: set[str] = set()
    for event in (data.get("sampleLibrary") or {}).get("logs") or []:
        if not isinstance(event, dict):
            continue
        event_id = str(event.get("id") or "")
        if event_id and event_id in seen_event_ids:
            errors.append(f"样机事件 ID 重复: {event_id}")
        if event_id:
            seen_event_ids.add(event_id)

    seen_stage_owners: dict[str, str] = {}
    seen_task_owners: dict[str, tuple[str, str]] = {}
    seen_task_log_owners: dict[str, str] = {}
    for project in data.get("projects") or []:
        if not isinstance(project, dict):
            continue
        project_id = str(project.get("id") or "")
        seen_stage_ids: set[str] = set()
        for stage in project.get("stages") or []:
            if not isinstance(stage, dict):
                continue
            stage_id = str(stage.get("id") or "")
            if stage_id:
                if stage_id in seen_stage_ids:
                    errors.append(f"项目 {project_id} 内阶段 ID 重复: {stage_id}")
                seen_stage_ids.add(stage_id)
                previous_project_id = seen_stage_owners.get(stage_id)
                if previous_project_id and previous_project_id != project_id:
                    errors.append(f"阶段 ID {stage_id} 同时属于项目 {previous_project_id} 和 {project_id}")
                else:
                    seen_stage_owners[stage_id] = project_id
            seen_task_ids: set[str] = set()
            for task in stage.get("tasks") or []:
                if not isinstance(task, dict):
                    continue
                task_id = str(task.get("id") or "")
                if task_id:
                    if task_id in seen_task_ids:
                        errors.append(f"阶段 {stage_id or '(无ID)'} 内任务 ID 重复: {task_id}")
                    seen_task_ids.add(task_id)
                    previous_owner = seen_task_owners.get(task_id)
                    if previous_owner and previous_owner != (project_id, stage_id):
                        errors.append(f"任务 ID {task_id} 同时属于阶段 {previous_owner[1]} 和 {stage_id}")
                    else:
                        seen_task_owners[task_id] = (project_id, stage_id)
                if project_id in target_project_ids:
                    for sample_id in task.get("sampleIds") or []:
                        sid = str(sample_id or "")
                        if sid and sid not in sample_ids:
                            errors.append(f"任务 {task_id or '(无ID)'} 引用不存在的样机: {sid}")
                for log in task.get("logs") or []:
                    if not isinstance(log, dict):
                        continue
                    log_id = str(log.get("id") or "")
                    if not log_id:
                        continue
                    previous_task_id = seen_task_log_owners.get(log_id)
                    if previous_task_id and previous_task_id != task_id:
                        errors.append(f"任务日志 ID {log_id} 同时属于任务 {previous_task_id} 和 {task_id}")
                    else:
                        seen_task_log_owners[log_id] = task_id
                if len(errors) >= 20:
                    return errors
    return errors


def validate_touched_sample_identities(data: dict, touched_sample_ids: set[str]) -> list[str]:
    """Reject new non-reassembled identity duplicates without blocking unrelated legacy rows."""
    touched = {str(value) for value in touched_sample_ids if str(value or "").strip()}
    if not touched:
        return []
    identity_owners: dict[str, tuple[str, str]] = {}
    errors: list[str] = []
    for category in (data.get("sampleLibrary") or {}).get("categories") or []:
        for sample in category.get("samples") or []:
            if not isinstance(sample, dict) or sample_queries.sample_is_reassembled(sample):
                continue
            sample_id = str(sample.get("id") or "")
            fields = sample_constraints.sample_identity_fields(sample)
            seen_values: set[str] = set()
            for field in fields:
                value = str(field.get("value") or "").strip()
                key = value.lower()
                if not key:
                    continue
                if key in seen_values:
                    if sample_id in touched:
                        errors.append(
                            f"样机 {sample_id} 的 SN/IMEI/主板SN 不能使用相同值: {value}"
                        )
                        if len(errors) >= 20:
                            return errors
                    continue
                seen_values.add(key)
                previous = identity_owners.get(key)
                if previous and previous[0] != sample_id and (sample_id in touched or previous[0] in touched):
                    errors.append(
                        f"样机身份标识重复: {field.get('label') or field.get('field')}={value} "
                        f"同时属于 {previous[0]} 和 {sample_id}"
                    )
                    if len(errors) >= 20:
                        return errors
                else:
                    identity_owners[key] = (sample_id, str(field.get("field") or ""))
    return errors


def sample_index_by_id(data: dict) -> dict[str, dict]:
    samples: dict[str, dict] = {}
    for category in (data.get("sampleLibrary") or {}).get("categories") or []:
        for sample in category.get("samples") or []:
            if isinstance(sample, dict) and sample.get("id"):
                samples[str(sample.get("id"))] = sample
    return samples


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

        existing_problem_hashes = {
            content_hash(record)
            for record in (target_sample.get("problemRecords") or [])
            if isinstance(record, dict)
        }
        for record in incoming_sample.get("problemRecords") or []:
            if not isinstance(record, dict):
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
    with connect_db() as conn:
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
    existing_ids = {
        str(log.get("id"))
        for log in logs
        if isinstance(log, dict) and log.get("id")
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

        event_id = str(log.get("id") or "")
        event_hash = content_hash(log)
        if (event_id and event_id in existing_ids) or event_hash in existing_hashes:
            continue
        logs.append(log)
        if event_id:
            existing_ids.add(event_id)
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
    """C1：检测同一样机被多个未完成任务占用的冲突。"""
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
                if task.get("archived") or task.get("completed"):
                    continue
                status = str(task.get("status") or "").strip()
                if status in FINISHED_TASK_STATUSES:
                    continue
                sample_ids = task.get("sampleIds") or []
                if not isinstance(sample_ids, list):
                    continue
                for sample_id in sample_ids:
                    sample_id = str(sample_id)
                    if not sample_id:
                        continue
                    occupancy[sample_id].append({
                        "taskId": str(task.get("id") or ""),
                        "projectId": str(project.get("id") or ""),
                        "stageId": str(stage.get("id") or ""),
                        "testItem": str(task.get("testItem") or ""),
                        "status": status,
                    })
    conflicts = []
    for sample_id, tasks in occupancy.items():
        if len(tasks) > 1:
            conflicts.append({"sampleId": sample_id, "tasks": tasks})
    return conflicts
