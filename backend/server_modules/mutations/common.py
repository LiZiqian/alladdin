"""事务上下文、输入标志、乐观锁与审计。
版本推进和审计必须使用调用方的同一个写事务；本模块不提交事务。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable
import re
import sqlite3

from server_modules import (
    record_writers,
    status_normalization,
)


@dataclass(frozen=True)
class MutationServiceContext:
    """由 server.py 注入运行时能力，避免业务模块反向依赖全局服务器。

    write_db_connection 提供 BEGIN IMMEDIATE 事务连接；服务函数负责
    成功提交。物理文件删除只在数据库提交成功后调用 unlink 能力。
    """
    write_db_connection: Callable
    now_iso: Callable[[], str]
    unlink_asset_relative_paths: Callable


def to_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _current_revision(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT revision FROM app_state WHERE id = 1").fetchone()
    return int(row["revision"]) if row else 1


def _mutation_flags_failure(payload: dict, *names: str) -> dict | None:
    for name in names:
        if name in payload and not isinstance(payload[name], bool):
            return {"status": 400, "error_code": "MUTATION_FLAG_INVALID",
                    "error": f"{name} 必须是 JSON 布尔值", "field": name}
    return None


def _task_revision_failure(payload: dict, current_revision: int) -> dict | None:
    """Reject a stale task page before it can overwrite a concurrent mutation."""
    if "revision" not in payload or payload.get("revision") is None:
        return None
    try:
        value = payload.get("revision")
        if type(value) is not int and not (isinstance(value, str) and re.fullmatch(r"[+-]?\d+", value.strip())):
            raise ValueError("revision must be an integer")
        client_revision = int(value)
    except (TypeError, ValueError):
        return {
            "status": 400,
            "error_code": "TASK_REVISION_INVALID",
            "error": "任务保存版本号无效。",
        }
    if client_revision == current_revision:
        return None
    return {
        "status": 409,
        "error_code": "TASK_REVISION_CONFLICT",
        "error": "平台数据已被其他页面更新；为避免旧任务页面覆盖新数据，本次保存已取消。",
        "client_revision": client_revision,
        "server_revision": current_revision,
    }


def _record_revision_failure(conn: sqlite3.Connection, payload: dict, current_revision: int) -> dict | None:
    """Apply optimistic concurrency to every full-record incremental write."""
    failure = _task_revision_failure(payload, current_revision)
    if not failure:
        return None
    row = conn.execute("SELECT updated_at FROM app_state WHERE id = 1").fetchone()
    invalid = failure.get("error_code") == "TASK_REVISION_INVALID"
    return {
        **failure,
        "error_code": "MUTATION_REVISION_INVALID" if invalid else "MUTATION_REVISION_CONFLICT",
        "error": "保存版本号无效。" if invalid else "平台数据已被其他页面更新；本次保存已取消，请刷新后重试。",
        "revision": current_revision,
        "updated_at": str(row["updated_at"] or "") if row else "",
    }


def _bump_revision_and_audit(
    ctx: MutationServiceContext,
    conn: sqlite3.Connection,
    *,
    current_revision: int,
    action: str,
    remark: str,
    user: str,
    client_ip: str,
) -> tuple[int, str]:
    new_revision = current_revision + 1
    updated_at = ctx.now_iso()
    record_writers.prune_orphan_operational_logs(conn)
    action = action
    remark = remark
    conn.execute(
        "UPDATE app_state SET revision = ?, updated_at = ? WHERE id = 1",
        (new_revision, updated_at),
    )
    conn.execute(
        """
        INSERT INTO audit_log
        (time, user, action, remark, revision_before, revision_after, client_ip)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (updated_at, user, action, remark, current_revision, new_revision, client_ip),
    )
    record_writers.clear_audit_log_when_platform_empty(conn)
    return new_revision, updated_at
