"""Import migration and defaulting for legacy and ChamberData bundles."""

from __future__ import annotations

import copy
import re

from server_modules import status_normalization


_UNSAFE_IMPORT_ID_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WINDOWS_DEVICE_NAMES = {
    "con", "prn", "aux", "nul",
    *(f"com{index}" for index in range(1, 10)),
    *(f"lpt{index}" for index in range(1, 10)),
}


def _validate_import_id(value: object, label: str) -> str:
    item_id = str(value or "").strip()
    if not item_id:
        raise ValueError(f"{label} 缺少 id")
    if (
        len(item_id) > 200
        or item_id in {".", ".."}
        or _UNSAFE_IMPORT_ID_RE.search(item_id)
        or item_id.rstrip(" .").lower().split(".", 1)[0] in _WINDOWS_DEVICE_NAMES
    ):
        raise ValueError(f"{label} id 包含不安全字符: {item_id}")
    return item_id


def _ensure_list(obj: dict, key: str) -> list:
    if not isinstance(obj.get(key), list):
        obj[key] = []
    return obj[key]


def _ensure_dict_list(obj: dict, key: str) -> list:
    values = obj.get(key)
    if not isinstance(values, list):
        obj[key] = []
        return obj[key]
    obj[key] = [item for item in values if isinstance(item, dict)]
    return obj[key]


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, bool):
        return default
    if isinstance(value, (dict, list, tuple, set)):
        return default
    return str(value)


def _ensure_text(obj: dict, key: str, default: str = "") -> str:
    obj[key] = _text(obj.get(key), default)
    return obj[key]


def _ensure_int(obj: dict, key: str, default: int = 0) -> int:
    try:
        if isinstance(obj.get(key), bool):
            raise ValueError
        obj[key] = int(obj.get(key))
    except (TypeError, ValueError):
        obj[key] = default
    return obj[key]


def _ensure_id_list(obj: dict, key: str) -> list:
    values = obj.get(key)
    if not isinstance(values, list):
        obj[key] = []
        return obj[key]
    result = []
    for item in values:
        value = _text(item, "")
        if value:
            result.append(value)
    obj[key] = result
    return obj[key]


def _ensure_text_list(obj: dict, key: str) -> list:
    values = obj.get(key)
    if not isinstance(values, list):
        obj[key] = []
        return obj[key]
    obj[key] = [_text(item) for item in values if _text(item)]
    return obj[key]


def _ensure_dict(obj: dict, key: str) -> dict:
    if not isinstance(obj.get(key), dict):
        obj[key] = {}
    return obj[key]


