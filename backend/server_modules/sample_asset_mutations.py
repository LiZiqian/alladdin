"""照片写入后的 revision 与审计事务；调用方负责资产文件事务。"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Callable
from server_modules import record_writers


@dataclass(frozen=True)
class SampleAssetMutationContext:
    app_version: str
    now_iso: Callable
    json_dumps: Callable
    json_obj: Callable
    empty_data: Callable
    split_state_for_storage: Callable
    load_sample_photos: Callable


def commit_sample_asset_mutation(
    ctx: SampleAssetMutationContext,
    conn: sqlite3.Connection,
    sample_id: str,
    action: str,
    remark: str,
    client_ip: str,
    *,
    user: str = "",
) -> dict:
    state_row = conn.execute("SELECT data_json, revision FROM app_state WHERE id = 1").fetchone()
    current_revision = int(state_row["revision"]) if state_row else 1
    new_revision = current_revision + 1
    updated_at = ctx.now_iso()

    sample_row = conn.execute(
        "SELECT data_json FROM sample_records WHERE id = ? AND deleted_at IS NULL",
        (sample_id,),
    ).fetchone()
    if not sample_row:
        raise KeyError("样机不存在")
    sample_json = ctx.json_obj(sample_row["data_json"], {}) or {}
    sample_json["updatedAt"] = updated_at
    conn.execute(
        "UPDATE sample_records SET data_json = ?, updated_at = ? WHERE id = ?",
        (ctx.json_dumps(sample_json), updated_at, sample_id),
    )

    stored = ctx.json_obj(state_row["data_json"] if state_row else None, {}) or ctx.split_state_for_storage(ctx.empty_data())
    stored["version"] = ctx.app_version
    if state_row:
        conn.execute(
            "UPDATE app_state SET data_json = ?, revision = ?, updated_at = ? WHERE id = 1",
            (ctx.json_dumps(stored), new_revision, updated_at),
        )
    else:
        conn.execute(
            "INSERT INTO app_state (id, data_json, revision, updated_at) VALUES (1, ?, ?, ?)",
            (ctx.json_dumps(stored), new_revision, updated_at),
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
    photos = ctx.load_sample_photos(conn, sample_id)
    conn.commit()
    return {"revision": new_revision, "updated_at": updated_at, "photos": photos}
