from __future__ import annotations

import copy
from typing import Any


TASK_FLOW_STATUSES = ("待下发", "进行中", "阻塞中", "正常完成", "异常终止")
TASK_RESULT_STATUSES = ("通过", "不通过")
PROGRESS_PLAN_KEYS = ("id", "strategyId", "category", "testItem", "skuIndex", "sampleSize")
SAMPLE_USAGE_STATUSES = ("闲置", "在位等待", "测试中", "已退库", "取走分析")
SAMPLE_QUALITY_STATUSES = ("无故障", "有故障")
REASSEMBLY_LABELS = ("非重组", "重组")

def _text(value: Any) -> str:
    return str(value or "").strip()


def _canonical(value: Any, choices: tuple[str, ...], default: str, label: str) -> str:
    raw = _text(value)
    if not raw:
        return default
    if raw not in choices:
        raise ValueError(f'{label}不受支持: {raw}；请使用现行状态值。')
    return raw


def normalize_task_flow_status(task_or_status: Any, *, completed: bool | None = None) -> str:
    """状态字段只接受现行枚举；completed 是当前任务模型的完成标志。"""
    if isinstance(task_or_status, dict):
        completed = bool(task_or_status.get('completed')) if completed is None else completed
        task_or_status = task_or_status.get('status')
    status = _canonical(task_or_status, TASK_FLOW_STATUSES, '待下发', '任务状态')
    return '正常完成' if completed and status != '异常终止' else status


def normalize_task_result_value(value: Any) -> str:
    return _canonical(value, TASK_RESULT_STATUSES, '', '测试结果')


def normalize_sample_usage_status(value: Any) -> str:
    return _canonical(value, SAMPLE_USAGE_STATUSES, '闲置', '样机状态')


def normalize_sample_quality_value(value: Any, *, has_problem: bool | None = None) -> str:
    if has_problem is not None:
        return '有故障' if has_problem else '无故障'
    return _canonical(value, SAMPLE_QUALITY_STATUSES, '无故障', '故障状态')


def normalize_task_stored_status(status: Any, *, completed: bool | None = None) -> str:
    return normalize_task_flow_status(status, completed=completed)


def normalize_reassembly_label(value: Any) -> str:
    if isinstance(value, bool):
        return "重组" if value else "非重组"
    if isinstance(value, (int, float)):
        return "重组" if int(value) == 1 else "非重组"
    raw = _text(value).lower()
    if raw in {"是", "yes", "y", "true", "1", "重组", "reassembled"}:
        return "重组"
    return "非重组"


def normalize_problem_records(records: Any) -> list:
    if records is None:
        return []
    if not isinstance(records, list) or any(not isinstance(record, dict) for record in records):
        raise ValueError("problemRecords 必须是当前问题记录对象数组")
    return copy.deepcopy(records)


def normalize_task_payload(task: Any) -> Any:
    if not isinstance(task, dict):
        return task
    original_status = task.get("status")
    original_completed = task.get("completed")
    item = copy.deepcopy(task)
    item["status"] = normalize_task_stored_status({"status": original_status, "completed": original_completed})
    flow = normalize_task_flow_status(item)
    item["completed"] = flow in {"正常完成", "异常终止"}
    if item["completed"]:
        item["completionType"] = flow
    if flow == "异常终止":
        item["latestResult"] = "不通过"
        item["result"] = "不通过"
    for key in ("latestResult", "result"):
        if key in item:
            normalized = normalize_task_result_value(item.get(key))
            if normalized:
                item[key] = normalized
    if isinstance(item.get("resultDraft"), dict):
        draft = item["resultDraft"]
        normalized = normalize_task_result_value(draft.get("result"))
        if normalized:
            draft["result"] = normalized
        for sample in draft.get("samples") or []:
            if isinstance(sample, dict):
                sample["fault"] = normalize_sample_quality_value(sample.get("fault"), has_problem=None)
    for upload in item.get("resultUploads") or []:
        if not isinstance(upload, dict):
            continue
        if upload.get("finishTask") and normalize_task_flow_status(upload.get("finishType")) == "异常终止":
            upload["finishType"] = "异常终止"
            upload["result"] = "不通过"
        normalized = normalize_task_result_value(upload.get("result"))
        if normalized:
            upload["result"] = normalized
        for sample in upload.get("samples") or []:
            if isinstance(sample, dict):
                sample["fault"] = normalize_sample_quality_value(sample.get("fault"), has_problem=None)
                if "destination" in sample:
                    sample["destination"] = normalize_sample_usage_status(sample.get("destination"))
    for fault in item.get("sampleFaultRecords") or []:
        if isinstance(fault, dict):
            if "result" in fault:
                normalized = normalize_task_result_value(fault.get("result"))
                if normalized:
                    fault["result"] = normalized
            if "fault" in fault and not isinstance(fault.get("fault"), bool):
                fault["fault"] = normalize_sample_quality_value(fault.get("fault")) == "有故障"
    return item


def normalize_progress_plan_payload(progress: Any) -> Any:
    if not isinstance(progress, dict):
        return progress
    return {key: copy.deepcopy(progress[key]) for key in PROGRESS_PLAN_KEYS if key in progress}


def normalize_stage_payload(stage: Any) -> Any:
    if not isinstance(stage, dict):
        return stage
    item = copy.deepcopy(stage)
    # Validate at the shared write/import boundary, not only in the number input.
    for row in item.get("strategy") or []:
        count = row.get("sampleSize") if isinstance(row, dict) else None
        if type(count) is not int or not 1 <= count <= 9007199254740991:
            raise ValueError("测试策略样机数必须为大于 0 的整数。")
    if isinstance(item.get("progress"), list):
        item["progress"] = [
            normalize_progress_plan_payload(progress)
            for progress in item["progress"]
            if isinstance(progress, dict)
        ]
    if isinstance(item.get("tasks"), list):
        item["tasks"] = [normalize_task_payload(task) for task in item["tasks"]]
    return item


def normalize_project_payload(project: Any) -> Any:
    if not isinstance(project, dict):
        return project
    item = copy.deepcopy(project)
    if isinstance(item.get("stages"), list):
        item["stages"] = [normalize_stage_payload(stage) for stage in item["stages"]]
    return item


def normalize_sample_payload(sample: Any) -> Any:
    if not isinstance(sample, dict):
        return sample
    item = copy.deepcopy(sample)
    item["status"] = normalize_sample_usage_status(item.get("status"))
    item["problemRecords"] = normalize_problem_records(item.get("problemRecords"))
    return item


def normalize_sample_category_payload(category: Any) -> Any:
    if not isinstance(category, dict):
        return category
    item = copy.deepcopy(category)
    if isinstance(item.get("samples"), list):
        item["samples"] = [normalize_sample_payload(sample) for sample in item["samples"]]
    return item


def normalize_state_payload(data: Any) -> Any:
    if not isinstance(data, dict):
        return data
    # Only typed fields are normalized; free text is preserved verbatim.
    item = copy.deepcopy(data)
    if isinstance(item.get("projects"), list):
        item["projects"] = [normalize_project_payload(project) for project in item["projects"]]
    library = item.get("sampleLibrary")
    if isinstance(library, dict):
        if isinstance(library.get("categories"), list):
            library["categories"] = [normalize_sample_category_payload(category) for category in library["categories"]]
        if isinstance(library.get("logs"), list):
            library["logs"] = library["logs"]
    return item
