from __future__ import annotations

import json
import hashlib
import ipaddress
import mimetypes
import re
import shutil
import traceback
import uuid
from urllib.parse import parse_qs, quote, unquote, urlparse

from server_modules.http_helpers import STATIC_ASSET_CACHE


VERSION_TEMPLATE_TOKEN = "__APP_VERSION__"


def _client_ip(handler, ctx) -> str:
    # Deliberately do not inspect X-Forwarded-For or any client-provided header.
    return ctx.get_access_context(handler.client_address[0]).client_ip


def _audit_access(ctx, client_ip: str, action: str, resource_type: str, resource_id: str, *, allowed: bool, actor_role: str = "", detail: dict | None = None) -> None:
    try:
        ctx.audit_security_event(
            client_ip,
            action,
            resource_type=resource_type,
            resource_id=resource_id,
            allowed=allowed,
            actor_role=actor_role,
            detail=detail,
        )
    except Exception:
        traceback.print_exc()


def _deny(handler, ctx, *, action: str, resource_type: str = "platform", resource_id: str = "", message: str = "当前 IP 未获授权") -> None:
    client_ip = _client_ip(handler, ctx)
    _audit_access(ctx, client_ip, action, resource_type, resource_id, allowed=False, detail={"reason": message})
    handler._send_json({
        "ok": False,
        "error": message,
        "errorCode": "ACCESS_DENIED",
        "clientIp": client_ip,
        "resourceType": resource_type,
        "resourceId": resource_id,
    }, 403)


def _require_local(handler, ctx, *, action: str) -> bool:
    if not _require_trusted_host(handler, ctx):
        return False
    if ctx.get_access_context(handler.client_address[0]).is_local_admin:
        return True
    _deny(handler, ctx, action=action, message="此操作仅限通过 localhost 访问的本机管理员")
    return False


def _host_is_trusted(handler) -> bool:
    host = str(handler.headers.get("Host") or "").strip().lower()
    if not host:
        # Preserve HTTP/1.0/local CLI and direct unit-harness compatibility.
        # Browser requests always carry Host and therefore cannot use this.
        return True
    host_name = str(urlparse(f"//{host}").hostname or "").strip().lower()
    if host_name == "localhost":
        return True
    try:
        ipaddress.ip_address(host_name)
        return True
    except ValueError:
        return False


def _require_trusted_host(handler, ctx) -> bool:
    if _host_is_trusted(handler):
        return True
    _deny(handler, ctx, action="host_header_blocked", message="仅允许使用 localhost 或明确 IP 地址访问 Host")
    return False


def _require_write_origin(handler, ctx) -> bool:
    """Block browser cross-site writes while preserving Origin-less local CLI use."""
    if not _require_trusted_host(handler, ctx):
        return False
    fetch_site = str(handler.headers.get("Sec-Fetch-Site") or "").strip().lower()
    origin = str(handler.headers.get("Origin") or "").strip()
    if fetch_site == "cross-site" or origin.lower() == "null":
        _deny(handler, ctx, action="csrf_write_blocked", message="已拒绝跨站写入请求")
        return False
    if not origin:
        return True
    parsed = urlparse(origin)
    host = str(handler.headers.get("Host") or "").strip().lower()
    if parsed.scheme.lower() != "http" or parsed.netloc.lower() != host:
        _deny(handler, ctx, action="csrf_write_blocked", message="写请求 Origin 与当前 Host 不同源")
        return False
    return True


def _project_allowed(handler, ctx, project_id: str, required: str = "viewer", *, action: str = "read_project") -> bool:
    with ctx.connect_db() as conn:
        allowed = ctx.has_project_role(conn, project_id, handler.client_address[0], required)
    if not allowed:
        _deny(handler, ctx, action=action, resource_type="project", resource_id=project_id)
    else:
        ctx.touch_access_seen(handler.client_address[0], "project", project_id)
    return allowed


def _pool_allowed(handler, ctx, category_id: str, required: str = "pool_viewer", *, action: str = "read_sample_pool") -> bool:
    with ctx.connect_db() as conn:
        allowed = ctx.has_pool_role(conn, category_id, handler.client_address[0], required)
    if not allowed:
        _deny(handler, ctx, action=action, resource_type="sample_pool", resource_id=category_id)
    else:
        ctx.touch_access_seen(handler.client_address[0], "sample_pool", category_id)
    return allowed


def _sample_allowed(handler, ctx, sample_id: str, *, project_id: str = "", action: str = "read_sample") -> bool:
    with ctx.connect_db() as conn:
        allowed = ctx.can_read_sample(conn, sample_id, handler.client_address[0], project_id=project_id)
        category_id = ctx.category_id_for_sample(conn, sample_id)
        project_match = bool(project_id and ctx.has_project_role(conn, project_id, handler.client_address[0], "viewer") and ctx.sample_is_linked_to_project(conn, sample_id, project_id))
        pool_match = bool(category_id and ctx.has_pool_role(conn, category_id, handler.client_address[0], "pool_viewer"))
    if not allowed:
        _deny(handler, ctx, action=action, resource_type="sample", resource_id=sample_id)
    else:
        if project_match:
            ctx.touch_access_seen(handler.client_address[0], "project", project_id)
        if pool_match:
            ctx.touch_access_seen(handler.client_address[0], "sample_pool", category_id)
    return allowed


def _acl_management_allowed(conn, ctx, route: tuple[str, str], client_ip: str) -> tuple[bool, str]:
    resource_type, resource_id = route
    if resource_type == "project":
        role = ctx.get_project_role(conn, resource_id, client_ip)
        return ctx.has_project_role(conn, resource_id, client_ip, "project_admin"), role
    role = ctx.get_pool_role(conn, resource_id, client_ip)
    return ctx.has_pool_role(conn, resource_id, client_ip, "pool_admin"), role


def _content_disposition_attachment(filename: str) -> str:
    raw = str(filename or "download.zip").replace("\r", "").replace("\n", "")
    fallback = re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("._") or "download.zip"
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(raw, safe='')}"


def _frontend_asset_version(ctx) -> str:
    digest = hashlib.sha256()
    for asset in sorted(path for path in ctx.FRONTEND_DIR.rglob("*") if path.is_file()):
        digest.update(asset.relative_to(ctx.FRONTEND_DIR).as_posix().encode("utf-8"))
        digest.update(b"\0")
        with asset.open("rb") as src:
            for chunk in iter(lambda: src.read(128 * 1024), b""):
                digest.update(chunk)
    return f"{ctx.APP_VERSION}-{digest.hexdigest()[:12]}"


