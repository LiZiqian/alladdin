from __future__ import annotations

import copy
from typing import Iterable


SELECTION_KEYS = {
    "projects": ("projects", "projectIds"),
    "stages": ("stages", "stageIds"),
    "tasks": ("tasks", "taskIds"),
    "sampleCategories": ("sampleCategories", "sampleCategoryIds"),
    "samples": ("samples", "sampleIds"),
}


def _ids(values: object) -> set[str]:
    if values is None:
        return set()
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, Iterable):
        return set()
    return {str(item or "").strip() for item in values if str(item or "").strip()}


def normalize_selection(selection: object | None) -> dict[str, set[str]]:
    if not isinstance(selection, dict):
        return {key: set() for key in SELECTION_KEYS}
    normalized: dict[str, set[str]] = {}
    for key, aliases in SELECTION_KEYS.items():
        values: set[str] = set()
        for alias in aliases:
            values.update(_ids(selection.get(alias)))
        normalized[key] = values
    return normalized


def selection_is_empty(selection: object | None) -> bool:
    normalized = normalize_selection(selection)
    return not any(normalized.values())


def task_sample_ids(task: dict) -> set[str]:
    ids = {str(item or "").strip() for item in (task.get("sampleIds") or []) if str(item or "").strip()}
    pending = [task.get(key) for key in ("removedSampleRecords", "sampleFaultRecords", "resultUploads",
                                       "resultDraft", "logs", "issueRecord")]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            for key in ("sampleId", "sid"):
                if isinstance(value.get(key), str) and value[key]:
                    ids.add(value[key])
            pending.extend(child for child in value.values() if isinstance(child, (dict, list)))
        elif isinstance(value, list):
            pending.extend(value)
    snapshots = task.get("sampleSnapshots")
    if isinstance(snapshots, dict):
        ids.update(str(sid) for sid in snapshots if sid)
    return ids


def _event_matches(log: dict, *, sample_ids: set[str], project_ids: set[str], stage_ids: set[str], task_ids: set[str]) -> bool:
    return (
        str(log.get("sampleId") or "") in sample_ids
        or str(log.get("projectId") or "") in project_ids
        or str(log.get("stageId") or "") in stage_ids
        or str(log.get("taskId") or "") in task_ids
    )


