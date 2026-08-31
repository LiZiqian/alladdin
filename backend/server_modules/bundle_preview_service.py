from __future__ import annotations

import copy
import hashlib
import json
import shutil
import tempfile
import time
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from server_modules import access_control, access_policy_transfer, chamber_package, import_defaults, import_diff, import_preview_cache, migration_scope, status_normalization, zip_security


@dataclass(frozen=True)
class BundlePreviewContext:
    app_version: str
    server_version: str
    data_dir: Path
    export_dir: Path
    import_preview_dir: Path
    import_previews: dict
    import_preview_ttl_seconds: int
    import_preview_max_entries: int
    import_preview_max_state_bytes: int
    import_preview_max_cached_bytes: int
    get_state: Callable[..., tuple[dict, int, str]]
    connect_db: Callable
    list_sample_history_page: Callable
    load_deployment_id: Callable[[], str]
    now_iso: Callable[[], str]
    json_dumps: Callable[..., str]
    path_inside_data: Callable[[str], Path]
    ensure_dirs: Callable[[], None]
    parse_multipart: Callable


def preview_id() -> str:
    return import_preview_cache.preview_id()


def cleanup_expired_previews(ctx: BundlePreviewContext) -> None:
    import_preview_cache.cleanup_expired_previews(
        ctx.import_previews,
        ttl_seconds=ctx.import_preview_ttl_seconds,
        max_entries=ctx.import_preview_max_entries,
        max_cached_bytes=ctx.import_preview_max_cached_bytes,
    )


def cleanup_preview_temp(ctx: BundlePreviewContext, preview_id_value: str) -> None:
    import_preview_cache.cleanup_preview_temp(ctx.import_previews, preview_id_value)


def store_import_preview_payload(ctx: BundlePreviewContext, tmp_path: Path, incoming: dict, result: dict) -> Path:
    return import_preview_cache.store_payload(tmp_path, incoming, result, ctx.json_dumps)


def load_import_preview_payload(entry: dict) -> tuple[dict, dict]:
    return import_preview_cache.load_payload(entry)