def _send_versioned_text(handler, ctx, target, content_type: str, *, cache: str) -> None:
    text = target.read_text(encoding="utf-8")
    text = text.replace(f'content="{VERSION_TEMPLATE_TOKEN}"', f'content="{ctx.APP_VERSION}"')
    text = text.replace(VERSION_TEMPLATE_TOKEN, _frontend_asset_version(ctx))
    handler._send_bytes(text.encode("utf-8"), content_type, cache=cache)


def _selection_from_query(query: dict[str, list[str]]) -> dict[str, list[str]]:
    aliases = {
        "projectIds": ("projectId", "projectIds", "projects"),
        "stageIds": ("stageId", "stageIds", "stages"),
        "taskIds": ("taskId", "taskIds", "tasks"),
        "sampleCategoryIds": ("sampleCategoryId", "sampleCategoryIds", "sampleCategories"),
        "sampleIds": ("sampleId", "sampleIds", "samples"),
    }
    selection: dict[str, list[str]] = {}
    for target_key, names in aliases.items():
        values: list[str] = []
        for name in names:
            for value in query.get(name) or []:
                values.extend(part.strip() for part in str(value or "").split(",") if part.strip())
        if values:
            selection[target_key] = values
    return selection


def handle_get(handler, ctx) -> None:
    if not _require_trusted_host(handler, ctx):
        return
    parsed = urlparse(handler.path)
    path = unquote(parsed.path)
    query = parse_qs(parsed.query, keep_blank_values=True)

    if path == "/api/health":
        handler._send_json({
            "ok": True,
            "version": ctx.APP_VERSION,
            "time": ctx.now_iso(),
        })
        return

    acl_route = ctx.access_rule_route(path)
    if acl_route:
        resource_type, resource_id = acl_route
        client_ip = _client_ip(handler, ctx)
        try:
            with ctx.connect_db() as conn:
                allowed, role = _acl_management_allowed(conn, ctx, acl_route, client_ip)
                if allowed:
                    rules = ctx.list_access_rules(conn, resource_type, resource_id)
            if not allowed:
                _deny(handler, ctx, action="list_access_rules", resource_type=resource_type, resource_id=resource_id)
                return
            handler._send_json({"ok": True, "resourceType": resource_type, "resourceId": resource_id, "actorRole": role, "rules": rules})
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/export-bundle":
        tmp_path = None
        response_started = False
        try:
            selection = _selection_from_query(query)
            actor = ctx.get_access_context(handler.client_address[0])
            if actor.is_local_admin:
                tmp_path, filename = ctx.build_export_bundle_file(selection)
                audit_resource_type = "platform"
                audit_resource_id = ""
            else:
                project_ids = selection.get("projectIds") or []
                category_ids = selection.get("sampleCategoryIds") or []
                other_selected = any(selection.get(key) for key in ("stageIds", "taskIds", "sampleIds"))
                if other_selected or (project_ids and category_ids) or (not project_ids and not category_ids):
                    _audit_access(
                        ctx,
                        actor.client_ip,
                        "export_bundle",
                        "platform",
                        "",
                        allowed=False,
                        detail={"reason": "invalid_remote_scope", "selection": selection},
                    )
                    handler._send_json({
                        "ok": False,
                        "error": "远程导出只允许非空的 projectIds-only 或 sampleCategoryIds-only，且不能混合选择",
                        "errorCode": "EXPORT_SCOPE_INVALID",
                    }, 400)
                    return
                audit_resource_type = "project" if project_ids else "sample_pool"
                audit_resource_id = ",".join(project_ids or category_ids)
                tmp_path, filename = ctx.build_remote_export_bundle_file(selection, actor.client_ip)
                for selected_resource_id in project_ids or category_ids:
                    ctx.touch_access_seen(actor.client_ip, audit_resource_type, selected_resource_id)
            _audit_access(
                ctx,
                actor.client_ip,
                "export_bundle",
                audit_resource_type,
                audit_resource_id,
                allowed=True,
                actor_role=actor.platform_role if actor.is_local_admin else "resource_admin",
                detail={"selection": selection},
            )
            size = tmp_path.stat().st_size
            handler.send_response(200)
            handler.send_header("Content-Type", "application/zip")
            handler.send_header("Content-Disposition", _content_disposition_attachment(filename))
            handler.send_header("Content-Length", str(size))
            handler.send_header("Cache-Control", "no-cache")
            handler.end_headers()
            response_started = True
            with tmp_path.open("rb") as src:
                shutil.copyfileobj(src, handler.wfile, length=1024 * 1024)
        except PermissionError as e:
            if not response_started:
                _deny(handler, ctx, action="export_bundle", resource_type="platform", message=str(e))
        except ValueError as e:
            if not response_started:
                _audit_access(ctx, _client_ip(handler, ctx), "export_bundle", "platform", "", allowed=False, detail={"reason": str(e)})
                handler._send_json({"ok": False, "error": str(e), "errorCode": "EXPORT_SCOPE_INVALID"}, 400)
        except Exception as e:
            if not response_started:
                traceback.print_exc()
                handler._send_json({"ok": False, "error": str(e), "errorCode": "EXPORT_FAILED"}, 500)
        finally:
            if tmp_path:
                tmp_path.unlink(missing_ok=True)
        return

    archive_sample_id = handler._sample_archive_route(path)
    if archive_sample_id:
        if not _require_local(handler, ctx, action="export_sample_archive"):
            return
        tmp_path = None
        response_started = False
        try:
            tmp_path, filename = ctx.build_sample_archive_file(archive_sample_id)
            size = tmp_path.stat().st_size
            handler.send_response(200)
            handler.send_header("Content-Type", "application/zip")
            handler.send_header("Content-Disposition", _content_disposition_attachment(filename))
            handler.send_header("Content-Length", str(size))
            handler.send_header("Cache-Control", "no-cache")
            handler.end_headers()
            response_started = True
            with tmp_path.open("rb") as src:
                shutil.copyfileobj(src, handler.wfile, length=1024 * 1024)
            _audit_access(ctx, _client_ip(handler, ctx), "export_sample_archive", "sample", archive_sample_id, allowed=True, actor_role="local_admin")
        except KeyError as e:
            _audit_access(ctx, _client_ip(handler, ctx), "export_sample_archive", "sample", archive_sample_id, allowed=False, actor_role="local_admin", detail={"reason": str(e)})
            if not response_started:
                handler._send_json({"ok": False, "error": str(e)}, 404)
        except Exception as e:
            _audit_access(ctx, _client_ip(handler, ctx), "export_sample_archive", "sample", archive_sample_id, allowed=False, actor_role="local_admin", detail={"reason": str(e)})
            if not response_started:
                traceback.print_exc()
                handler._send_json({"ok": False, "error": str(e), "errorCode": "SAMPLE_ARCHIVE_EXPORT_FAILED"}, 500)
        finally:
            if tmp_path:
                tmp_path.unlink(missing_ok=True)
        return

    if path == "/api/state":
        if not _require_local(handler, ctx, action="read_full_state"):
            return
        try:
            reason = ctx.first_query_value(query, "reason", "").strip()
            if not reason:
                print(f"[WARN] /api/state called without reason from {handler.client_address[0]}")
            data, revision, updated_at = ctx.get_state(compact=True)
            handler._send_json({
                "ok": True,
                "revision": revision,
                "updated_at": updated_at,
                "data": data,
                "compat": {
                    "stateEndpoint": "compact-full-state",
                    "reason": reason or "legacy-unspecified",
                    "lowFrequencyOnly": True,
                },
            })
            _audit_access(ctx, _client_ip(handler, ctx), "read_full_state", "platform", "", allowed=True, actor_role="local_admin", detail={"reason": reason or "legacy-unspecified"})
        except Exception as e:
            _audit_access(ctx, _client_ip(handler, ctx), "read_full_state", "platform", "", allowed=False, actor_role="local_admin", detail={"reason": str(e)})
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/bootstrap":
        try:
            with ctx.connect_db() as conn:
                data, revision, updated_at = ctx.compose_bootstrap_state(conn)
                data = ctx.decorate_bootstrap(conn, data, handler.client_address[0])
            handler._send_json({
                "ok": True,
                "version": ctx.APP_VERSION,
                "revision": revision,
                "updated_at": updated_at,
                "data": data,
                "partial": True,
            })
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/projects/summary":
        try:
            with ctx.connect_db() as conn:
                projects = ctx.list_project_summary(conn)
                projects = ctx.decorate_project_summaries(conn, projects, handler.client_address[0])
            handler._send_json({"ok": True, "projects": projects, "count": len(projects)})
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    project_detail_id = handler._project_detail_route(path)
    if project_detail_id:
        if not _project_allowed(handler, ctx, project_detail_id, "viewer", action="read_project_detail"):
            return
        try:
            include_tasks = ctx.first_query_value(query, "includeTasks", "") in ("1", "true", "yes")
            with ctx.connect_db() as conn:
                project = ctx.load_project_detail(conn, project_detail_id, include_tasks=include_tasks)
            if not project:
                handler._send_json({"ok": False, "error": "项目不存在"}, 404)
                return
            handler._send_json({"ok": True, "project": project, "includeTasks": include_tasks})
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/sample-categories":
        try:
            with ctx.connect_db() as conn:
                categories = ctx.list_sample_categories_summary(conn)
                categories = ctx.decorate_pool_summaries(conn, categories, handler.client_address[0])
            handler._send_json({"ok": True, "categories": categories, "count": len(categories)})
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/task-sample-candidates":
        try:
            client_ip = _client_ip(handler, ctx)
            with ctx.connect_db() as conn:
                task_id = ctx.first_query_value(query, "taskId", "").strip()
                project_id, _ = ctx.task_scope(conn, task_id)
                if not project_id:
                    project_id = ctx.first_query_value(query, "projectId", "").strip()
                selected_ids = []
                for value in query.get("selectedIds") or []:
                    selected_ids.extend(part.strip() for part in str(value or "").split(",") if part.strip())
                is_admin = bool(project_id and ctx.has_project_role(conn, project_id, client_ip, "project_admin"))
                is_viewer = bool(project_id and ctx.has_project_role(conn, project_id, client_ip, "viewer"))
                bound_categories = ctx.project_bound_pool_ids(conn, project_id) if project_id else set()
                readonly_selected = bool(is_viewer and not is_admin and selected_ids)
                selected_scope_denied = False
                if selected_ids:
                    placeholders = ",".join("?" for _ in selected_ids)
                    selected_rows = conn.execute(
                        f"SELECT id, category_id FROM sample_records WHERE id IN ({placeholders}) AND deleted_at IS NULL",
                        selected_ids,
                    ).fetchall()
                    selected_categories = {str(row["id"] or ""): str(row["category_id"] or "") for row in selected_rows}
                    selected_scope_denied = set(selected_categories) != set(selected_ids) or any(
                        not ctx.sample_is_linked_to_project(conn, sample_id, project_id)
                        and not (
                            is_admin
                            and selected_categories.get(sample_id) in bound_categories
                            and ctx.has_pool_role(conn, selected_categories.get(sample_id), client_ip, "pool_viewer")
                        )
                        for sample_id in selected_ids
                    )
                if readonly_selected and selected_scope_denied:
                    readonly_selected = False
                if not project_id or selected_scope_denied or (not is_admin and not readonly_selected):
                    allowed = False
                else:
                    allowed = True
                    if readonly_selected:
                        placeholders = ",".join("?" for _ in selected_ids)
                        category_rows = conn.execute(
                            f"SELECT DISTINCT category_id AS id FROM sample_records WHERE id IN ({placeholders}) AND deleted_at IS NULL",
                            selected_ids,
                        ).fetchall()
                    else:
                        category_rows = conn.execute("SELECT id FROM sample_categories WHERE deleted_at IS NULL").fetchall()
                    allowed_categories = [str(row["id"]) for row in category_rows if str(row["id"]) in bound_categories]
                    if not readonly_selected:
                        allowed_categories = [
                            category_id for category_id in allowed_categories
                            if ctx.has_pool_role(conn, category_id, client_ip, "pool_viewer")
                        ]
                    restricted_query = dict(query)
                    restricted_query["_allowedCategoryIds"] = allowed_categories
                    result = ctx.list_task_sample_candidates_page(conn, restricted_query)
                    if readonly_selected:
                        result.update({"items": [], "categories": [], "total": 0, "totalPages": 1, "page": 1})
                    result = ctx.sanitize_task_sample_candidates(
                        conn,
                        result,
                        client_ip,
                        project_id=project_id,
                    )
            if not allowed:
                message = "所请求样机不属于该项目" if selected_scope_denied else "当前 IP 未获授权"
                _deny(handler, ctx, action="list_task_sample_candidates", resource_type="project", resource_id=project_id, message=message)
                return
            handler._send_json({"ok": True, **result})
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/sample-destroy-impact":
        try:
            sample_id = ctx.first_query_value(query, "sampleId", "").strip()
            category_id = ctx.first_query_value(query, "categoryId", "").strip()
            if sample_id and category_id:
                handler._send_json({"ok": False, "error": "sampleId 与 categoryId 只能选择一种", "errorCode": "DESTROY_SCOPE_INVALID"}, 400)
                return
            with ctx.connect_db() as conn:
                if sample_id and not category_id:
                    category_id = ctx.category_id_for_sample(conn, sample_id)
                allowed = bool(category_id and ctx.has_pool_role(conn, category_id, handler.client_address[0], "pool_admin"))
                if allowed:
                    result = ctx.list_sample_destroy_impact_scope(conn, query)
                    result = ctx.sanitize_destroy_impact(conn, result, handler.client_address[0])
            if not allowed:
                _deny(handler, ctx, action="read_destroy_impact", resource_type="sample_pool", resource_id=category_id)
                return
            handler._send_json({"ok": True, **result})
        except KeyError as e:
            handler._send_json({"ok": False, "error": str(e)}, 404)
        except ValueError as e:
            handler._send_json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    sample_category_detail_id = handler._sample_category_detail_route(path)
    if sample_category_detail_id:
        if not _pool_allowed(handler, ctx, sample_category_detail_id, "pool_viewer", action="read_sample_pool_detail"):
            return
        try:
            include_photos = ctx.first_query_value(query, "includePhotos", "") in ("1", "true", "yes")
            with ctx.connect_db() as conn:
                category = ctx.load_sample_category_detail(conn, sample_category_detail_id, include_photos=include_photos)
                if category:
                    category = ctx.sanitize_category_detail_for_actor(
                        conn,
                        category,
                        handler.client_address[0],
                        include_photos=include_photos,
                    )
            if not category:
                handler._send_json({"ok": False, "error": "样机池不存在"}, 404)
                return
            handler._send_json({"ok": True, "category": category, "includePhotos": include_photos})
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    stage_tasks_id = handler._stage_tasks_route(path)
    if stage_tasks_id:
        try:
            with ctx.connect_db() as conn:
                project_id = ctx.project_id_for_stage(conn, stage_tasks_id)
                allowed = bool(project_id and ctx.has_project_role(conn, project_id, handler.client_address[0], "viewer"))
                if allowed:
                    result = ctx.list_stage_tasks_page(conn, stage_tasks_id, query)
            if not allowed:
                _deny(handler, ctx, action="list_stage_tasks", resource_type="project", resource_id=project_id)
                return
            handler._send_json({"ok": True, **result})
        except KeyError as e:
            handler._send_json({"ok": False, "error": str(e)}, 404)
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    sample_category_id = handler._sample_category_samples_route(path)
    if sample_category_id:
        if not _pool_allowed(handler, ctx, sample_category_id, "pool_viewer", action="list_sample_pool"):
            return
        try:
            with ctx.connect_db() as conn:
                scoped_query = dict(query)
                if not ctx.get_access_context(handler.client_address[0]).is_local_admin:
                    scoped_query["_safePoolSearch"] = ["1"]
                result = ctx.list_samples_page(conn, sample_category_id, scoped_query)
                result = ctx.sanitize_sample_page_for_actor(conn, result, handler.client_address[0])
            handler._send_json({"ok": True, **result})
        except KeyError as e:
            handler._send_json({"ok": False, "error": str(e)}, 404)
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    photo_route = handler._sample_photo_route(path)
    if photo_route and photo_route[1] is None:
        sample_id, _ = photo_route
        project_id = ctx.first_query_value(query, "projectId", "").strip()
        if not _sample_allowed(handler, ctx, sample_id, project_id=project_id, action="list_sample_photos"):
            return
        try:
            with ctx.connect_db() as conn:
                photos = ctx.load_sample_photos(conn, sample_id)
                photos = ctx.filter_photo_list_for_actor(conn, sample_id, photos, handler.client_address[0], project_id=project_id)
            handler._send_json({"ok": True, "sampleId": sample_id, "photos": photos, "photoCount": len(photos)})
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if photo_route and photo_route[1]:
        sample_id, photo_id = photo_route
        project_id = ctx.first_query_value(query, "projectId", "").strip()
        if not _sample_allowed(handler, ctx, sample_id, project_id=project_id, action="read_sample_photo"):
            return
        try:
            with ctx.connect_db() as conn:
                row = conn.execute(
                    """
                    SELECT relative_path, mime_type
                    FROM sample_assets
                    WHERE sample_id = ? AND id = ? AND kind IN ('photo', 'photo_thumb') AND deleted_at IS NULL
                    """,
                    (sample_id, photo_id),
                ).fetchone()
                visible = bool(row and ctx.photo_is_visible(conn, sample_id, photo_id, handler.client_address[0], project_id=project_id))
            if not row:
                handler._send_json({"ok": False, "error": "照片不存在"}, 404)
                return
            if not visible:
                _deny(handler, ctx, action="read_sample_photo", resource_type="sample", resource_id=sample_id)
                return
            target = ctx.path_inside_data(row["relative_path"])
            if not target.is_file():
                handler._send_json({"ok": False, "error": "照片文件不存在"}, 404)
                return
            content = target.read_bytes()
            try:
                safe_mime = ctx.validate_safe_photo_upload(content, row["mime_type"] or "")
            except ValueError:
                handler._send_json({"ok": False, "error": "照片文件类型不安全或签名无效"}, 415)
                return
            handler._send_bytes(content, safe_mime, cache="private, max-age=3600")
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    event_sample_id = handler._sample_events_route(path)
    if event_sample_id:
        try:
            project_id = ctx.first_query_value(query, "projectId", "").strip()
            if not _sample_allowed(handler, ctx, event_sample_id, project_id=project_id, action="read_sample_events"):
                return
            with ctx.connect_db() as conn:
                logs = ctx.load_sample_events(conn, event_sample_id)
                if project_id:
                    logs = [log for log in logs if str(log.get("projectId") or "") == project_id]
                logs = ctx.filter_sample_events_for_actor(conn, logs, handler.client_address[0])
            handler._send_json({"ok": True, "sampleId": event_sample_id, "logs": logs, "count": len(logs)})
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    history_sample_id = handler._sample_history_route(path)
    if history_sample_id:
        try:
            project_id = ctx.first_query_value(query, "projectId", "").strip()
            if not _sample_allowed(handler, ctx, history_sample_id, project_id=project_id, action="read_sample_history"):
                return
            with ctx.connect_db() as conn:
                result = ctx.list_sample_history_page(conn, history_sample_id, query)
                result = ctx.filter_sample_history_for_actor(conn, result, handler.client_address[0], project_id=project_id)
            handler._send_json({"ok": True, **result})
        except KeyError as e:
            handler._send_json({"ok": False, "error": str(e)}, 404)
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path in ("/", "/index.html"):
        if not ctx.INDEX_PATH.exists():
            handler._send_json({"ok": False, "error": "index.html 不存在"}, 404)
            return
        _send_versioned_text(handler, ctx, ctx.INDEX_PATH, "text/html; charset=utf-8", cache="no-cache")
        return

    if not handler._is_public_static_path(path):
        handler._send_json({"ok": False, "error": "禁止访问"}, 403)
        return

    rel = path.lstrip("/")
    target = (ctx.FRONTEND_DIR / rel).resolve()
    if ctx.FRONTEND_DIR not in target.parents and target != ctx.FRONTEND_DIR:
        handler._send_json({"ok": False, "error": "非法路径"}, 403)
        return
    if target.is_file():
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if path == "/css/style.css":
            _send_versioned_text(handler, ctx, target, content_type, cache=STATIC_ASSET_CACHE)
            return
        handler._send_file(target, content_type)
        return

    handler._send_json({"ok": False, "error": "Not Found"}, 404)


