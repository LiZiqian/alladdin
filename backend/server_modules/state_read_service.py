from __future__ import annotations

import sqlite3
from contextlib import closing
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class StateReadContext:
    app_version: str
    db_lock: object
    connect_db: Callable[[], sqlite3.Connection]
    ensure_dirs: Callable[[], None]
    ensure_deployment_id: Callable[[], str]
    ensure_schema: Callable[[sqlite3.Connection], None]
    empty_data: Callable[[], dict]
    now_iso: Callable[[], str]
    json_obj: Callable
    json_dumps: Callable
    split_state_for_storage: Callable[[dict], dict]
    list_project_summary: Callable[[sqlite3.Connection], list[dict]]
    list_sample_categories_summary: Callable[[sqlite3.Connection], list[dict]]
    load_project_library: Callable[[sqlite3.Connection], list[dict]]
    load_sample_library: Callable[..., dict]


def compose_bootstrap_state(ctx: StateReadContext, conn: sqlite3.Connection) -> tuple[dict, int, str]:
    row = conn.execute("SELECT data_json, revision, updated_at FROM app_state WHERE id = 1").fetchone()
    if row is None:
        data = ctx.empty_data()
        revision = 1
        updated_at = ctx.now_iso()
    else:
        stored = ctx.json_obj(row["data_json"], ctx.empty_data()) or ctx.empty_data()
        data = ctx.empty_data()
        data["currentProjectId"] = stored.get("currentProjectId")
        data["currentStageId"] = stored.get("currentStageId")
        data["eventSchema"] = stored.get("eventSchema") or "sample_events_v2"
        data["users"] = stored.get("users") if isinstance(stored.get("users"), list) else []
        revision = int(row["revision"])
        updated_at = str(row["updated_at"])

    data["projects"] = [
        {**project, "stages": [], "_summaryOnly": True, "_detailLoaded": False}
        for project in ctx.list_project_summary(conn)
    ]
    data["sampleLibrary"] = {
        "categories": [
            {**category, "samples": [], "_summaryOnly": True, "samplesLoaded": False}
            for category in ctx.list_sample_categories_summary(conn)
        ],
        "logs": [],
        "photosExternalized": True,
        "eventsExternalized": True,
    }
    data["bootstrapMode"] = True
    return data, revision, updated_at


def compose_state(
    ctx: StateReadContext,
    conn: sqlite3.Connection,
    *,
    include_sample_photos: bool = True,
    include_sample_logs: bool = True,
) -> tuple[dict, int, str]:
    row = conn.execute("SELECT data_json, revision, updated_at FROM app_state WHERE id = 1").fetchone()
    if row is None:
        return ctx.empty_data(), 1, ctx.now_iso()
    data = ctx.json_obj(row["data_json"], ctx.empty_data()) or ctx.empty_data()
    data["version"] = ctx.app_version
    data["projects"] = ctx.load_project_library(conn)
    data["sampleLibrary"] = ctx.load_sample_library(
        conn,
        include_photos=include_sample_photos,
        include_logs=include_sample_logs,
    )
    return data, int(row["revision"]), str(row["updated_at"])


def begin_read_snapshot(conn: sqlite3.Connection) -> bool:
    """Start a SQLite read transaction when the connection is not already in one."""
    if getattr(conn, "in_transaction", False):
        return False
    conn.execute("BEGIN")
    return True


def init_db(ctx: StateReadContext) -> None:
    ctx.ensure_dirs()
    ctx.ensure_deployment_id()
    with ctx.db_lock:
        conn = ctx.connect_db()
        with closing(conn), conn:
            ctx.ensure_schema(conn)
            row = conn.execute("SELECT data_json, revision FROM app_state WHERE id = 1").fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO app_state (id, data_json, revision, updated_at) VALUES (1, ?, 1, ?)",
                    (ctx.json_dumps(ctx.split_state_for_storage(ctx.empty_data())), ctx.now_iso()),
                )
            conn.commit()


def get_state(ctx: StateReadContext, *, compact: bool = False) -> tuple[dict, int, str]:
    with closing(ctx.connect_db()) as conn:
        began = begin_read_snapshot(conn)
        try:
            return compose_state(
                ctx,
                conn,
                include_sample_photos=not compact,
                include_sample_logs=not compact,
            )
        finally:
            if began and getattr(conn, "in_transaction", False):
                conn.execute("COMMIT")


def get_state_metadata(ctx: StateReadContext) -> tuple[int, str]:
    with closing(ctx.connect_db()) as conn:
        began = begin_read_snapshot(conn)
        try:
            row = conn.execute("SELECT revision, updated_at FROM app_state WHERE id = 1").fetchone()
            if row is None:
                return 1, ctx.now_iso()
            return int(row["revision"]), str(row["updated_at"] or "")
        finally:
            if began and getattr(conn, "in_transaction", False):
                conn.execute("COMMIT")
