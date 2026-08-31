"""Fixed-IP authorization for the lightweight intranet deployment.

The peer address supplied by ``BaseHTTPRequestHandler.client_address`` is the
only identity input.  In particular, proxy headers are deliberately ignored.
"""

from __future__ import annotations

import copy
import ipaddress
import json
import re
import sqlite3
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import quote

from server_modules import status_normalization


PROJECT_ROLES = ("viewer", "contributor", "project_admin")
POOL_ROLES = ("pool_viewer", "pool_maintainer", "pool_admin")
PROJECT_ROLE_RANK = {"none": 0, "viewer": 1, "contributor": 2, "project_admin": 3, "local_admin": 99}
POOL_ROLE_RANK = {"none": 0, "pool_viewer": 1, "pool_maintainer": 2, "pool_admin": 3, "local_admin": 99}


@dataclass(frozen=True)
class AccessContext:
    client_ip: str
    is_local_admin: bool

    @property
    def platform_role(self) -> str:
        return "local_admin" if self.is_local_admin else "none"

    def to_public_dict(self) -> dict:
        return {
            "clientIp": self.client_ip,
            "isLocalAdmin": self.is_local_admin,
            "platformRole": self.platform_role,
        }


def normalize_client_ip(value: object) -> str:
    """Return a stable socket peer IP, including IPv4-mapped IPv6 handling."""
    raw = str(value or "").strip()
    if raw.startswith("[") and "]" in raw:
        raw = raw[1:raw.index("]")]
    if "%" in raw:
        raw = raw.split("%", 1)[0]
    try:
        address = ipaddress.ip_address(raw)
    except ValueError:
        # A malformed socket address is never elevated and never matches an ACL.
        return raw.lower()
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.compressed


def access_context(client_ip: object) -> AccessContext:
    normalized = normalize_client_ip(client_ip)
    local = normalized in {"127.0.0.1", "::1"}
    return AccessContext(normalized, local)


def validate_acl_ipv4(value: object) -> str:
    normalized = normalize_client_ip(value)
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError as exc:
        raise ValueError("IP 地址不是有效的固定 IPv4") from exc
    if not isinstance(address, ipaddress.IPv4Address):
        raise ValueError("第一版权限名单只支持固定 IPv4")
    if address.is_loopback:
        raise ValueError("localhost 权限由服务器动态生成，不能写入名单")
    if address.is_unspecified or address.is_multicast:
        raise ValueError("该 IPv4 不能用作客户端权限凭证")
    return address.compressed


def project_role(conn: sqlite3.Connection, project_id: str, client_ip: object) -> str:
    actor = access_context(client_ip)
    if actor.is_local_admin:
        return "local_admin"
    row = conn.execute(
        """
        SELECT access.role
        FROM project_ip_access AS access
        JOIN project_records AS project
          ON project.id = access.project_id AND project.deleted_at IS NULL
        WHERE access.project_id = ? AND access.ip_address = ? AND access.enabled = 1
        """,
        (str(project_id or ""), actor.client_ip),
    ).fetchone()
    role = str(row["role"] or "") if row else ""
    return role if role in PROJECT_ROLES else "none"


def pool_role(conn: sqlite3.Connection, category_id: str, client_ip: object) -> str:
    actor = access_context(client_ip)
    if actor.is_local_admin:
        return "local_admin"
    row = conn.execute(
        """
        SELECT access.role
        FROM sample_pool_ip_access AS access
        JOIN sample_categories AS category
          ON category.id = access.category_id AND category.deleted_at IS NULL
        WHERE access.category_id = ? AND access.ip_address = ? AND access.enabled = 1
        """,
        (str(category_id or ""), actor.client_ip),
    ).fetchone()
    role = str(row["role"] or "") if row else ""
    return role if role in POOL_ROLES else "none"


def has_project_role(conn: sqlite3.Connection, project_id: str, client_ip: object, required: str = "viewer") -> bool:
    return PROJECT_ROLE_RANK.get(project_role(conn, project_id, client_ip), 0) >= PROJECT_ROLE_RANK.get(required, 999)


def has_pool_role(conn: sqlite3.Connection, category_id: str, client_ip: object, required: str = "pool_viewer") -> bool:
    return POOL_ROLE_RANK.get(pool_role(conn, category_id, client_ip), 0) >= POOL_ROLE_RANK.get(required, 999)


def project_id_for_stage(conn: sqlite3.Connection, stage_id: str) -> str:
    row = conn.execute(
        "SELECT project_id FROM project_stages WHERE id = ? AND deleted_at IS NULL",
        (str(stage_id or ""),),
    ).fetchone()
    return str(row["project_id"] or "") if row else ""


def task_scope(conn: sqlite3.Connection, task_id: str) -> tuple[str, str]:
    row = conn.execute(
        "SELECT project_id, stage_id FROM project_tasks WHERE id = ? AND deleted_at IS NULL",
        (str(task_id or ""),),
    ).fetchone()
    if not row:
        return "", ""
    return str(row["project_id"] or ""), str(row["stage_id"] or "")


def project_bound_pool_ids(conn: sqlite3.Connection, project_id: object) -> set[str]:
    row = conn.execute(
        "SELECT data_json FROM project_records WHERE id = ? AND deleted_at IS NULL",
        (str(project_id or ""),),
    ).fetchone()
    if not row:
        return set()
    project = json.loads(row["data_json"] or "{}")
    result = {str(project.get("defaultSampleCategoryId") or "")}
    for key in ("sampleCategoryIds", "boundSampleCategoryIds"):
        result.update(str(value or "") for value in project.get(key) or [])
    return {value for value in result if value}


def category_id_for_sample(conn: sqlite3.Connection, sample_id: str) -> str:
    row = conn.execute(
        "SELECT category_id FROM sample_records WHERE id = ? AND deleted_at IS NULL",
        (str(sample_id or ""),),
    ).fetchone()
    return str(row["category_id"] or "") if row else ""


def sample_is_linked_to_project(conn: sqlite3.Connection, sample_id: str, project_id: str) -> bool:
    if not sample_id or not project_id:
        return False
    row = conn.execute(
        """
        SELECT 1 FROM project_task_samples pts
        JOIN project_tasks t ON t.id = pts.task_id
        WHERE pts.sample_id = ? AND t.project_id = ? AND t.deleted_at IS NULL
        LIMIT 1
        """,
        (sample_id, project_id),
    ).fetchone()
    if row:
        return True
    # Completed/destroyed relationships can remain only in JSON snapshots.
    return bool(conn.execute(
        "SELECT 1 FROM sample_events WHERE sample_id = ? AND project_id = ? LIMIT 1",
        (sample_id, project_id),
    ).fetchone())


def can_read_sample(
    conn: sqlite3.Connection,
    sample_id: str,
    client_ip: object,
    *,
    project_id: str = "",
) -> bool:
    category_id = category_id_for_sample(conn, sample_id)
    if not category_id:
        return False
    if has_pool_role(conn, category_id, client_ip, "pool_viewer"):
        return True
    return bool(
        project_id
        and has_project_role(conn, project_id, client_ip, "viewer")
        and sample_is_linked_to_project(conn, sample_id, project_id)
    )


def list_access_rules(conn: sqlite3.Connection, resource_type: str, resource_id: str) -> list[dict]:
    if resource_type == "project":
        table, id_column = "project_ip_access", "project_id"
    elif resource_type == "sample_pool":
        table, id_column = "sample_pool_ip_access", "category_id"
    else:
        raise ValueError("未知权限资源类型")
    rows = conn.execute(
        f"""
        SELECT ip_address, role, enabled, device_label, user_note,
               created_by_ip, created_at, updated_at, last_seen_at
        FROM {table}
        WHERE {id_column} = ?
        ORDER BY ip_address
        """,
        (resource_id,),
    ).fetchall()
    return [{
        "ipAddress": str(row["ip_address"] or ""),
        "role": str(row["role"] or ""),
        "enabled": bool(row["enabled"]),
        "deviceLabel": str(row["device_label"] or ""),
        "userNote": str(row["user_note"] or ""),
        "createdByIp": str(row["created_by_ip"] or ""),
        "createdAt": str(row["created_at"] or ""),
        "updatedAt": str(row["updated_at"] or ""),
        "lastSeenAt": str(row["last_seen_at"] or ""),
    } for row in rows]