def handle_post(handler, ctx) -> None:
    if not _require_write_origin(handler, ctx):
        return
    parsed = urlparse(handler.path)
    path = unquote(parsed.path)

    acl_route = ctx.access_rule_route(path)
    if acl_route:
        resource_type, resource_id = acl_route
        client_ip = _client_ip(handler, ctx)
        try:
            payload = json.loads(handler._read_body(max_bytes=ctx.MAX_UPLOAD_BYTES).decode("utf-8") or "{}")
            with ctx.write_db_connection() as conn:
                allowed, role = _acl_management_allowed(conn, ctx, acl_route, client_ip)
                if allowed:
                    rule = ctx.upsert_access_rule(
                        conn,
                        resource_type,
                        resource_id,
                        payload,
                        actor_ip=client_ip,
                        now=ctx.now_iso(),
                    )
                    ctx.record_security_audit_in_transaction(
                        conn,
                        time=ctx.now_iso(),
                        client_ip=client_ip,
                        action="upsert_access_rule",
                        resource_type=resource_type,
                        resource_id=resource_id,
                        allowed=True,
                        actor_role=role,
                        detail={
                            "targetIp": rule["ipAddress"],
                            "role": rule["role"],
                            "enabled": rule["enabled"],
                        },
                    )
            if not allowed:
                _deny(handler, ctx, action="upsert_access_rule", resource_type=resource_type, resource_id=resource_id)
                return
            handler._send_json({"ok": True, "resourceType": resource_type, "resourceId": resource_id, "rule": rule})
        except json.JSONDecodeError:
            handler._send_json({"ok": False, "error": "请求体不是有效 JSON"}, 400)
        except (ValueError, KeyError) as e:
            handler._send_json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            traceback.print_exc()
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/browser-cache/clear":
        payload = json.dumps({
            "ok": True,
            "cleared": ["cache"],
            "reload": True,
        }, ensure_ascii=False).encode("utf-8")
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(payload)))
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("Clear-Site-Data", '"cache"')
        handler.end_headers()
        handler.wfile.write(payload)
        return

    if path == "/api/import-bundle/preview":
        if not _require_local(handler, ctx, action="preview_import_bundle"):
            return
        try:
            result = ctx.analyze_import_bundle(handler.headers, handler._read_body())
            handler._send_json({"ok": True, **result})
        except ValueError as e:
            handler._send_json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            traceback.print_exc()
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/import-bundle/commit":
        if not _require_local(handler, ctx, action="commit_import_bundle"):
            return
        try:
            payload = json.loads(handler._read_body(max_bytes=ctx.MAX_UPLOAD_BYTES).decode("utf-8"))
            result = ctx.commit_import_bundle(payload)
            if result.get("status"):
                _audit_access(ctx, _client_ip(handler, ctx), "commit_import_bundle", "platform", "", allowed=False, actor_role="local_admin", detail={"status": result.get("status"), "reason": result.get("error", "")})
                handler._send_json(result, result["status"])
            else:
                handler._send_json({"ok": True, **result})
                _audit_access(
                    ctx,
                    _client_ip(handler, ctx),
                    "commit_import_bundle",
                    "platform",
                    "",
                    allowed=True,
                    actor_role="local_admin",
                    detail={
                        "revision": result.get("revision"),
                        "accessPolicy": result.get("accessPolicy") or {},
                    },
                )
        except ValueError as e:
            _audit_access(ctx, _client_ip(handler, ctx), "commit_import_bundle", "platform", "", allowed=False, actor_role="local_admin", detail={"reason": str(e)})
            handler._send_json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            _audit_access(ctx, _client_ip(handler, ctx), "commit_import_bundle", "platform", "", allowed=False, actor_role="local_admin", detail={"reason": str(e)})
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/samples/archive/preview":
        if not _require_local(handler, ctx, action="preview_sample_archive"):
            return
        try:
            result = ctx.analyze_sample_archive(handler.headers, handler._read_body())
            if result.get("packageKind") != "sample-archive":
                handler._send_json({"ok": False, "error": "这不是单台样机档案包"}, 400)
                return
            handler._send_json({"ok": True, **result})
        except ValueError as e:
            handler._send_json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            traceback.print_exc()
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/samples/archive/commit":
        if not _require_local(handler, ctx, action="commit_sample_archive"):
            return
        try:
            payload = json.loads(handler._read_body(max_bytes=ctx.MAX_UPLOAD_BYTES).decode("utf-8"))
            result = ctx.commit_sample_archive(payload)
            if result.get("status"):
                _audit_access(ctx, _client_ip(handler, ctx), "commit_sample_archive", "sample", str(payload.get("sampleId") or ""), allowed=False, actor_role="local_admin", detail={"status": result.get("status"), "reason": result.get("error", "")})
                handler._send_json(result, result["status"])
            else:
                handler._send_json({"ok": True, **result})
                _audit_access(ctx, _client_ip(handler, ctx), "commit_sample_archive", "sample", str(payload.get("sampleId") or result.get("sampleId") or ""), allowed=True, actor_role="local_admin", detail={"revision": result.get("revision")})
        except ValueError as e:
            _audit_access(ctx, _client_ip(handler, ctx), "commit_sample_archive", "sample", "", allowed=False, actor_role="local_admin", detail={"reason": str(e)})
            handler._send_json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            _audit_access(ctx, _client_ip(handler, ctx), "commit_sample_archive", "sample", "", allowed=False, actor_role="local_admin", detail={"reason": str(e)})
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/sample-identity-check":
        try:
            payload = json.loads(handler._read_body(max_bytes=ctx.MAX_UPLOAD_BYTES).decode("utf-8") or "{}")
            with ctx.connect_db() as conn:
                category_id = str(payload.get("categoryId") or payload.get("excludeCategoryId") or "")
                allowed = ctx.get_access_context(handler.client_address[0]).is_local_admin or bool(
                    category_id and ctx.has_pool_role(conn, category_id, handler.client_address[0], "pool_maintainer")
                )
                if allowed:
                    result = ctx.check_sample_identity_conflicts(conn, payload)
                    result = ctx.sanitize_identity_conflicts(conn, result, handler.client_address[0])
            if not allowed:
                _deny(handler, ctx, action="check_sample_identity", resource_type="sample_pool", resource_id=category_id)
                return
            handler._send_json({"ok": True, **result})
        except ValueError as e:
            handler._send_json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    route = handler._sample_photo_route(unquote(parsed.path))
    if not route or route[1] is not None:
        handler._send_json({"ok": False, "error": "Not Found"}, 404)
        return

    sample_id, _ = route
    try:
        fields, files = ctx.parse_multipart(handler.headers, handler._read_body())
        image_files = [f for f in files if f["field"] in ("photos", "photo", "file")]
        thumb_files = {}
        for f in files:
            m = re.match(r"^thumb_(\d+)$", str(f.get("field") or ""))
            if m:
                thumb_files[int(m.group(1))] = f
        if not image_files:
            handler._send_json({"ok": False, "error": "没有收到照片文件"}, 400)
            return

        client_ip = _client_ip(handler, ctx)
        project_id = str(fields.get("projectId") or "").strip()
        stage_id = str(fields.get("stageId") or "").strip()
        task_id = str(fields.get("taskId") or "").strip()
        with ctx.connect_db() as conn:
            sample_row = conn.execute(
                "SELECT id, category_id FROM sample_records WHERE id = ? AND deleted_at IS NULL",
                (sample_id,),
            ).fetchone()
            if not sample_row:
                handler._send_json({"ok": False, "error": "样机不存在"}, 404)
                return
            category_id = str(sample_row["category_id"] or "")
            if project_id or stage_id or task_id:
                real_project_id, real_stage_id = ctx.task_scope(conn, task_id)
                linked = bool(conn.execute(
                    "SELECT 1 FROM project_task_samples WHERE task_id = ? AND sample_id = ?",
                    (task_id, sample_id),
                ).fetchone())
                allowed = bool(
                    project_id and stage_id and task_id
                    and real_project_id == project_id and real_stage_id == stage_id
                    and linked
                    and ctx.has_project_role(conn, project_id, client_ip, "contributor")
                )
                upload_role = ctx.get_project_role(conn, project_id, client_ip)
            else:
                allowed = ctx.has_pool_role(conn, category_id, client_ip, "pool_maintainer")
                upload_role = ctx.get_pool_role(conn, category_id, client_ip)
        if not allowed:
            _deny(handler, ctx, action="upload_sample_photos", resource_type="sample", resource_id=sample_id, message="当前 IP 无权向该样机上传此类照片或附件")
            return

        for file_item in [*image_files, *thumb_files.values()]:
            file_item["mime_type"] = ctx.validate_safe_photo_upload(
                file_item.get("content") or b"",
                file_item.get("mime_type") or "",
            )

        uploaded = []
        asset_records: list[tuple[str, dict]] = []
        written_paths: list[str] = []
        for idx, file_item in enumerate(image_files):
            uploaded_at = ctx.now_iso()
            meta = ctx.write_sample_asset_file(
                sample_id,
                f"photo_{uuid.uuid4().hex}",
                file_item["content"],
                file_item["filename"],
                file_item["mime_type"],
                uploaded_at=uploaded_at,
                file_prefix="photo",
            )
            asset_records.append(("photo", meta))
            meta.update({"projectId": project_id, "stageId": stage_id, "taskId": task_id})
            written_paths.append(str(meta.get("relativePath") or ""))
            thumb_item = thumb_files.get(idx)
            if thumb_item:
                thumb_meta = ctx.write_sample_asset_file(
                    sample_id,
                    ctx.thumbnail_asset_id(str(meta.get("id") or "")),
                    thumb_item["content"],
                    thumb_item["filename"],
                    thumb_item["mime_type"],
                    uploaded_at=uploaded_at,
                    file_prefix="thumb",
                )
                asset_records.append(("photo_thumb", thumb_meta))
                thumb_meta.update({"projectId": project_id, "stageId": stage_id, "taskId": task_id})
                written_paths.append(str(thumb_meta.get("relativePath") or ""))
                ctx.attach_thumbnail_meta(meta, thumb_meta)
            uploaded.append(meta)

        with ctx.write_db_connection() as conn:
            missing_after_write = False
            sample_row = conn.execute(
                "SELECT id FROM sample_records WHERE id = ? AND deleted_at IS NULL",
                (sample_id,),
            ).fetchone()
            if not sample_row:
                missing_after_write = True
            else:
                for kind, meta in asset_records:
                    ctx.upsert_sample_asset_meta(conn, sample_id, meta, kind, uploaded_by=handler.client_address[0])
                result = ctx.commit_sample_asset_mutation(
                    conn,
                    sample_id,
                    "upload_sample_photos",
                    fields.get("remark", "上传样机外观照片"),
                    handler.client_address[0],
                )
                result["photos"] = ctx.filter_photo_list_for_actor(
                    conn,
                    sample_id,
                    result.get("photos") or [],
                    handler.client_address[0],
                    project_id=project_id,
                )
                visible_uploaded = {
                    str(photo.get("id") or ""): photo
                    for photo in result.get("photos") or []
                    if isinstance(photo, dict)
                }
                uploaded = [
                    visible_uploaded[str(meta.get("id") or "")]
                    for meta in uploaded
                    if str(meta.get("id") or "") in visible_uploaded
                ]
        if missing_after_write:
            ctx.unlink_asset_relative_paths(written_paths, warn_label="清理未入库照片文件")
            handler._send_json({"ok": False, "error": "样机不存在"}, 404)
            return
        handler._send_json({"ok": True, **result, "uploaded": uploaded})
        _audit_access(ctx, client_ip, "upload_sample_photos", "sample", sample_id, allowed=True, actor_role=upload_role, detail={"count": len(uploaded), "projectId": project_id, "taskId": task_id})
    except ValueError as e:
        handler._send_json({"ok": False, "error": str(e)}, 400)
    except Exception as e:
        if "written_paths" in locals():
            ctx.unlink_asset_relative_paths(written_paths, warn_label="清理上传失败照片文件")
        handler._send_json({"ok": False, "error": str(e)}, 500)


