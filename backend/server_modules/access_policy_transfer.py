"""Portable ChamberData access-policy import/export helpers.

Runtime authorization remains owned by the Host SQLite ACL tables.  This
module only defines the deliberately small, portable representation embedded
in ChamberData bundles and the deterministic merge/replace rules used during
import.
"""

from __future__ import annotations

import ipaddress
import json
import sqlite3
from pathlib import Path


ACCESS_POLICY_PATH = "access/access-policy.json"
ACCESS_POLICY_SCHEMA_VERSION = 1
SUPPORTED_IMPORT_MODES = ("merge", "replace_selected", "skip")

PROJECT_TABLE = "project_ip_access"
POOL_TABLE = "sample_pool_ip_access"
PROJECT_ROLES = frozenset({"viewer", "contributor", "project_admin"})
POOL_ROLES = frozenset({"pool_viewer", "pool_maintainer", "pool_admin"})


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def _canonical_remote_ipv4(value: object) -> str:
    text = str(value or "").strip()
    try:
        parsed = ipaddress.ip_address(text)
    except ValueError as exc:
        raise ValueError(f"权限策略包含无效 IPv4: {text or '(空)'}") from exc
    if parsed.version != 4:
        raise ValueError(f"权限策略第一版仅支持 IPv4: {text}")
    if parsed.is_loopback:
        raise ValueError("权限策略不能携带 localhost 本机管理员规则")
    if parsed.is_unspecified or parsed.is_multicast:
        raise ValueError(f"权限策略包含不可用的客户端 IPv4: {text}")
    return str(parsed)


def _optional_text(value: object, *, field: str, max_length: int) -> str:
    text = str(value or "").strip()
    if len(text) > max_length:
        raise ValueError(f"权限策略字段 {field} 过长")
    return text


def _normalize_rule(
    raw: object,
    *,
    resource_field: str,
    allowed_roles: frozenset[str],
) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("权限策略规则格式不正确")
    resource_id = str(raw.get(resource_field) or "").strip()
    if not resource_id:
        raise ValueError(f"权限策略规则缺少 {resource_field}")
    role = str(raw.get("role") or "").strip()
    if role not in allowed_roles:
        raise ValueError(f"权限策略角色不受支持: {role or '(空)'}")
    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ValueError("权限策略 enabled 必须为布尔值")
    return {
        resource_field: resource_id,
        "ipAddress": _canonical_remote_ipv4(raw.get("ipAddress")),
        "role": role,
        "enabled": enabled,
        "deviceLabel": _optional_text(raw.get("deviceLabel"), field="deviceLabel", max_length=200),
        "userNote": _optional_text(raw.get("userNote"), field="userNote", max_length=1000),
    }


