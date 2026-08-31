from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Callable

from server_modules import status_normalization


@dataclass(frozen=True)
class DatabaseBackfillContext:
    json_obj: Callable
    task_flow_status: Callable[[dict], str]
    sample_has_problem: Callable[[dict], bool]
    sample_effective_status: Callable[[dict], str]
    sample_is_reassembled: Callable[[dict], bool]
    replace_task_sample_links: Callable[..., None]


def json_dumps(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def backfill_status_normalization(ctx: DatabaseBackfillContext, conn: sqlite3.Connection) -> None:
    """Canonicalize persisted status values and business status text."""
    state_rows = conn.execute("SELECT id, data_json FROM app_state").fetchall()
    for row in state_rows:
        data = ctx.json_obj(row["data_json"], {}) or {}
        normalized = status_normalization.normalize_state_payload(data)
        if normalized != data:
            conn.execute(
                "UPDATE app_state SET data_json = ? WHERE id = ?",
                (json_dumps(normalized), row["id"]),
            )

    project_rows = conn.execute("SELECT id, data_json FROM project_records").fetchall()
    for row in project_rows:
        project = ctx.json_obj(row["data_json"], {}) or {}
        normalized = status_normalization.normalize_project_payload(project)
        if normalized != project:
            conn.execute(
                "UPDATE project_records SET data_json = ? WHERE id = ?",
                (json_dumps(normalized), row["id"]),
            )

    stage_rows = conn.execute("SELECT id, data_json FROM project_stages").fetchall()
    for row in stage_rows:
        stage = ctx.json_obj(row["data_json"], {}) or {}
        normalized = status_normalization.normalize_stage_payload(stage)
        if normalized != stage:
            conn.execute(
                "UPDATE project_stages SET data_json = ? WHERE id = ?",
                (json_dumps(normalized), row["id"]),
            )

    task_rows = conn.execute(
        """
        SELECT id, status, flow_status, data_json
        FROM project_tasks
        WHERE deleted_at IS NULL
        """
    ).fetchall()
    for row in task_rows:
        task = ctx.json_obj(row["data_json"], {}) or {}
        task["id"] = row["id"]
        task["status"] = row["status"] or task.get("status") or ""
        normalized = status_normalization.normalize_task_payload(task)
        status = status_normalization.normalize_task_stored_status(normalized)
        flow_status = ctx.task_flow_status(normalized)
        if normalized != task or str(row["status"] or "") != status or str(row["flow_status"] or "") != flow_status:
            conn.execute(
                """
                UPDATE project_tasks
                SET status = ?, flow_status = ?, data_json = ?, completed_at = COALESCE(NULLIF(completed_at, ''), ?)
                WHERE id = ?
                """,
                (
                    status,
                    flow_status,
                    json_dumps(normalized),
                    str(normalized.get("completedAt") or normalized.get("endDate") or ""),
                    row["id"],
                ),
            )

    link_rows = conn.execute(
        """
        SELECT pts.task_id, pts.sample_id, pts.status, pts.flow_status, pt.status AS task_status, pt.flow_status AS task_flow_status
        FROM project_task_samples pts
        LEFT JOIN project_tasks pt ON pt.id = pts.task_id
        """
    ).fetchall()
    for row in link_rows:
        status = status_normalization.normalize_task_stored_status(row["task_status"] or row["status"] or "")
        flow_status = status_normalization.normalize_task_flow_status(row["task_flow_status"] or status)
        if str(row["status"] or "") != status or str(row["flow_status"] or "") != flow_status:
            conn.execute(
                """
                UPDATE project_task_samples
                SET status = ?, flow_status = ?
                WHERE task_id = ? AND sample_id = ?
                """,
                (status, flow_status, row["task_id"], row["sample_id"]),
            )

    category_rows = conn.execute("SELECT id, data_json FROM sample_categories").fetchall()
    for row in category_rows:
        category = ctx.json_obj(row["data_json"], {}) or {}
        normalized = status_normalization.normalize_sample_category_payload(category)
        if normalized != category:
            conn.execute(
                "UPDATE sample_categories SET data_json = ? WHERE id = ?",
                (json_dumps(normalized), row["id"]),
            )

    sample_rows = conn.execute(
        """
        SELECT id, status, has_problem, effective_status, board_sn, is_reassembled, data_json
        FROM sample_records
        WHERE deleted_at IS NULL
        """
    ).fetchall()
    for row in sample_rows:
        sample = ctx.json_obj(row["data_json"], {}) or {}
        sample["id"] = row["id"]
        sample["status"] = row["status"] or sample.get("status") or ""
        normalized = status_normalization.normalize_sample_payload(sample)
        if int(row["has_problem"] or 0) or status_normalization.normalize_sample_quality_value(row["effective_status"]) == "有故障":
            normalized["hasProblem"] = True
            normalized["problemState"] = "有故障"
        status = ctx.sample_effective_status(normalized)
        has_problem = 1 if ctx.sample_has_problem(normalized) else 0
        effective_status = ctx.sample_effective_status(normalized)
        board_sn = str(normalized.get("boardSn") or "").strip()
        is_reassembled = 1 if ctx.sample_is_reassembled(normalized) else 0
        if (
            normalized != sample
            or str(row["status"] or "") != status
            or int(row["has_problem"] or 0) != has_problem
            or str(row["effective_status"] or "") != effective_status
            or str(row["board_sn"] or "") != board_sn
            or int(row["is_reassembled"] or 0) != is_reassembled
        ):
            conn.execute(
                """
                UPDATE sample_records
                SET status = ?, has_problem = ?, effective_status = ?, board_sn = ?, is_reassembled = ?, data_json = ?
                WHERE id = ?
                """,
                (status, has_problem, effective_status, board_sn, is_reassembled, json_dumps(normalized), row["id"]),
            )

    task_log_rows = conn.execute("SELECT id, action, data_json FROM task_logs").fetchall()
    for row in task_log_rows:
        log = ctx.json_obj(row["data_json"], {}) or {}
        normalized = status_normalization.normalize_business_value(log)
        action = status_normalization.normalize_status_text(str(row["action"] or ""))
        if normalized != log or action != str(row["action"] or ""):
            conn.execute(
                "UPDATE task_logs SET action = ?, data_json = ? WHERE id = ?",
                (action, json_dumps(normalized), row["id"]),
            )

    sample_event_rows = conn.execute("SELECT id, data_json FROM sample_events").fetchall()
    for row in sample_event_rows:
        log = ctx.json_obj(row["data_json"], {}) or {}
        normalized = status_normalization.normalize_business_value(log)
        if normalized != log:
            conn.execute(
                "UPDATE sample_events SET data_json = ? WHERE id = ?",
                (json_dumps(normalized), row["id"]),
            )

    audit_rows = conn.execute("SELECT id, action, remark FROM audit_log").fetchall()
    for row in audit_rows:
        action = status_normalization.normalize_status_text(str(row["action"] or ""))
        remark = status_normalization.normalize_status_text(str(row["remark"] or ""))
        if action != str(row["action"] or "") or remark != str(row["remark"] or ""):
            conn.execute(
                "UPDATE audit_log SET action = ?, remark = ? WHERE id = ?",
                (action, remark, row["id"]),
            )


def backfill_query_state_columns(ctx: DatabaseBackfillContext, conn: sqlite3.Connection) -> None:
    task_rows = conn.execute(
        """
        SELECT id, status, data_json
        FROM project_tasks
        WHERE COALESCE(flow_status, '') = ''
        """
    ).fetchall()
    for row in task_rows:
        task = ctx.json_obj(row["data_json"], {}) or {}
        task["status"] = row["status"] or task.get("status") or ""
        conn.execute(
            "UPDATE project_tasks SET flow_status = ? WHERE id = ?",
            (ctx.task_flow_status(task), row["id"]),
        )

    sample_rows = conn.execute(
        """
        SELECT id, status, has_problem, effective_status, data_json
        FROM sample_records
        WHERE deleted_at IS NULL
        """
    ).fetchall()
    for row in sample_rows:
        sample = ctx.json_obj(row["data_json"], {}) or {}
        sample["status"] = row["status"] or sample.get("status") or ""
        has_problem = 1 if ctx.sample_has_problem(sample) else 0
        effective_status = ctx.sample_effective_status(sample)
        if int(row["has_problem"] or 0) != has_problem or str(row["effective_status"] or "") != effective_status:
            conn.execute(
                "UPDATE sample_records SET has_problem = ?, effective_status = ? WHERE id = ?",
                (has_problem, effective_status, row["id"]),
            )


def backfill_sample_identity_columns(ctx: DatabaseBackfillContext, conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT id, data_json, board_sn, is_reassembled
        FROM sample_records
        WHERE deleted_at IS NULL
        """
    ).fetchall()
    for row in rows:
        sample = ctx.json_obj(row["data_json"], {}) or {}
        board_sn = str(sample.get("boardSn") or "").strip()
        is_reassembled = 1 if ctx.sample_is_reassembled(sample) else 0
        if str(row["board_sn"] or "") != board_sn or int(row["is_reassembled"] or 0) != is_reassembled:
            conn.execute(
                "UPDATE sample_records SET board_sn = ?, is_reassembled = ? WHERE id = ?",
                (board_sn, is_reassembled, row["id"]),
            )


def backfill_project_task_samples(ctx: DatabaseBackfillContext, conn: sqlite3.Connection) -> None:
    existing = conn.execute("SELECT COUNT(*) AS count FROM project_task_samples").fetchone()
    if int(existing["count"] if existing else 0) > 0:
        return
    rows = conn.execute(
        """
        SELECT id, project_id, stage_id, test_item, status, sample_ids_json, data_json
        FROM project_tasks
        WHERE deleted_at IS NULL
        """
    ).fetchall()
    for row in rows:
        task = ctx.json_obj(row["data_json"], {}) or {}
        task["id"] = row["id"]
        task["projectId"] = row["project_id"]
        task["stageId"] = row["stage_id"]
        task["testItem"] = row["test_item"] or task.get("testItem") or ""
        task["status"] = row["status"] or task.get("status") or ""
        sample_ids = ctx.json_obj(row["sample_ids_json"], [])
        if not isinstance(sample_ids, list):
            sample_ids = []
        ctx.replace_task_sample_links(
            conn,
            str(row["id"] or ""),
            str(row["project_id"] or ""),
            str(row["stage_id"] or ""),
            task,
            [str(x) for x in sample_ids],
        )


def _photo_reference_ids(record: object) -> set[str]:
    if not isinstance(record, dict):
        return set()
    result: set[str] = set()
    for key in ("photos", "resultPhotos", "attachments"):
        values = record.get(key)
        if not isinstance(values, list):
            continue
        for photo in values:
            if not isinstance(photo, dict):
                continue
            photo_id = str(photo.get("id") or "")
            thumb_id = str(photo.get("thumbId") or photo.get("thumbnailId") or "")
            if photo_id:
                result.add(photo_id)
                result.add(f"{photo_id}__thumb")
            if thumb_id:
                result.add(thumb_id)
    return result


def _task_photo_references(task: dict) -> set[tuple[str, str]]:
    references: set[tuple[str, str]] = set()

    def add_sample_record(record: object) -> None:
        if not isinstance(record, dict):
            return
        sample_id = str(record.get("sampleId") or record.get("sid") or "")
        if not sample_id:
            return
        for photo_id in _photo_reference_ids(record):
            references.add((sample_id, photo_id))

    for upload in task.get("resultUploads") or []:
        if isinstance(upload, dict):
            for record in upload.get("samples") or []:
                add_sample_record(record)
    result_draft = task.get("resultDraft")
    if isinstance(result_draft, dict):
        for record in result_draft.get("samples") or []:
            add_sample_record(record)
    for key in ("sampleFaultRecords", "removedSampleRecords"):
        for record in task.get(key) or []:
            add_sample_record(record)
    return references


def backfill_sample_asset_context(
    ctx: DatabaseBackfillContext,
    conn: sqlite3.Connection,
    *,
    force: bool = False,
) -> None:
    """Attach legacy task-result photos to their real project/task context.

    Old releases stored exterior photos and result attachments in the same
    table without context columns.  Only unambiguous references are promoted;
    assets that are genuinely unreferenced remain compatible public photos.
    """
    migration_id = "20260830_sample_asset_project_context_v1"
    if not force and conn.execute("SELECT 1 FROM schema_migrations WHERE id = ?", (migration_id,)).fetchone():
        return
    unresolved = conn.execute(
        """
        SELECT 1
        FROM sample_assets AS a
        JOIN sample_records AS s ON s.id = a.sample_id AND s.deleted_at IS NULL
        WHERE a.kind IN ('photo', 'photo_thumb')
          AND COALESCE(a.project_id, '') = ''
          AND COALESCE(a.stage_id, '') = ''
          AND COALESCE(a.task_id, '') = ''
        LIMIT 1
        """
    ).fetchone()
    if not unresolved:
        conn.execute("INSERT OR IGNORE INTO schema_migrations(id) VALUES(?)", (migration_id,))
        return

    candidates: dict[tuple[str, str], set[tuple[str, str, str]]] = {}

    def add(sample_id: str, photo_id: str, scope: tuple[str, str, str]) -> None:
        if sample_id and photo_id and any(scope):
            candidates.setdefault((sample_id, photo_id), set()).add(scope)

    def event_requires_restricted_context(event: dict) -> bool:
        event_type = str(event.get("eventType") or event.get("type") or event.get("source") or "").lower()
        if "externalhistory" in event_type or "external_history" in event_type or "外部履历" in event_type:
            return True
        business_keys = (
            "projectName", "stageName", "taskName", "testItem", "result", "latestResult",
            "problem", "problemDescription", "resultPhotos", "resultUploads",
        )
        return any(event.get(key) not in (None, "", [], {}) for key in business_keys)

    task_rows = conn.execute(
        "SELECT id, project_id, stage_id, data_json FROM project_tasks"
    ).fetchall()
    for row in task_rows:
        task = ctx.json_obj(row["data_json"], {}) or {}
        scope = (str(row["project_id"] or ""), str(row["stage_id"] or ""), str(row["id"] or ""))
        for sample_id, photo_id in _task_photo_references(task):
            add(sample_id, photo_id, scope)

    event_rows = conn.execute(
        "SELECT sample_id, project_id, stage_id, task_id, data_json FROM sample_events"
    ).fetchall()
    for row in event_rows:
        event = ctx.json_obj(row["data_json"], {}) or {}
        sample_id = str(row["sample_id"] or event.get("sampleId") or "")
        scope = (
            str(row["project_id"] or event.get("projectId") or ""),
            str(row["stage_id"] or event.get("stageId") or ""),
            str(row["task_id"] or event.get("taskId") or ""),
        )
        for photo_id in _photo_reference_ids(event):
            if any(scope):
                add(sample_id, photo_id, scope)
            elif event_requires_restricted_context(event):
                # Sample-archive externalHistory and legacy result events may
                # have no resolvable project/task IDs. They are still business
                # attachments and must never fall back to public pool photos.
                add(sample_id, photo_id, ("__restricted__", "", ""))

    for (sample_id, photo_id), scopes in candidates.items():
        if len(scopes) == 1:
            project_id, stage_id, task_id = next(iter(scopes))
        else:
            # A task-referenced asset is never public merely because legacy
            # data makes its exact owning task ambiguous.
            project_id, stage_id, task_id = "__restricted__", "", ""
        root_photo_id = photo_id[:-7] if photo_id.endswith("__thumb") else photo_id
        conn.execute(
            """
            UPDATE sample_assets
            SET project_id = ?, stage_id = ?, task_id = ?
            WHERE sample_id = ? AND id IN (?, ?)
              AND COALESCE(project_id, '') = ''
              AND COALESCE(stage_id, '') = ''
              AND COALESCE(task_id, '') = ''
            """,
            (
                project_id or None,
                stage_id or None,
                task_id or None,
                sample_id,
                root_photo_id,
                f"{root_photo_id}__thumb",
            ),
        )
    conn.execute("INSERT OR IGNORE INTO schema_migrations(id) VALUES(?)", (migration_id,))
