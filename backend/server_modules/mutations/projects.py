"""项目与阶段增量写入。
阶段重排、删除后的样机释放与项目摘要在同一个写事务内完成。"""
from __future__ import annotations

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
    reconcile_task_sample_occupancy,
)

from .sample_guards import (
    _project_delete_sample_scope_failure,
    _sample_event_conflict_failure,
    _sample_event_scope_failure,
)

from .task_guards import (
    _stage_mutation_scope_failure,
)

from server_modules import (
    mutation_summary,
    record_writers,
    task_queries,
)


def commit_project_mutation(ctx: MutationServiceContext, payload: dict, client_ip: str) -> tuple[bool, dict]:
    flag_failure = _mutation_flags_failure(payload, "deleteProject", "createIfMissing")
    if flag_failure:
        return False, flag_failure
    project = payload.get("project")
    project_id = str(payload.get("projectId") or (project.get("id") if isinstance(project, dict) else "") or "")
    if not project_id:
        return False, {"status": 400, "error": "缺少 projectId"}
    delete_project = bool(payload.get("deleteProject"))
    if not delete_project and not isinstance(project, dict):
        return False, {"status": 400, "error": "project 必须是 JSON 对象"}
    if not delete_project and (project.get("_summaryOnly") or project.get("_summary") or project.get("_detailLoaded") is False):
        return False, {"status": 409, "error_code": "PROJECT_DETAIL_REQUIRED", "error": "项目详情尚未完整加载，请刷新后再保存项目配置。"}
    affected = {}

    with ctx.write_db_connection() as conn:
        current_revision = _current_revision(conn)
        revision_failure = _record_revision_failure(conn, payload, current_revision)
        if revision_failure:
            return False, revision_failure
        event_failure = _sample_event_conflict_failure(conn, payload.get("sampleEvents"))
        if event_failure:
            return False, {**event_failure, "server_revision": current_revision}
        project_sample_ids = {
            str(sample.get("id") or "")
            for sample in (payload.get("samples") or [])
            if isinstance(sample, dict) and str(sample.get("id") or "")
        }
        event_scope_failure = _sample_event_scope_failure(
            conn,
            payload.get("sampleEvents"),
            allowed_sample_ids=project_sample_ids,
            expected_project_id=project_id,
        )
        if event_scope_failure:
            return False, {**event_scope_failure, "server_revision": current_revision}

        if delete_project:
            exists = conn.execute(
                "SELECT 1 FROM project_records WHERE id = ? AND deleted_at IS NULL",
                (project_id,),
            ).fetchone()
            if not exists:
                return False, {
                    "status": 404,
                    "error_code": "PROJECT_NOT_FOUND",
                    "error": "待删除的项目不存在。",
                    "projectId": project_id,
                }
            scope_failure = _project_delete_sample_scope_failure(
                conn,
                project_id=project_id,
                samples=payload.get("samples"),
            )
            if scope_failure:
                scope_failure["server_revision"] = current_revision
                return False, scope_failure

        sample_payloads = [sample for sample in (payload.get("samples") or []) if isinstance(sample, dict)]
        for sample in _operational_sample_write_payloads(conn, sample_payloads, preserve_sample_state=delete_project):
            record_writers.update_sample_record(conn, sample)
        record_writers.upsert_sample_events(conn, payload.get("sampleEvents") or [])

        if delete_project:
            record_writers.delete_project_record(conn, project_id)
            reconcile_task_sample_occupancy(conn, project_sample_ids)
        else:
            project["id"] = project_id
            record_writers.update_project_record(
                conn,
                project,
                create_if_missing=bool(payload.get("createIfMissing")),
                sort_order=to_int(payload.get("sortOrder")) if payload.get("sortOrder") is not None else None,
            )

        new_revision, updated_at = _bump_revision_and_audit(
            ctx,
            conn,
            current_revision=current_revision,
            action=str(payload.get("action") or ("delete_project" if delete_project else "project_mutation")),
            remark=str(payload.get("remark") or ("删除项目" if delete_project else "项目增量变更")),
            user=str(payload.get("user") or ""),
            client_ip=client_ip,
        )
        affected = mutation_summary.build_mutation_affected_summary(
            conn,
            project_ids=[project_id],
            sample_ids=[
                sample.get("id")
                for sample in payload.get("samples") or []
                if isinstance(sample, dict)
            ],
        )
        conn.commit()

    return True, {"revision": new_revision, "updated_at": updated_at, "affected": affected}