def normalize_access_policy(
    raw: object,
    *,
    manifest_source_deployment_id: str = "",
    included_project_ids: set[str] | None = None,
    included_category_ids: set[str] | None = None,
) -> dict:
    if not isinstance(raw, dict):
        raise ValueError(f"导入包 {ACCESS_POLICY_PATH} 格式不正确")
    try:
        schema_version = int(raw.get("schemaVersion"))
    except (TypeError, ValueError):
        schema_version = -1
    if schema_version != ACCESS_POLICY_SCHEMA_VERSION:
        raise ValueError(f"权限策略 schemaVersion 不受支持: {raw.get('schemaVersion')}")

    source_deployment_id = str(raw.get("sourceDeploymentId") or "").strip()
    if not source_deployment_id:
        raise ValueError("权限策略缺少 sourceDeploymentId")
    manifest_source = str(manifest_source_deployment_id or "").strip()
    if manifest_source and source_deployment_id != manifest_source:
        raise ValueError("权限策略 sourceDeploymentId 与 manifest 不一致")

    if not isinstance(raw.get("projectRules", []), list) or not isinstance(raw.get("samplePoolRules", []), list):
        raise ValueError("权限策略规则集合必须为数组")
    project_rules = [
        _normalize_rule(item, resource_field="projectId", allowed_roles=PROJECT_ROLES)
        for item in (raw.get("projectRules") or [])
    ]
    pool_rules = [
        _normalize_rule(item, resource_field="categoryId", allowed_roles=POOL_ROLES)
        for item in (raw.get("samplePoolRules") or [])
    ]

    def policy_scope_ids(field: str, fallback_rules: list[dict], resource_field: str) -> list[str]:
        values = raw.get(field)
        if values is None:
            # Compatibility for the short-lived pre-scope draft: a rule still
            # identifies its own selected resource, but cannot express an empty
            # ACL replacement for that resource.
            return sorted({rule[resource_field] for rule in fallback_rules})
        if not isinstance(values, list):
            raise ValueError(f"权限策略字段 {field} 必须为数组")
        ids = [str(value or "").strip() for value in values]
        if any(not value for value in ids) or len(ids) != len(set(ids)):
            raise ValueError(f"权限策略字段 {field} 包含空值或重复值")
        return sorted(ids)

    project_ids = policy_scope_ids("projectIds", project_rules, "projectId")
    sample_pool_ids = policy_scope_ids("samplePoolIds", pool_rules, "categoryId")
    project_scope = set(project_ids)
    pool_scope = set(sample_pool_ids)
    if included_project_ids is not None and not project_scope.issubset(included_project_ids):
        missing = sorted(project_scope - included_project_ids)[0]
        raise ValueError(f"权限策略引用了数据包中不存在的project: {missing}")
    if included_category_ids is not None and not pool_scope.issubset(included_category_ids):
        missing = sorted(pool_scope - included_category_ids)[0]
        raise ValueError(f"权限策略引用了数据包中不存在的sample_pool: {missing}")

    seen: set[tuple[str, str, str]] = set()
    for resource_type, resource_field, rules, included_ids in (
        ("project", "projectId", project_rules, included_project_ids),
        ("sample_pool", "categoryId", pool_rules, included_category_ids),
    ):
        for rule in rules:
            resource_id = rule[resource_field]
            if included_ids is not None and resource_id not in included_ids:
                raise ValueError(f"权限策略引用了数据包中不存在的{resource_type}: {resource_id}")
            declared_scope = project_scope if resource_type == "project" else pool_scope
            if resource_id not in declared_scope:
                raise ValueError(f"权限策略规则不在声明的迁移范围内: {resource_id}")
            key = (resource_type, resource_id, rule["ipAddress"])
            if key in seen:
                raise ValueError(f"权限策略存在重复规则: {resource_id}/{rule['ipAddress']}")
            seen.add(key)

    return {
        "schemaVersion": ACCESS_POLICY_SCHEMA_VERSION,
        "sourceDeploymentId": source_deployment_id,
        "projectIds": project_ids,
        "samplePoolIds": sample_pool_ids,
        "projectRules": project_rules,
        "samplePoolRules": pool_rules,
    }


def _read_export_rows(
    conn: sqlite3.Connection,
    *,
    table: str,
    resource_column: str,
    resource_ids: set[str],
) -> list[dict]:
    if not resource_ids or not _table_exists(conn, table):
        return []
    placeholders = ",".join("?" for _ in resource_ids)
    rows = conn.execute(
        f"""
        SELECT {resource_column}, ip_address, role, enabled, device_label, user_note
        FROM {table}
        WHERE {resource_column} IN ({placeholders})
        ORDER BY {resource_column}, ip_address
        """,
        tuple(sorted(resource_ids)),
    ).fetchall()
    output: list[dict] = []
    output_field = "projectId" if resource_column == "project_id" else "categoryId"
    for row in rows:
        try:
            ip_address = _canonical_remote_ipv4(row["ip_address"])
        except ValueError:
            # A loopback or malformed legacy row is Host-local state and must
            # never leak into a portable policy.
            continue
        output.append({
            output_field: str(row[resource_column]),
            "ipAddress": ip_address,
            "role": str(row["role"]),
            "enabled": bool(row["enabled"]),
            "deviceLabel": str(row["device_label"] or ""),
            "userNote": str(row["user_note"] or ""),
        })
    return output


