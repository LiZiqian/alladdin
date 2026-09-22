from __future__ import annotations

import copy
import json
from pathlib import Path

from server_modules import chamber_package, sample_queries, task_reservations


IMPORT_DIFF_SYSTEM_SKIP_KEYS = {
    "categoryId",
    "photoCount",
    "photosLoaded",
    "eventsLoaded",
    "effectiveStatus",
    "logsLoaded",
}


def stable_json(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def entity_label_for_conflict(entity: str, item: dict) -> str:
    """生成冲突项的人类可读标签"""
    if entity == "project":
        return f"{item.get('name', '')} ({item.get('code', '')})"
    if entity == "stage":
        return item.get("name", "")
    if entity == "task":
        return f"{item.get('category', '')} - {item.get('testItem', '')}"
    if entity == "sample":
        parts = [s for s in [item.get("sn"), item.get("imei"), item.get("sampleNo")] if s]
        return " / ".join(parts) if parts else item.get("id", "")
    return item.get("id", "")


def strip_view_state(data: dict) -> dict:
    """移除导出数据中的 UI 状态字段"""
    clean = copy.deepcopy(data)
    clean.pop("currentProjectId", None)
    clean.pop("currentStageId", None)
    return clean


def diff_fields(current_item: dict, incoming_item: dict, skip_keys: set | None = None) -> set:
    """返回两个字典中有差异的字段名集合（排除 skip_keys）"""
    diffs = set()
    ignored = set(skip_keys or set()) | IMPORT_DIFF_SYSTEM_SKIP_KEYS
    all_keys = set(current_item.keys()) | set(incoming_item.keys())
    for key in all_keys:
        if key in ignored or key.startswith("_"):
            continue
        current_value = current_item.get(key)
        incoming_value = incoming_item.get(key)
        if stable_json(current_value) != stable_json(incoming_value):
            diffs.add(key)
    return diffs


def conflict_identity(conflict: dict) -> tuple:
    """Identify a conflict independently of its position in the preview list."""
    return tuple(str(conflict.get(key) or "") for key in (
        "type", "entity", "currentId", "incomingId", "sampleId", "currentTaskId", "incomingTaskId",
    ))


def retain_preview_conflict_ids(result: dict, preview: dict) -> None:
    # A selected subset can remove earlier conflicts. Never let its new sequence
    # numbers apply a decision that the user made for a different record.
    original_ids = {conflict_identity(item): item["conflictId"] for item in preview.get("conflicts") or []}
    for item in result.get("conflicts") or []:
        original_id = original_ids.get(conflict_identity(item))
        if original_id is None:
            raise ValueError("导入范围的冲突已变化，请重新选择文件预览")
        item["conflictId"] = original_id


def diff_import_bundle(current: dict, incoming: dict, manifest: dict, tmp_path: Path, *, asset_index: dict) -> dict:
    """对比主库与导入数据，生成 autoApply / conflicts / blockers"""
    auto_apply: list[dict] = []
    conflicts: list[dict] = []
    conflict_idx = [0]

    def next_conflict_id():
        conflict_idx[0] += 1
        return f"conflict_{conflict_idx[0]:04d}"

    curr_projects = {p["id"]: p for p in (current.get("projects") or [])}
    curr_project_codes = {p.get("code", ""): p for p in (current.get("projects") or []) if p.get("code")}
    curr_project_names = {p.get("name", "").strip().lower(): p for p in (current.get("projects") or []) if p.get("name")}

    curr_samples: list[dict] = []
    for cat in (current.get("sampleLibrary") or {}).get("categories") or []:
        for sample in cat.get("samples") or []:
            sample_copy = dict(sample)
            sample_copy["_categoryName"] = cat.get("name", "")
            curr_samples.append(sample_copy)
    curr_samples_by_id = {s["id"]: s for s in curr_samples}
    curr_samples_by_identity = {}
    for sample in curr_samples:
        sn = (sample.get("sn") or "").strip()
        imei = (sample.get("imei") or "").strip()
        board_sn = (sample.get("boardSn") or "").strip()
        sample_no = (sample.get("sampleNo") or "").strip()
        for value in {sn.lower(), imei.lower(), board_sn.lower()} - {""}:
            curr_samples_by_identity.setdefault(value, []).append(sample)

    missing_photo_assets: list[str] = []
    corrupt_photo_assets: list[str] = []
    asset_lookup = chamber_package.sample_photo_asset_lookup(asset_index)
    incoming_sample_ids_for_assets = {
        str(sample.get("id") or "")
        for cat in (incoming.get("sampleLibrary") or {}).get("categories") or []
        for sample in (cat.get("samples") or [])
        if isinstance(sample, dict) and sample.get("id")
    }

    def asset_path_from_index(asset: dict | None) -> Path | None:
        if not asset:
            return None
        zip_path = str(asset.get("zipPath") or "")
        return chamber_package.safe_package_member_path(tmp_path, zip_path)

    checked_manifest_assets: set[tuple[str, str, str]] = set()
    for cat in (incoming.get("sampleLibrary") or {}).get("categories") or []:
        for sample in cat.get("samples") or []:
            sample_id = sample.get("id", "")
            for photo in [*(sample.get("photos") or []), *(sample.get("files") or [])]:
                photo_id = photo.get("id", "")
                rel = photo.get("relativePath", "")
                if rel:
                    key = (str(sample_id), str(photo_id), "original")
                    asset = asset_lookup.get(key)
                    checked_manifest_assets.add(key)
                    asset_path = asset_path_from_index(asset)
                    if asset_path is None or not asset_path.is_file():
                        missing_photo_assets.append(photo_id)
                    elif asset and asset.get("sha256"):
                        actual_hash = chamber_package.sha256_file(asset_path)
                        if actual_hash != str(asset.get("sha256") or ""):
                            corrupt_photo_assets.append(photo_id)
                thumb_rel = photo.get("thumbRelativePath", "")
                if thumb_rel:
                    key = (str(sample_id), str(photo_id), "thumbnail")
                    asset = asset_lookup.get(key)
                    checked_manifest_assets.add(key)
                    asset_path = asset_path_from_index(asset)
                    if asset_path is None or not asset_path.is_file():
                        missing_photo_assets.append(f"{photo_id}::thumbnail")
                    elif asset.get("sha256"):
                        actual_hash = chamber_package.sha256_file(asset_path)
                        if actual_hash != str(asset.get("sha256") or ""):
                            corrupt_photo_assets.append(f"{photo_id}::thumbnail")

    for key, asset in asset_lookup.items():
        if key[0] not in incoming_sample_ids_for_assets:
            continue
        if key in checked_manifest_assets or not asset.get("exists"):
            continue
        asset_path = asset_path_from_index(asset)
        asset_id = str(asset.get("metadataId") or asset.get("assetId") or "")
        if not asset_path or not asset_path.is_file():
            missing_photo_assets.append(asset_id)
        elif asset.get("sha256") and chamber_package.sha256_file(asset_path) != str(asset.get("sha256") or ""):
            corrupt_photo_assets.append(asset_id)

    blockers = []
    if missing_photo_assets:
        blockers.append({
            "type": "missing_photos",
            "assetIds": missing_photo_assets[:20],
            "count": len(missing_photo_assets),
        })
    if corrupt_photo_assets:
        blockers.append({
            "type": "asset_integrity_mismatch",
            "assetIds": corrupt_photo_assets[:20],
            "count": len(corrupt_photo_assets),
        })

    for project in incoming.get("projects") or []:
        project_id = project.get("id", "")
        project_name = (project.get("name") or "").strip()
        project_code = (project.get("code") or "").strip()

        if project_id and project_id in curr_projects:
            current_project = curr_projects[project_id]
            field_diffs = diff_fields(current_project, project, skip_keys={"stages", "tasks"})
            if field_diffs:
                conflicts.append({
                    "conflictId": next_conflict_id(),
                    "type": "field_conflict",
                    "entity": "project",
                    "currentId": project_id,
                    "incomingId": project_id,
                    "label": entity_label_for_conflict("project", project),
                    "current": {key: current_project.get(key) for key in field_diffs},
                    "incoming": {key: project.get(key) for key in field_diffs},
                    "diffFields": list(field_diffs),
                    "allowedActions": ["apply_field_choices"],
                })
            diff_stages(current_project, project, project_id, project_id, next_conflict_id, conflicts, auto_apply)
            continue

        if project_code and project_code in curr_project_codes:
            current_project = curr_project_codes[project_code]
            conflicts.append({
                "conflictId": next_conflict_id(),
                "type": "project_name_conflict",
                "entity": "project",
                "currentId": current_project["id"],
                "incomingId": project_id,
                "label": f"{project_name} (code: {project_code})",
                "current": {"name": current_project.get("name"), "code": current_project.get("code")},
                "incoming": {"name": project_name, "code": project_code},
                "allowedActions": ["merge_into_existing", "rename_import", "skip"],
                "preferredMergeTarget": current_project["id"],
            })
            continue

        if project_name and project_name.lower() in curr_project_names:
            current_project = curr_project_names[project_name.lower()]
            conflicts.append({
                "conflictId": next_conflict_id(),
                "type": "project_name_conflict",
                "entity": "project",
                "currentId": current_project["id"],
                "incomingId": project_id,
                "label": project_name,
                "current": {"name": current_project.get("name"), "code": current_project.get("code")},
                "incoming": {"name": project_name, "code": project_code},
                "allowedActions": ["merge_into_existing", "rename_import", "skip"],
                "preferredMergeTarget": current_project["id"],
            })
            continue

        auto_apply.append({"type": "new_project", "id": project_id, "name": project_name, "label": project_name})
        for stage in project.get("stages") or []:
            auto_apply.append({"type": "new_stage", "id": stage.get("id"), "name": stage.get("name", ""), "projectId": project_id})
            for task in stage.get("tasks") or []:
                auto_apply.append({
                    "type": "new_task",
                    "id": task.get("id"),
                    "label": f"{task.get('category','')}-{task.get('testItem','')}",
                    "projectId": project_id,
                    "stageId": stage.get("id"),
                })

    def blocking_sample_identity_match(index: dict, value: str, incoming_sample: dict, incoming_id: str) -> dict | None:
        if not value:
            return None
        for current_sample in index.get(value.lower(), []) or []:
            if current_sample.get("id") == incoming_id:
                continue
            if sample_queries.sample_is_reassembled(incoming_sample) or sample_queries.sample_is_reassembled(current_sample):
                continue
            return current_sample
        return None

    def append_sample_identity_conflict(current_sample: dict, sample: dict, sample_id: str, match_by: str, label: str) -> None:
        mergeable = ["location", "owner", "status", "borrower", "sourceStageName", "sourceSkuName"]
        conflicts.append({
            "conflictId": next_conflict_id(),
            "type": "sample_identity_conflict",
            "entity": "sample",
            "currentId": current_sample["id"],
            "incomingId": sample_id,
            "matchBy": match_by,
            "label": label,
            "current": {key: current_sample.get(key) for key in mergeable if current_sample.get(key) != sample.get(key)},
            "incoming": {key: sample.get(key) for key in mergeable if current_sample.get(key) != sample.get(key)},
            "allowedActions": ["merge_into_existing", "import_as_new_with_identity_edit", "skip"],
            "mergeableFields": mergeable,
            "autoMergeSubData": ["photos", "files", "problemRecords"],
            "preferredMergeTarget": current_sample["id"],
        })

    for cat in (incoming.get("sampleLibrary") or {}).get("categories") or []:
        category_name = cat.get("name", "")
        for sample in cat.get("samples") or []:
            sample_id = sample.get("id", "")
            sn = (sample.get("sn") or "").strip()
            imei = (sample.get("imei") or "").strip()
            board_sn = (sample.get("boardSn") or "").strip()

            if sample_id and sample_id in curr_samples_by_id:
                current_sample = curr_samples_by_id[sample_id]
                field_diffs = diff_fields(current_sample, sample, skip_keys={"photos", "files", "logs", "problemRecords", "_categoryName"})
                if field_diffs:
                    conflicts.append({
                        "conflictId": next_conflict_id(),
                        "type": "field_conflict",
                        "entity": "sample",
                        "currentId": sample_id,
                        "incomingId": sample_id,
                        "label": entity_label_for_conflict("sample", sample),
                        "current": {key: current_sample.get(key) for key in field_diffs},
                        "incoming": {key: sample.get(key) for key in field_diffs},
                        "diffFields": list(field_diffs),
                        "allowedActions": ["apply_field_choices"],
                        "mergeableFields": list(field_diffs),
                    })
                continue

            identity_checks = [
                ("sn", sn, f"SN: {sn}", curr_samples_by_identity),
                ("imei", imei, f"IMEI: {imei}", curr_samples_by_identity),
                ("boardSn", board_sn, f"主板SN: {board_sn}", curr_samples_by_identity),
            ]
            identity_conflicted = False
            for match_by, value, label, index in identity_checks:
                current_sample = blocking_sample_identity_match(index, value, sample, sample_id)
                if current_sample:
                    append_sample_identity_conflict(current_sample, sample, sample_id, match_by, label)
                    identity_conflicted = True
                    break
            if identity_conflicted:
                continue

            auto_apply.append({
                "type": "new_sample",
                "id": sample_id,
                "sn": sn,
                "label": entity_label_for_conflict("sample", sample),
                "categoryName": category_name,
            })

    identity_targets = {item["incomingId"]: item["currentId"] for item in conflicts
                        if item["type"] == "sample_identity_conflict"}
    current_reservations: dict[str, list[dict]] = {}
    for project in current.get("projects") or []:
        for stage in project.get("stages") or []:
            for task in stage.get("tasks") or []:
                if task_reservations.is_open(task):
                    for sample_id in set(task.get("sampleIds") or []):
                        current_reservations.setdefault(sample_id, []).append(task)

    for project in incoming.get("projects") or []:
        for stage in project.get("stages") or []:
            for task in stage.get("tasks") or []:
                if task_reservations.is_open(task):
                    for sample_id in set(task.get("sampleIds") or []):
                        target_sample_id = identity_targets.get(sample_id, sample_id)
                        if target_sample_id in curr_samples_by_id:
                            current_sample = curr_samples_by_id[target_sample_id]
                            other_tasks = [other for other in current_reservations.get(target_sample_id, [])
                                           if other.get("id") != task.get("id") and task_reservations.conflict_reason(task, other)]
                            if other_tasks:
                                conflicts.append({
                                    "conflictId": next_conflict_id(),
                                    "type": "task_occupancy_conflict",
                                    "entity": "sample",
                                    "sampleId": sample_id,
                                    "mergeTargetSampleId": target_sample_id if target_sample_id != sample_id else "",
                                    "label": entity_label_for_conflict("sample", current_sample),
                                    "currentTaskId": other_tasks[0].get("id"),
                                    "incomingTaskId": task.get("id"),
                                    "incomingTaskLabel": entity_label_for_conflict("task", task),
                                    "allowedActions": ["skip_occupancy", "import_no_occupy"],
                                })

    summary = {
        "projects": {
            "new": sum(1 for item in auto_apply if item["type"] == "new_project"),
            "conflict": sum(1 for item in conflicts if item["entity"] == "project"),
        },
        "stages": {
            "new": sum(1 for item in auto_apply if item["type"] == "new_stage"),
        },
        "tasks": {
            "new": sum(1 for item in auto_apply if item["type"] == "new_task"),
            "conflict": sum(1 for item in conflicts if item["entity"] == "task"),
        },
        "samples": {
            "new": sum(1 for item in auto_apply if item["type"] == "new_sample"),
            "conflict": sum(1 for item in conflicts if item["entity"] == "sample"),
        },
        "sampleIdentityConflicts": sum(1 for item in conflicts if item["type"] == "sample_identity_conflict"),
        "fieldConflicts": sum(1 for item in conflicts if item["type"] == "field_conflict"),
        "occupancyConflicts": sum(1 for item in conflicts if item["type"] == "task_occupancy_conflict"),
        "nameConflicts": sum(1 for item in conflicts if item["type"] in ("project_name_conflict", "stage_name_conflict")),
    }

    return {
        "source": {
            "deploymentId": manifest.get("sourceDeploymentId", ""),
            "revision": manifest.get("revision", 0),
            "exportedAt": manifest.get("exportedAt", ""),
            "appVersion": manifest.get("appVersion", ""),
            "packageKind": manifest.get("packageKind", "full"),
            "scope": manifest.get("scope", ""),
        },
        "summary": summary,
        "autoApply": auto_apply,
        "conflicts": conflicts,
        "blockers": blockers,
    }


def diff_stages(curr_proj: dict, incoming_proj: dict, curr_proj_id: str, inc_proj_id: str,
                next_id, conflicts: list, auto_apply: list):
    """递归比较阶段和任务"""
    curr_stages = {s["id"]: s for s in (curr_proj.get("stages") or [])}
    curr_stage_names = {s.get("name", "").strip().lower(): s for s in (curr_proj.get("stages") or []) if s.get("name")}

    for stage in incoming_proj.get("stages") or []:
        stage_id = stage.get("id", "")
        stage_name = (stage.get("name") or "").strip()

        if stage_id and stage_id in curr_stages:
            current_stage = curr_stages[stage_id]
            field_diffs = diff_fields(current_stage, stage, skip_keys={"tasks"})
            if field_diffs:
                conflicts.append({
                    "conflictId": next_id(),
                    "type": "field_conflict",
                    "entity": "stage",
                    "currentId": stage_id,
                    "incomingId": stage_id,
                    "label": f"阶段: {stage_name}",
                    "current": {key: current_stage.get(key) for key in field_diffs},
                    "incoming": {key: stage.get(key) for key in field_diffs},
                    "diffFields": list(field_diffs),
                    "allowedActions": ["apply_field_choices"],
                })
            curr_tasks = {t["id"]: t for t in (current_stage.get("tasks") or [])}
            for task in stage.get("tasks") or []:
                task_id = task.get("id", "")
                task_label = f"{task.get('category','')}-{task.get('testItem','')}"
                if task_id and task_id in curr_tasks:
                    current_task = curr_tasks[task_id]
                    # Task assignments, drafts and result history are business
                    # data too. Hiding them here silently discarded incoming
                    # updates to an existing task even after a successful import.
                    field_diffs = diff_fields(current_task, task)
                    if field_diffs:
                        conflicts.append({
                            "conflictId": next_id(),
                            "type": "field_conflict",
                            "entity": "task",
                            "currentId": task_id,
                            "incomingId": task_id,
                            "label": task_label,
                            "current": {key: current_task.get(key) for key in field_diffs},
                            "incoming": {key: task.get(key) for key in field_diffs},
                            "diffFields": list(field_diffs),
                            "allowedActions": ["apply_field_choices"],
                            "mergeableFields": list(field_diffs),
                        })
                else:
                    matched = None
                    for _, current_task in curr_tasks.items():
                        if (
                            current_task.get("category") == task.get("category")
                            and current_task.get("testItem") == task.get("testItem")
                            and current_task.get("skuIndex") == task.get("skuIndex")
                        ):
                            matched = current_task
                            break
                    if matched:
                        conflicts.append({
                            "conflictId": next_id(),
                            "type": "task_name_conflict",
                            "entity": "task",
                            "currentId": matched["id"],
                            "incomingId": task_id,
                            "label": task_label,
                            "current": {"category": matched.get("category"), "testItem": matched.get("testItem"), "status": matched.get("status")},
                            "incoming": {"category": task.get("category"), "testItem": task.get("testItem"), "status": task.get("status")},
                            "allowedActions": ["merge_into_existing", "rename_import", "skip"],
                            "preferredMergeTarget": matched["id"],
                        })
                    else:
                        auto_apply.append({"type": "new_task", "id": task_id, "label": task_label, "projectId": curr_proj_id, "stageId": stage_id})
            continue

        if stage_name and stage_name.lower() in curr_stage_names:
            current_stage = curr_stage_names[stage_name.lower()]
            conflicts.append({
                "conflictId": next_id(),
                "type": "stage_name_conflict",
                "entity": "stage",
                "currentId": current_stage["id"],
                "incomingId": stage_id,
                "label": stage_name,
                "current": {"name": current_stage.get("name")},
                "incoming": {"name": stage_name},
                "allowedActions": ["merge_into_existing", "rename_import", "skip"],
                "preferredMergeTarget": current_stage["id"],
            })
            continue

        auto_apply.append({"type": "new_stage", "id": stage_id, "name": stage_name, "projectId": curr_proj_id})
        for task in stage.get("tasks") or []:
            auto_apply.append({
                "type": "new_task",
                "id": task.get("id"),
                "label": f"{task.get('category','')}-{task.get('testItem','')}",
                "projectId": curr_proj_id,
                "stageId": stage_id,
            })
