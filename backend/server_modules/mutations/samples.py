"""样机与样机池增量写入。
销毁先验证完整任务引用，再写数据库；物理文件清理保持在成功提交之后。"""
from __future__ import annotations

import sqlite3

from .common import (
    MutationServiceContext,
    _bump_revision_and_audit,
    _current_revision,
    _mutation_flags_failure,
    _record_revision_failure,
    to_int,
)

from .effects import (
    _operational_sample_write_payloads,
    _persist_destroyed_sample_snapshots,
    reconcile_task_sample_occupancy,
)

from .sample_guards import (
    _category_sample_scope_failure,
    _sample_destroy_scope_failure,
    _sample_event_conflict_failure,
    _sample_event_scope_failure,
)

from server_modules import (
    mutation_summary,
    record_writers,
    sample_assets,
    sample_constraints,
    task_mutation_rules,
)


def commit_sample_mutation(ctx: MutationServiceContext, payload: dict, client_ip: str) -> tuple[bool, dict]:
    flag_failure = _mutation_flags_failure(payload, "deleteSample")
    if flag_failure:
        return False, flag_failure
    sample = payload.get("sample")
    if sample is not None and not isinstance(sample, dict):
        return False, {"status": 400, "error": "sample 必须是 JSON 对象"}
    sample_id = str(payload.get("sampleId") or (sample or {}).get("id") or "")
    if not sample_id:
        return False, {"status": 400, "error": "缺少 sampleId"}
    body_sample_id = str((sample or {}).get("id") or "")
    if body_sample_id and body_sample_id != sample_id:
        return False, {
            "status": 409,
            "error_code": "SAMPLE_ID_MISMATCH",
            "error": "请求路径中的样机与请求体样机不一致，已拒绝写入。",
            "sampleId": sample_id,
            "bodySampleId": body_sample_id,
        }
    if isinstance(sample, dict):
        sample = {**sample, "id": sample_id}
    delete_sample = bool(payload.get("deleteSample"))
    if not delete_sample and payload.get("taskMutations"):
        return False, {"status": 400, "error_code": "SAMPLE_TASK_MUTATION_NOT_ALLOWED", "error": "普通样机编辑不能同时修改任务，请使用任务操作保存。"}
    affected = {}
    asset_paths_to_delete: list[str] = []
    destroyed_task_sample_ids: set[str] = set()

    with ctx.write_db_connection() as conn:
        current_revision = _current_revision(conn)
        revision_failure = _record_revision_failure(conn, payload, current_revision)
        if revision_failure:
            return False, revision_failure
        if not delete_sample:
            identity_samples = [item for item in (payload.get("samples") or []) if isinstance(item, dict) and str(item.get("id") or "") != sample_id]
            if isinstance(sample, dict):
                identity_samples.append(sample)
            identity_failure = sample_constraints.sample_identity_write_failure(conn, identity_samples)
            if identity_failure:
                return False, {**identity_failure, "server_revision": current_revision}
        event_failure = _sample_event_conflict_failure(conn, payload.get("sampleEvents"))
        if event_failure:
            return False, {**event_failure, "server_revision": current_revision}
        allowed_event_sample_ids = {
            sample_id,
            *{
                str(item.get("id") or "")
                for item in (payload.get("samples") or [])
                if isinstance(item, dict) and str(item.get("id") or "")
            },
        }
        event_scope_failure = _sample_event_scope_failure(
            conn,
            payload.get("sampleEvents"),
            allowed_sample_ids=allowed_event_sample_ids,
        )
        if event_scope_failure:
            return False, {**event_scope_failure, "server_revision": current_revision}

        if delete_sample:
            exists = conn.execute(
                "SELECT 1 FROM sample_records WHERE id = ? AND deleted_at IS NULL",
                (sample_id,),
            ).fetchone()
            if not exists:
                return False, {
                    "status": 404,
                    "error_code": "SAMPLE_NOT_FOUND",
                    "error": "待销毁的样机档案不存在。",
                    "sampleId": sample_id,
                }
            scope_failure = _sample_destroy_scope_failure(
                conn,
                sample_ids={sample_id},
                task_mutations=payload.get("taskMutations"),
            )
            if scope_failure:
                scope_failure["server_revision"] = current_revision
                return False, scope_failure
            for item in payload.get("taskMutations") or []:
                destroyed_task_sample_ids.update(task_mutation_rules.existing_task_sample_ids(conn, str(item.get("taskId") or item["task"].get("id") or "")))
            _persist_destroyed_sample_snapshots(
                conn,
                sample_ids={sample_id},
                destroyed_at=ctx.now_iso(),
            )

        for item in payload.get("taskMutations") or []:
            if not isinstance(item, dict):
                continue
            task = item.get("task")
            if not isinstance(task, dict):
                continue
            project_id = str(item.get("projectId") or task.get("projectId") or "")
            stage_id = str(item.get("stageId") or task.get("stageId") or "")
            task_id = str(item.get("taskId") or task.get("id") or "")
            if not project_id or not stage_id or not task_id:
                continue
            if not delete_sample:
                record_writers.update_stage_record(conn, item.get("stage") or {}, project_id, stage_id)
            record_writers.upsert_task_record(
                conn,
                task,
                project_id,
                stage_id,
                create_if_missing=bool(item.get("createIfMissing")),
            )

        related_samples = payload.get("samples") or []
        if delete_sample:
            related_samples = _operational_sample_write_payloads(conn, related_samples, preserve_sample_state=True)
        for related_sample in related_samples:
            if isinstance(related_sample, dict) and str(related_sample.get("id") or "") != sample_id:
                record_writers.update_sample_record(conn, related_sample)

        if isinstance(sample, dict) and not delete_sample:
            record_writers.update_sample_record(conn, sample)

        record_writers.upsert_sample_events(conn, payload.get("sampleEvents") or [])

        if delete_sample:
            asset_paths_to_delete = sample_assets.sample_asset_relative_paths(conn, [sample_id])
            conn.execute("DELETE FROM sample_assets WHERE sample_id = ?", (sample_id,))
            conn.execute("DELETE FROM sample_events WHERE sample_id = ?", (sample_id,))
            conn.execute("DELETE FROM project_task_samples WHERE sample_id = ?", (sample_id,))
            conn.execute("DELETE FROM sample_records WHERE id = ?", (sample_id,))
            reconcile_task_sample_occupancy(conn, destroyed_task_sample_ids - {sample_id})

        action = str(payload.get("action") or ("destroy_sample" if delete_sample else "sample_mutation"))
        new_revision, updated_at = _bump_revision_and_audit(
            ctx,
            conn,
            current_revision=current_revision,
            action=action,
            remark=str(payload.get("remark") or ("样机档案销毁" if delete_sample else "样机增量变更")),
            user=str(payload.get("user") or ""),
            client_ip=client_ip,
        )
        affected_task_ids = []
        affected_project_ids = []
        affected_stage_ids = []
        for item in payload.get("taskMutations") or []:
            if not isinstance(item, dict):
                continue
            affected_task_ids.append(item.get("taskId") or (item.get("task") or {}).get("id"))
            affected_project_ids.append(item.get("projectId") or (item.get("task") or {}).get("projectId"))
            affected_stage_ids.append(item.get("stageId") or (item.get("task") or {}).get("stageId"))
        affected_sample_ids = [sample_id, *destroyed_task_sample_ids, *[
            sample.get("id")
            for sample in payload.get("samples") or []
            if isinstance(sample, dict)
        ], *[
            event.get("sampleId")
            for event in payload.get("sampleEvents") or []
            if isinstance(event, dict)
        ]]
        affected = mutation_summary.build_mutation_affected_summary(
            conn,
            project_ids=affected_project_ids,
            stage_ids=affected_stage_ids,
            task_ids=affected_task_ids,
            sample_ids=affected_sample_ids,
        )
        conn.commit()

        if asset_paths_to_delete:
            ctx.unlink_asset_relative_paths(asset_paths_to_delete, warn_label="删除样机资产文件")

    return True, {"revision": new_revision, "updated_at": updated_at, "affected": affected}