def build_export_access_policy(
    conn: sqlite3.Connection,
    export_state: dict,
    source_deployment_id: str,
    *,
    project_ids: set[str] | None = None,
    category_ids: set[str] | None = None,
) -> dict:
    state_project_ids = {
        str(project.get("id") or "")
        for project in (export_state.get("projects") or [])
        if isinstance(project, dict) and str(project.get("id") or "")
    }
    state_category_ids = {
        str(category.get("id") or "")
        for category in ((export_state.get("sampleLibrary") or {}).get("categories") or [])
        if isinstance(category, dict) and str(category.get("id") or "")
    }
    resolved_project_ids = state_project_ids if project_ids is None else state_project_ids.intersection(project_ids)
    resolved_category_ids = state_category_ids if category_ids is None else state_category_ids.intersection(category_ids)
    return {
        "schemaVersion": ACCESS_POLICY_SCHEMA_VERSION,
        "sourceDeploymentId": str(source_deployment_id or ""),
        "projectIds": sorted(resolved_project_ids),
        "samplePoolIds": sorted(resolved_category_ids),
        "projectRules": _read_export_rows(
            conn,
            table=PROJECT_TABLE,
            resource_column="project_id",
            resource_ids=resolved_project_ids,
        ),
        "samplePoolRules": _read_export_rows(
            conn,
            table=POOL_TABLE,
            resource_column="category_id",
            resource_ids=resolved_category_ids,
        ),
    }


def load_access_policy_from_package(
    root_dir: Path,
    manifest: dict,
    checksums: dict | None,
    *,
    max_bytes: int,
    included_project_ids: set[str] | None = None,
    included_category_ids: set[str] | None = None,
) -> dict | None:
    declared_path = str((manifest or {}).get("accessPolicyPath") or "").strip()
    if not declared_path:
        return None
    if declared_path != ACCESS_POLICY_PATH:
        raise ValueError("导入包 accessPolicyPath 不受支持")
    if not isinstance(checksums, dict) or ACCESS_POLICY_PATH not in checksums:
        raise ValueError(f"导入包 {ACCESS_POLICY_PATH} 缺少 checksum")
    path = (Path(root_dir) / ACCESS_POLICY_PATH).resolve()
    root = Path(root_dir).resolve()
    if root not in path.parents or not path.is_file():
        raise ValueError(f"导入包缺少 {ACCESS_POLICY_PATH}")
    if path.stat().st_size > max_bytes:
        raise ValueError(f"导入包 {ACCESS_POLICY_PATH} 过大，超过 {max_bytes} bytes 上限")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"导入包 {ACCESS_POLICY_PATH} 格式不正确") from exc
    return normalize_access_policy(
        raw,
        manifest_source_deployment_id=str((manifest or {}).get("sourceDeploymentId") or ""),
        included_project_ids=included_project_ids,
        included_category_ids=included_category_ids,
    )


def _existing_rule(conn: sqlite3.Connection, table: str, resource_column: str, resource_id: str, ip_address: str):
    if not _table_exists(conn, table):
        return None
    return conn.execute(
        f"""
        SELECT role, enabled, device_label, user_note
        FROM {table}
        WHERE {resource_column} = ? AND ip_address = ?
        """,
        (resource_id, ip_address),
    ).fetchone()


def preview_access_policy(conn: sqlite3.Connection, policy: dict | None, *, selected_mode: str = "merge") -> dict:
    if selected_mode not in SUPPORTED_IMPORT_MODES:
        raise ValueError(f"权限策略导入模式不受支持: {selected_mode}")
    if policy is None:
        return {
            "available": False,
            "defaultMode": "merge",
            "selectedMode": selected_mode,
            "supportedModes": list(SUPPORTED_IMPORT_MODES),
            "projectRuleCount": 0,
            "samplePoolRuleCount": 0,
            "projectCount": 0,
            "samplePoolCount": 0,
            "conflicts": [],
        }
    conflicts: list[dict] = []
    for resource_type, table, resource_column, resource_field, rules in (
        ("project", PROJECT_TABLE, "project_id", "projectId", policy["projectRules"]),
        ("sample_pool", POOL_TABLE, "category_id", "categoryId", policy["samplePoolRules"]),
    ):
        for rule in rules:
            existing = _existing_rule(conn, table, resource_column, rule[resource_field], rule["ipAddress"])
            if existing is None:
                continue
            if str(existing["role"]) != rule["role"] or bool(existing["enabled"]) != rule["enabled"]:
                conflicts.append({
                    "type": "access_rule_conflict",
                    "resourceType": resource_type,
                    "resourceId": rule[resource_field],
                    "ipAddress": rule["ipAddress"],
                    "currentRole": str(existing["role"]),
                    "incomingRole": rule["role"],
                    "currentEnabled": bool(existing["enabled"]),
                    "incomingEnabled": rule["enabled"],
                    "resolution": "keep_target",
                })
    return {
        "available": True,
        "schemaVersion": policy["schemaVersion"],
        "sourceDeploymentId": policy["sourceDeploymentId"],
        "defaultMode": "merge",
        "selectedMode": selected_mode,
        "supportedModes": list(SUPPORTED_IMPORT_MODES),
        "projectRuleCount": len(policy["projectRules"]),
        "samplePoolRuleCount": len(policy["samplePoolRules"]),
        "projectCount": len(policy["projectIds"]),
        "samplePoolCount": len(policy["samplePoolIds"]),
        "conflicts": conflicts,
    }