def upsert_access_rule(
    conn: sqlite3.Connection,
    resource_type: str,
    resource_id: str,
    payload: dict,
    *,
    actor_ip: object,
    now: str,
) -> dict:
    ip_address = validate_acl_ipv4(payload.get("ipAddress"))
    if resource_type == "project":
        table, id_column, roles = "project_ip_access", "project_id", PROJECT_ROLES
        exists_table = "project_records"
    elif resource_type == "sample_pool":
        table, id_column, roles = "sample_pool_ip_access", "category_id", POOL_ROLES
        exists_table = "sample_categories"
    else:
        raise ValueError("未知权限资源类型")
    role = str(payload.get("role") or "").strip()
    if role not in roles:
        raise ValueError("权限角色无效，且不能授予 local_admin")
    enabled_value = payload.get("enabled", True)
    if not isinstance(enabled_value, bool):
        raise ValueError("enabled 必须是 JSON 布尔值")
    device_label = str(payload.get("deviceLabel") or "").strip()
    user_note = str(payload.get("userNote") or "").strip()
    if len(device_label) > 100:
        raise ValueError("设备标签不能超过 100 个字符")
    if len(user_note) > 500:
        raise ValueError("备注不能超过 500 个字符")
    exists = conn.execute(
        f"SELECT 1 FROM {exists_table} WHERE id = ? AND deleted_at IS NULL",
        (resource_id,),
    ).fetchone()
    if not exists:
        raise KeyError("权限所属资源不存在")
    actor = access_context(actor_ip)
    conn.execute(
        f"""
        INSERT INTO {table}
        ({id_column}, ip_address, role, enabled, device_label, user_note,
         created_by_ip, created_at, updated_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT({id_column}, ip_address) DO UPDATE SET
            role = excluded.role,
            enabled = excluded.enabled,
            device_label = excluded.device_label,
            user_note = excluded.user_note,
            updated_at = excluded.updated_at
        """,
        (
            resource_id,
            ip_address,
            role,
            1 if enabled_value else 0,
            device_label,
            user_note,
            actor.client_ip,
            now,
            now,
        ),
    )
    return next(item for item in list_access_rules(conn, resource_type, resource_id) if item["ipAddress"] == ip_address)


def delete_access_rule(conn: sqlite3.Connection, resource_type: str, resource_id: str, ip_address: object) -> bool:
    normalized = validate_acl_ipv4(ip_address)
    if resource_type == "project":
        table, id_column = "project_ip_access", "project_id"
    elif resource_type == "sample_pool":
        table, id_column = "sample_pool_ip_access", "category_id"
    else:
        raise ValueError("未知权限资源类型")
    cursor = conn.execute(
        f"DELETE FROM {table} WHERE {id_column} = ? AND ip_address = ?",
        (resource_id, normalized),
    )
    return bool(cursor.rowcount)


def record_security_audit(
    conn: sqlite3.Connection,
    *,
    time: str,
    client_ip: object,
    action: str,
    resource_type: str = "platform",
    resource_id: str = "",
    allowed: bool,
    actor_role: str = "",
    detail: dict | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO security_audit_log
        (time, client_ip, action, resource_type, resource_id, allowed, actor_role, detail_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            time,
            access_context(client_ip).client_ip,
            str(action or ""),
            str(resource_type or "platform"),
            str(resource_id or ""),
            1 if allowed else 0,
            str(actor_role or ""),
            json.dumps(detail or {}, ensure_ascii=False, separators=(",", ":")),
        ),
    )


def touch_access_rule(conn: sqlite3.Connection, resource_type: str, resource_id: str, client_ip: object, *, now: str) -> None:
    actor = access_context(client_ip)
    if actor.is_local_admin:
        return
    if resource_type == "project":
        conn.execute(
            "UPDATE project_ip_access SET last_seen_at = ? WHERE project_id = ? AND ip_address = ? AND enabled = 1",
            (now, resource_id, actor.client_ip),
        )
    elif resource_type == "sample_pool":
        conn.execute(
            "UPDATE sample_pool_ip_access SET last_seen_at = ? WHERE category_id = ? AND ip_address = ? AND enabled = 1",
            (now, resource_id, actor.client_ip),
        )


def decorate_project_summaries(conn: sqlite3.Connection, projects: list[dict], client_ip: object) -> list[dict]:
    actor = access_context(client_ip)
    status_rows = conn.execute(
        """
        SELECT project_id, COALESCE(flow_status, '待下发') AS flow_status, COUNT(*) AS count
        FROM project_tasks WHERE deleted_at IS NULL
        GROUP BY project_id, flow_status
        """
    ).fetchall()
    statuses: dict[str, dict[str, int]] = {}
    for row in status_rows:
        statuses.setdefault(str(row["project_id"]), {})[str(row["flow_status"] or "待下发")] = int(row["count"] or 0)
    result = []
    for source in projects:
        item = copy.deepcopy(source)
        project_id = str(item.get("id") or "")
        role = project_role(conn, project_id, actor.client_ip)
        if not actor.is_local_admin:
            item.pop("owner", None)
            item.pop("defaultSampleCategoryId", None)
        item["statusCounts"] = statuses.get(project_id, {})
        item.update({
            "accessRole": role,
            "canOpen": PROJECT_ROLE_RANK.get(role, 0) >= PROJECT_ROLE_RANK["viewer"],
            "canContribute": PROJECT_ROLE_RANK.get(role, 0) >= PROJECT_ROLE_RANK["contributor"],
            "canManage": PROJECT_ROLE_RANK.get(role, 0) >= PROJECT_ROLE_RANK["project_admin"],
        })
        result.append(item)
    return result


def decorate_pool_summaries(conn: sqlite3.Connection, categories: list[dict], client_ip: object) -> list[dict]:
    result = []
    for source in categories:
        item = copy.deepcopy(source)
        category_id = str(item.get("id") or "")
        role = pool_role(conn, category_id, client_ip)
        item.update({
            "accessRole": role,
            "canOpen": POOL_ROLE_RANK.get(role, 0) >= POOL_ROLE_RANK["pool_viewer"],
            "canContribute": POOL_ROLE_RANK.get(role, 0) >= POOL_ROLE_RANK["pool_maintainer"],
            "canManage": POOL_ROLE_RANK.get(role, 0) >= POOL_ROLE_RANK["pool_admin"],
        })
        result.append(item)
    return result


def decorate_bootstrap(conn: sqlite3.Connection, data: dict, client_ip: object) -> dict:
    actor = access_context(client_ip)
    result = copy.deepcopy(data)
    result["projects"] = decorate_project_summaries(conn, result.get("projects") or [], actor.client_ip)
    library = result.get("sampleLibrary") if isinstance(result.get("sampleLibrary"), dict) else {}
    library["categories"] = decorate_pool_summaries(conn, library.get("categories") or [], actor.client_ip)
    library.pop("logs", None)
    result["sampleLibrary"] = library
    if not actor.is_local_admin:
        result.pop("users", None)
        result.pop("currentProjectId", None)
        result.pop("currentStageId", None)
    result["accessContext"] = actor.to_public_dict()
    return result


_PROJECT_ACCESS_RE = re.compile(r"^/api/projects/([^/]+)/access-rules$")
_POOL_ACCESS_RE = re.compile(r"^/api/sample-categories/([^/]+)/access-rules$")


def access_rule_route(path: str) -> tuple[str, str] | None:
    match = _PROJECT_ACCESS_RE.fullmatch(path)
    if match:
        return "project", match.group(1)
    match = _POOL_ACCESS_RE.fullmatch(path)
    if match:
        return "sample_pool", match.group(1)
    return None


CONTRIBUTOR_TASK_ACTIONS = {
    "start_task", "restart_task", "block_task", "finish_task_result",
    "upload_task_result", "save_task_result_draft", "update_issue_record",
}
PROJECT_ADMIN_TASK_ACTIONS = {
    "create_task_config", "save_task_config", "assign_task_samples", "reassign_task_samples",
    "set_task_plan", "create_tasks_batch", "delete_task", "archive_task_delete", "temp_change_task",
}

_TASK_PROTECTED_KEY_RE = re.compile(
    r"(^id$|project|stage|progress|category|testitem|sku|sampleids|samplesize|"
    r"owner|executor|assignee|plan|schedule|strategy|testcase|dts|duration|device|fixture|"
    r"archived|deletedat|deletemode|createdat|removedsamplerecords)",
    re.IGNORECASE,
)