def delete_sample_category_record(conn: sqlite3.Connection, category_id: str) -> list[str]:
    return record_writers.delete_sample_category_record(conn, category_id)


def commit_sample_category_mutation(ctx: MutationServiceContext, payload: dict, client_ip: str) -> tuple[bool, dict]:
    flag_failure = _mutation_flags_failure(payload, "deleteCategory", "createSamples", "createIfMissing")
    if flag_failure:
        return False, flag_failure
    category = payload.get("category")
    if category is not None and not isinstance(category, dict):
        return False, {"status": 400, "error": "category 必须是 JSON 对象"}
    category_id = str(payload.get("categoryId") or (category or {}).get("id") or "")
    if not category_id:
        return False, {"status": 400, "error": "缺少 categoryId"}
    delete_category = bool(payload.get("deleteCategory"))
    if not delete_category and payload.get("taskMutations"):
        return False, {"status": 400, "error_code": "SAMPLE_TASK_MUTATION_NOT_ALLOWED", "error": "普通样机池编辑不能同时修改任务，请使用任务操作保存。"}
    samples = payload.get("samples") or []
    if not isinstance(samples, list) or any(not isinstance(sample, dict) for sample in samples):
        return False, {"status": 400, "error": "samples 必须是 JSON 对象数组"}
    affected = {}
    asset_paths_to_delete: list[str] = []
    default_project_ids: list[str] = []
    destroyed_task_sample_ids: set[str] = set()

    with ctx.write_db_connection() as conn:
        current_revision = _current_revision(conn)
        revision_failure = _record_revision_failure(conn, payload, current_revision)
        if revision_failure:
            return False, revision_failure
        if not delete_category:
            scope_failure = _category_sample_scope_failure(conn, category_id, samples)
            if scope_failure:
                return False, {**scope_failure, "server_revision": current_revision}
            identity_failure = sample_constraints.sample_identity_write_failure(conn, samples)
            if identity_failure:
                return False, {**identity_failure, "server_revision": current_revision}
        event_failure = _sample_event_conflict_failure(conn, payload.get("sampleEvents"))
        if event_failure:
            return False, {**event_failure, "server_revision": current_revision}

        category_sample_ids: set[str] = set()
        if delete_category:
            exists = conn.execute(
                "SELECT 1 FROM sample_categories WHERE id = ? AND deleted_at IS NULL",
                (category_id,),
            ).fetchone()
            if not exists:
                return False, {
                    "status": 404,
                    "error_code": "SAMPLE_CATEGORY_NOT_FOUND",
                    "error": "待销毁的样机池档案不存在。",
                    "categoryId": category_id,
                }
            sample_rows = conn.execute(
                "SELECT id FROM sample_records WHERE category_id = ? AND deleted_at IS NULL",
                (category_id,),
            ).fetchall()
            category_sample_ids = {str(row["id"] or "") for row in sample_rows if str(row["id"] or "")}
            scope_failure = _sample_destroy_scope_failure(
                conn,
                sample_ids=category_sample_ids,
                task_mutations=payload.get("taskMutations"),
            )
            if scope_failure:
                scope_failure["server_revision"] = current_revision
                return False, scope_failure
            for item in payload.get("taskMutations") or []:
                destroyed_task_sample_ids.update(task_mutation_rules.existing_task_sample_ids(conn, str(item.get("taskId") or item["task"].get("id") or "")))

        payload_sample_ids = {
            str(sample.get("id") or "")
            for sample in (payload.get("samples") or [])
            if isinstance(sample, dict) and str(sample.get("id") or "")
        }
        event_scope_failure = _sample_event_scope_failure(
            conn,
            payload.get("sampleEvents"),
            allowed_sample_ids=category_sample_ids | payload_sample_ids,
            allow_missing_sample_ids=payload_sample_ids if payload.get("createSamples") else set(),
        )
        if event_scope_failure:
            return False, {**event_scope_failure, "server_revision": current_revision}

        if delete_category:
            # All rejecting guards must run before the first write. A normal
            # return exits the connection context successfully and commits.
            _persist_destroyed_sample_snapshots(
                conn, sample_ids=category_sample_ids, destroyed_at=ctx.now_iso(),
            )

        if not delete_category:
            category = payload.get("category")
            if not isinstance(category, dict):
                return False, {"status": 400, "error": "category 必须是 JSON 对象"}
            category["id"] = category_id
            record_writers.update_sample_category_record(
                conn,
                category,
                create_if_missing=bool(payload.get("createIfMissing")),
                sort_order=to_int(payload.get("sortOrder")) if payload.get("sortOrder") is not None else None,
            )

        for item in payload.get("taskMutations") or []:
            if not isinstance(item, dict):
                continue
            task = item.get("task")
            if not isinstance(task, dict):
                continue
            project_id = str(item.get("projectId") or task.get("projectId") or "")
            stage_id = str(item.get("stageId") or task.get("stageId") or "")
            task_id = str(item.get("taskId") or task.get("id") or "")
            if not project_id or not stage_id or not task_id:
                continue
            if not delete_category:
                record_writers.update_stage_record(conn, item.get("stage") or {}, project_id, stage_id)
            record_writers.upsert_task_record(
                conn,
                task,
                project_id,
                stage_id,
                create_if_missing=bool(item.get("createIfMissing")),
            )

        related_samples = payload.get("samples") or []
        if delete_category:
            related_samples = _operational_sample_write_payloads(conn, related_samples, preserve_sample_state=True)
        for sample in related_samples:
            if isinstance(sample, dict):
                record_writers.update_sample_record(
                    conn,
                    sample,
                    create_if_missing=bool(payload.get("createSamples") or payload.get("createIfMissing")),
                )
        record_writers.upsert_sample_events(conn, payload.get("sampleEvents") or [])

        if delete_category:
            default_project_ids = record_writers.clear_project_default_sample_category(conn, category_id)
            asset_paths_to_delete = delete_sample_category_record(conn, category_id)
            reconcile_task_sample_occupancy(conn, destroyed_task_sample_ids - category_sample_ids)

        new_revision, updated_at = _bump_revision_and_audit(
            ctx,
            conn,
            current_revision=current_revision,
            action=str(payload.get("action") or ("destroy_sample_category" if delete_category else "sample_category_mutation")),
            remark=str(payload.get("remark") or ("样机池档案销毁" if delete_category else "样机池增量变更")),
            user=str(payload.get("user") or ""),
            client_ip=client_ip,
        )
        affected_task_ids = []
        affected_project_ids = []
        affected_stage_ids = []
        for item in payload.get("taskMutations") or []:
            if not isinstance(item, dict):
                continue
            affected_task_ids.append(item.get("taskId") or (item.get("task") or {}).get("id"))
            affected_project_ids.append(item.get("projectId") or (item.get("task") or {}).get("projectId"))
            affected_stage_ids.append(item.get("stageId") or (item.get("task") or {}).get("stageId"))
        affected_project_ids.extend(default_project_ids)
        affected = mutation_summary.build_mutation_affected_summary(
            conn,
            project_ids=affected_project_ids,
            stage_ids=affected_stage_ids,
            task_ids=affected_task_ids,
            sample_category_ids=[category_id],
            sample_ids=[*destroyed_task_sample_ids, *[
                sample.get("id")
                for sample in payload.get("samples") or []
                if isinstance(sample, dict)
            ]],
        )
        conn.commit()

        if asset_paths_to_delete:
            ctx.unlink_asset_relative_paths(asset_paths_to_delete, warn_label="删除样机池资产文件")

    return True, {"revision": new_revision, "updated_at": updated_at, "affected": affected}