def filter_state_by_selection(state: dict, selection: object | None) -> dict:
    """Return a state subset for selected project/sample migration.

    Empty selection means full state. Project selection carries referenced
    samples so imported task history does not point at missing sample records.
    """
    if selection_is_empty(selection):
        if isinstance(selection, dict) and any(alias in selection for aliases in SELECTION_KEYS.values() for alias in aliases):
            raise ValueError("请至少选择一项导入或导出数据")
        return copy.deepcopy(state)

    selected = normalize_selection(selection)
    selected_project_ids = set(selected["projects"])
    selected_stage_ids = set(selected["stages"])
    selected_task_ids = set(selected["tasks"])
    selected_category_ids = set(selected["sampleCategories"])
    selected_sample_ids = set(selected["samples"])

    clean = copy.deepcopy(state)
    clean["projects"] = []
    included_project_ids: set[str] = set()
    included_stage_ids: set[str] = set()
    included_task_ids: set[str] = set()
    referenced_sample_ids: set[str] = set()

    for project in state.get("projects") or []:
        if not isinstance(project, dict):
            continue
        project_id = str(project.get("id") or "")
        include_project_all = project_id in selected_project_ids
        next_project = copy.deepcopy(project)
        next_project["stages"] = []
        for stage in project.get("stages") or []:
            if not isinstance(stage, dict):
                continue
            stage_id = str(stage.get("id") or "")
            include_stage_all = include_project_all or stage_id in selected_stage_ids
            next_stage = copy.deepcopy(stage)
            next_stage["tasks"] = []
            for task in stage.get("tasks") or []:
                if not isinstance(task, dict):
                    continue
                task_id = str(task.get("id") or "")
                if include_stage_all or task_id in selected_task_ids:
                    next_stage["tasks"].append(copy.deepcopy(task))
                    included_task_ids.add(task_id)
                    referenced_sample_ids.update(task_sample_ids(task))
            if include_stage_all or next_stage["tasks"]:
                next_project["stages"].append(next_stage)
                included_stage_ids.add(stage_id)
        if include_project_all or next_project["stages"]:
            clean["projects"].append(next_project)
            included_project_ids.add(project_id)
            default_category_id = str(project.get("defaultSampleCategoryId") or "").strip()
            if default_category_id:
                selected_category_ids.add(default_category_id)

    selected_sample_ids.update(referenced_sample_ids)
    library = copy.deepcopy(state.get("sampleLibrary") or {})
    library["categories"] = []
    all_included_sample_ids: set[str] = set()
    for category in (state.get("sampleLibrary") or {}).get("categories") or []:
        if not isinstance(category, dict):
            continue
        category_id = str(category.get("id") or "")
        include_category_all = category_id in selected_category_ids
        next_category = copy.deepcopy(category)
        next_category["samples"] = []
        for sample in category.get("samples") or []:
            if not isinstance(sample, dict):
                continue
            sample_id = str(sample.get("id") or "")
            if include_category_all or sample_id in selected_sample_ids:
                next_category["samples"].append(copy.deepcopy(sample))
                all_included_sample_ids.add(sample_id)
        if include_category_all or next_category["samples"]:
            library["categories"].append(next_category)

    logs = []
    for log in (state.get("sampleLibrary") or {}).get("logs") or []:
        if isinstance(log, dict) and _event_matches(
            log,
            sample_ids=all_included_sample_ids,
            project_ids=included_project_ids,
            stage_ids=included_stage_ids,
            task_ids=included_task_ids,
        ):
            logs.append(copy.deepcopy(log))
    library["logs"] = logs
    clean["sampleLibrary"] = library
    return clean


def build_selection_tree(state: dict) -> dict:
    projects = []
    for project in state.get("projects") or []:
        if not isinstance(project, dict):
            continue
        project_node = {
            "id": str(project.get("id") or ""),
            "label": str(project.get("name") or project.get("code") or project.get("id") or "未命名项目"),
            "stages": [],
            "defaultSampleCategoryId": str(project.get("defaultSampleCategoryId") or ""),
        }
        for stage in project.get("stages") or []:
            if not isinstance(stage, dict):
                continue
            stage_node = {
                "id": str(stage.get("id") or ""),
                "label": str(stage.get("name") or stage.get("id") or "未命名阶段"),
                "projectId": project_node["id"],
                "tasks": [],
            }
            for task in stage.get("tasks") or []:
                if not isinstance(task, dict):
                    continue
                label = " - ".join(part for part in [str(task.get("category") or ""), str(task.get("testItem") or "")] if part)
                stage_node["tasks"].append({
                    "id": str(task.get("id") or ""),
                    "label": label or str(task.get("id") or "未命名任务"),
                    "stageId": stage_node["id"],
                    "projectId": project_node["id"],
                    "sampleIds": sorted(task_sample_ids(task)),
                })
            project_node["stages"].append(stage_node)
        projects.append(project_node)

    sample_categories = []
    for category in (state.get("sampleLibrary") or {}).get("categories") or []:
        if not isinstance(category, dict):
            continue
        category_node = {
            "id": str(category.get("id") or ""),
            "label": str(category.get("name") or category.get("id") or "未命名样机池"),
            "samples": [],
        }
        for sample in category.get("samples") or []:
            if not isinstance(sample, dict):
                continue
            parts = [sample.get("sn"), sample.get("imei"), sample.get("boardSn"), sample.get("sampleNo"), sample.get("id")]
            label = next((str(part) for part in parts if str(part or "").strip()), "未命名样机")
            category_node["samples"].append({
                "id": str(sample.get("id") or ""),
                "label": label,
                "categoryId": category_node["id"],
            })
        sample_categories.append(category_node)
    return {"projects": projects, "sampleCategories": sample_categories}