def apply_access_policy(
    conn: sqlite3.Connection,
    policy: dict | None,
    *,
    mode: str,
    project_id_map: dict[str, str],
    category_id_map: dict[str, str],
    selected_project_ids: set[str],
    selected_category_ids: set[str],
    now_iso: str,
    created_by_ip: str,
) -> dict:
    if mode not in SUPPORTED_IMPORT_MODES:
        raise ValueError(f"权限策略导入模式不受支持: {mode}")
    base = {
        "available": policy is not None,
        "mode": mode,
        "added": 0,
        "deduplicated": 0,
        "replaced": 0,
        "skipped": 0,
        "conflicts": [],
    }
    if policy is None or mode == "skip":
        if policy is not None:
            base["skipped"] = len(policy["projectRules"]) + len(policy["samplePoolRules"])
        return base

    effective_project_ids = selected_project_ids.intersection(policy["projectIds"])
    effective_category_ids = selected_category_ids.intersection(policy["samplePoolIds"])
    mapped_groups = (
        (
            "project", PROJECT_TABLE, "project_id", "projectId", policy["projectRules"],
            project_id_map, effective_project_ids,
        ),
        (
            "sample_pool", POOL_TABLE, "category_id", "categoryId", policy["samplePoolRules"],
            category_id_map, effective_category_ids,
        ),
    )
    for _resource_type, table, _column, _field, _rules, _id_map, selected_ids in mapped_groups:
        if selected_ids and not _table_exists(conn, table):
            raise RuntimeError(f"Host 权限表尚未初始化: {table}")

    if mode == "replace_selected":
        for _resource_type, table, resource_column, _resource_field, _rules, id_map, selected_ids in mapped_groups:
            target_ids = sorted({id_map[source_id] for source_id in selected_ids if source_id in id_map})
            for target_id in target_ids:
                cursor = conn.execute(f"DELETE FROM {table} WHERE {resource_column} = ?", (target_id,))
                base["replaced"] += max(int(cursor.rowcount or 0), 0)

    for resource_type, table, resource_column, resource_field, rules, id_map, selected_ids in mapped_groups:
        for rule in rules:
            source_id = rule[resource_field]
            if source_id not in selected_ids or source_id not in id_map:
                base["skipped"] += 1
                continue
            target_id = id_map[source_id]
            existing = _existing_rule(conn, table, resource_column, target_id, rule["ipAddress"])
            if existing is not None:
                same_access = str(existing["role"]) == rule["role"] and bool(existing["enabled"]) == rule["enabled"]
                if same_access:
                    base["deduplicated"] += 1
                    continue
                if mode == "merge":
                    base["conflicts"].append({
                        "type": "access_rule_conflict",
                        "resourceType": resource_type,
                        "sourceResourceId": source_id,
                        "resourceId": target_id,
                        "ipAddress": rule["ipAddress"],
                        "currentRole": str(existing["role"]),
                        "incomingRole": rule["role"],
                        "currentEnabled": bool(existing["enabled"]),
                        "incomingEnabled": rule["enabled"],
                        "resolution": "keep_target",
                    })
                    continue
                # replace_selected deleted all selected target rows above, so
                # reaching here means two source resources were mapped onto the
                # same target. Preserve the first deterministic insert.
                base["conflicts"].append({
                    "type": "access_rule_mapping_conflict",
                    "resourceType": resource_type,
                    "sourceResourceId": source_id,
                    "resourceId": target_id,
                    "ipAddress": rule["ipAddress"],
                    "resolution": "keep_first_imported",
                })
                continue
            conn.execute(
                f"""
                INSERT INTO {table}
                ({resource_column}, ip_address, role, enabled, device_label, user_note,
                 created_by_ip, created_at, updated_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (
                    target_id,
                    rule["ipAddress"],
                    rule["role"],
                    1 if rule["enabled"] else 0,
                    rule["deviceLabel"],
                    rule["userNote"],
                    created_by_ip,
                    now_iso,
                    now_iso,
                ),
            )
            base["added"] += 1
    return base
