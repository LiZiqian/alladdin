from __future__ import annotations

import copy
import json
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from server_modules import access_policy_transfer, chamber_package, import_commit, import_defaults, import_diff, migration_scope, mutation_summary as mutation_summary_module, record_writers


@dataclass(frozen=True)
class ImportBundleCommitContext:
    app_version: str
    sample_data_dir: Path
    import_previews: dict
    cleanup_expired_previews: Callable[[], None]
    cleanup_preview_temp: Callable[[str], None]
    load_import_preview_payload: Callable[[dict], tuple[dict, dict]]
    get_state_metadata: Callable[[], tuple[int, str]]
    get_state: Callable[..., tuple[dict, int, str]]
    detect_sample_occupancy_conflicts: Callable[[dict], list[dict]]
    write_db_connection: Callable
    now_iso: Callable[[], str]
    sync_project_library: Callable
    sync_sample_library: Callable
    split_state_for_storage: Callable[[dict], dict]
    json_dumps: Callable[[object], str]
    connect_db: Callable
    begin_read_snapshot: Callable
    load_sample_photos: Callable
    url_for_asset: Callable[[str, str], str]
    thumbnail_asset_id: Callable[[str], str]
    backfill_sample_asset_context: Callable[..., None]


def complete_accepted_identity_maps(
    incoming: dict,
    current_projects: dict[str, dict],
    project_id_map: dict[str, str],
    stage_id_map: dict[str, str],
    task_id_map: dict[str, str],
    *,
    skipped_project_ids: set[str] | None = None,
    skipped_stage_ids: set[str] | None = None,
    skipped_task_ids: set[str] | None = None,
) -> None:
    """Complete same-ID mappings for resources actually present after merge.

    Import diffing emits ``new_task`` without necessarily emitting an explicit
    project/stage merge decision when Host B already contains the same project
    and stage. Portable photo ownership is remapped fail-closed, so accepted
    ancestors need identity mappings before photo metadata is processed.
    Explicitly skipped name-conflict subtrees remain unmapped and restricted.
    """
    skipped_projects = {str(value) for value in (skipped_project_ids or set())}
    skipped_stages = {str(value) for value in (skipped_stage_ids or set())}
    skipped_tasks = {str(value) for value in (skipped_task_ids or set())}

    for incoming_project in incoming.get("projects") or []:
        if not isinstance(incoming_project, dict):
            continue
        source_project_id = str(incoming_project.get("id") or "")
        if not source_project_id or source_project_id in skipped_projects:
            continue
        target_project_id = str(project_id_map.get(source_project_id) or "")
        if not target_project_id and source_project_id in current_projects:
            target_project_id = source_project_id
            project_id_map[source_project_id] = source_project_id
        target_project = current_projects.get(target_project_id)
        if not isinstance(target_project, dict):
            continue
        target_stages = {
            str(stage.get("id") or ""): stage
            for stage in target_project.get("stages") or []
            if isinstance(stage, dict) and str(stage.get("id") or "")
        }
        for incoming_stage in incoming_project.get("stages") or []:
            if not isinstance(incoming_stage, dict):
                continue
            source_stage_id = str(incoming_stage.get("id") or "")
            if not source_stage_id or source_stage_id in skipped_stages:
                continue
            target_stage_id = str(stage_id_map.get(source_stage_id) or "")
            if not target_stage_id and source_stage_id in target_stages:
                target_stage_id = source_stage_id
                stage_id_map[source_stage_id] = source_stage_id
            target_stage = target_stages.get(target_stage_id)
            if not isinstance(target_stage, dict):
                continue
            target_task_ids = {
                str(task.get("id") or "")
                for task in target_stage.get("tasks") or []
                if isinstance(task, dict) and str(task.get("id") or "")
            }
            for incoming_task in incoming_stage.get("tasks") or []:
                if not isinstance(incoming_task, dict):
                    continue
                source_task_id = str(incoming_task.get("id") or "")
                if (
                    source_task_id
                    and source_task_id not in skipped_tasks
                    and source_task_id not in task_id_map
                    and source_task_id in target_task_ids
                ):
                    task_id_map[source_task_id] = source_task_id