def handle_delete(handler, ctx) -> None:
    if not _require_write_origin(handler, ctx):
        return
    parsed = urlparse(handler.path)
    path = unquote(parsed.path)
    query = parse_qs(parsed.query, keep_blank_values=True)
    acl_route = ctx.access_rule_route(path)
    if acl_route:
        resource_type, resource_id = acl_route
        client_ip = _client_ip(handler, ctx)
        target_ip = ctx.first_query_value(query, "ipAddress", "").strip()
        try:
            with ctx.write_db_connection() as conn:
                allowed, role = _acl_management_allowed(conn, ctx, acl_route, client_ip)
                if allowed:
                    deleted = ctx.delete_access_rule(conn, resource_type, resource_id, target_ip)
                    if deleted:
                        ctx.record_security_audit_in_transaction(
                            conn,
                            time=ctx.now_iso(),
                            client_ip=client_ip,
                            action="delete_access_rule",
                            resource_type=resource_type,
                            resource_id=resource_id,
                            allowed=True,
                            actor_role=role,
                            detail={"targetIp": target_ip},
                        )
            if not allowed:
                _deny(handler, ctx, action="delete_access_rule", resource_type=resource_type, resource_id=resource_id)
                return
            if not deleted:
                handler._send_json({"ok": False, "error": "权限规则不存在"}, 404)
                return
            handler._send_json({"ok": True, "resourceType": resource_type, "resourceId": resource_id, "ipAddress": target_ip})
        except ValueError as e:
            handler._send_json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            traceback.print_exc()
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return
    route = handler._sample_photo_route(path)
    if not route or not route[1]:
        handler._send_json({"ok": False, "error": "Not Found"}, 404)
        return

    sample_id, photo_id = route
    try:
        client_ip = _client_ip(handler, ctx)
        asset_paths: list[str] = []
        result: dict | None = None
        with ctx.write_db_connection() as conn:
            sample_row = conn.execute(
                "SELECT id, category_id FROM sample_records WHERE id = ? AND deleted_at IS NULL",
                (sample_id,),
            ).fetchone()
            if not sample_row:
                handler._send_json({"ok": False, "error": "样机不存在"}, 404)
                return
            category_id = str(sample_row["category_id"] or "")
            role = ctx.get_pool_role(conn, category_id, client_ip)
            if not ctx.has_pool_role(conn, category_id, client_ip, "pool_admin"):
                allowed = False
            else:
                allowed = True
            if not allowed:
                # Exit the transaction before recording the independent denial.
                pass
            else:
                asset_rows = conn.execute(
                """
                SELECT relative_path, project_id FROM sample_assets
                WHERE sample_id = ? AND id IN (?, ?) AND kind IN ('photo', 'photo_thumb') AND deleted_at IS NULL
                """,
                (sample_id, photo_id, ctx.thumbnail_asset_id(photo_id)),
                ).fetchall()
                if not asset_rows:
                    handler._send_json({"ok": False, "error": "照片不存在"}, 404)
                    return
                if not ctx.get_access_context(client_ip).is_local_admin and any(str(asset["project_id"] or "") for asset in asset_rows):
                    allowed = False
                if not allowed:
                    asset_paths = []
                    result = None
                else:
                    asset_paths = [str(asset["relative_path"] or "") for asset in asset_rows if asset["relative_path"]]
                    conn.execute(
                """
                UPDATE sample_assets SET deleted_at = ?
                WHERE sample_id = ? AND id IN (?, ?) AND kind IN ('photo', 'photo_thumb')
                """,
                (ctx.now_iso(), sample_id, photo_id, ctx.thumbnail_asset_id(photo_id)),
                    )
                    result = ctx.commit_sample_asset_mutation(conn, sample_id, "delete_sample_photo", "删除样机外观照片", handler.client_address[0])
                    result["photos"] = ctx.filter_photo_list_for_actor(conn, sample_id, result.get("photos") or [], client_ip)
        if not allowed:
            _deny(handler, ctx, action="delete_sample_photo", resource_type="sample_pool", resource_id=category_id, message="当前 IP 无权删除该照片；项目任务附件仅限本机管理员删除")
            return
        ctx.unlink_asset_relative_paths(asset_paths, warn_label="删除照片文件")
        handler._send_json({"ok": True, **(result or {})})
        _audit_access(ctx, client_ip, "delete_sample_photo", "sample_pool", category_id, allowed=True, actor_role=role, detail={"sampleId": sample_id, "photoId": photo_id})
    except Exception as e:
        handler._send_json({"ok": False, "error": str(e)}, 500)