def normalize_import_state(state: dict, *, source_format: str = "") -> dict:
    """Return a canonical import state while preserving unknown harmless fields."""
    data = copy.deepcopy(state) if isinstance(state, dict) else {}
    data.setdefault("version", "")
    data.setdefault("currentProjectId", None)
    data.setdefault("currentStageId", None)
    _ensure_list(data, "users")
    _ensure_dict_list(data, "projects")
    _ensure_list(data, "testCaseMaster")
    library = _ensure_dict(data, "sampleLibrary")
    _ensure_dict_list(library, "categories")
    _ensure_dict_list(library, "logs")

    for project in data["projects"]:
        _ensure_text(project, "id")
        _ensure_text(project, "name")
        _ensure_text(project, "code")
        project["owner"] = _text(project.get("owner")) or _text(project.get("leader")) or _text(project.get("manager"))
        _ensure_dict_list(project, "members")
        _ensure_text_list(project, "locations")
        _ensure_list(project, "testCaseMaster")
        _ensure_dict_list(project, "stages")
        for stage in project["stages"]:
            _ensure_text(stage, "id")
            stage["projectId"] = _text(stage.get("projectId")) or project.get("id") or ""
            _ensure_text(stage, "name")
            _ensure_text_list(stage, "skuNames")
            _ensure_list(stage, "bom")
            _ensure_list(stage, "strategy")
            _ensure_list(stage, "progress")
            _ensure_dict_list(stage, "tasks")
            for task in stage["tasks"]:
                _ensure_text(task, "id")
                task["projectId"] = _text(task.get("projectId")) or project.get("id") or ""
                task["stageId"] = _text(task.get("stageId")) or stage.get("id") or ""
                _ensure_text(task, "category")
                _ensure_text(task, "testItem")
                task.setdefault("skuIndex", 0)
                _ensure_text(task, "status")
                _ensure_text(task, "owner")
                _ensure_text(task, "remark")
                task.setdefault("archived", False)
                _ensure_id_list(task, "sampleIds")
                _ensure_dict_list(task, "logs")
                _ensure_dict_list(task, "removedSampleRecords")
                _ensure_dict_list(task, "sampleFaultRecords")
                _ensure_dict_list(task, "resultUploads")
                issue_record = _ensure_dict(task, "issueRecord")
                _ensure_text(issue_record, "dtsNo")
                _ensure_text(issue_record, "isIssue")
                _ensure_text(issue_record, "issueNote")

    for category in library["categories"]:
        _ensure_text(category, "id")
        _ensure_text(category, "name")
        _ensure_text(category, "description")
        _ensure_dict_list(category, "samples")
        for sample in category["samples"]:
            _ensure_text(sample, "id")
            sample["categoryId"] = _text(sample.get("categoryId")) or category.get("id") or ""
            _ensure_text(sample, "sampleNo")
            _ensure_text(sample, "sn")
            _ensure_text(sample, "imei")
            _ensure_text(sample, "boardSn")
            sample.setdefault("isReassembled", False)
            _ensure_text(sample, "schemeNo")
            sample["status"] = _text(sample.get("status"), "闲置") or "闲置"
            _ensure_text(sample, "location")
            _ensure_text(sample, "owner")
            _ensure_text(sample, "borrower")
            _ensure_text(sample, "borrowDate")
            _ensure_text(sample, "importDate")
            _ensure_text(sample, "sourceStageName")
            _ensure_text(sample, "sourceSkuName")
            _ensure_text(sample, "initialResult")
            _ensure_list(sample, "initialResults")
            _ensure_list(sample, "problemRecords")
            _ensure_dict_list(sample, "photos")
            _ensure_dict_list(sample, "logs")
            for photo in sample["photos"]:
                _ensure_text(photo, "id")
                _ensure_text(photo, "name")
                _ensure_text(photo, "type")
                _ensure_int(photo, "size", 0)
                if "thumbSize" in photo:
                    _ensure_int(photo, "thumbSize", 0)
                if "thumbnailSize" in photo:
                    _ensure_int(photo, "thumbnailSize", 0)
                _ensure_text(photo, "uploadedAt")
                _ensure_text(photo, "relativePath")
                _ensure_text(photo, "url")
                _ensure_text(photo, "thumbRelativePath")
                _ensure_text(photo, "thumbUrl")

    data["_importNormalizedFrom"] = source_format or "unknown"
    return status_normalization.normalize_state_payload(data)