def commit_merged_import_state(
    ctx: ImportBundleCommitContext,
    merged_data: dict,
    expected_revision: int | None,
    client_ip: str,
    remark: str,
    user: str,
    access_policy_commit: Callable[[object], dict] | None = None,
) -> tuple[bool, dict]:
    """Persist an already-merged import state without composing full current state again."""
    detect_sample_occupancy_conflicts = ctx.detect_sample_occupancy_conflicts
    write_db_connection = ctx.write_db_connection
    now_iso = ctx.now_iso
    sync_project_library = ctx.sync_project_library
    sync_sample_library = ctx.sync_sample_library
    split_state_for_storage = ctx.split_state_for_storage
    json_dumps = ctx.json_dumps
    APP_VERSION = ctx.app_version
    conflict = detect_sample_occupancy_conflicts(merged_data)
    if conflict:
        return False, {
            "status": 409,
            "error_code": "SAMPLE_OCCUPANCY_CONFLICT",
            "error": "样机占用冲突：同一样机被多个未完成任务占用，已拒绝保存。",
            "conflicts": conflict,
        }

    with write_db_connection() as conn:
        row = conn.execute("SELECT revision FROM app_state WHERE id = 1").fetchone()
        current_revision = int(row["revision"]) if row else 1
        if expected_revision is not None and int(expected_revision) != current_revision:
            return False, {
                "status": 409,
                "error": "revision 冲突，服务器数据已被其他客户端更新",
                "error_code": "IMPORT_REVISION_CONFLICT",
                "server_revision": current_revision,
            }

        new_revision = current_revision + 1
        updated_at = now_iso()
        merged_data["version"] = APP_VERSION
        sync_project_library(conn, merged_data, allow_empty=True)
        sync_sample_library(conn, merged_data, allow_empty=True)
        # Import can introduce legacy unclassified task photos after the
        # one-time startup migration marker already exists. Re-run inference
        # inside this same transaction so old packages cannot turn result
        # attachments into public pool photos on Host B.
        reclassify_assets = getattr(ctx, "backfill_sample_asset_context", None)
        if callable(reclassify_assets):
            reclassify_assets(conn, force=True)
        record_writers.prune_orphan_operational_logs(conn)
        access_policy_result = access_policy_commit(conn) if access_policy_commit else None
        stored_data = split_state_for_storage(merged_data)
        conn.execute(
            "UPDATE app_state SET data_json = ?, revision = ?, updated_at = ? WHERE id = 1",
            (json_dumps(stored_data), new_revision, updated_at),
        )
        conn.execute(
            """
            INSERT INTO audit_log
            (time, user, action, remark, revision_before, revision_after, client_ip)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (updated_at, user, "import_bundle_commit", remark, current_revision, new_revision, client_ip),
        )
        record_writers.clear_audit_log_when_platform_empty(conn)
        conn.commit()

    response = {"revision": new_revision, "updated_at": updated_at}
    if access_policy_result is not None:
        response["accessPolicy"] = access_policy_result
    return True, response


def commit_import_bundle(ctx: ImportBundleCommitContext, payload: dict) -> dict:
    """执行导入写入"""
    if not isinstance(payload, dict):
        return {"ok": False, "error": "导入提交参数格式不正确", "status": 400}
    _cleanup_expired_previews = ctx.cleanup_expired_previews
    _IMPORT_PREVIEWS = ctx.import_previews
    _load_import_preview_payload = ctx.load_import_preview_payload
    _cleanup_preview_temp = ctx.cleanup_preview_temp
    get_state_metadata = ctx.get_state_metadata
    get_state = ctx.get_state
    SAMPLE_DATA_DIR = ctx.sample_data_dir
    url_for_asset = ctx.url_for_asset
    thumbnail_asset_id = ctx.thumbnail_asset_id
    _normalize_project = import_diff.normalize_project
    _register_imported_project_tree = import_commit.register_imported_project_tree
    _register_imported_stage_tree = import_commit.register_imported_stage_tree
    _find_incoming_stage = import_commit.find_incoming_stage
    _find_incoming_task = import_commit.find_incoming_task
    _merge_project_sub_data = import_commit.merge_project_sub_data
    _content_hash = import_commit.content_hash
    _sample_index_by_id = import_commit.sample_index_by_id
    _merge_import_sample_subrecords = import_commit.merge_import_sample_subrecords
    _remap_import_photo_contexts = import_commit.remap_import_photo_contexts
    _apply_id_maps = import_commit.apply_id_maps
    _merge_import_sample_events = import_commit.merge_import_sample_events
    _validate_import_commit_state = import_commit.validate_import_commit_state
    _validate_touched_sample_identities = import_commit.validate_touched_sample_identities
    _build_import_mutation_summary = mutation_summary_module.build_import_mutation_summary

    def hydrate_import_target_photos(current_data: dict, incoming: dict, sample_id_map: dict[str, str], existing_sample_ids: set[str]) -> None:
        import_commit.hydrate_import_target_photos(
            current_data,
            incoming,
            sample_id_map,
            existing_sample_ids,
            connect_db=ctx.connect_db,
            begin_read_snapshot=ctx.begin_read_snapshot,
            load_sample_photos=ctx.load_sample_photos,
        )

    def merge_task_subrecords(target_task: dict, source_task: dict) -> int:
        added = 0
        for subkey in ("logs", "resultUploads", "sampleFaultRecords", "removedSampleRecords"):
            existing_ids = {
                str(item.get("id"))
                for item in (target_task.get(subkey) or [])
                if isinstance(item, dict) and item.get("id")
            }
            existing_hashes = {
                import_commit.content_hash(item)
                for item in (target_task.get(subkey) or [])
                if isinstance(item, dict)
            }
            for item in source_task.get(subkey) or []:
                if not isinstance(item, dict):
                    continue
                item_id = str(item.get("id") or "")
                item_hash = import_commit.content_hash(item)
                if (item_id and item_id in existing_ids) or item_hash in existing_hashes:
                    continue
                target_task.setdefault(subkey, []).append(copy.deepcopy(item))
                if item_id:
                    existing_ids.add(item_id)
                existing_hashes.add(item_hash)
                added += 1
        return added
    preview_id = str(payload.get("previewId") or "").strip()
    raw_decisions = payload.get("decisions")
    if raw_decisions is not None and not isinstance(raw_decisions, dict):
        return {"ok": False, "error": "导入冲突决策格式不正确", "status": 400}
    decisions = raw_decisions or {}
    selection_supplied = "selection" in payload and payload.get("selection") is not None
    selection = payload.get("selection")
    if selection_supplied and not isinstance(selection, dict):
        return {"ok": False, "error": "导入范围格式不正确", "status": 400}
    if selection_supplied and migration_scope.selection_is_empty(selection):
        return {
            "ok": False,
            "error": "未选择任何导入内容；为避免误操作，已拒绝把空选择解释为全量导入",
            "error_code": "EMPTY_IMPORT_SELECTION",
            "status": 400,
        }
    access_policy_mode = str(payload.get("accessPolicyMode") or "merge").strip()
    if access_policy_mode not in access_policy_transfer.SUPPORTED_IMPORT_MODES:
        return {
            "ok": False,
            "error": f"权限策略导入模式不受支持: {access_policy_mode or '(空)'}",
            "error_code": "ACCESS_POLICY_MODE_INVALID",
            "status": 400,
        }

    _cleanup_expired_previews()
    entry = _IMPORT_PREVIEWS.get(preview_id)
    if not entry:
        return {"ok": False, "error": "previewId 无效或已过期", "status": 400}

    incoming_payload, result = _load_import_preview_payload(entry)
    if not result:
        _cleanup_preview_temp(preview_id)
        del _IMPORT_PREVIEWS[preview_id]
        return {"ok": False, "error": "导入预览缓存损坏，请重新选择文件导入", "status": 400}
    # Preview payloads created by older builds (and long-lived tools) may
    # predate normalization. Re-normalize before filtering or validation so
    # missing legacy parent IDs are filled without accepting mismatches.
    incoming_payload = import_defaults.normalize_import_state(
        incoming_payload,
        source_format=str((result.get("source") or {}).get("format") or "preview"),
    )

    # ── Revision 校验：commit 时主库 revision 必须与 preview 时一致 ──
    preview_revision = entry.get("_revision")
    if preview_revision is not None:
        current_revision_check, _ = get_state_metadata()
        if current_revision_check != preview_revision:
            return {"ok": False,
                    "error": "服务器数据在预览后被其他用户修改，请重新选择文件导入。",
                    "error_code": "IMPORT_REVISION_CONFLICT",
                    "server_revision": current_revision_check,
                    "status": 409}

    tmp_dir = Path(entry["_tmp_dir"])
    manifest: dict = {}
    manifest_path = tmp_dir / "manifest.json"
    if manifest_path.is_file():
        try:
            loaded_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(loaded_manifest, dict):
                manifest = loaded_manifest
        except (OSError, json.JSONDecodeError):
            manifest = {}
    checksums = None
    checksums_path = tmp_dir / chamber_package.CHECKSUMS_PATH
    if checksums_path.is_file():
        try:
            loaded_checksums = json.loads(checksums_path.read_text(encoding="utf-8"))
            if isinstance(loaded_checksums, dict):
                checksums = loaded_checksums
        except (OSError, json.JSONDecodeError):
            checksums = None
    try:
        if checksums is not None and chamber_package.is_chamberdata_manifest(manifest):
            chamber_package.verify_checksums(tmp_dir, checksums)
        access_policy = access_policy_transfer.load_access_policy_from_package(
            tmp_dir,
            manifest,
            checksums,
            max_bytes=32 * 1024 * 1024,
        )
    except ValueError as exc:
        return {
            "ok": False,
            "error": f"权限策略校验失败：{exc}",
            "error_code": "ACCESS_POLICY_INVALID",
            "status": 400,
        }
    asset_index = {"assets": []}
    asset_index_path = tmp_dir / chamber_package.ASSET_INDEX_PATH
    if asset_index_path.is_file():
        try:
            loaded_asset_index = json.loads(asset_index_path.read_text(encoding="utf-8"))
            if isinstance(loaded_asset_index, dict):
                asset_index = loaded_asset_index
        except (OSError, json.JSONDecodeError):
            asset_index = {"assets": []}

    current_data = None
    if not migration_scope.selection_is_empty(selection):
        current_data, _, _ = get_state(compact=True)
        incoming_payload = migration_scope.filter_state_by_selection(incoming_payload, selection)
        selected_result = import_diff.diff_import_bundle(current_data, incoming_payload, manifest, tmp_dir, asset_index=asset_index)

        # 子集重算会改变顺序编号；按冲突实体身份复用原 preview 的 conflictId，
        # 确保前端在完整预览中做出的决策不会绑定到另一条冲突。
        conflict_identity_fields = (
            "type", "entity", "incomingId", "currentId", "sampleId",
            "incomingTaskId", "currentTaskId", "matchBy", "label",
        )

        def conflict_identity(conflict: dict) -> str:
            return json.dumps(
                {field: conflict.get(field) for field in conflict_identity_fields},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )

        original_conflict_ids: dict[str, list[str]] = {}
        for conflict in result.get("conflicts") or []:
            original_conflict_ids.setdefault(conflict_identity(conflict), []).append(str(conflict.get("conflictId") or ""))
        for conflict in selected_result.get("conflicts") or []:
            candidates = original_conflict_ids.get(conflict_identity(conflict)) or []
            if candidates:
                conflict["conflictId"] = candidates.pop(0)
        result = selected_result

    try:
        import_defaults.validate_import_state_structure(incoming_payload)
    except ValueError as exc:
        return {
            "ok": False,
            "error": f"导入数据结构校验失败：{exc}",
            "error_code": "IMPORT_STRUCTURE_INVALID",
            "status": 400,
        }

    blockers = result.get("blockers") or []
    if blockers:
        return {"ok": False, "error": "存在阻断项（如缺失照片），无法提交导入", "blockers": blockers, "status": 400}

    # 验证所有 conflict 都有 decision
    for c in result.get("conflicts") or []:
        cid = c.get("conflictId")
        if cid not in decisions:
            return {"ok": False, "error": f"冲突 {cid} 尚未处理", "status": 400}
        d = decisions[cid]
        if not isinstance(d, dict):
            return {"ok": False, "error": f"冲突 {cid} 的决策格式不正确", "status": 400}
        action = str(d.get("action") or "")
        allowed_actions = {str(item) for item in (c.get("allowedActions") or []) if str(item)}
        if allowed_actions and action not in allowed_actions:
            return {"ok": False, "error": f"冲突 {cid} 的处理动作不受支持: {action or '(空)'}", "status": 400}
        if action == "merge_into_existing":
            target_id = str(d.get("targetId") or c.get("preferredMergeTarget") or c.get("currentId") or "")
            allowed_targets = {
                str(value)
                for value in (c.get("preferredMergeTarget"), c.get("currentId"))
                if str(value or "")
            }
            if allowed_targets and target_id not in allowed_targets:
                return {"ok": False, "error": f"冲突 {cid} 的合并目标不合法", "status": 400}
        if action == "rename_import":
            # 项目/阶段/任务改名导入：必须有 newName
            if not d.get("newName", "").strip():
                return {"ok": False, "error": f"冲突 {cid} 选择改名导入但未提供新名称", "status": 400}
        elif action == "import_as_new_with_identity_edit":
            # 样机标识编辑导入：必须有至少一个新标识字段
            new_sn = (d.get("newSN") or "").strip()
            new_imei = (d.get("newIMEI") or "").strip()
            new_board_sn = (d.get("newBoardSn") or "").strip()
            new_sample_no = (d.get("newSampleNo") or "").strip()
            if not new_sn and not new_imei and not new_board_sn and not new_sample_no:
                return {"ok": False, "error": f"冲突 {cid} 选择编辑标识导入但未提供新 SN/IMEI/主板SN/编号", "status": 400}
        elif action == "apply_field_choices":
            if not isinstance(d.get("fieldChoices") or {}, dict):
                return {"ok": False, "error": f"冲突 {cid} 的字段选择格式不正确", "status": 400}
        field_choices = d.get("fieldChoices") or {}
        if not isinstance(field_choices, dict):
            return {"ok": False, "error": f"冲突 {cid} 的字段选择格式不正确", "status": 400}
        valid_fields = {str(item) for item in (c.get("diffFields") or c.get("mergeableFields") or [])}
        for field, choice in field_choices.items():
            if valid_fields and str(field) not in valid_fields:
                return {"ok": False, "error": f"冲突 {cid} 包含未知字段选择: {field}", "status": 400}
            if choice not in {"current", "incoming"}:
                return {"ok": False, "error": f"冲突 {cid} 的字段 {field} 选择值不正确", "status": 400}

    # Commit merge does not need full photo/event arrays for the whole library.
    # Existing photos for touched samples are loaded selectively before photo merge.
    if current_data is None:
        current_data, _, _ = get_state(compact=True)
    existing_sample_ids_before_import = set(_sample_index_by_id(current_data).keys())
    existing_sample_occupancy = {
        sample_id: {
            field: copy.deepcopy(sample.get(field))
            for field in ("currentTaskId", "currentProjectId", "currentStageId", "currentTestItem")
        }
        for sample_id, sample in _sample_index_by_id(current_data).items()
    }
    existing_task_ids_before_import = {
        str(task.get("id"))
        for project in current_data.get("projects") or []
        for stage in (project.get("stages") or [])
        for task in (stage.get("tasks") or [])
        if isinstance(task, dict) and task.get("id")
    }

    incoming = copy.deepcopy(incoming_payload)
    source_manifest = (result.get("source") or {})
    source_deployment_id = str(
        source_manifest.get("sourceDeploymentId")
        or source_manifest.get("deploymentId")
        or manifest.get("sourceDeploymentId")
        or ""
    )
    asset_lookup = chamber_package.sample_photo_asset_lookup(asset_index)

    def import_asset_source(incoming_sample_id: str, photo: dict, role: str, fallback_relative_path: str) -> tuple[Path | None, str]:
        photo_id = str(photo.get("id") or "")
        asset = asset_lookup.get((str(incoming_sample_id), photo_id, role))
        if asset:
            zip_path = str(asset.get("zipPath") or "")
            source_path = chamber_package.safe_package_member_path(tmp_dir, zip_path)
            filename = Path(str(asset.get("fileName") or Path(zip_path).name or Path(fallback_relative_path).name)).name
            return source_path, filename
        filename = Path(fallback_relative_path or "").name
        if not filename:
            return None, ""
        fallback_path = chamber_package.safe_package_member_path(
            tmp_dir,
            f"assets/samples/{incoming_sample_id}/photos/{filename}",
        )
        return fallback_path, filename

    # 构建决策索引
    decision_map: dict[str, dict] = {}
    for c in result.get("conflicts") or []:
        cid = c.get("conflictId", "")
        if cid in decisions:
            decision_map[cid] = decisions[cid]

    # ── 处理项目 ──
    curr_projects = {p["id"]: p for p in (current_data.setdefault("projects", []))}
    incoming_projects_by_id = {p["id"]: p for p in (incoming.get("projects") or [])}

    stats = {"projectsAdded": 0, "projectsMerged": 0, "stagesAdded": 0, "stagesMerged": 0,
             "tasksAdded": 0, "tasksMerged": 0, "samplesAdded": 0, "samplesMerged": 0,
             "photosAdded": 0, "sampleEventsAdded": 0, "skipped": 0}

    # ── ID 映射表（incoming → target），所有写入必须经此重映射 ──
    project_id_map: dict[str, str] = {}  # incomingPID → targetPID
    stage_id_map: dict[str, str] = {}    # incomingSID → targetSID
    task_id_map: dict[str, str] = {}     # incomingTID → targetTID
    sample_id_map: dict[str, str] = {}   # incomingSampleID → targetSampleID
    sample_category_id_map: dict[str, str] = {}
    skipped_sample_ids: set[str] = set()
    skipped_project_ids: set[str] = set()
    skipped_stage_ids: set[str] = set()
    skipped_task_ids: set[str] = set()
    fully_imported_project_ids: set[str] = set()
    fully_imported_stage_ids: set[str] = set()
    touched_structure_project_ids: set[str] = set()
    pending_occupancy_decisions: list[tuple[dict, str]] = []

    for auto in result.get("autoApply") or []:
        atype = auto["type"]
        if atype == "new_project":
            pid = auto["id"]
            if pid not in curr_projects and pid in incoming_projects_by_id:
                project = _normalize_project(incoming_projects_by_id[pid])
                curr_projects[pid] = project
                stats["projectsAdded"] += 1
                project_id_map[pid] = pid
                stage_count, task_count, stage_ids = _register_imported_project_tree(project, stage_id_map, task_id_map)
                stats["stagesAdded"] += stage_count
                stats["tasksAdded"] += task_count
                fully_imported_project_ids.add(pid)
                fully_imported_stage_ids.update(stage_ids)
                touched_structure_project_ids.add(pid)
        elif atype == "new_stage":
            proj_id = auto.get("projectId", "")
            sid = auto["id"]
            target_project_id = project_id_map.get(proj_id, proj_id)
            if proj_id in fully_imported_project_ids or sid in fully_imported_stage_ids:
                continue
            if target_project_id in curr_projects and proj_id in incoming_projects_by_id:
                inc_proj = incoming_projects_by_id[proj_id]
                for inc_stage in inc_proj.get("stages") or []:
                    if inc_stage.get("id") == sid:
                        stage = copy.deepcopy(inc_stage)
                        curr_projects[target_project_id].setdefault("stages", []).append(stage)
                        stats["stagesAdded"] += 1
                        _, task_count, stage_id = _register_imported_stage_tree(stage, stage_id_map, task_id_map)
                        stats["tasksAdded"] += task_count
                        if stage_id:
                            fully_imported_stage_ids.add(stage_id)
                        touched_structure_project_ids.add(target_project_id)
                        break
        elif atype == "new_task":
            proj_id = auto.get("projectId", "")
            stage_id = auto.get("stageId", "")
            tid = auto["id"]
            target_project_id = project_id_map.get(proj_id, proj_id)
            target_stage_id = stage_id_map.get(stage_id, stage_id)
            if proj_id in fully_imported_project_ids or stage_id in fully_imported_stage_ids:
                continue
            if target_project_id in curr_projects and proj_id in incoming_projects_by_id:
                inc_proj = incoming_projects_by_id[proj_id]
                for inc_stage in inc_proj.get("stages") or []:
                    if inc_stage.get("id") == stage_id:
                        for inc_task in inc_stage.get("tasks") or []:
                            if inc_task.get("id") == tid:
                                curr_stages = curr_projects[target_project_id].setdefault("stages", [])
                                for cs in curr_stages:
                                    if cs.get("id") == target_stage_id:
                                        cs.setdefault("tasks", []).append(copy.deepcopy(inc_task))
                                        stats["tasksAdded"] += 1
                                        task_id_map[tid] = tid
                                        touched_structure_project_ids.add(target_project_id)
                                        break
                                break
                        break
        elif atype == "new_sample":
            sid = auto["id"]
            # 稍后处理

    # 处理样机类别索引（field_conflict 中 sample 类型需要）
    curr_categories = {c["id"]: c for c in (current_data.setdefault("sampleLibrary", {})).setdefault("categories", [])}
    incoming_categories_by_id: dict[str, dict] = {}
    incoming_samples_by_id: dict[str, dict] = {}
    for cat in (incoming.get("sampleLibrary") or {}).get("categories") or []:
        incoming_categories_by_id[str(cat["id"])] = cat
        for s in cat.get("samples") or []:
            incoming_samples_by_id[str(s["id"])] = s

    # 处理项目级冲突
    for c in result.get("conflicts") or []:
        cid = c["conflictId"]
        d = decision_map.get(cid, {})
        action = d.get("action", "skip")
        etype = c.get("entity")

        # ── 硬规则：未实现冲突类型必须报错 ──
        ctype = c.get("type", "unknown")
        SUPPORTED = ("field_conflict", "project_name_conflict",
                     "stage_name_conflict", "task_name_conflict",
                     "sample_identity_conflict", "task_occupancy_conflict")
        if ctype not in SUPPORTED:
            return {"ok": False,
                    "error": f"不支持的冲突类型: {ctype} (冲突 {cid})",
                    "error_code": "UNSUPPORTED_IMPORT_CONFLICT", "status": 400}

        # ── field_conflict：统一处理所有实体类型 ──
        if c.get("type") == "field_conflict":
            if action == "apply_field_choices":
                field_choices = d.get("fieldChoices", {})
                target_id = c.get("currentId")
                inc_id = c.get("incomingId")
                if etype == "project":
                    if target_id in curr_projects and inc_id in incoming_projects_by_id:
                        curr_p = curr_projects[target_id]
                        inc_p = incoming_projects_by_id[inc_id]
                        for fname in c.get("diffFields", []):
                            choice = field_choices.get(fname, "current")
                            if choice == "incoming" and fname in inc_p:
                                curr_p[fname] = inc_p[fname]
                        stats["projectsMerged"] += 1
                        project_id_map[inc_id] = target_id
                        touched_structure_project_ids.add(target_id)
                elif etype == "stage":
                    # 在当前主库中查找 stage
                    for proj_id, proj in curr_projects.items():
                        for stage in proj.get("stages") or []:
                            if stage.get("id") == target_id:
                                inc_stage = _find_incoming_stage(incoming_projects_by_id, inc_id)
                                if inc_stage:
                                    for fname in c.get("diffFields", []):
                                        choice = field_choices.get(fname, "current")
                                        if choice == "incoming" and fname in inc_stage:
                                            stage[fname] = inc_stage[fname]
                                if inc_id:
                                    stage_id_map[inc_id] = target_id
                                touched_structure_project_ids.add(proj_id)
                                break
                elif etype == "task":
                    for proj_id, proj in curr_projects.items():
                        for stage in proj.get("stages") or []:
                            for task in stage.get("tasks") or []:
                                if task.get("id") == target_id:
                                    inc_task = _find_incoming_task(incoming_projects_by_id, inc_id)
                                    if inc_task:
                                        for fname in c.get("diffFields", []):
                                            choice = field_choices.get(fname, "current")
                                            if choice == "incoming" and fname in inc_task:
                                                task[fname] = inc_task[fname]
                                    if inc_id:
                                        task_id_map[inc_id] = target_id
                                    touched_structure_project_ids.add(proj_id)
                                    break
                elif etype == "sample":
                    for cat_id, cat in curr_categories.items():
                        for cs in cat.get("samples") or []:
                            if cs.get("id") == target_id:
                                inc_sample = incoming_samples_by_id.get(str(inc_id or ""))
                                if inc_sample and isinstance(inc_sample, dict):
                                    for fname in c.get("diffFields", []):
                                        choice = field_choices.get(fname, "current")
                                        if choice == "incoming" and fname in inc_sample:
                                            cs[fname] = inc_sample[fname]
                                sample_id_map[inc_id] = target_id
                                stats["samplesMerged"] += 1
                                break
                elif etype == "sampleCategory":
                    target_category = curr_categories.get(str(target_id or ""))
                    incoming_category = incoming_categories_by_id.get(str(inc_id or ""))
                    if target_category and incoming_category:
                        for fname in c.get("diffFields", []):
                            choice = field_choices.get(fname, "current")
                            if choice == "incoming" and fname in incoming_category:
                                target_category[fname] = copy.deepcopy(incoming_category[fname])
                        if inc_id:
                            sample_category_id_map[str(inc_id)] = str(target_id or inc_id)
            elif action == "skip":
                if etype == "sample" and c.get("incomingId"):
                    skipped_sample_ids.add(str(c.get("incomingId")))
                if etype == "task" and c.get("incomingId"):
                    skipped_task_ids.add(str(c.get("incomingId")))
                stats["skipped"] += 1
            continue  # field_conflict 已处理，跳过后续 entity 特定逻辑

        if etype == "project":
            ipid = c.get("incomingId")
            if action == "merge_into_existing":
                target_id = d.get("targetId") or c.get("preferredMergeTarget") or c.get("currentId")
                if ipid in incoming_projects_by_id and target_id in curr_projects:
                    # 合并：追加子数据（阶段/任务），不覆盖项目主字段
                    inc_proj = incoming_projects_by_id[ipid]
                    curr_proj = curr_projects[target_id]
                    _merge_project_sub_data(curr_proj, inc_proj)
                    stats["projectsMerged"] += 1
                    project_id_map[ipid] = target_id
                    target_stages = {
                        str(stage.get("id") or ""): stage
                        for stage in curr_proj.get("stages") or []
                        if isinstance(stage, dict) and str(stage.get("id") or "")
                    }
                    for incoming_stage in inc_proj.get("stages") or []:
                        if not isinstance(incoming_stage, dict):
                            continue
                        incoming_stage_id = str(incoming_stage.get("id") or "")
                        target_stage = target_stages.get(incoming_stage_id)
                        if not incoming_stage_id or not target_stage:
                            continue
                        stage_id_map[incoming_stage_id] = incoming_stage_id
                        target_task_ids = {
                            str(task.get("id") or "")
                            for task in target_stage.get("tasks") or []
                            if isinstance(task, dict) and str(task.get("id") or "")
                        }
                        for incoming_task in incoming_stage.get("tasks") or []:
                            incoming_task_id = str((incoming_task or {}).get("id") or "") if isinstance(incoming_task, dict) else ""
                            if incoming_task_id and incoming_task_id in target_task_ids:
                                task_id_map[incoming_task_id] = incoming_task_id
                    touched_structure_project_ids.add(target_id)
            elif action == "rename_import":
                new_name = d.get("newName", "").strip()
                if new_name and ipid in incoming_projects_by_id:
                    inc_proj = incoming_projects_by_id[ipid]
                    inc_proj["name"] = new_name
                    project = _normalize_project(inc_proj)
                    curr_projects[ipid] = project
                    stats["projectsAdded"] += 1
                    project_id_map[ipid] = ipid
                    stage_count, task_count, stage_ids = _register_imported_project_tree(project, stage_id_map, task_id_map)
                    stats["stagesAdded"] += stage_count
                    stats["tasksAdded"] += task_count
                    fully_imported_stage_ids.update(stage_ids)
                    touched_structure_project_ids.add(ipid)
            elif action == "skip":
                if ipid:
                    skipped_project_ids.add(str(ipid))
                stats["skipped"] += 1

        # ── stage_name_conflict ──
        elif c.get("type") == "stage_name_conflict":
            inc_sid = c.get("incomingId")
            inc_stage = _find_incoming_stage(incoming_projects_by_id, inc_sid)
            if action == "merge_into_existing":
                target_id = d.get("targetId") or c.get("preferredMergeTarget") or c.get("currentId")
                if inc_stage and target_id:
                    for proj_id, proj in curr_projects.items():
                        for st in proj.get("stages") or []:
                            if st.get("id") == target_id:
                                existing_task_ids = {t.get("id") for t in (st.get("tasks") or [])}
                                for inc_task in inc_stage.get("tasks") or []:
                                    tid = inc_task.get("id", "")
                                    if tid and tid not in existing_task_ids:
                                        st.setdefault("tasks", []).append(copy.deepcopy(inc_task))
                                        stats["tasksAdded"] += 1
                                        existing_task_ids.add(tid)
                                    if tid and tid in existing_task_ids:
                                        task_id_map[tid] = tid
                                stats["stagesMerged"] += 1
                                stage_id_map[inc_sid] = target_id
                                touched_structure_project_ids.add(proj_id)
                                break
            elif action == "rename_import":
                new_name = d.get("newName", "").strip()
                if new_name and inc_stage and inc_sid:
                    inc_stage["name"] = new_name
                    # 查找 stage 所属的 incoming project，经 project_id_map 定位 target project
                    for inc_pid, inc_proj in incoming_projects_by_id.items():
                        found = any(s.get("id") == inc_sid for s in (inc_proj.get("stages") or []))
                        if found:
                            target_pid = project_id_map.get(inc_pid, inc_pid)
                            if target_pid in curr_projects:
                                stage = copy.deepcopy(inc_stage)
                                curr_projects[target_pid].setdefault("stages", []).append(stage)
                                stats["stagesAdded"] += 1
                                _, task_count, stage_id = _register_imported_stage_tree(stage, stage_id_map, task_id_map)
                                stats["tasksAdded"] += task_count
                                if stage_id:
                                    fully_imported_stage_ids.add(stage_id)
                                touched_structure_project_ids.add(target_pid)
                                stage_id_map[inc_sid] = inc_sid
                            break
            elif action == "skip":
                if inc_sid:
                    skipped_stage_ids.add(str(inc_sid))
                    stage_id_map.pop(str(inc_sid), None)
                    if inc_stage:
                        for inc_task in inc_stage.get("tasks") or []:
                            if isinstance(inc_task, dict) and inc_task.get("id"):
                                skipped_task_ids.add(str(inc_task.get("id")))
                                task_id_map.pop(str(inc_task.get("id")), None)
                stats["skipped"] += 1

        # ── task_name_conflict ──
        elif c.get("type") == "task_name_conflict":
            inc_tid = c.get("incomingId")
            inc_task = _find_incoming_task(incoming_projects_by_id, inc_tid)
            if action == "merge_into_existing":
                target_id = d.get("targetId") or c.get("preferredMergeTarget") or c.get("currentId")
                if inc_task and target_id:
                    for proj_id, proj in curr_projects.items():
                        for st in proj.get("stages") or []:
                            for tk in st.get("tasks") or []:
                                if tk.get("id") == target_id:
                                    # 合并日志/结果
                                    merge_task_subrecords(tk, inc_task)
                                    stats["tasksMerged"] += 1
                                    task_id_map[inc_tid] = target_id
                                    touched_structure_project_ids.add(proj_id)
                                    break
            elif action == "rename_import":
                new_name = d.get("newName", "").strip()
                if new_name and inc_task and inc_tid:
                    inc_task["testItem"] = new_name
                    # 找到 task 所属的 stage → project，经映射定位
                    for inc_pid, inc_proj in incoming_projects_by_id.items():
                        for inc_st in (inc_proj.get("stages") or []):
                            for inc_tk in (inc_st.get("tasks") or []):
                                if inc_tk.get("id") == inc_tid:
                                    target_pid = project_id_map.get(inc_pid, inc_pid)
                                    target_sid = stage_id_map.get(inc_st.get("id"), inc_st.get("id"))
                                    if target_pid in curr_projects:
                                        for cs in curr_projects[target_pid].get("stages") or []:
                                            if cs.get("id") == target_sid:
                                                cs.setdefault("tasks", []).append(copy.deepcopy(inc_task))
                                                stats["tasksAdded"] += 1
                                                task_id_map[inc_tid] = inc_tid
                                                touched_structure_project_ids.add(target_pid)
                                                break
                                    break
            elif action == "skip":
                if inc_tid:
                    skipped_task_ids.add(str(inc_tid))
                    task_id_map.pop(str(inc_tid), None)
                stats["skipped"] += 1

        # ── task_occupancy_conflict ──
        elif c.get("type") == "task_occupancy_conflict":
            if action in ("skip_occupancy", "import_no_occupy", "skip"):
                pending_occupancy_decisions.append((c, action))
                stats["skipped"] += 1

    # 同 ID 任务的日志/结果属于可追加子记录；此前仅比较主字段会静默漏掉这些数据。
    current_task_index: dict[str, tuple[str, dict]] = {}
    for project_id, project in curr_projects.items():
        for stage in project.get("stages") or []:
            for task in stage.get("tasks") or []:
                if isinstance(task, dict) and task.get("id"):
                    current_task_index[str(task.get("id"))] = (project_id, task)
    for incoming_project in incoming.get("projects") or []:
        for incoming_stage in incoming_project.get("stages") or []:
            for incoming_task in incoming_stage.get("tasks") or []:
                task_id = str(incoming_task.get("id") or "")
                if not task_id or task_id not in existing_task_ids_before_import or task_id in skipped_task_ids:
                    continue
                target_entry = current_task_index.get(task_id)
                if not target_entry:
                    continue
                project_id, target_task = target_entry
                added = merge_task_subrecords(target_task, incoming_task)
                task_id_map.setdefault(task_id, task_id)
                touched_structure_project_ids.add(project_id)
                if added:
                    stats["tasksMerged"] += 1

    # 处理样机
    curr_categories = {c["id"]: c for c in (current_data.setdefault("sampleLibrary", {})).setdefault("categories", [])}
    curr_category_names = {
        str(c.get("name") or "").strip().lower(): c
        for c in curr_categories.values()
        if str(c.get("name") or "").strip()
    }

    def ensure_target_sample_category(incoming_category: dict) -> dict:
        inc_id = str((incoming_category or {}).get("id") or "")
        inc_name = str((incoming_category or {}).get("name") or "")
        inc_name_key = inc_name.strip().lower()
        if inc_id and inc_id in curr_categories:
            sample_category_id_map[inc_id] = inc_id
            return curr_categories[inc_id]
        if inc_name_key and inc_name_key in curr_category_names:
            target = curr_category_names[inc_name_key]
            target_id = str(target.get("id") or "")
            if inc_id and target_id:
                sample_category_id_map[inc_id] = target_id
            return target

        target_id = inc_id or f"cat_{uuid.uuid4().hex[:12]}"
        while target_id in curr_categories:
            target_id = f"cat_{uuid.uuid4().hex[:12]}"
        target = copy.deepcopy(incoming_category or {})
        target["id"] = target_id
        target["name"] = str(target.get("name") or inc_name or "未命名样机池")
        target["description"] = str(target.get("description") or "")
        target["samples"] = []
        curr_categories[target_id] = target
        if inc_name_key:
            curr_category_names[inc_name_key] = target
        if inc_id:
            sample_category_id_map[inc_id] = target_id
        return target

    incoming_cats_by_id = {}
    for cat in (incoming.get("sampleLibrary") or {}).get("categories") or []:
        incoming_cats_by_id[cat["id"]] = cat
        # Preserve intentionally empty pools, but do not create a ghost pool
        # when every contained sample was skipped or merged elsewhere.
        if not any(isinstance(sample, dict) for sample in (cat.get("samples") or [])):
            ensure_target_sample_category(cat)
        for s in cat.get("samples") or []:
            incoming_cats_by_id[s["id"]] = s  # 也索引样机

    # 新增样机
    for auto in result.get("autoApply") or []:
        if auto["type"] == "new_sample":
            sid = auto["id"]
            # 找到样机所属类别并添加
            for inc_cat in (incoming.get("sampleLibrary") or {}).get("categories") or []:
                for inc_s in inc_cat.get("samples") or []:
                    if inc_s.get("id") == sid:
                        target_cat = ensure_target_sample_category(inc_cat)
                        target_sample = copy.deepcopy(inc_s)
                        target_sample["categoryId"] = str(target_cat.get("id") or "")
                        target_cat.setdefault("samples", []).append(target_sample)
                        stats["samplesAdded"] += 1
                        sample_id_map[sid] = sid
                        break

    # 处理样机冲突
    for c in result.get("conflicts") or []:
        if c.get("entity") != "sample":
            continue
        cid = c["conflictId"]
        d = decision_map.get(cid, {})
        action = d.get("action", "skip")

        if c["type"] == "sample_identity_conflict":
            if action == "merge_into_existing":
                target_id = d.get("targetId") or c.get("preferredMergeTarget") or c.get("currentId")
                inc_id = c.get("incomingId")
                # 找到导入样机
                inc_sample = None
                for cat in (incoming.get("sampleLibrary") or {}).get("categories") or []:
                    for s in cat.get("samples") or []:
                        if s.get("id") == inc_id:
                            inc_sample = s
                            break
                if inc_sample and target_id:
                    # 找到主库样机并合并
                    for cat_id, cat in curr_categories.items():
                        for cs in cat.get("samples") or []:
                            if cs.get("id") == target_id:
                                # 逐字段选择
                                field_choices = d.get("fieldChoices", {})
                                for fname in c.get("mergeableFields", []):
                                    choice = field_choices.get(fname, "current")
                                    if choice == "incoming" and fname in inc_sample:
                                        cs[fname] = inc_sample[fname]
                                # 追加子数据
                                sub_data_keys = c.get("autoMergeSubData", [])
                                for subk in sub_data_keys:
                                    if subk == "photos":
                                        # Central photo merge below loads only the touched
                                        # target sample photos before appending incoming photos.
                                        continue
                                    elif subk == "problemRecords":
                                        existing_hashes = {_content_hash(pr) for pr in (cs.get("problemRecords") or [])}
                                        for pr in inc_sample.get("problemRecords") or []:
                                            if _content_hash(pr) not in existing_hashes:
                                                cs.setdefault("problemRecords", []).append(copy.deepcopy(pr))
                                                existing_hashes.add(_content_hash(pr))
                                stats["samplesMerged"] += 1
                                sample_id_map[inc_id] = target_id
                                break
            elif action == "import_as_new_with_identity_edit":
                inc_id = c.get("incomingId")
                new_sn = d.get("newSN", "").strip()
                new_imei = d.get("newIMEI", "").strip()
                new_board_sn = d.get("newBoardSn", "").strip()
                new_sample_no = d.get("newSampleNo", "").strip()
                # 找到导入样机
                inc_sample = None
                inc_cat = None
                for cat in (incoming.get("sampleLibrary") or {}).get("categories") or []:
                    for s in cat.get("samples") or []:
                        if s.get("id") == inc_id:
                            inc_sample = s
                            inc_cat = cat
                            break
                if inc_sample:
                    if new_sn:
                        inc_sample["sn"] = new_sn
                    if new_imei:
                        inc_sample["imei"] = new_imei
                    if new_board_sn:
                        inc_sample["boardSn"] = new_board_sn
                    if new_sample_no:
                        inc_sample["sampleNo"] = new_sample_no
                    target_cat = ensure_target_sample_category(inc_cat or {})
                    target_sample = copy.deepcopy(inc_sample)
                    target_sample["categoryId"] = str(target_cat.get("id") or "")
                    target_cat.setdefault("samples", []).append(target_sample)
                    stats["samplesAdded"] += 1
                    sample_id_map[inc_id] = inc_id
            elif action == "skip":
                if c.get("incomingId"):
                    skipped_sample_ids.add(str(c.get("incomingId")))
                stats["skipped"] += 1

    incoming_sample_ids = {
        str(sample.get("id"))
        for cat in (incoming.get("sampleLibrary") or {}).get("categories") or []
        for sample in (cat.get("samples") or [])
        if sample.get("id")
    }
    current_sample_ids = {
        str(sample.get("id"))
        for cat in curr_categories.values()
        for sample in (cat.get("samples") or [])
        if sample.get("id")
    }
    for sid in incoming_sample_ids:
        if sid in current_sample_ids and sid not in skipped_sample_ids:
            sample_id_map.setdefault(sid, sid)

    def drop_task_sample_reference(sample_id: str, task_id: str = "") -> None:
        for project_tree in (incoming.get("projects") or [], curr_projects.values()):
            for project in project_tree:
                for stage in project.get("stages") or []:
                    for task in stage.get("tasks") or []:
                        if task_id and str(task.get("id") or "") != task_id:
                            continue
                        task["sampleIds"] = [
                            value for value in (task.get("sampleIds") or [])
                            if str(value or "") != str(sample_id)
                        ]

    for skipped_sample_id in skipped_sample_ids:
        drop_task_sample_reference(skipped_sample_id)

    for conflict, _action in pending_occupancy_decisions:
        incoming_sample_id = str(conflict.get("sampleId") or "")
        target_sample_id = str(conflict.get("targetSampleId") or incoming_sample_id)
        resolved_target_id = str(sample_id_map.get(incoming_sample_id) or incoming_sample_id)
        # 若用户把身份冲突样机改成新标识作为新样机导入，此占用冲突已自然消失。
        if resolved_target_id != target_sample_id:
            continue
        drop_task_sample_reference(incoming_sample_id, str(conflict.get("incomingTaskId") or ""))
        incoming_sample = _sample_index_by_id(incoming).get(incoming_sample_id)
        if incoming_sample:
            incoming_sample["currentTaskId"] = None
            incoming_sample["currentProjectId"] = None
            incoming_sample["currentStageId"] = None
            incoming_sample["currentTestItem"] = ""
        target_sample = _sample_index_by_id(current_data).get(target_sample_id)
        if target_sample and target_sample_id in existing_sample_occupancy:
            target_sample.update(copy.deepcopy(existing_sample_occupancy[target_sample_id]))

    current_data["sampleLibrary"]["categories"] = list(curr_categories.values())
    current_data["projects"] = list(curr_projects.values())

    complete_accepted_identity_maps(
        incoming,
        curr_projects,
        project_id_map,
        stage_id_map,
        task_id_map,
        skipped_project_ids=skipped_project_ids,
        skipped_stage_ids=skipped_stage_ids,
        skipped_task_ids=skipped_task_ids,
    )
    _remap_import_photo_contexts(incoming, project_id_map, stage_id_map, task_id_map)
    # Newly imported samples may already have been copied into current_data
    # before all conflict ID maps were known. Synchronize only those new
    # samples; existing Host B assets are deliberately left untouched.
    incoming_photo_samples = _sample_index_by_id(incoming)
    current_photo_samples = _sample_index_by_id(current_data)
    for incoming_sample_id, target_sample_id in sample_id_map.items():
        if target_sample_id in existing_sample_ids_before_import:
            continue
        source_sample = incoming_photo_samples.get(incoming_sample_id)
        target_sample = current_photo_samples.get(target_sample_id)
        if source_sample is not None and target_sample is not None:
            target_sample["photos"] = copy.deepcopy(source_sample.get("photos") or [])

    hydrate_import_target_photos(current_data, incoming, sample_id_map, existing_sample_ids_before_import)
    incoming_samples_by_id = _sample_index_by_id(incoming)
    current_samples_before_photo_merge = _sample_index_by_id(current_data)
    photo_import_plans: list[dict] = []
    target_photo_keys: dict[str, tuple[set[str], set[str]]] = {}
    for inc_sid, target_sid in sample_id_map.items():
        inc_sample = incoming_samples_by_id.get(inc_sid)
        target_sample = current_samples_before_photo_merge.get(target_sid)
        if not inc_sample or not target_sample:
            continue
        if target_sid not in existing_sample_ids_before_import:
            for photo in inc_sample.get("photos") or []:
                if isinstance(photo, dict):
                    photo_import_plans.append({
                        "incomingSampleId": inc_sid,
                        "targetSampleId": target_sid,
                        "photoId": str(photo.get("id") or ""),
                        "photoHash": _content_hash(photo),
                        "sourcePhoto": photo,
                    })
            continue
        if target_sid not in target_photo_keys:
            target_photo_keys[target_sid] = (
                {
                    str(photo.get("id"))
                    for photo in (target_sample.get("photos") or [])
                    if isinstance(photo, dict) and photo.get("id")
                },
                {
                    _content_hash(photo)
                    for photo in (target_sample.get("photos") or [])
                    if isinstance(photo, dict)
                },
            )
        existing_photo_ids, existing_photo_hashes = target_photo_keys[target_sid]
        for photo in inc_sample.get("photos") or []:
            if not isinstance(photo, dict):
                continue
            photo_id = str(photo.get("id") or "")
            photo_hash = _content_hash(photo)
            if (photo_id and photo_id in existing_photo_ids) or photo_hash in existing_photo_hashes:
                continue
            photo_import_plans.append({
                "incomingSampleId": inc_sid,
                "targetSampleId": target_sid,
                "photoId": photo_id,
                "photoHash": photo_hash,
                "sourcePhoto": photo,
            })
            if photo_id:
                existing_photo_ids.add(photo_id)
            existing_photo_hashes.add(photo_hash)

    _merge_import_sample_subrecords(current_data, incoming, sample_id_map)
    stats["photosAdded"] += len(photo_import_plans)
    current_samples_after_photo_merge = _sample_index_by_id(current_data)
    created_asset_paths: list[Path] = []

    def rollback_created_asset_paths() -> None:
        root = SAMPLE_DATA_DIR.resolve()
        for path in reversed(created_asset_paths):
            try:
                path.unlink(missing_ok=True)
                parent = path.parent
                while parent != root and root in parent.resolve().parents:
                    try:
                        parent.rmdir()
                    except OSError:
                        break
                    parent = parent.parent
            except OSError:
                pass

    def copy_asset_without_collision(source_path: Path, dest_dir: Path, filename: str) -> str:
        safe_name = Path(filename or "").name
        if not safe_name:
            raise ValueError("导入照片文件名为空")
        dest_dir.mkdir(parents=True, exist_ok=True)
        destination = dest_dir / safe_name
        if destination.exists():
            stem = Path(safe_name).stem or "asset"
            suffix = Path(safe_name).suffix
            digest = chamber_package.sha256_file(source_path)[:10]
            counter = 1
            while True:
                extra = f"_{digest}" if counter == 1 else f"_{digest}_{counter}"
                candidate = dest_dir / f"{stem}{extra}{suffix}"
                if not candidate.exists():
                    destination = candidate
                    break
                counter += 1
        created_asset_paths.append(destination)
        shutil.copy2(source_path, destination)
        return destination.name

    # ── 复制照片资产文件（经 sample_id_map 定位源文件）──
    try:
        for plan in photo_import_plans:
            inc_sid = str(plan["incomingSampleId"])
            target_sid = str(plan["targetSampleId"])
            photo_id = str(plan["photoId"])
            source_photo = plan["sourcePhoto"]
            target_sample = current_samples_after_photo_merge.get(target_sid)
            if not target_sample:
                continue
            photo = next(
                (
                    item for item in (target_sample.get("photos") or [])
                    if isinstance(item, dict) and (
                        (photo_id and str(item.get("id") or "") == photo_id)
                        or (not photo_id and _content_hash(item) == plan["photoHash"])
                    )
                ),
                None,
            )
            if not photo:
                continue
            manifest_original_key = (inc_sid, photo_id, "original")
            manifest_thumb_key = (inc_sid, photo_id, "thumbnail")
            # 原图：用 relativePath 获取真实文件名（含扩展名）
            rel = source_photo.get("relativePath", "")
            if rel or manifest_original_key in asset_lookup:
                asset_src, fn = import_asset_source(inc_sid, source_photo, "original", rel)
                if asset_src and fn and asset_src.is_file():
                    dest_dir = SAMPLE_DATA_DIR / target_sid / "photos"
                    stored_name = copy_asset_without_collision(asset_src, dest_dir, fn)
                    photo["relativePath"] = f"samples/{target_sid}/photos/{stored_name}"
                    photo["url"] = f"/api/samples/{target_sid}/photos/{photo_id}"
                else:
                    raise ValueError(f"导入照片原图在提交前丢失: {photo_id or rel}")
            else:
                photo["url"] = ""
                photo["relativePath"] = ""
            # 缩略图：用 thumbRelativePath
            thumb_rel = source_photo.get("thumbRelativePath", "")
            if thumb_rel or manifest_thumb_key in asset_lookup:
                thumb_src, thumb_fn = import_asset_source(inc_sid, source_photo, "thumbnail", thumb_rel)
                if thumb_src and thumb_fn and thumb_src.is_file():
                    dest_dir = SAMPLE_DATA_DIR / target_sid / "photos"
                    stored_thumb_name = copy_asset_without_collision(thumb_src, dest_dir, thumb_fn)
                    photo["thumbRelativePath"] = f"samples/{target_sid}/photos/{stored_thumb_name}"
                    photo["thumbUrl"] = url_for_asset(target_sid, thumbnail_asset_id(photo_id))
                else:
                    raise ValueError(f"导入照片缩略图在提交前丢失: {photo_id or thumb_rel}")
            else:
                photo["thumbUrl"] = ""
                photo["thumbRelativePath"] = ""
    except Exception:
        rollback_created_asset_paths()
        raise

    # ── 重新生成样机数据，同步到 SQLite ──
    # 将 categories dict 转回 list
    current_data["sampleLibrary"]["categories"] = list(curr_categories.values())
    current_data["projects"] = list(curr_projects.values())

    for project in current_data.get("projects") or []:
        default_category_id = str(project.get("defaultSampleCategoryId") or "")
        if default_category_id in sample_category_id_map:
            project["defaultSampleCategoryId"] = sample_category_id_map[default_category_id]

    # ── 统一 ID 重映射：所有交叉引用经映射表重写 ──
    _apply_id_maps(current_data, project_id_map, stage_id_map, task_id_map, sample_id_map)
    stats["sampleEventsAdded"] = _merge_import_sample_events(
        current_data, incoming, project_id_map, stage_id_map, task_id_map, sample_id_map
    )
    validation_errors = _validate_import_commit_state(current_data, touched_structure_project_ids)
    validation_errors.extend(
        _validate_touched_sample_identities(current_data, set(sample_id_map.values()))
    )
    if validation_errors:
        rollback_created_asset_paths()
        _cleanup_preview_temp(preview_id)
        del _IMPORT_PREVIEWS[preview_id]
        return {
            "ok": False,
            "error": "导入后数据一致性校验失败：" + "；".join(validation_errors[:3]),
            "error_code": "IMPORT_STATE_VALIDATION_FAILED",
            "validationErrors": validation_errors,
            "status": 400,
        }

    # Only resources that were actually accepted by the business merge may
    # receive ACL rules.  In particular, a skipped name/field conflict must not
    # accidentally overwrite the target Host's existing access policy.
    skipped_policy_project_ids: set[str] = set()
    skipped_policy_category_ids: set[str] = set()
    for conflict in result.get("conflicts") or []:
        incoming_id = str(conflict.get("incomingId") or "")
        decision = decision_map.get(str(conflict.get("conflictId") or ""), {})
        if str(decision.get("action") or "") != "skip" or not incoming_id:
            continue
        if conflict.get("entity") == "project":
            skipped_policy_project_ids.add(incoming_id)
        elif conflict.get("entity") == "sampleCategory":
            skipped_policy_category_ids.add(incoming_id)

    selected_policy_project_ids = {
        str(project.get("id") or "")
        for project in (incoming.get("projects") or [])
        if isinstance(project, dict) and str(project.get("id") or "")
    } - skipped_policy_project_ids
    selected_policy_category_ids = {
        str(category.get("id") or "")
        for category in ((incoming.get("sampleLibrary") or {}).get("categories") or [])
        if isinstance(category, dict) and str(category.get("id") or "")
    } - skipped_policy_category_ids
    if selection_supplied:
        normalized_policy_selection = migration_scope.normalize_selection(selection)
        # ACL scope follows explicit top-level selection only.  Samples carried
        # along for referential integrity do not implicitly select their whole
        # pool policy, and selecting a stage/task does not broaden to project
        # administration rights.
        selected_policy_project_ids.intersection_update(normalized_policy_selection["projects"])
        selected_policy_category_ids.intersection_update(normalized_policy_selection["sampleCategories"])
    target_project_ids = {
        str(project.get("id") or "")
        for project in (current_data.get("projects") or [])
        if isinstance(project, dict) and str(project.get("id") or "")
    }
    target_category_ids = {
        str(category.get("id") or "")
        for category in ((current_data.get("sampleLibrary") or {}).get("categories") or [])
        if isinstance(category, dict) and str(category.get("id") or "")
    }
    for source_id in selected_policy_project_ids:
        if source_id not in project_id_map and source_id in target_project_ids:
            project_id_map[source_id] = source_id
    for source_id in selected_policy_category_ids:
        if source_id not in sample_category_id_map and source_id in target_category_ids:
            sample_category_id_map[source_id] = source_id
    policy_project_id_map = {
        source_id: project_id_map[source_id]
        for source_id in selected_policy_project_ids
        if source_id in project_id_map
    }
    policy_category_id_map = {
        source_id: sample_category_id_map[source_id]
        for source_id in selected_policy_category_ids
        if source_id in sample_category_id_map
    }

    import_remark = f"导入数据包 (deployment={source_deployment_id or '?'})"
    access_policy_commit = lambda conn: access_policy_transfer.apply_access_policy(
        conn,
        access_policy,
        mode=access_policy_mode,
        project_id_map=policy_project_id_map,
        category_id_map=policy_category_id_map,
        selected_project_ids=selected_policy_project_ids,
        selected_category_ids=selected_policy_category_ids,
        now_iso=ctx.now_iso(),
        created_by_ip="127.0.0.1",
    )
    try:
        ok, resp = commit_merged_import_state(
            ctx,
            current_data,
            preview_revision,
            "import-bundle",
            import_remark,
            "数据导入",
            access_policy_commit=access_policy_commit,
        )
    except Exception:
        rollback_created_asset_paths()
        raise

    if not ok:
        rollback_created_asset_paths()
        _cleanup_preview_temp(preview_id)
        del _IMPORT_PREVIEWS[preview_id]
        return {"ok": False, "error": resp.get("error", "写入失败"), "status": resp.get("status", 500)}

    _cleanup_preview_temp(preview_id)
    del _IMPORT_PREVIEWS[preview_id]

    revision = resp.get("revision", 0)
    mutation_summary = _build_import_mutation_summary(
        current_data,
        project_id_map,
        stage_id_map,
        task_id_map,
        sample_id_map,
        touched_structure_project_ids,
        sample_category_id_map,
    )
    return {
        "ok": True,
        "stats": stats,
        "revision": revision,
        "newRevision": revision,
        "updated_at": resp.get("updated_at", ""),
        "mutationSummary": mutation_summary,
        "accessPolicy": resp.get("accessPolicy") or {
            "available": False,
            "mode": access_policy_mode,
            "added": 0,
            "deduplicated": 0,
            "replaced": 0,
            "skipped": 0,
            "conflicts": [],
        },
    }


def sample_archive_default_decisions(result: dict) -> dict:
    decisions: dict[str, dict] = {}
    for conflict in result.get("conflicts") or []:
        cid = conflict.get("conflictId")
        if not cid:
            continue
        if conflict.get("type") == "sample_identity_conflict":
            decisions[cid] = {
                "action": "merge_into_existing",
                "targetId": conflict.get("preferredMergeTarget") or conflict.get("currentId"),
                "fieldChoices": {},
            }
        elif conflict.get("type") == "field_conflict" and conflict.get("entity") == "sample":
            decisions[cid] = {
                "action": "apply_field_choices",
                "fieldChoices": {field: "current" for field in conflict.get("diffFields") or []},
            }
        else:
            decisions[cid] = {"action": "skip"}
    return decisions


def commit_sample_archive(ctx: ImportBundleCommitContext, payload: dict) -> dict:
    if not isinstance(payload, dict):
        return {"ok": False, "error": "样机档案提交参数格式不正确", "status": 400}
    preview_id = payload.get("previewId", "")
    ctx.cleanup_expired_previews()
    entry = ctx.import_previews.get(preview_id)
    if not entry:
        return {"ok": False, "error": "previewId 无效或已过期", "status": 400}
    incoming, result = ctx.load_import_preview_payload(entry)
    package_kind = str((result or {}).get("packageKind") or "")
    scope = str((result or {}).get("scope") or "")
    projects = incoming.get("projects") if isinstance(incoming, dict) else None
    categories = ((incoming.get("sampleLibrary") or {}).get("categories") or []) if isinstance(incoming, dict) else []
    samples = [
        sample
        for category in categories
        if isinstance(category, dict)
        for sample in (category.get("samples") or [])
        if isinstance(sample, dict)
    ]
    if package_kind != "sample-archive" or scope != "selected-samples" or projects != [] or len(samples) != 1:
        return {
            "ok": False,
            "error": "previewId 不属于有效的单台样机档案预览",
            "status": 400,
        }
    decisions = payload.get("decisions")
    if not isinstance(decisions, dict) or not decisions:
        decisions = sample_archive_default_decisions(result or {})
    next_payload = {
        "previewId": preview_id,
        "decisions": decisions,
    }
    return commit_import_bundle(ctx, next_payload)