def text_sha256(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _scope_label(selection: dict | None, fallback: str = "all") -> str:
    if migration_scope.selection_is_empty(selection):
        return fallback
    selected = migration_scope.normalize_selection(selection)
    if selected["projects"] or selected["stages"] or selected["tasks"]:
        return "selected-projects"
    if selected["sampleCategories"]:
        return "selected-sample-categories"
    if selected["samples"]:
        return "selected-samples"
    return fallback


def _find_sample(state: dict, sample_id: str) -> tuple[dict | None, dict | None]:
    for category in (state.get("sampleLibrary") or {}).get("categories") or []:
        for sample in category.get("samples") or []:
            if str(sample.get("id") or "") == str(sample_id or ""):
                return category, sample
    return None, None


def _filename_segment(value: object, fallback: str = "-") -> str:
    text = str(value or "").strip() or fallback
    for char in '<>:"/\\|?*\r\n\t':
        text = text.replace(char, "-")
    text = "-".join(part for part in text.split() if part)
    text = text.strip(" .-_") or fallback
    return text[:80]


def _sample_archive_display_code(sample: dict) -> str:
    sn = str(sample.get("sn") or "").strip()
    imei = str(sample.get("imei") or "").strip()
    board_sn = str(sample.get("boardSn") or "").strip()
    sample_no = str(sample.get("sampleNo") or "").strip()
    if sn:
        return f"SN-{sn[-8:]}"
    if imei:
        return f"IMEI-{imei[-8:]}"
    if board_sn:
        return f"主板SN-{board_sn[-8:]}"
    return sample_no or "未录入身份"


def _sample_archive_filename(category: dict | None, sample: dict, sample_id: str, exported_at: str) -> str:
    category_name = _filename_segment((category or {}).get("name"), "未命名样机池")
    display_code = _filename_segment(_sample_archive_display_code(sample), "未录入身份")
    stable_id = _filename_segment(sample.get("id") or sample_id, "sample-id")
    ts = exported_at.replace("-", "").replace(":", "")[:15]
    return f"{category_name}-{display_code}-{stable_id}-{ts}.zip"


def _sample_archive_history(ctx: BundlePreviewContext, sample_id: str) -> list[dict]:
    history: list[dict] = []
    with ctx.connect_db() as conn:
        page = 1
        while True:
            result = ctx.list_sample_history_page(conn, sample_id, {"page": [str(page)], "pageSize": ["50"]})
            items = result.get("items") or []
            history.extend(items)
            if page >= int(result.get("totalPages") or 1):
                break
            page += 1
    return history


def _external_history_events(sample_id: str, history: list[dict], *, deployment_id: str, exported_at: str) -> list[dict]:
    events: list[dict] = []
    for idx, row in enumerate(history, start=1):
        key = str(row.get("key") or idx)
        event_id = f"external_history_{sample_id}_{chamber_package.sha256_bytes(key.encode('utf-8'))[:16]}"
        problems = row.get("problems") if isinstance(row.get("problems"), list) else []
        events.append({
            "id": event_id,
            "sampleId": sample_id,
            "time": str(row.get("date") or exported_at),
            "type": "external_history",
            "eventType": "external_history",
            "sourceDeploymentId": deployment_id,
            "sourceSampleId": sample_id,
            "projectName": str(row.get("projectName") or ""),
            "stageName": str(row.get("stageName") or ""),
            "testItem": str(row.get("testItem") or ""),
            "taskStatus": str(row.get("status") or ""),
            "result": str(row.get("result") or ""),
            "faultMarked": bool(row.get("faultMarked")),
            "problemDescription": "；".join(str(item) for item in problems if str(item or "").strip()),
            "resultPhotos": row.get("resultPhotos") or [],
            "externalHistory": True,
        })
    return events


def _sample_archive_payloads(sample: dict, photos: list, events: list, history: list, *, manifest: dict) -> dict[str, object]:
    info = dict(sample)
    info.pop("photos", None)
    return {
        "dossier.json": {
            "packageKind": "sample-archive",
            "sourceDeploymentId": manifest.get("sourceDeploymentId", ""),
            "sourceSampleId": sample.get("id", ""),
            "exportedAt": manifest.get("exportedAt", ""),
            "info": info,
            "photos": photos,
            "events": events,
            "history": history,
        },
        "sample/info.json": info,
        "sample/photos.json": photos,
        "sample/events.json": events,
        "sample/history.json": history,
    }


def prepare_export_bundle_parts(
    ctx: BundlePreviewContext,
    *,
    selection: dict | None = None,
    package_kind: str = "full",
    scope: str | None = None,
    extra_payloads: dict[str, object] | None = None,
    source_state: dict | None = None,
    already_scoped: bool = False,
) -> tuple[dict, dict, dict[str, str], dict, str]:
    """Build ChamberData v2 export payloads shared by byte/file exports."""
    runtime_data, revision, _ = ctx.get_state()
    data = source_state if source_state is not None else runtime_data
    export_data = import_diff.strip_view_state(data)
    if not already_scoped and not migration_scope.selection_is_empty(selection):
        export_data = migration_scope.filter_state_by_selection(export_data, selection)
    # Normal server startup always creates a deployment id.  Keep direct test
    # and recovery callers self-consistent if they build a package before that
    # bootstrap step instead of emitting an invalid empty policy identifier.
    deployment_id = ctx.load_deployment_id() or "deployment-unavailable"
    exported_at = ctx.now_iso()
    export_id = f"exp_{exported_at.replace('-','').replace(':','').replace('T','_')[:15]}_{uuid.uuid4().hex[:6]}"
    resolved_scope = scope or _scope_label(selection)

    package = chamber_package.build_export_package(
        export_data,
        data_dir=ctx.data_dir,
        app_version=ctx.app_version,
        server_version=ctx.server_version,
        exported_at=exported_at,
        export_id=export_id,
        deployment_id=deployment_id,
        revision=revision,
        package_kind=package_kind,
        scope=resolved_scope,
    )
    # Never hand the user a ZIP that our own importer would reject. This also
    # catches duplicate IDs and orphan references already present in live data.
    chamber_package.validate_domain_documents(
        package.get("manifest") or {},
        package.get("domains") or {},
        package.get("assetIndex") or {"assets": []},
    )
    export_roundtrip = chamber_package.state_from_domain_documents(
        package.get("manifest") or {},
        package.get("domains") or {},
    )
    export_roundtrip = import_defaults.normalize_import_state(export_roundtrip, source_format=chamber_package.FORMAT_V2)
    import_defaults.validate_import_state_structure(export_roundtrip)
    resolved_extra_payloads = dict(extra_payloads or {})
    if package_kind != "sample-archive":
        selected_access_projects = None
        selected_access_categories = None
        if not migration_scope.selection_is_empty(selection):
            normalized_selection = migration_scope.normalize_selection(selection)
            # ACLs are independent top-level resources.  Project-carried
            # samples must not silently export an entire pool ACL, and a
            # selected task/stage must not broaden to the whole project ACL.
            selected_access_projects = normalized_selection["projects"]
            selected_access_categories = normalized_selection["sampleCategories"]
        with ctx.connect_db() as conn:
            access_policy = access_policy_transfer.build_export_access_policy(
                conn,
                export_data,
                deployment_id,
                project_ids=selected_access_projects,
                category_ids=selected_access_categories,
            )
        # Callers cannot override the runtime-derived Host policy with a
        # client-supplied companion payload.
        resolved_extra_payloads[access_policy_transfer.ACCESS_POLICY_PATH] = access_policy
    payloads = chamber_package.package_payloads(package, pretty=True, extra_payloads=resolved_extra_payloads)
    checksums = {path: text_sha256(text) for path, text in payloads.items()}
    payloads["checksums.json"] = ctx.json_dumps(checksums, pretty=True)

    ts = exported_at.replace("-", "").replace(":", "")[:15]
    filename = f"sample_archive_{ts}.zip" if package_kind == "sample-archive" else f"chamberdata_export_{ts}.zip"
    return export_data, package, payloads, checksums, filename


def write_export_bundle_zip(ctx: BundlePreviewContext, zf: zipfile.ZipFile, export_data: dict, package: dict, payloads: dict[str, str]) -> None:
    for path, text in payloads.items():
        zf.writestr(path, text)

    for asset in (package.get("assetIndex") or {}).get("assets") or []:
        if not asset.get("exists"):
            print(f"[EXPORT] 资产缺失，已记录但未写入: {asset.get('sourceRelativePath')}")
            continue
        rel = str(asset.get("sourceRelativePath") or "")
        zip_path = str(asset.get("zipPath") or "")
        if not rel or not zip_path:
            continue
        try:
            source_path = ctx.path_inside_data(rel)
            if not source_path.is_file():
                raise FileNotFoundError(f"导出资产在生成索引后消失: {rel}")
            digest = hashlib.sha256()
            byte_count = 0
            with source_path.open("rb") as src, zf.open(zip_path, "w") as dst:
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    dst.write(chunk)
                    digest.update(chunk)
                    byte_count += len(chunk)
            expected_bytes = int(asset.get("bytes") or 0)
            expected_digest = str(asset.get("sha256") or "").lower()
            if byte_count != expected_bytes or digest.hexdigest() != expected_digest:
                raise RuntimeError(f"导出资产在打包期间发生变化: {rel}")
        except (ValueError, OSError, RuntimeError) as e:
            raise RuntimeError(f"导出资产失败 {asset.get('assetId')}: {e}") from e


def build_export_bundle(ctx: BundlePreviewContext) -> tuple[bytes, str]:
    """生成完整导出包 zip，返回 (bytes, filename)。测试和低频工具保留该兼容接口。"""
    tmp_path, filename = build_export_bundle_file(ctx)
    try:
        return tmp_path.read_bytes(), filename
    finally:
        tmp_path.unlink(missing_ok=True)


def build_export_bundle_file(ctx: BundlePreviewContext, *, selection: dict | None = None) -> tuple[Path, str]:
    """生成完整导出包到临时文件，HTTP 下载路径用它避免整包 bytes 常驻内存。"""
    ctx.ensure_dirs()
    export_data, package, payloads, _checksums, filename = prepare_export_bundle_parts(ctx, selection=selection)
    tmp = tempfile.NamedTemporaryFile(prefix="tcv7_export_", suffix=".zip", dir=ctx.export_dir, delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            write_export_bundle_zip(ctx, zf, export_data, package, payloads)
        return tmp_path, filename
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def build_remote_export_bundle_file(ctx: BundlePreviewContext, *, selection: dict, client_ip: str) -> tuple[Path, str]:
    """Generate a caller-aware project/pool-only bundle for a remote admin."""
    ctx.ensure_dirs()
    data, _revision, _ = ctx.get_state()
    export_source = import_diff.strip_view_state(data)
    with ctx.connect_db() as conn:
        export_source = access_control.build_remote_export_state(conn, export_source, selection, client_ip)
    export_data, package, payloads, _checksums, filename = prepare_export_bundle_parts(
        ctx,
        selection=selection,
        source_state=export_source,
        already_scoped=True,
        scope=_scope_label(selection),
    )
    tmp = tempfile.NamedTemporaryFile(prefix="tcv7_remote_export_", suffix=".zip", dir=ctx.export_dir, delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            write_export_bundle_zip(ctx, zf, export_data, package, payloads)
        return tmp_path, filename
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def build_sample_archive_file(ctx: BundlePreviewContext, sample_id: str) -> tuple[Path, str]:
    data, _revision, _ = ctx.get_state()
    export_data = import_diff.strip_view_state(data)
    category, sample = _find_sample(export_data, sample_id)
    if not sample:
        raise KeyError("样机不存在")
    selection = {"sampleIds": [sample_id]}
    history = _sample_archive_history(ctx, sample_id)
    deployment_id = ctx.load_deployment_id()
    exported_at = ctx.now_iso()
    filtered = migration_scope.filter_state_by_selection(export_data, selection)
    sample_events = _external_history_events(sample_id, history, deployment_id=deployment_id, exported_at=exported_at)
    existing_event_ids = {
        str(log.get("id") or "")
        for log in (filtered.get("sampleLibrary") or {}).get("logs") or []
        if isinstance(log, dict)
    }
    for event in sample_events:
        if event["id"] not in existing_event_ids:
            filtered.setdefault("sampleLibrary", {}).setdefault("logs", []).append(event)
            existing_event_ids.add(event["id"])
    _, filtered_sample = _find_sample(filtered, sample_id)
    photos = list((filtered_sample or {}).get("photos") or [])
    events = [
        log for log in (filtered.get("sampleLibrary") or {}).get("logs") or []
        if isinstance(log, dict) and str(log.get("sampleId") or "") == str(sample_id)
    ]
    # Reuse the standard export path by temporarily providing the filtered state
    # through a tiny context shim.
    def _filtered_state(*_args, **_kwargs):
        return copy.deepcopy(filtered), _revision, exported_at

    shim = BundlePreviewContext(**{**ctx.__dict__, "get_state": _filtered_state})
    extra_payloads = _sample_archive_payloads(
        filtered_sample or sample,
        photos,
        events,
        history,
        manifest={"sourceDeploymentId": deployment_id, "exportedAt": exported_at},
    )
    ctx.ensure_dirs()
    export_data, package, payloads, _checksums, filename = prepare_export_bundle_parts(
        shim,
        selection=None,
        package_kind="sample-archive",
        scope="selected-samples",
        extra_payloads=extra_payloads,
    )
    tmp = tempfile.NamedTemporaryFile(prefix="tcv7_sample_archive_", suffix=".zip", dir=ctx.export_dir, delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            write_export_bundle_zip(ctx, zf, export_data, package, payloads)
        archive_name = _sample_archive_filename(category, sample, sample_id, exported_at)
        return tmp_path, archive_name
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _target_archive_category(current_data: dict, target_category_id: str) -> dict:
    categories = (current_data.get("sampleLibrary") or {}).get("categories") or []
    for category in categories:
        if str(category.get("id") or "") == str(target_category_id or ""):
            return {
                "id": str(category.get("id") or ""),
                "name": str(category.get("name") or "外部导入样机"),
                "description": str(category.get("description") or ""),
            }
    if str(target_category_id or "").strip():
        raise ValueError("目标样机池不存在或已被删除，请刷新页面后重试")
    return {
        "id": "cat_external_imported_samples",
        "name": "外部导入样机",
        "description": "从单台样机档案包导入的外部样机。",
    }


def _prepare_sample_archive_import_state(incoming_state: dict, current_data: dict, target_category_id: str) -> dict:
    prepared = copy.deepcopy(incoming_state)
    target = _target_archive_category(current_data, target_category_id)
    samples = []
    for category in (prepared.get("sampleLibrary") or {}).get("categories") or []:
        for sample in category.get("samples") or []:
            if isinstance(sample, dict):
                source_fields = {
                    "currentProjectId": "sourceProjectId",
                    "currentStageId": "sourceStageId",
                    "currentTaskId": "sourceTaskId",
                    "currentTestItem": "sourceTestItem",
                }
                for current_field, source_field in source_fields.items():
                    current_value = sample.get(current_field)
                    if current_value not in (None, "") and sample.get(source_field) in (None, ""):
                        sample[source_field] = current_value
                sample["currentProjectId"] = None
                sample["currentStageId"] = None
                sample["currentTaskId"] = None
                sample["currentTestItem"] = ""
                sample["categoryId"] = str(target.get("id") or "")
                if status_normalization.normalize_sample_usage_status(sample.get("status")) in ("测试中", "在位等待"):
                    sample["status"] = "闲置"
                    sample["borrower"] = ""
                    sample["borrowDate"] = ""
                samples.append(sample)
    prepared["projects"] = []
    prepared.setdefault("sampleLibrary", {})["categories"] = [{
        **target,
        "samples": samples,
    }]
    prepared_logs = []
    for log in (prepared.get("sampleLibrary") or {}).get("logs") or []:
        if not isinstance(log, dict):
            continue
        source_fields = {
            "projectId": "sourceProjectId",
            "stageId": "sourceStageId",
            "taskId": "sourceTaskId",
        }
        for current_field, source_field in source_fields.items():
            current_value = log.get(current_field)
            if current_value not in (None, "") and log.get(source_field) in (None, ""):
                log[source_field] = current_value
            log[current_field] = ""
        prepared_logs.append(log)
    prepared["sampleLibrary"]["logs"] = prepared_logs
    return prepared


def analyze_import_bundle(ctx: BundlePreviewContext, headers, raw_body: bytes) -> dict:
    """解压导入包，与主库对比生成 preview 分析结果"""
    cleanup_expired_previews(ctx)

    fields, files = ctx.parse_multipart(headers, raw_body)
    zip_raw = None
    for f in files:
        if f.get("filename", "").endswith(".zip"):
            zip_raw = f.get("content", b"")
            break
    if not zip_raw:
        for f in files:
            zip_raw = f.get("content", b"")
            break

    if not zip_raw or len(zip_raw) < 4:
        raise ValueError("未找到有效的 zip 文件内容")
    zip_bytes = len(zip_raw)

    ctx.ensure_dirs()
    tmp_dir = tempfile.mkdtemp(prefix="tcv7_import_", dir=ctx.import_preview_dir)
    try:
        zip_path = Path(tmp_dir) / "bundle.zip"
        zip_path.write_bytes(zip_raw)
        zip_raw = None
        for item in files:
            item["content"] = b""

        with zipfile.ZipFile(zip_path, "r") as zf:
            zip_security.safe_extract_zip(zf, tmp_dir)

        tmp_path = Path(tmp_dir)

        manifest_path = tmp_path / "manifest.json"
        if not manifest_path.is_file():
            raise ValueError("导入包缺少 manifest.json")
        if manifest_path.stat().st_size > ctx.import_preview_max_state_bytes:
            raise ValueError(f"导入包 manifest.json 过大，超过 {ctx.import_preview_max_state_bytes} bytes 上限")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            raise ValueError("导入包 manifest.json 格式不正确")

        asset_index = None
        access_policy = None
        checksums = None
        if chamber_package.is_chamberdata_manifest(manifest):
            checksums_path = tmp_path / chamber_package.CHECKSUMS_PATH
            # Early ChamberData v2 packages did not always include checksums.json.
            # Keep them importable, but verify every declared digest when present.
            if checksums_path.is_file():
                if checksums_path.stat().st_size > ctx.import_preview_max_state_bytes:
                    raise ValueError(f"导入包 {chamber_package.CHECKSUMS_PATH} 过大，超过 {ctx.import_preview_max_state_bytes} bytes 上限")
                checksums = json.loads(checksums_path.read_text(encoding="utf-8"))
                chamber_package.verify_checksums(tmp_path, checksums)

            def _read_package_json(rel_path: str):
                path = tmp_path / rel_path
                if not path.is_file():
                    raise ValueError(f"导入包缺少 {rel_path}")
                if path.stat().st_size > ctx.import_preview_max_state_bytes:
                    raise ValueError(f"导入包 {rel_path} 过大，超过 {ctx.import_preview_max_state_bytes} bytes 上限")
                return json.loads(path.read_text(encoding="utf-8"))

            domains = chamber_package.read_domain_documents(_read_package_json)
            asset_index = chamber_package.read_asset_index(_read_package_json)
            chamber_package.validate_domain_documents(manifest, domains, asset_index)
            incoming_state = chamber_package.state_from_domain_documents(manifest, domains)
            included_project_ids = {
                str(project.get("id") or "")
                for project in (incoming_state.get("projects") or [])
                if isinstance(project, dict) and str(project.get("id") or "")
            }
            included_category_ids = {
                str(category.get("id") or "")
                for category in ((incoming_state.get("sampleLibrary") or {}).get("categories") or [])
                if isinstance(category, dict) and str(category.get("id") or "")
            }
            access_policy = access_policy_transfer.load_access_policy_from_package(
                tmp_path,
                manifest,
                checksums,
                max_bytes=ctx.import_preview_max_state_bytes,
                included_project_ids=included_project_ids,
                included_category_ids=included_category_ids,
            )
            state_bytes = sum((tmp_path / rel).stat().st_size for rel in chamber_package.DOMAIN_PATHS.values())
            state_bytes += (tmp_path / chamber_package.ASSET_INDEX_PATH).stat().st_size
            if access_policy is not None:
                state_bytes += (tmp_path / access_policy_transfer.ACCESS_POLICY_PATH).stat().st_size
            if checksums_path.is_file():
                state_bytes += checksums_path.stat().st_size
        else:
            state_path = tmp_path / "state.json"
            if not state_path.is_file():
                raise ValueError("导入包缺少 state.json")
            state_bytes = state_path.stat().st_size
            if state_bytes > ctx.import_preview_max_state_bytes:
                raise ValueError(f"导入包 state.json 过大 ({state_bytes} bytes)，超过 {ctx.import_preview_max_state_bytes} bytes 上限")
            incoming_state = json.loads(state_path.read_text(encoding="utf-8"))
        incoming_state = import_defaults.normalize_import_state(
            incoming_state,
            source_format=str(manifest.get("format") or manifest.get("protocol") or ""),
        )
        import_defaults.validate_import_state_structure(incoming_state)

        current_data, current_revision, _ = ctx.get_state(compact=True)
        access_policy_mode = str(fields.get("accessPolicyMode") or "merge").strip()
        if access_policy_mode not in access_policy_transfer.SUPPORTED_IMPORT_MODES:
            raise ValueError(f"权限策略导入模式不受支持: {access_policy_mode}")
        package_kind = str(manifest.get("packageKind") or "full")
        target_category_id = str(fields.get("targetCategoryId") or "")
        if package_kind == "sample-archive":
            raw_samples = [
                sample
                for category in (incoming_state.get("sampleLibrary") or {}).get("categories") or []
                if isinstance(category, dict)
                for sample in (category.get("samples") or [])
                if isinstance(sample, dict)
            ]
            if str(manifest.get("scope") or "") != "selected-samples" or incoming_state.get("projects") != [] or len(raw_samples) != 1:
                raise ValueError("样机档案包必须且只能包含一台样机，且不能携带项目树")
            incoming_state = _prepare_sample_archive_import_state(incoming_state, current_data, target_category_id)

        result = import_diff.diff_import_bundle(current_data, incoming_state, manifest, tmp_path, asset_index=asset_index)
        result["selectionTree"] = migration_scope.build_selection_tree(incoming_state)
        result["packageKind"] = package_kind
        result["scope"] = str(manifest.get("scope") or "")
        with ctx.connect_db() as conn:
            result["accessPolicy"] = access_policy_transfer.preview_access_policy(
                conn,
                access_policy,
                selected_mode=access_policy_mode,
            )
        if package_kind == "sample-archive":
            result["targetCategory"] = _target_archive_category(current_data, target_category_id)
        preview_id_value = preview_id()
        result["previewId"] = preview_id_value
        payload_path = store_import_preview_payload(ctx, tmp_path, incoming_state, result)
        payload_bytes = payload_path.stat().st_size
        ctx.import_previews[preview_id_value] = {
            "_ts": time.time(),
            "_tmp_dir": str(tmp_path),
            "_payload_path": str(payload_path),
            "_revision": current_revision,
            "_zip_bytes": zip_bytes,
            "_state_bytes": state_bytes,
            "_payload_bytes": payload_bytes,
            "_cache_bytes": zip_bytes + payload_bytes,
        }
        cleanup_expired_previews(ctx)
        if preview_id_value not in ctx.import_previews:
            raise ValueError("导入预览缓存已超过服务器上限，请稍后重试")
        return result
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