def handle_patch(handler, ctx) -> None:
    if not _require_write_origin(handler, ctx):
        return
    parsed = urlparse(handler.path)
    path = unquote(parsed.path)
    photo_route = handler._sample_photo_route(path)
    if photo_route and photo_route[1]:
        _handle_photo_rename_patch(handler, ctx, photo_route)
        return

    project_id = handler._project_mutation_route(path)
    stage_mutation_id = handler._stage_mutation_route(path)
    stage_tasks_batch_id = handler._stage_tasks_batch_route(path)
    task_id = handler._task_mutation_route(path)
    sample_id = handler._sample_mutation_route(path)
    category_id = handler._sample_category_mutation_route(path)
    if not project_id and not stage_mutation_id and not stage_tasks_batch_id and not task_id and not sample_id and not category_id:
        handler._send_json({"ok": False, "error": "Not Found"}, 404)
        return

    try:
        payload = json.loads(handler._read_body(max_bytes=ctx.MAX_UPLOAD_BYTES).decode("utf-8"))
        if project_id:
            payload["projectId"] = project_id
            ok, result = ctx.commit_project_mutation(payload, handler.client_address[0])
        elif stage_mutation_id:
            payload["stageId"] = stage_mutation_id
            ok, result = ctx.commit_stage_mutation(payload, handler.client_address[0])
        elif stage_tasks_batch_id:
            payload["stageId"] = stage_tasks_batch_id
            ok, result = ctx.commit_task_batch_mutation(payload, handler.client_address[0])
        elif task_id:
            payload["taskId"] = task_id
            ok, result = ctx.commit_task_mutation(payload, handler.client_address[0])
        elif sample_id:
            payload["sampleId"] = sample_id
            ok, result = ctx.commit_sample_mutation(payload, handler.client_address[0])
        else:
            payload["categoryId"] = category_id
            ok, result = ctx.commit_sample_category_mutation(payload, handler.client_address[0])
        if not ok:
            handler._send_json({"ok": False, **result}, int(result.get("status", 400)))
            return
        handler._send_json({"ok": True, **result})
    except json.JSONDecodeError:
        handler._send_json({"ok": False, "error": "请求体不是有效 JSON"}, 400)
    except KeyError as e:
        handler._send_json({"ok": False, "error": str(e)}, 404)
    except ValueError as e:
        handler._send_json({"ok": False, "error": str(e)}, 400)
    except Exception as e:
        handler._send_json({"ok": False, "error": str(e)}, 500)