def commit_stage_mutation(ctx: MutationServiceContext, payload: dict, client_ip: str) -> tuple[bool, dict]:
    flag_failure = _mutation_flags_failure(payload, "deleteStage", "createIfMissing")
    if flag_failure:
        return False, flag_failure
    stage = payload.get("stage")
    stage_body = stage if isinstance(stage, dict) else {}
    stage_id = str(payload.get("stageId") or stage_body.get("id") or "")
    project_id = str(payload.get("projectId") or stage_body.get("projectId") or "")
    if not stage_id or not project_id:
        return False, {"status": 400, "error": "缺少 projectId/stageId"}
    delete_stage = bool(payload.get("deleteStage"))
    if not delete_stage and not isinstance(stage, dict):
        return False, {"status": 400, "error": "stage 必须是 JSON 对象"}
    affected = {}

    with ctx.write_db_connection() as conn:
        current_revision = _current_revision(conn)
        revision_failure = _record_revision_failure(conn, payload, current_revision)
        if revision_failure:
            return False, revision_failure
        scope_failure = _stage_mutation_scope_failure(
            conn,
            project_id=project_id,
            stage_id=stage_id,
            create_if_missing=bool(payload.get("createIfMissing")),
            delete_stage=delete_stage,
        )
        if scope_failure:
            return False, {**scope_failure, "server_revision": current_revision}
        if payload.get("action") == "remove_scheme" and not delete_stage:
            stored = conn.execute("SELECT data_json FROM project_stages WHERE id = ?", (stage_id,)).fetchone()
            old_names = record_writers.json_obj(stored["data_json"], {}).get("skuNames", []) if stored else []
            new_names = stage_body.get("skuNames", [])
            removed_index = next((i for i in range(len(old_names)) if old_names[:i] + old_names[i + 1:] == new_names), None)
            if removed_index is None or not new_names:
                return False, {"status": 400, "error": "每次只能删除一个方案，且至少保留一个方案。"}
            # Tasks (including archived history) use positional SKU references.
            # Never let deleting an earlier scheme silently relabel those tasks.
            linked_task = conn.execute(
                "SELECT id FROM project_tasks WHERE stage_id = ? AND sku_index >= ? LIMIT 1",
                (stage_id, removed_index + 1),
            ).fetchone()
            if linked_task:
                return False, {"status": 409, "error_code": "SCHEME_HAS_TASK_REFERENCES", "error": "该方案或后续方案已关联任务，删除会改变任务的方案归属，请保留这些方案。"}
        siblings = payload.get("stages") or []
        if not isinstance(siblings, list):
            return False, {"status": 400, "error": "stages 必须是数组"}
        sibling_ids = []
        for sibling in siblings:
            sibling_id = str(sibling.get("id") or "") if isinstance(sibling, dict) else ""
            if not sibling_id or sibling_id in sibling_ids:
                return False, {"status": 400, "error": "stages 中阶段 id 必须非空且不能重复"}
            sibling_ids.append(sibling_id)
            if sibling_id == stage_id:
                continue
            sibling_failure = _stage_mutation_scope_failure(
                conn, project_id=project_id, stage_id=sibling_id,
                create_if_missing=False, delete_stage=False,
            )
            if sibling_failure:
                return False, {**sibling_failure, "server_revision": current_revision}
        if delete_stage:
            # Match the UI guard under the write transaction: another client may
            # have assigned or started a task since the delete dialog opened.
            occupied_rows = conn.execute(
                f"""
                SELECT DISTINCT t.id
                FROM project_tasks t JOIN project_task_samples pts ON pts.task_id = t.id
                WHERE t.stage_id = ? AND t.deleted_at IS NULL
                  AND t.flow_status NOT IN ('正常完成', '异常终止')
                  AND {task_queries.task_visibility_sql('t.data_json')}
                """,
                (stage_id,),
            ).fetchall()
            if occupied_rows:
                return False, {
                    "status": 409, "error_code": "STAGE_HAS_OCCUPIED_TASKS",
                    "error": "该阶段仍有未完成且占用样机的任务，请先结束或释放样机后再删除。",
                    "taskIds": [str(row["id"]) for row in occupied_rows],
                    "server_revision": current_revision,
                }
        event_failure = _sample_event_conflict_failure(conn, payload.get("sampleEvents"))
        if event_failure:
            return False, {**event_failure, "server_revision": current_revision}
        stage_sample_ids = {
            str(sample.get("id") or "")
            for sample in (payload.get("samples") or [])
            if isinstance(sample, dict) and str(sample.get("id") or "")
        }
        event_scope_failure = _sample_event_scope_failure(
            conn,
            payload.get("sampleEvents"),
            allowed_sample_ids=stage_sample_ids,
            expected_project_id=project_id,
            expected_stage_id=stage_id,
        )
        if event_scope_failure:
            return False, {**event_scope_failure, "server_revision": current_revision}

        sample_payloads = [sample for sample in (payload.get("samples") or []) if isinstance(sample, dict)]
        for sample in _operational_sample_write_payloads(conn, sample_payloads):
            record_writers.update_sample_record(conn, sample)
        record_writers.upsert_sample_events(conn, payload.get("sampleEvents") or [])

        if delete_stage:
            record_writers.delete_stage_record(conn, stage_id)
        else:
            stage["id"] = stage_id
            stage["projectId"] = project_id
            sort_order = sibling_ids.index(stage_id) if stage_id in sibling_ids else None
            if payload.get("action") != "reorder_stages":
                record_writers.update_stage_record(
                    conn,
                    stage,
                    project_id,
                    stage_id,
                    create_if_missing=bool(payload.get("createIfMissing")),
                    sort_order=sort_order,
                )
        # Sibling snapshots are only an ordering hint. Writing their full JSON
        # would silently undo concurrent edits in an unrelated stage.
        for idx, sibling_id in enumerate(sibling_ids):
            if delete_stage and sibling_id == stage_id:
                continue
            conn.execute(
                "UPDATE project_stages SET sort_order = ? WHERE id = ? AND project_id = ? AND deleted_at IS NULL",
                (idx, sibling_id, project_id),
            )

        new_revision, updated_at = _bump_revision_and_audit(
            ctx,
            conn,
            current_revision=current_revision,
            action=str(payload.get("action") or ("delete_stage" if delete_stage else "stage_mutation")),
            remark=str(payload.get("remark") or ("删除阶段" if delete_stage else "阶段增量变更")),
            user=str(payload.get("user") or ""),
            client_ip=client_ip,
        )
        affected = mutation_summary.build_mutation_affected_summary(
            conn,
            project_ids=[project_id],
            stage_ids=[stage_id, *[
                sibling.get("id")
                for sibling in payload.get("stages") or []
                if isinstance(sibling, dict)
            ]],
            sample_ids=[
                sample.get("id")
                for sample in payload.get("samples") or []
                if isinstance(sample, dict)
            ],
        )
        conn.commit()

    return True, {"revision": new_revision, "updated_at": updated_at, "affected": affected}