def _json_value(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _append_only_failure(current: object, incoming: object) -> bool:
    if not isinstance(current, list):
        current = []
    if not isinstance(incoming, list) or len(incoming) < len(current):
        return True
    return any(_json_value(before) != _json_value(incoming[index]) for index, before in enumerate(current))


def _contributor_task_payload_failure(conn: sqlite3.Connection, task_id: str, incoming: dict, action: str) -> dict | None:
    row = conn.execute(
        "SELECT data_json, project_id, stage_id, sample_ids_json FROM project_tasks WHERE id = ? AND deleted_at IS NULL",
        (task_id,),
    ).fetchone()
    if not row:
        return {"status": 403, "errorCode": "RESOURCE_SCOPE_DENIED", "error": "贡献者不能创建任务"}
    current = json.loads(row["data_json"] or "{}")
    current.update({
        "id": task_id,
        "projectId": str(row["project_id"] or ""),
        "stageId": str(row["stage_id"] or ""),
        "sampleIds": json.loads(row["sample_ids_json"] or "[]"),
    })
    current["logs"] = [
        json.loads(log_row["data_json"] or "{}")
        for log_row in conn.execute("SELECT data_json FROM task_logs WHERE task_id = ? ORDER BY time, id", (task_id,)).fetchall()
    ]
    protected_keys = {key for key in set(current) | set(incoming) if _TASK_PROTECTED_KEY_RE.search(str(key))}
    changed = sorted(key for key in protected_keys if _json_value(current.get(key)) != _json_value(incoming.get(key)))
    if changed:
        return {
            "status": 403,
            "errorCode": "TASK_FIELDS_DENIED",
            "error": "贡献者操作不能修改任务计划、归属、执行人或样机分配",
            "fields": changed,
        }
    common_fields = {"updatedAt", "logs"}
    mutable_by_action = {
        "start_task": common_fields | {"status", "completed", "startDate", "completionType", "completedAt", "blockReason"},
        "restart_task": common_fields | {"status", "completed", "startDate", "completionType", "completedAt", "blockReason"},
        "block_task": common_fields | {"status", "completed", "blockReason", "issue"},
        "finish_task_result": common_fields | {
            "status", "completed", "completionType", "completedAt", "endDate", "resultDate",
            "latestResult", "result", "resultDraft", "resultUploads", "attachments",
            "problemRecords", "issueRecords", "sampleFaultRecords", "issue",
        },
        "upload_task_result": common_fields | {
            "resultDate", "latestResult", "result", "resultDraft", "resultUploads", "attachments",
            "problemRecords", "issueRecords", "sampleFaultRecords",
        },
        "save_task_result_draft": common_fields | {"resultDraft"},
        "update_issue_record": common_fields | {"problemRecords", "issueRecords", "sampleFaultRecords", "issue"},
    }
    allowed_changed_fields = mutable_by_action.get(action, common_fields)
    unexpected_changed = sorted(
        key for key in (set(current) | set(incoming))
        if key not in allowed_changed_fields and _json_value(current.get(key)) != _json_value(incoming.get(key))
    )
    if unexpected_changed:
        return {
            "status": 403,
            "errorCode": "TASK_FIELDS_DENIED",
            "error": "贡献者操作包含当前动作未授权的任务字段变更",
            "fields": unexpected_changed,
        }
    append_only_fields = {
        "logs", "resultUploads", "attachments", "problemRecords", "issueRecords", "sampleFaultRecords",
    }
    append_changed = sorted(
        field for field in append_only_fields
        if (
            (field in incoming and _append_only_failure(current.get(field), incoming.get(field)))
            or (field not in incoming and isinstance(current.get(field), list) and bool(current.get(field)))
        )
    )
    if append_changed:
        return {
            "status": 403,
            "errorCode": "TASK_HISTORY_REWRITE_DENIED",
            "error": "贡献者只能追加结果、问题、附件和日志，不能覆盖或删除既有记录",
            "fields": append_changed,
        }
    draft_actions = {"save_task_result_draft", "upload_task_result", "finish_task_result"}
    if action not in draft_actions and "resultDraft" in incoming and _json_value(current.get("resultDraft")) != _json_value(incoming.get("resultDraft")):
        return {
            "status": 403,
            "errorCode": "TASK_RESULT_REWRITE_DENIED",
            "error": "当前贡献者操作不能改写结果草稿",
            "fields": ["resultDraft"],
        }
    return None


def _contributor_sample_payload_failure(conn: sqlite3.Connection, payload: dict, task_id: str, action: str) -> dict | None:
    task_row = conn.execute(
        "SELECT project_id, stage_id, test_item, sample_ids_json FROM project_tasks WHERE id = ? AND deleted_at IS NULL",
        (task_id,),
    ).fetchone()
    allowed_ids = {str(value or "") for value in json.loads(task_row["sample_ids_json"] or "[]")} if task_row else set()
    incoming_task = payload.get("task") if isinstance(payload.get("task"), dict) else {}
    allowed_ids.update(str(value or "") for value in incoming_task.get("sampleIds") or [])
    presentation_fields = {"effectiveStatus", "hasProblem", "categoryName", "photosLoaded", "photoCount", "accessRole", "canOpen", "canManage"}
    workflow_fields = {"status", "currentProjectId", "currentStageId", "currentTaskId", "currentTestItem"}
    append_fields = {"problemRecords", "initialResults"}
    append_actions = {"upload_task_result", "finish_task_result", "update_issue_record"}
    for incoming in payload.get("samples") or []:
        if not isinstance(incoming, dict):
            return {"status": 403, "errorCode": "TASK_SAMPLE_FIELDS_DENIED", "error": "贡献者样机载荷格式无效"}
        sample_id = str(incoming.get("id") or "")
        if not sample_id or sample_id not in allowed_ids:
            return {"status": 403, "errorCode": "TASK_SAMPLE_FIELDS_DENIED", "error": "贡献者不能修改任务范围外的样机"}
        row = conn.execute("SELECT * FROM sample_records WHERE id = ? AND deleted_at IS NULL", (sample_id,)).fetchone()
        if not row:
            return {"status": 403, "errorCode": "TASK_SAMPLE_FIELDS_DENIED", "error": "样机档案不存在"}
        current = json.loads(row["data_json"] or "{}")
        current.update({"id": sample_id, "categoryId": str(row["category_id"] or ""), "status": str(row["status"] or current.get("status") or "")})
        denied_fields = []
        for key, value in incoming.items():
            if key in presentation_fields or key in workflow_fields or key == "updatedAt":
                continue
            if key in append_fields and action in append_actions:
                if _append_only_failure(current.get(key), value):
                    denied_fields.append(key)
                continue
            if _json_value(current.get(key)) != _json_value(value):
                denied_fields.append(key)
        if denied_fields:
            return {
                "status": 403,
                "errorCode": "TASK_SAMPLE_FIELDS_DENIED",
                "error": "贡献者任务操作不能修改样机位置、人员、身份或其他主档字段",
                "sampleId": sample_id,
                "fields": sorted(set(denied_fields)),
            }
        expected = {field: current.get(field) for field in workflow_fields}
        if action in {"start_task", "restart_task", "block_task"}:
            expected.update({
                "status": "测试中" if action in {"start_task", "restart_task"} else "在位等待",
                "currentProjectId": str(task_row["project_id"] or ""),
                "currentStageId": str(task_row["stage_id"] or ""),
                "currentTaskId": task_id,
                "currentTestItem": str(task_row["test_item"] or ""),
            })
        elif action in {"finish_task_result", "upload_task_result"}:
            result_sample = None
            for upload in reversed((incoming_task.get("resultUploads") or [])):
                if not isinstance(upload, dict):
                    continue
                result_sample = next((
                    item for item in (upload.get("samples") or [])
                    if isinstance(item, dict) and str(item.get("sampleId") or item.get("sid") or "") == sample_id
                ), None)
                if result_sample:
                    break
            if not result_sample:
                return {
                    "status": 403,
                    "errorCode": "TASK_SAMPLE_WORKFLOW_DENIED",
                    "error": "结果操作中的样机状态缺少对应的新增结果记录，无法由服务器核实",
                    "sampleId": sample_id,
                }
            destination = status_normalization.normalize_sample_usage_status(result_sample.get("destination") or "闲置")
            if destination not in {"闲置", "已退库", "取走分析"}:
                return {
                    "status": 403,
                    "errorCode": "TASK_SAMPLE_WORKFLOW_DENIED",
                    "error": "结果操作只能把样机流转到已定义的任务结束状态",
                    "sampleId": sample_id,
                }
            expected.update({
                "status": destination,
                "currentProjectId": "",
                "currentStageId": "",
                "currentTaskId": "",
                "currentTestItem": "",
            })

        workflow_mismatch = []
        for field in workflow_fields:
            if field not in incoming:
                continue
            actual_value = incoming.get(field)
            expected_value = expected.get(field)
            if field == "status":
                actual_value = status_normalization.normalize_sample_usage_status(actual_value)
                expected_value = status_normalization.normalize_sample_usage_status(expected_value)
            else:
                actual_value = str(actual_value or "")
                expected_value = str(expected_value or "")
            if actual_value != expected_value:
                workflow_mismatch.append(field)
        if workflow_mismatch:
            return {
                "status": 403,
                "errorCode": "TASK_SAMPLE_WORKFLOW_DENIED",
                "error": "贡献者不能自行指定样机流程状态或占用归属",
                "sampleId": sample_id,
                "fields": sorted(workflow_mismatch),
            }
    return None


def _forbidden(message: str, *, code: str = "ACCESS_DENIED") -> tuple[bool, dict]:
    return False, {"status": 403, "errorCode": code, "error": message}


def authorize_task_mutation(conn: sqlite3.Connection, payload: dict, client_ip: object, *, batch: bool = False) -> tuple[bool, dict]:
    actor = access_context(client_ip)
    if actor.is_local_admin:
        return True, {"actorRole": "local_admin"}
    action = str(payload.get("action") or ("create_tasks_batch" if batch else ""))
    task_id = str(payload.get("taskId") or ((payload.get("task") or {}).get("id") if isinstance(payload.get("task"), dict) else ""))
    real_project_id, real_stage_id = task_scope(conn, task_id) if task_id else ("", "")
    project_id = real_project_id or str(payload.get("projectId") or ((payload.get("task") or {}).get("projectId") if isinstance(payload.get("task"), dict) else ""))
    stage_id = real_stage_id or str(payload.get("stageId") or ((payload.get("task") or {}).get("stageId") if isinstance(payload.get("task"), dict) else ""))
    if not project_id or not stage_id or project_id_for_stage(conn, stage_id) != project_id:
        return _forbidden("无法确认任务所属项目，已拒绝写入", code="RESOURCE_SCOPE_DENIED")
    required = "contributor" if action in CONTRIBUTOR_TASK_ACTIONS else "project_admin"
    if action not in CONTRIBUTOR_TASK_ACTIONS | PROJECT_ADMIN_TASK_ACTIONS:
        required = "project_admin"
    if not has_project_role(conn, project_id, actor.client_ip, required):
        return _forbidden(f"当前 IP 缺少项目 {required} 权限")
    if required == "contributor":
        incoming_task = payload.get("task") if isinstance(payload.get("task"), dict) else {}
        field_failure = _contributor_task_payload_failure(conn, task_id, incoming_task, action)
        if field_failure:
            return False, field_failure
        sample_field_failure = _contributor_sample_payload_failure(conn, payload, task_id, action)
        if sample_field_failure:
            return False, sample_field_failure
    if action in {"create_task_config", "save_task_config", "assign_task_samples", "reassign_task_samples", "temp_change_task", "create_tasks_batch"}:
        task_payloads = (
            [item for item in (payload.get("tasks") or []) if isinstance(item, dict)]
            if action == "create_tasks_batch" or batch
            else [payload.get("task") if isinstance(payload.get("task"), dict) else {}]
        )
        sample_ids = {
            str(value or "")
            for task_payload in task_payloads
            for value in (task_payload.get("sampleIds") or [])
            if str(value or "")
        }
        if sample_ids:
            placeholders = ",".join("?" for _ in sample_ids)
            rows = conn.execute(
                f"SELECT id, category_id FROM sample_records WHERE id IN ({placeholders}) AND deleted_at IS NULL",
                sorted(sample_ids),
            ).fetchall()
            found = {str(row["id"]): str(row["category_id"]) for row in rows}
            if set(found) != sample_ids:
                return _forbidden("样机分配包含不存在的样机", code="RESOURCE_SCOPE_DENIED")
            denied_categories = sorted({cat for cat in found.values() if not has_pool_role(conn, cat, actor.client_ip, "pool_viewer")})
            if denied_categories:
                return _forbidden("项目管理员还需要对应样机池的查看权限", code="POOL_ACCESS_REQUIRED")
            bound_categories = project_bound_pool_ids(conn, project_id)
            unbound_categories = sorted({cat for cat in found.values() if cat not in bound_categories})
            if unbound_categories:
                return _forbidden("样机只能从已绑定到本项目的样机池分配", code="PROJECT_POOL_BINDING_REQUIRED")
    return True, {"projectId": project_id, "stageId": stage_id, "actorRole": project_role(conn, project_id, actor.client_ip)}


def authorize_project_mutation(conn: sqlite3.Connection, payload: dict, client_ip: object) -> tuple[bool, dict]:
    actor = access_context(client_ip)
    if actor.is_local_admin:
        project_id = str(payload.get("projectId") or ((payload.get("project") or {}).get("id") if isinstance(payload.get("project"), dict) else ""))
        return True, {"projectId": project_id, "actorRole": "local_admin"}
    project_id = str(payload.get("projectId") or ((payload.get("project") or {}).get("id") if isinstance(payload.get("project"), dict) else ""))
    if payload.get("deleteProject") or str(payload.get("action") or "") == "delete_project":
        return (True, {"projectId": project_id, "actorRole": "local_admin"}) if actor.is_local_admin else _forbidden("删除项目仅限 localhost 本机管理员")
    exists = conn.execute("SELECT 1 FROM project_records WHERE id = ? AND deleted_at IS NULL", (project_id,)).fetchone()
    if not exists:
        return (True, {"projectId": project_id, "actorRole": "local_admin"}) if actor.is_local_admin else _forbidden("创建项目仅限 localhost 本机管理员")
    if not has_project_role(conn, project_id, actor.client_ip, "project_admin"):
        return _forbidden("当前 IP 缺少项目管理员权限")
    if (payload.get("samples") or []) or (payload.get("sampleEvents") or []):
        return _forbidden("项目资料接口不能携带样机主档或样机事件", code="NESTED_RESOURCE_DENIED")
    row = conn.execute("SELECT data_json FROM project_records WHERE id = ? AND deleted_at IS NULL", (project_id,)).fetchone()
    incoming_project = payload.get("project") if isinstance(payload.get("project"), dict) else {}
    current_project = json.loads(row["data_json"] or "{}") if row else {}
    prospective = {**current_project, **incoming_project}

    def binding_ids(project: dict) -> set[str]:
        result = {str(project.get("defaultSampleCategoryId") or "")}
        for key in ("sampleCategoryIds", "boundSampleCategoryIds"):
            result.update(str(value or "") for value in project.get(key) or [])
        return {value for value in result if value}

    changed_bindings = binding_ids(current_project) ^ binding_ids(prospective)
    if changed_bindings:
        existing_rows = conn.execute(
            f"SELECT id FROM sample_categories WHERE id IN ({','.join('?' for _ in changed_bindings)}) AND deleted_at IS NULL",
            sorted(changed_bindings),
        ).fetchall()
        existing_ids = {str(item["id"] or "") for item in existing_rows}
        if existing_ids != changed_bindings:
            return _forbidden("项目绑定包含不存在的样机池", code="RESOURCE_SCOPE_DENIED")
        denied = sorted(
            category_id for category_id in changed_bindings
            if not has_pool_role(conn, category_id, actor.client_ip, "pool_admin")
        )
        if denied:
            return _forbidden("新增或移除项目样机池绑定需要对应池管理员权限", code="POOL_ADMIN_REQUIRED")
    return True, {"projectId": project_id, "actorRole": project_role(conn, project_id, actor.client_ip)}


def authorize_stage_mutation(conn: sqlite3.Connection, payload: dict, client_ip: object) -> tuple[bool, dict]:
    if access_context(client_ip).is_local_admin:
        return True, {"actorRole": "local_admin"}
    stage_id = str(payload.get("stageId") or ((payload.get("stage") or {}).get("id") if isinstance(payload.get("stage"), dict) else ""))
    real_project_id = project_id_for_stage(conn, stage_id)
    project_id = real_project_id or str(payload.get("projectId") or ((payload.get("stage") or {}).get("projectId") if isinstance(payload.get("stage"), dict) else ""))
    if not project_id or (real_project_id and real_project_id != project_id):
        return _forbidden("阶段所属项目不匹配", code="RESOURCE_SCOPE_DENIED")
    if not has_project_role(conn, project_id, client_ip, "project_admin"):
        return _forbidden("当前 IP 缺少项目管理员权限")
    if not access_context(client_ip).is_local_admin and ((payload.get("samples") or []) or (payload.get("sampleEvents") or [])):
        return _forbidden("阶段接口不能携带跨资源样机写入", code="NESTED_RESOURCE_DENIED")
    return True, {"projectId": project_id, "stageId": stage_id, "actorRole": project_role(conn, project_id, client_ip)}


_PENDING_DESTROY_MUTABLE_TASK_FIELDS = {
    "sampleIds", "logs", "sampleSnapshots", "removedSampleRecords", "updatedAt", "flowStatus",
}
_ACTIVE_DESTROY_MUTABLE_TASK_FIELDS = _PENDING_DESTROY_MUTABLE_TASK_FIELDS | {
    "status", "completed", "completionType", "completedAt", "endDate", "resultDate",
    "latestResult", "issue",
}


def _active_destroy_task_rows(conn: sqlite3.Connection, destroyed_sample_ids: set[str]) -> dict[str, sqlite3.Row]:
    if not destroyed_sample_ids:
        return {}
    placeholders = ",".join("?" for _ in destroyed_sample_ids)
    rows = conn.execute(
        f"""
        SELECT DISTINCT t.*
        FROM project_task_samples AS pts
        JOIN project_tasks AS t ON t.id = pts.task_id
        WHERE pts.sample_id IN ({placeholders})
          AND t.deleted_at IS NULL
          AND t.flow_status NOT IN ('正常完成', '异常终止')
        """,
        tuple(sorted(destroyed_sample_ids)),
    ).fetchall()
    return {str(row["id"] or ""): row for row in rows if str(row["id"] or "")}


def _remote_destroy_payload_failure(
    conn: sqlite3.Connection,
    payload: dict,
    destroyed_sample_ids: set[str],
) -> dict | None:
    """Validate the preview-shaped destroy request before server-side rebuilding.

    Remote pool administrators may confirm the current impact, but they never
    get to provide authoritative task/stage/sample records.  The mutation
    service rebuilds those records from SQLite after this shape/diff check.
    """
    if not (payload.get("taskMutations") or payload.get("samples") or payload.get("sampleEvents")):
        return None
    rows = _active_destroy_task_rows(conn, destroyed_sample_ids)
    supplied: dict[str, dict] = {}
    task_mutations = payload.get("taskMutations") or []
    if not isinstance(task_mutations, list):
        return {"status": 403, "errorCode": "DESTROY_PAYLOAD_DENIED", "error": "销毁任务联动载荷格式无效"}
    for item in task_mutations:
        if not isinstance(item, dict) or not isinstance(item.get("task"), dict):
            return {"status": 403, "errorCode": "DESTROY_PAYLOAD_DENIED", "error": "销毁任务联动载荷格式无效"}
        task = item["task"]
        task_id = str(item.get("taskId") or task.get("id") or "")
        if not task_id or task_id in supplied or item.get("createIfMissing"):
            return {"status": 403, "errorCode": "DESTROY_TASK_REWRITE_DENIED", "error": "销毁操作不能创建或重复写入任务"}
        supplied[task_id] = item
    if set(supplied) != set(rows):
        return {
            "status": 409,
            "errorCode": "SAMPLE_DESTROY_SCOPE_CHANGED",
            "error": "样机占用关系已变化或任务联动载荷不完整，已拒绝销毁。",
            "missingTaskIds": sorted(set(rows) - set(supplied)),
            "unexpectedTaskIds": sorted(set(supplied) - set(rows)),
        }

    allowed_related_sample_ids: set[str] = set(destroyed_sample_ids)
    verified_task_contexts: set[tuple[str, str, str]] = set()
    for task_id, row in rows.items():
        item = supplied[task_id]
        incoming = item["task"]
        project_id = str(row["project_id"] or "")
        stage_id = str(row["stage_id"] or "")
        if str(item.get("projectId") or project_id) != project_id or str(item.get("stageId") or stage_id) != stage_id:
            return {"status": 403, "errorCode": "DESTROY_TASK_REWRITE_DENIED", "error": "销毁任务归属与数据库记录不一致"}
        if str(incoming.get("id") or task_id) != task_id:
            return {"status": 403, "errorCode": "DESTROY_TASK_REWRITE_DENIED", "error": "销毁操作不能改写任务 ID"}

        current = json.loads(row["data_json"] or "{}")
        current.update({
            "id": task_id,
            "projectId": project_id,
            "stageId": stage_id,
            "sampleIds": json.loads(row["sample_ids_json"] or "[]"),
            "status": str(row["status"] or current.get("status") or ""),
            "flowStatus": str(row["flow_status"] or "待下发"),
        })
        if row["created_at"]:
            current.setdefault("createdAt", str(row["created_at"]))
        current_sample_ids = {str(value or "") for value in current.get("sampleIds") or [] if str(value or "")}
        allowed_related_sample_ids.update(current_sample_ids)
        flow_status = str(row["flow_status"] or "待下发")
        mutable_fields = (
            _ACTIVE_DESTROY_MUTABLE_TASK_FIELDS
            if flow_status in {"进行中", "阻塞中"}
            else _PENDING_DESTROY_MUTABLE_TASK_FIELDS
        )
        changed = sorted(
            key for key, value in incoming.items()
            if key not in mutable_fields and _json_value(current.get(key)) != _json_value(value)
        )
        if changed:
            return {
                "status": 403,
                "errorCode": "DESTROY_TASK_REWRITE_DENIED",
                "error": "样机销毁联动只能改变服务器允许的任务状态与样机引用",
                "taskId": task_id,
                "fields": changed,
            }

        incoming_sample_ids = {
            str(value or "") for value in incoming.get("sampleIds") or [] if str(value or "")
        }
        if flow_status in {"进行中", "阻塞中"}:
            if incoming_sample_ids:
                return {"status": 403, "errorCode": "DESTROY_TASK_REWRITE_DENIED", "error": "进行中或阻塞任务销毁联动后必须清空样机", "taskId": task_id}
            if str(incoming.get("status") or incoming.get("flowStatus") or "") not in {"异常终止", "异常完成", "失败"}:
                return {"status": 403, "errorCode": "DESTROY_TASK_REWRITE_DENIED", "error": "进行中或阻塞任务只能由销毁流程异常终止", "taskId": task_id}
            if "latestResult" in incoming and str(incoming.get("latestResult") or "") != "不通过":
                return {"status": 403, "errorCode": "DESTROY_TASK_REWRITE_DENIED", "error": "销毁导致的异常终止结果必须为不通过", "taskId": task_id}
        else:
            expected_ids = current_sample_ids - destroyed_sample_ids
            if incoming_sample_ids != expected_ids:
                return {"status": 403, "errorCode": "DESTROY_TASK_REWRITE_DENIED", "error": "待下发任务只能移除待销毁样机", "taskId": task_id}
        verified_task_contexts.add((project_id, stage_id, task_id))

    supplied_samples = payload.get("samples") or []
    if not isinstance(supplied_samples, list):
        return {"status": 403, "errorCode": "DESTROY_PAYLOAD_DENIED", "error": "销毁样机联动载荷格式无效"}
    for sample in supplied_samples:
        sample_id = str(sample.get("id") or "") if isinstance(sample, dict) else ""
        if not sample_id or sample_id in destroyed_sample_ids or sample_id not in allowed_related_sample_ids:
            return {"status": 403, "errorCode": "DESTROY_SAMPLE_SCOPE_DENIED", "error": "销毁联动包含无关样机", "sampleId": sample_id}

    events = payload.get("sampleEvents") or []
    if not isinstance(events, list):
        return {"status": 403, "errorCode": "DESTROY_PAYLOAD_DENIED", "error": "销毁事件载荷格式无效"}
    for event in events:
        if not isinstance(event, dict) or str(event.get("sampleId") or "") not in allowed_related_sample_ids:
            return {"status": 403, "errorCode": "DESTROY_EVENT_SCOPE_DENIED", "error": "销毁事件超出核实的样机范围"}
        event_id = str(event.get("id") or "")
        if event_id and conn.execute("SELECT 1 FROM sample_events WHERE id = ?", (event_id,)).fetchone():
            continue
        source = str(event.get("source") or event.get("action") or "")
        if "销毁" not in source:
            return {"status": 403, "errorCode": "DESTROY_EVENT_SCOPE_DENIED", "error": "销毁流程不能注入无关样机事件"}
        task_id = str(event.get("taskId") or "")
        if task_id:
            context = (str(event.get("projectId") or ""), str(event.get("stageId") or ""), task_id)
            if context not in verified_task_contexts:
                sample_id = str(event.get("sampleId") or "")
                actual = conn.execute(
                    """
                    SELECT t.project_id, t.stage_id
                    FROM project_task_samples AS pts
                    JOIN project_tasks AS t ON t.id = pts.task_id
                    WHERE pts.sample_id = ? AND t.id = ? AND t.deleted_at IS NULL
                    """,
                    (sample_id, task_id),
                ).fetchone()
                if not actual or context[:2] != (str(actual["project_id"] or ""), str(actual["stage_id"] or "")):
                    return {"status": 403, "errorCode": "DESTROY_EVENT_SCOPE_DENIED", "error": "销毁事件任务上下文与数据库不一致"}
    return None


_REMOTE_POOL_SAMPLE_PROTECTED_FIELDS = {
    "problemRecords", "problems", "issueRecords", "initialResults", "initialResult",
    "currentProjectId", "currentStageId", "currentTaskId", "currentTestItem",
    "projectName", "stageName", "taskName", "logs", "events", "history",
    "resultUploads", "results", "attachments", "taskResults", "photos", "ctData", "ctFiles",
}


def _remote_pool_sample_hidden_field_failure(conn: sqlite3.Connection, sample_id: str, incoming: dict) -> dict | None:
    row = conn.execute("SELECT data_json FROM sample_records WHERE id = ? AND deleted_at IS NULL", (sample_id,)).fetchone()
    current = json.loads(row["data_json"] or "{}") if row else {}
    changed = sorted(
        field for field in _REMOTE_POOL_SAMPLE_PROTECTED_FIELDS
        if field in incoming and _json_value(current.get(field)) != _json_value(incoming.get(field))
    )
    if not changed:
        return None
    return {
        "status": 403,
        "errorCode": "SAMPLE_HIDDEN_FIELDS_DENIED",
        "error": "样机池角色不能通过主档接口改写项目结果、附件、占用或历史字段",
        "fields": changed,
    }


def authorize_sample_mutation(conn: sqlite3.Connection, payload: dict, client_ip: object) -> tuple[bool, dict]:
    if access_context(client_ip).is_local_admin:
        return True, {"actorRole": "local_admin"}
    sample_id = str(payload.get("sampleId") or ((payload.get("sample") or {}).get("id") if isinstance(payload.get("sample"), dict) else ""))
    category_id = category_id_for_sample(conn, sample_id)
    if not category_id:
        return _forbidden("无法确认样机所属样机池", code="RESOURCE_SCOPE_DENIED")
    action = str(payload.get("action") or "")
    required = "pool_admin" if payload.get("deleteSample") or action in {"destroy_sample", "migrate_sample"} else "pool_maintainer"
    if not has_pool_role(conn, category_id, client_ip, required):
        return _forbidden(f"当前 IP 缺少样机池 {required} 权限")
    actor = access_context(client_ip)
    if not actor.is_local_admin:
        incoming = payload.get("sample") if isinstance(payload.get("sample"), dict) else {}
        destination_category_id = str(incoming.get("categoryId") or category_id) if incoming else category_id
        if destination_category_id != category_id:
            if action != "migrate_sample":
                return _forbidden("只有明确的 migrate_sample 操作可以迁移样机", code="RESOURCE_SCOPE_DENIED")
            destination_exists = conn.execute(
                "SELECT 1 FROM sample_categories WHERE id = ? AND deleted_at IS NULL",
                (destination_category_id,),
            ).fetchone()
            if not destination_exists:
                return _forbidden("目标样机池不存在", code="RESOURCE_SCOPE_DENIED")
            if not has_pool_role(conn, destination_category_id, client_ip, "pool_admin"):
                return _forbidden("迁移样机需要同时具备来源池和目标池的池管理员权限", code="POOL_ADMIN_REQUIRED")
        if payload.get("deleteSample"):
            destroy_failure = _remote_destroy_payload_failure(conn, payload, {sample_id})
            if destroy_failure:
                return False, destroy_failure
        else:
            if payload.get("taskMutations") or payload.get("samples"):
                return _forbidden("样机主档接口不能携带任务或其他样机写入", code="NESTED_RESOURCE_DENIED")
            hidden_failure = _remote_pool_sample_hidden_field_failure(conn, sample_id, incoming)
            if hidden_failure:
                return False, hidden_failure
            event_failure = _validate_maintenance_events(conn, payload.get("sampleEvents") or [], {sample_id})
            if event_failure:
                return False, event_failure
    return True, {"categoryId": category_id, "sampleId": sample_id, "actorRole": pool_role(conn, category_id, client_ip)}


def authorize_sample_category_mutation(conn: sqlite3.Connection, payload: dict, client_ip: object) -> tuple[bool, dict]:
    actor = access_context(client_ip)
    if actor.is_local_admin:
        category_id = str(payload.get("categoryId") or ((payload.get("category") or {}).get("id") if isinstance(payload.get("category"), dict) else ""))
        return True, {"categoryId": category_id, "actorRole": "local_admin"}
    category_id = str(payload.get("categoryId") or ((payload.get("category") or {}).get("id") if isinstance(payload.get("category"), dict) else ""))
    action = str(payload.get("action") or "")
    exists = conn.execute("SELECT 1 FROM sample_categories WHERE id = ? AND deleted_at IS NULL", (category_id,)).fetchone()
    if not exists:
        return (True, {"categoryId": category_id, "actorRole": "local_admin"}) if actor.is_local_admin else _forbidden("创建样机池仅限 localhost 本机管理员")
    if payload.get("deleteCategory") or action == "destroy_sample_category":
        required = "pool_admin"
    elif action in {"create_sample", "import_samples"} or payload.get("createSamples"):
        required = "pool_maintainer"
    else:
        required = "pool_admin"
    if not has_pool_role(conn, category_id, actor.client_ip, required):
        return _forbidden(f"当前 IP 缺少样机池 {required} 权限")
    if not actor.is_local_admin:
        incoming_samples = [item for item in (payload.get("samples") or []) if isinstance(item, dict)]
        existing_ids: set[str] = set()
        for item in incoming_samples:
            sample_id = str(item.get("id") or "")
            row = conn.execute(
                "SELECT category_id FROM sample_records WHERE id = ? AND deleted_at IS NULL",
                (sample_id,),
            ).fetchone()
            actual_category = str(row["category_id"] or "") if row else str(item.get("categoryId") or category_id)
            if actual_category != category_id:
                return _forbidden("样机池操作包含其他样机池的样机", code="RESOURCE_SCOPE_DENIED")
            if row:
                existing_ids.add(sample_id)
        if action in {"create_sample", "import_samples"} or payload.get("createSamples"):
            category_failure = _incoming_category_changes_existing(conn, category_id, payload.get("category"))
            if category_failure:
                return False, category_failure
            if payload.get("taskMutations"):
                return _forbidden("新增或导入样机不能携带任务写入", code="NESTED_RESOURCE_DENIED")
            event_failure = _validate_maintenance_events(
                conn,
                payload.get("sampleEvents") or [],
                {str(item.get("id") or "") for item in incoming_samples},
            )
            if event_failure:
                return False, event_failure
        elif not payload.get("deleteCategory"):
            if incoming_samples or payload.get("sampleEvents") or payload.get("taskMutations"):
                return _forbidden("样机池资料接口不能携带样机、事件或任务写入", code="NESTED_RESOURCE_DENIED")
        else:
            rows = conn.execute(
                "SELECT id FROM sample_records WHERE category_id = ? AND deleted_at IS NULL",
                (category_id,),
            ).fetchall()
            destroy_failure = _remote_destroy_payload_failure(
                conn,
                payload,
                {str(row["id"] or "") for row in rows if str(row["id"] or "")},
            )
            if destroy_failure:
                return False, destroy_failure
    return True, {"categoryId": category_id, "actorRole": pool_role(conn, category_id, actor.client_ip)}


def _validate_maintenance_events(conn: sqlite3.Connection, events: list, allowed_sample_ids: set[str]) -> dict | None:
    for event in events:
        if not isinstance(event, dict):
            return {"status": 403, "errorCode": "EVENT_SCOPE_DENIED", "error": "样机事件格式无效"}
        sample_id = str(event.get("sampleId") or "")
        if sample_id not in allowed_sample_ids:
            return {"status": 403, "errorCode": "EVENT_SCOPE_DENIED", "error": "样机事件超出当前样机范围"}
        event_id = str(event.get("id") or "")
        row = conn.execute("SELECT data_json FROM sample_events WHERE id = ?", (event_id,)).fetchone() if event_id else None
        if row:
            existing = json.loads(row["data_json"] or "{}")
            if _json_value(existing) != _json_value(event):
                return {"status": 403, "errorCode": "EVENT_REWRITE_DENIED", "error": "不能改写已有样机事件"}
            continue
        if any(str(event.get(key) or "") for key in ("projectId", "stageId", "taskId")):
            return {"status": 403, "errorCode": "EVENT_SCOPE_DENIED", "error": "样机池维护事件不能伪造项目或任务上下文"}
        if event_has_business_details(event):
            return {"status": 403, "errorCode": "EVENT_FIELDS_DENIED", "error": "样机池维护事件不能写入项目结果、问题或附件字段"}
    return None


def _incoming_category_changes_existing(conn: sqlite3.Connection, category_id: str, incoming: object) -> dict | None:
    if not isinstance(incoming, dict):
        return None
    row = conn.execute("SELECT name, description, data_json FROM sample_categories WHERE id = ?", (category_id,)).fetchone()
    if not row:
        return None
    current = json.loads(row["data_json"] or "{}")
    current.update({"id": category_id, "name": str(row["name"] or ""), "description": str(row["description"] or "")})
    ignored = {"samples", "sampleCount", "samplesLoaded", "statusCounts", "problemCounts", "accessRole", "canOpen", "canContribute", "canManage"}
    changed = sorted(
        key for key, value in incoming.items()
        if key not in ignored and _json_value(current.get(key)) != _json_value(value)
    )
    if changed:
        return {
            "status": 403,
            "errorCode": "POOL_FIELDS_DENIED",
            "error": "池维护者新增或导入样机时不能同时修改样机池资料",
            "fields": changed,
        }
    return None


def sanitize_identity_conflicts(conn: sqlite3.Connection, result: dict, client_ip: object) -> dict:
    """Keep duplicate detection useful without disclosing another pool's archive."""
    actor = access_context(client_ip)
    if actor.is_local_admin:
        return result

    def sanitize(conflict: object) -> dict | None:
        if not isinstance(conflict, dict):
            return None
        category_id = str(conflict.get("categoryId") or "")
        if category_id and has_pool_role(conn, category_id, actor.client_ip, "pool_viewer"):
            return copy.deepcopy(conflict)
        return {
            "index": conflict.get("index"),
            "scope": "restricted",
            "restricted": True,
            "incomingField": conflict.get("incomingField"),
            "incomingLabel": conflict.get("incomingLabel"),
            "message": "检测到其他无权样机池中存在重复标识，详细档案已隐藏。",
        }

    output = copy.deepcopy(result)
    clean_conflicts = []
    for item in output.get("results") or []:
        if not isinstance(item, dict) or not item.get("conflict"):
            continue
        item["conflict"] = sanitize(item.get("conflict"))
        if item["conflict"]:
            clean_conflicts.append(copy.deepcopy(item["conflict"]))
    output["conflicts"] = clean_conflicts
    output["count"] = len(clean_conflicts)
    return output


def sanitize_destroy_impact(conn: sqlite3.Connection, result: dict, client_ip: object) -> dict:
    """Expose only confirmation counts/statuses to a remote pool administrator."""
    if access_context(client_ip).is_local_admin:
        return result
    task_ids = [str(value or "") for value in result.get("taskIds") or [] if str(value or "")]
    status_counts: dict[str, int] = {}
    if task_ids:
        placeholders = ",".join("?" for _ in task_ids)
        rows = conn.execute(
            f"SELECT COALESCE(flow_status, '待下发') AS flow_status, COUNT(*) AS count FROM project_tasks WHERE id IN ({placeholders}) GROUP BY flow_status",
            task_ids,
        ).fetchall()
        status_counts = {str(row["flow_status"] or "待下发"): int(row["count"] or 0) for row in rows}
    return {
        "sampleId": str(result.get("sampleId") or ""),
        "categoryId": str(result.get("categoryId") or ""),
        "sampleCount": len(result.get("sampleIds") or []),
        "relatedSampleCount": len(result.get("relatedSampleIds") or []),
        "projectCount": len(result.get("projectIds") or []),
        "stageCount": len(result.get("stageIds") or []),
        "taskCount": len(task_ids),
        "relatedPoolCount": len(result.get("sampleCategoryIds") or []),
        "taskStatusCounts": status_counts,
        "serverManagedLinkage": True,
    }


_BUSINESS_EVENT_KEYS = {
    "projectName", "stageId", "stageName", "taskId", "testItem", "result", "latestResult",
    "problem", "problems", "problemRecords", "resultPhotos", "attachments", "resultUploads",
}


def event_has_business_details(event: object) -> bool:
    return isinstance(event, dict) and any(
        key in event and event.get(key) not in (None, "", [], {})
        for key in _BUSINESS_EVENT_KEYS
    )


def filter_sample_events_for_actor(conn: sqlite3.Connection, events: Iterable[dict], client_ip: object) -> list[dict]:
    """Hide other projects' business details from pool-only viewers."""
    actor = access_context(client_ip)
    if actor.is_local_admin:
        return list(events)
    output = []
    for event in events:
        project_id = str(event.get("projectId") or event.get("project_id") or "")
        if project_id and has_project_role(conn, project_id, actor.client_ip, "viewer"):
            output.append(event)
            continue
        if not project_id and not event_has_business_details(event):
            output.append(event)
            continue
        # Pool access may reveal occupancy/status, never task result/detail fields.
        output.append({
            "id": event.get("id"),
            "sampleId": event.get("sampleId"),
            "time": event.get("time"),
            "eventType": "项目占用状态",
            "redacted": True,
        })
    return output


def filter_sample_history_for_actor(
    conn: sqlite3.Connection,
    result: dict,
    client_ip: object,
    *,
    project_id: str = "",
) -> dict:
    actor = access_context(client_ip)
    if actor.is_local_admin:
        return result
    filtered = []
    for source in result.get("items") or []:
        item = copy.deepcopy(source)
        task = item.get("task") if isinstance(item.get("task"), dict) else {}
        item_project_ids = {str(task.get("projectId") or "")} if str(task.get("projectId") or "") else set()
        for log in item.get("logs") or []:
            if isinstance(log, dict) and str(log.get("projectId") or ""):
                item_project_ids.add(str(log.get("projectId") or ""))
        if project_id and project_id not in item_project_ids:
            continue
        unscoped_business = not item_project_ids and (
            any(str(item.get(key) or "") not in {"", "-", "[]"} for key in ("projectName", "stageName", "testItem", "result"))
            or bool(item.get("problems") or item.get("resultPhotos"))
            or any(event_has_business_details(log) for log in item.get("logs") or [])
        )
        denied = unscoped_business or any(
            not has_project_role(conn, item_project_id, actor.client_ip, "viewer")
            for item_project_id in item_project_ids
        )
        if denied:
            filtered.append({
                "key": item.get("key"),
                "task": None,
                "projectName": "受限项目",
                "stageName": "-",
                "testItem": "-",
                "logs": [],
                "status": item.get("status") or "项目占用",
                "result": "-",
                "date": item.get("date") or "-",
                "taskSampleCount": item.get("taskSampleCount") or 0,
                "faultMarked": False,
                "problems": [],
                "resultPhotos": [],
                "redacted": True,
            })
        else:
            filtered.append(item)
    output = {**result, "items": filtered}
    # The source total can reveal hidden project history; report only this page's
    # visible rows for project-scoped clients.
    if project_id:
        output["total"] = len(filtered)
        output["totalPages"] = 1
        output["page"] = 1
    return output


def sanitize_task_sample_candidates(
    conn: sqlite3.Connection,
    result: dict,
    client_ip: object,
    *,
    project_id: str,
) -> dict:
    actor = access_context(client_ip)
    if actor.is_local_admin:
        return result
    output = copy.deepcopy(result)
    for collection in ("items", "selectedItems"):
        clean_items = []
        for source in result.get(collection) or []:
            sample = sanitize_pool_sample(source, allow_occupancy_ids=False)
            occupancy = []
            for usage in source.get("occupyingTasks") or []:
                usage_project_id = str(usage.get("projectId") or "") if isinstance(usage, dict) else ""
                if usage_project_id == project_id or (
                    usage_project_id and has_project_role(conn, usage_project_id, actor.client_ip, "viewer")
                ):
                    occupancy.append(copy.deepcopy(usage))
                else:
                    occupancy.append({
                        "occupied": True,
                        "status": str((usage or {}).get("status") or "占用中"),
                        "redacted": True,
                    })
            sample["occupyingTasks"] = occupancy
            clean_items.append(sample)
        output[collection] = clean_items
    return output


_SAMPLE_PROJECT_DETAIL_FIELDS = {
    "problemRecords", "problems", "issueRecords", "initialResults", "initialResult",
    "currentTestItem", "projectName", "stageName", "taskName", "logs", "events",
    "history", "resultUploads", "results", "attachments", "taskResults",
}


def sanitize_pool_sample(sample: dict, *, allow_occupancy_ids: bool = False) -> dict:
    result = copy.deepcopy(sample)
    for key in _SAMPLE_PROJECT_DETAIL_FIELDS:
        result.pop(key, None)
    if allow_occupancy_ids:
        result["occupied"] = bool(
            sample.get("currentProjectId") or sample.get("currentStageId") or sample.get("currentTaskId")
            or str(sample.get("status") or "") in {"测试中", "在位等待"}
        )
    result.pop("currentProjectId", None)
    result.pop("currentStageId", None)
    result.pop("currentTaskId", None)
    result["photos"] = []
    result["photosLoaded"] = False
    return result


def public_photo_ids(conn: sqlite3.Connection, sample_id: str) -> set[str]:
    rows = conn.execute(
        """
        SELECT id FROM sample_assets
        WHERE sample_id = ? AND kind = 'photo' AND deleted_at IS NULL
          AND COALESCE(project_id, '') = '' AND COALESCE(task_id, '') = ''
        """,
        (sample_id,),
    ).fetchall()
    return {str(row["id"] or "") for row in rows}


def visible_photo_ids(conn: sqlite3.Connection, sample_id: str, client_ip: object, *, project_id: str = "") -> set[str]:
    actor = access_context(client_ip)
    if actor.is_local_admin:
        rows = conn.execute(
            "SELECT id FROM sample_assets WHERE sample_id = ? AND kind = 'photo' AND deleted_at IS NULL",
            (sample_id,),
        ).fetchall()
        return {str(row["id"] or "") for row in rows}
    visible = public_photo_ids(conn, sample_id)
    if project_id and has_project_role(conn, project_id, actor.client_ip, "viewer") and sample_is_linked_to_project(conn, sample_id, project_id):
        rows = conn.execute(
            """
            SELECT id FROM sample_assets
            WHERE sample_id = ? AND kind = 'photo' AND deleted_at IS NULL AND project_id = ?
            """,
            (sample_id, project_id),
        ).fetchall()
        visible.update(str(row["id"] or "") for row in rows)
    return visible


def photo_is_visible(conn: sqlite3.Connection, sample_id: str, photo_id: str, client_ip: object, *, project_id: str = "") -> bool:
    root_id = str(photo_id or "")
    if root_id.endswith("__thumb"):
        root_id = root_id[:-7]
    return root_id in visible_photo_ids(conn, sample_id, client_ip, project_id=project_id)


def filter_photo_list(conn: sqlite3.Connection, sample_id: str, photos: list[dict], client_ip: object, *, project_id: str = "") -> list[dict]:
    visible = visible_photo_ids(conn, sample_id, client_ip, project_id=project_id)
    actor = access_context(client_ip)
    if actor.is_local_admin:
        return [copy.deepcopy(photo) for photo in photos if str(photo.get("id") or "") in visible]
    rows = conn.execute(
        "SELECT id, project_id FROM sample_assets WHERE sample_id = ? AND kind = 'photo' AND deleted_at IS NULL",
        (sample_id,),
    ).fetchall()
    context_by_id = {str(row["id"] or ""): str(row["project_id"] or "") for row in rows}
    result = []
    for source in photos:
        photo_id = str(source.get("id") or "")
        if photo_id not in visible:
            continue
        photo = copy.deepcopy(source)
        for key in ("relativePath", "thumbRelativePath", "sourceRelativePath", "fileName", "path"):
            photo.pop(key, None)
        asset_project_id = context_by_id.get(photo_id, "")
        if asset_project_id:
            # The URL is itself capability-neutral; the server rechecks this
            # project id against the asset row and the socket peer on GET.
            suffix = f"projectId={quote(asset_project_id, safe='')}"
            for key in ("url", "thumbUrl", "thumbnailUrl"):
                url = str(photo.get(key) or "")
                if url:
                    photo[key] = f"{url}{'&' if '?' in url else '?'}{suffix}"
        result.append(photo)
    return result


def sanitize_sample_page(conn: sqlite3.Connection, result: dict, client_ip: object) -> dict:
    actor = access_context(client_ip)
    if actor.is_local_admin:
        return result
    category_id = str((result.get("category") or {}).get("id") or "")
    role = pool_role(conn, category_id, actor.client_ip)
    allow_occupancy = POOL_ROLE_RANK.get(role, 0) >= POOL_ROLE_RANK["pool_admin"]
    output = copy.deepcopy(result)
    output["items"] = []
    for item in result.get("items") or []:
        clean = sanitize_pool_sample(item, allow_occupancy_ids=allow_occupancy)
        clean["photoCount"] = len(public_photo_ids(conn, str(item.get("id") or "")))
        output["items"].append(clean)
    return output


def sanitize_category_detail(conn: sqlite3.Connection, category: dict, client_ip: object, *, include_photos: bool = False) -> dict:
    actor = access_context(client_ip)
    if actor.is_local_admin:
        return category
    category_id = str(category.get("id") or "")
    role = pool_role(conn, category_id, actor.client_ip)
    allow_occupancy = POOL_ROLE_RANK.get(role, 0) >= POOL_ROLE_RANK["pool_admin"]
    output = copy.deepcopy(category)
    output["samples"] = []
    for item in category.get("samples") or []:
        sample_id = str(item.get("id") or "")
        clean = sanitize_pool_sample(item, allow_occupancy_ids=allow_occupancy)
        if include_photos:
            clean["photos"] = filter_photo_list(conn, sample_id, item.get("photos") or [], actor.client_ip)
            clean["photosLoaded"] = True
            clean["photoCount"] = len(clean["photos"])
        else:
            clean["photoCount"] = len(public_photo_ids(conn, sample_id))
        output["samples"].append(clean)
    return output


_EXPORT_SAMPLE_MASTER_FIELDS = {
    "id", "categoryId", "sampleNo", "name", "model", "sku", "serialNumber",
    "sn", "imei", "boardSn", "isReassembled", "status", "effectiveStatus",
    "hasProblem", "location", "owner", "borrower", "borrowDate", "returnDate",
    "createdAt", "updatedAt", "remark", "remarks", "description", "tags",
    "source", "sourceId", "sourceDeploymentId", "assetNo", "batch", "manufacturer",
}


def _export_sample_master(sample: dict) -> dict:
    return {key: copy.deepcopy(value) for key, value in sample.items() if key in _EXPORT_SAMPLE_MASTER_FIELDS}


def _export_task_sample_ids(task: dict) -> set[str]:
    result = {str(value or "") for value in task.get("sampleIds") or [] if str(value or "")}
    for key in ("removedSampleRecords", "sampleFaultRecords"):
        for item in task.get(key) or []:
            if isinstance(item, dict):
                sample_id = str(item.get("sampleId") or item.get("sid") or "")
                if sample_id:
                    result.add(sample_id)
    for upload in task.get("resultUploads") or []:
        if not isinstance(upload, dict):
            continue
        for item in upload.get("samples") or []:
            if isinstance(item, dict):
                sample_id = str(item.get("sampleId") or item.get("sid") or "")
                if sample_id:
                    result.add(sample_id)
    return result


def _remote_export_selection(selection: object) -> tuple[str, set[str]]:
    if not isinstance(selection, dict):
        raise ValueError("远程导出必须明确选择项目或样机池")
    project_ids = {str(value or "").strip() for value in selection.get("projectIds") or [] if str(value or "").strip()}
    category_ids = {str(value or "").strip() for value in selection.get("sampleCategoryIds") or [] if str(value or "").strip()}
    forbidden = any(selection.get(key) for key in ("stageIds", "taskIds", "sampleIds"))
    if forbidden or (project_ids and category_ids) or (not project_ids and not category_ids):
        raise ValueError("远程导出只允许非空的 projectIds-only 或 sampleCategoryIds-only，且两者不能混合")
    return ("projects", project_ids) if project_ids else ("sample_pools", category_ids)


def build_remote_export_state(conn: sqlite3.Connection, state: dict, selection: dict, client_ip: object) -> dict:
    """Build an already-scoped state for a remote project/pool administrator.

    This intentionally does not reuse ``migration_scope``: its local-export
    semantics broaden default pools and history, which is unsafe for a remote
    caller whose authority is resource-scoped.
    """
    actor = access_context(client_ip)
    if actor.is_local_admin:
        raise ValueError("本机导出不需要远程裁剪")
    mode, selected_ids = _remote_export_selection(selection)
    clean = {
        key: copy.deepcopy(state[key])
        for key in ("version", "schemaVersion")
        if key in state
    }
    clean.update({
        "users": [],
        "currentProjectId": None,
        "currentStageId": None,
        "projects": [],
    })
    library_source = state.get("sampleLibrary") if isinstance(state.get("sampleLibrary"), dict) else {}
    library = {"categories": [], "logs": []}

    category_by_id = {
        str(category.get("id") or ""): category
        for category in library_source.get("categories") or []
        if isinstance(category, dict)
    }

    if mode == "projects":
        for project_id in selected_ids:
            if not has_project_role(conn, project_id, actor.client_ip, "project_admin"):
                raise PermissionError(f"当前 IP 不是项目 {project_id} 的项目管理员")
        referenced_sample_ids: set[str] = set()
        default_category_ids: set[str] = set()
        for project in state.get("projects") or []:
            if not isinstance(project, dict) or str(project.get("id") or "") not in selected_ids:
                continue
            project_copy = copy.deepcopy(project)
            clean["projects"].append(project_copy)
            default_category_id = str(project.get("defaultSampleCategoryId") or "")
            if default_category_id:
                default_category_ids.add(default_category_id)
            for stage in project.get("stages") or []:
                if not isinstance(stage, dict):
                    continue
                for task in stage.get("tasks") or []:
                    if isinstance(task, dict):
                        referenced_sample_ids.update(_export_task_sample_ids(task))
        project_logs = []
        for event in library_source.get("logs") or []:
            if not isinstance(event, dict):
                continue
            if str(event.get("projectId") or "") in selected_ids:
                project_logs.append(copy.deepcopy(event))
                sample_id = str(event.get("sampleId") or "")
                if sample_id:
                    referenced_sample_ids.add(sample_id)
        # Public maintenance events are safe and useful only for samples already
        # carried by the selected project.
        for event in library_source.get("logs") or []:
            if not isinstance(event, dict):
                continue
            sample_id = str(event.get("sampleId") or "")
            if (
                sample_id in referenced_sample_ids
                and not any(str(event.get(key) or "") for key in ("projectId", "stageId", "taskId"))
            ):
                project_logs.append(copy.deepcopy(event))
        seen_event_ids: set[str] = set()
        library["logs"] = []
        for event in project_logs:
            event_id = str(event.get("id") or _json_value(event))
            if event_id not in seen_event_ids:
                seen_event_ids.add(event_id)
                library["logs"].append(event)

        included_categories = set(default_category_ids)
        for category_id, category in category_by_id.items():
            matching_samples = [
                sample for sample in category.get("samples") or []
                if isinstance(sample, dict) and str(sample.get("id") or "") in referenced_sample_ids
            ]
            if not matching_samples and category_id not in default_category_ids:
                continue
            category_copy = {
                key: copy.deepcopy(category.get(key))
                for key in ("id", "name", "description")
                if key in category
            }
            category_copy["samples"] = []
            for sample in matching_samples:
                sample_id = str(sample.get("id") or "")
                sample_copy = _export_sample_master(sample)
                visible_ids = visible_photo_ids(conn, sample_id, actor.client_ip, project_id=next(iter(selected_ids)) if len(selected_ids) == 1 else "")
                if len(selected_ids) > 1:
                    visible_ids = public_photo_ids(conn, sample_id)
                    rows = conn.execute(
                        f"SELECT id FROM sample_assets WHERE sample_id = ? AND kind = 'photo' AND deleted_at IS NULL AND project_id IN ({','.join('?' for _ in selected_ids)})",
                        (sample_id, *sorted(selected_ids)),
                    ).fetchall()
                    visible_ids.update(str(row["id"] or "") for row in rows)
                sample_copy["photos"] = [
                    copy.deepcopy(photo) for photo in sample.get("photos") or []
                    if isinstance(photo, dict) and str(photo.get("id") or "") in visible_ids
                ]
                category_copy["samples"].append(sample_copy)
            library["categories"].append(category_copy)
            included_categories.add(category_id)
    else:
        for category_id in selected_ids:
            if not has_pool_role(conn, category_id, actor.client_ip, "pool_admin"):
                raise PermissionError(f"当前 IP 不是样机池 {category_id} 的池管理员")
        for category_id in sorted(selected_ids):
            category = category_by_id.get(category_id)
            if not category:
                continue
            category_copy = copy.deepcopy(category)
            category_copy["samples"] = []
            for sample in category.get("samples") or []:
                if not isinstance(sample, dict):
                    continue
                sample_id = str(sample.get("id") or "")
                sample_copy = _export_sample_master(sample)
                visible_ids = public_photo_ids(conn, sample_id)
                sample_copy["photos"] = [
                    copy.deepcopy(photo) for photo in sample.get("photos") or []
                    if isinstance(photo, dict) and str(photo.get("id") or "") in visible_ids
                ]
                category_copy["samples"].append(sample_copy)
            library["categories"].append(category_copy)

    clean["sampleLibrary"] = library
    return clean