def _handle_photo_rename_patch(handler, ctx, photo_route) -> None:
    sample_id, photo_id = photo_route
    try:
        client_ip = _client_ip(handler, ctx)
        payload = json.loads(handler._read_body(max_bytes=ctx.MAX_UPLOAD_BYTES).decode("utf-8") or "{}")
        name = str(payload.get("name") or "").strip()
        if not name:
            handler._send_json({"ok": False, "error": "照片名称不能为空"}, 400)
            return
        with ctx.write_db_connection() as conn:
            row = conn.execute(
                """
                SELECT a.id, a.project_id, r.category_id
                FROM sample_assets a
                JOIN sample_records r ON r.id = a.sample_id AND r.deleted_at IS NULL
                WHERE a.sample_id = ? AND a.id = ? AND a.kind = 'photo' AND a.deleted_at IS NULL
                """,
                (sample_id, photo_id),
            ).fetchone()
            if not row:
                handler._send_json({"ok": False, "error": "照片不存在"}, 404)
                return
            category_id = str(row["category_id"] or "")
            actor = ctx.get_access_context(client_ip)
            role = "local_admin" if actor.is_local_admin else ctx.get_pool_role(conn, category_id, client_ip)
            allowed = actor.is_local_admin or (
                not str(row["project_id"] or "")
                and ctx.has_pool_role(conn, category_id, client_ip, "pool_maintainer")
            )
            if not allowed:
                photos = []
            else:
                ts = ctx.now_iso()
                conn.execute(
                "UPDATE sample_assets SET original_name = ? WHERE sample_id = ? AND id = ? AND kind = 'photo'",
                (name, sample_id, photo_id),
                )
                sample_row = conn.execute("SELECT data_json FROM sample_records WHERE id = ?", (sample_id,)).fetchone()
                if sample_row:
                    sample = ctx.json_obj(sample_row["data_json"], {}) or {}
                    sample["updatedAt"] = ts
                    conn.execute(
                    "UPDATE sample_records SET data_json = ?, updated_at = ? WHERE id = ?",
                    (ctx.json_dumps(sample), ts, sample_id),
                    )
                state_row = conn.execute("SELECT revision FROM app_state WHERE id = 1").fetchone()
                current_revision = int(state_row["revision"] or 1) if state_row else 1
                new_revision = current_revision + 1
                conn.execute("UPDATE app_state SET revision = ?, updated_at = ? WHERE id = 1", (new_revision, ts))
                conn.execute(
                """
                INSERT INTO audit_log
                (time, user, action, remark, revision_before, revision_after, client_ip)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ts,
                    str(payload.get("user") or "管理员"),
                    "rename_sample_photo",
                    f"重命名样机照片：{name}",
                    current_revision,
                    new_revision,
                    handler.client_address[0],
                ),
                )
                photos = ctx.load_sample_photos(conn, sample_id)
                photos = ctx.filter_photo_list_for_actor(conn, sample_id, photos, client_ip)
                conn.commit()
        if not allowed:
            _deny(handler, ctx, action="rename_sample_photo", resource_type="sample_pool", resource_id=category_id, message="项目任务附件不能由样机池角色重命名")
            return
        handler._send_json({"ok": True, "revision": new_revision, "updated_at": ts, "sampleId": sample_id, "photos": photos})
        _audit_access(ctx, client_ip, "rename_sample_photo", "sample_pool", category_id, allowed=True, actor_role=role, detail={"sampleId": sample_id, "photoId": photo_id})
    except json.JSONDecodeError:
        handler._send_json({"ok": False, "error": "请求体不是有效 JSON"}, 400)
    except Exception as e:
        traceback.print_exc()
        handler._send_json({"ok": False, "error": str(e)}, 500)


def handle_put(handler, ctx) -> None:
    if not _require_write_origin(handler, ctx):
        return
    parsed = urlparse(handler.path)
    if parsed.path != "/api/state":
        handler._send_json({"ok": False, "error": "Not Found"}, 404)
        return
    if not _require_local(handler, ctx, action="write_full_state"):
        return

    try:
        payload = json.loads(handler._read_body(max_bytes=ctx.MAX_UPLOAD_BYTES).decode("utf-8"))
        expected_revision = payload.get("revision")
        data = payload.get("data")
        base_data = payload.get("baseData")
        remark = str(payload.get("remark") or "")
        user = str(payload.get("user") or "")

        ok, result = ctx.save_state(data, expected_revision, handler.client_address[0], remark=remark, user=user, base_data=base_data)
        if not ok:
            _audit_access(ctx, _client_ip(handler, ctx), "write_full_state", "platform", "", allowed=False, actor_role="local_admin", detail={"status": result.get("status"), "reason": result.get("error", "")})
            handler._send_json({"ok": False, **result}, int(result.get("status", 400)))
            return

        handler._send_json({"ok": True, **result})
        _audit_access(ctx, _client_ip(handler, ctx), "write_full_state", "platform", "", allowed=True, actor_role="local_admin", detail={"revision": result.get("revision")})
    except json.JSONDecodeError:
        _audit_access(ctx, _client_ip(handler, ctx), "write_full_state", "platform", "", allowed=False, actor_role="local_admin", detail={"reason": "invalid_json"})
        handler._send_json({"ok": False, "error": "请求体不是有效 JSON"}, 400)
    except ValueError as e:
        _audit_access(ctx, _client_ip(handler, ctx), "write_full_state", "platform", "", allowed=False, actor_role="local_admin", detail={"reason": str(e)})
        handler._send_json({"ok": False, "error": str(e)}, 400)
    except Exception as e:
        _audit_access(ctx, _client_ip(handler, ctx), "write_full_state", "platform", "", allowed=False, actor_role="local_admin", detail={"reason": str(e)})
        handler._send_json({"ok": False, "error": str(e)}, 500)