def validate_import_state_structure(state: dict) -> None:
    """Reject ambiguous IDs and broken parent/reference relationships before diff/commit."""
    if not isinstance(state, dict):
        raise ValueError("导入包 state 数据格式不正确")

    seen_project_ids: set[str] = set()
    seen_stage_ids: set[str] = set()
    seen_task_ids: set[str] = set()
    task_sample_refs: list[tuple[str, str]] = []

    for project_index, project in enumerate(state.get("projects") or [], start=1):
        if not isinstance(project, dict):
            raise ValueError(f"导入包项目第 {project_index} 项格式不正确")
        project_id = _validate_import_id(project.get("id"), f"导入包项目第 {project_index} 项")
        if project_id in seen_project_ids:
            raise ValueError(f"导入包项目 id 重复: {project_id}")
        seen_project_ids.add(project_id)
        for stage_index, stage in enumerate(project.get("stages") or [], start=1):
            if not isinstance(stage, dict):
                raise ValueError(f"导入包项目 {project_id} 的阶段第 {stage_index} 项格式不正确")
            stage_id = _validate_import_id(stage.get("id"), f"导入包项目 {project_id} 的阶段第 {stage_index} 项")
            if stage_id in seen_stage_ids:
                raise ValueError(f"导入包阶段 id 重复: {stage_id}")
            seen_stage_ids.add(stage_id)
            if str(stage.get("projectId") or "") != project_id:
                raise ValueError(f"导入包阶段 {stage_id} 的 projectId 与所属项目不一致")
            for task_index, task in enumerate(stage.get("tasks") or [], start=1):
                if not isinstance(task, dict):
                    raise ValueError(f"导入包阶段 {stage_id} 的任务第 {task_index} 项格式不正确")
                task_id = _validate_import_id(task.get("id"), f"导入包阶段 {stage_id} 的任务第 {task_index} 项")
                if task_id in seen_task_ids:
                    raise ValueError(f"导入包任务 id 重复: {task_id}")
                seen_task_ids.add(task_id)
                if str(task.get("projectId") or "") != project_id or str(task.get("stageId") or "") != stage_id:
                    raise ValueError(f"导入包任务 {task_id} 的项目/阶段归属不一致")
                for sample_id in task.get("sampleIds") or []:
                    value = str(sample_id or "").strip()
                    if value:
                        task_sample_refs.append((task_id, value))

    seen_category_ids: set[str] = set()
    seen_sample_ids: set[str] = set()
    seen_photo_ids: set[str] = set()
    for category_index, category in enumerate((state.get("sampleLibrary") or {}).get("categories") or [], start=1):
        if not isinstance(category, dict):
            raise ValueError(f"导入包样机池第 {category_index} 项格式不正确")
        category_id = _validate_import_id(category.get("id"), f"导入包样机池第 {category_index} 项")
        if category_id in seen_category_ids:
            raise ValueError(f"导入包样机池 id 重复: {category_id}")
        seen_category_ids.add(category_id)
        for sample_index, sample in enumerate(category.get("samples") or [], start=1):
            if not isinstance(sample, dict):
                raise ValueError(f"导入包样机池 {category_id} 的样机第 {sample_index} 项格式不正确")
            sample_id = _validate_import_id(sample.get("id"), f"导入包样机池 {category_id} 的样机第 {sample_index} 项")
            if sample_id in seen_sample_ids:
                raise ValueError(f"导入包样机 id 重复: {sample_id}")
            seen_sample_ids.add(sample_id)
            if str(sample.get("categoryId") or "") != category_id:
                raise ValueError(f"导入包样机 {sample_id} 的 categoryId 与所属样机池不一致")
            for photo in sample.get("photos") or []:
                if not isinstance(photo, dict):
                    raise ValueError(f"导入包样机 {sample_id} 包含格式不正确的照片记录")
                photo_id = _validate_import_id(photo.get("id"), f"导入包样机 {sample_id} 的照片记录")
                if photo_id in seen_photo_ids:
                    raise ValueError(f"导入包照片 id 重复: {photo_id}")
                seen_photo_ids.add(photo_id)

    for task_id, sample_id in task_sample_refs:
        if sample_id not in seen_sample_ids:
            raise ValueError(f"导入包任务 {task_id} 引用不存在的样机: {sample_id}")

    seen_event_ids: set[str] = set()
    for event_index, event in enumerate((state.get("sampleLibrary") or {}).get("logs") or [], start=1):
        if not isinstance(event, dict):
            raise ValueError(f"导入包样机事件第 {event_index} 项格式不正确")
        event_id = _validate_import_id(event.get("id"), f"导入包样机事件第 {event_index} 项")
        sample_id = str(event.get("sampleId") or "").strip()
        if event_id in seen_event_ids:
            raise ValueError(f"导入包样机事件 id 重复: {event_id}")
        seen_event_ids.add(event_id)
        if sample_id not in seen_sample_ids:
            raise ValueError(f"导入包样机事件 {event_id} 引用不存在的样机: {sample_id or '(空)'}")
