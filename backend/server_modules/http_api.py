from __future__ import annotations

import json
import hashlib
import mimetypes
import re
import shutil
import traceback
import uuid
from urllib.parse import parse_qs, quote, unquote, urlparse

from server_modules.http_helpers import STATIC_ASSET_CACHE


VERSION_TEMPLATE_TOKEN = "__APP_VERSION__"


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
    parsed = urlparse(handler.path)
    path = unquote(parsed.path)
    query = parse_qs(parsed.query, keep_blank_values=True)

    if path == "/api/health":
        handler._send_json({
            "ok": True,
            "version": ctx.APP_VERSION,
            "time": ctx.now_iso(),
            "data_dir": str(ctx.DATA_DIR),
            "deploymentId": ctx.load_deployment_id(),
        })
        return

    if path == "/api/export-bundle":
        tmp_path = None
        response_started = False
        try:
            tmp_path, filename = ctx.build_export_bundle_file(_selection_from_query(query))
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
        except KeyError as e:
            if not response_started:
                handler._send_json({"ok": False, "error": str(e)}, 404)
        except Exception as e:
            if not response_started:
                traceback.print_exc()
                handler._send_json({"ok": False, "error": str(e), "errorCode": "SAMPLE_ARCHIVE_EXPORT_FAILED"}, 500)
        finally:
            if tmp_path:
                tmp_path.unlink(missing_ok=True)
        return

    if path == "/api/state":
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
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/bootstrap":
        try:
            with ctx.connect_db() as conn:
                data, revision, updated_at = ctx.compose_bootstrap_state(conn)
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
            handler._send_json({"ok": True, "projects": projects, "count": len(projects)})
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    project_detail_id = handler._project_detail_route(path)
    if project_detail_id:
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
            handler._send_json({"ok": True, "categories": categories, "count": len(categories)})
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/task-sample-candidates":
        try:
            with ctx.connect_db() as conn:
                result = ctx.list_task_sample_candidates_page(conn, query)
            handler._send_json({"ok": True, **result})
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/sample-destroy-impact":
        try:
            with ctx.connect_db() as conn:
                result = ctx.list_sample_destroy_impact_scope(conn, query)
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
        try:
            include_photos = ctx.first_query_value(query, "includePhotos", "") in ("1", "true", "yes")
            with ctx.connect_db() as conn:
                category = ctx.load_sample_category_detail(conn, sample_category_detail_id, include_photos=include_photos)
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
                result = ctx.list_stage_tasks_page(conn, stage_tasks_id, query)
            handler._send_json({"ok": True, **result})
        except KeyError as e:
            handler._send_json({"ok": False, "error": str(e)}, 404)
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    sample_category_id = handler._sample_category_samples_route(path)
    if sample_category_id:
        try:
            with ctx.connect_db() as conn:
                result = ctx.list_samples_page(conn, sample_category_id, query)
            handler._send_json({"ok": True, **result})
        except KeyError as e:
            handler._send_json({"ok": False, "error": str(e)}, 404)
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    photo_route = handler._sample_photo_route(path)
    if photo_route and photo_route[1] is None:
        sample_id, _ = photo_route
        try:
            with ctx.connect_db() as conn:
                photos = ctx.load_sample_photos(conn, sample_id)
            handler._send_json({"ok": True, "sampleId": sample_id, "photos": photos, "photoCount": len(photos)})
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if photo_route and photo_route[1]:
        sample_id, photo_id = photo_route
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
            if not row:
                handler._send_json({"ok": False, "error": "照片不存在"}, 404)
                return
            target = ctx.path_inside_data(row["relative_path"])
            if not target.is_file():
                handler._send_json({"ok": False, "error": "照片文件不存在"}, 404)
                return
            handler._send_bytes(target.read_bytes(), row["mime_type"] or "application/octet-stream", cache="private, max-age=3600")
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    event_sample_id = handler._sample_events_route(path)
    if event_sample_id:
        try:
            with ctx.connect_db() as conn:
                logs = ctx.load_sample_events(conn, event_sample_id)
            handler._send_json({"ok": True, "sampleId": event_sample_id, "logs": logs, "count": len(logs)})
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    history_sample_id = handler._sample_history_route(path)
    if history_sample_id:
        try:
            with ctx.connect_db() as conn:
                result = ctx.list_sample_history_page(conn, history_sample_id, query)
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
    parsed = urlparse(handler.path)
    path = unquote(parsed.path)

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
        try:
            payload = json.loads(handler._read_body(max_bytes=ctx.MAX_UPLOAD_BYTES).decode("utf-8"))
            result = ctx.commit_import_bundle(payload)
            if result.get("status"):
                handler._send_json(result, result["status"])
            else:
                handler._send_json({"ok": True, **result})
        except ValueError as e:
            handler._send_json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/samples/archive/preview":
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
        try:
            payload = json.loads(handler._read_body(max_bytes=ctx.MAX_UPLOAD_BYTES).decode("utf-8"))
            result = ctx.commit_sample_archive(payload)
            if result.get("status"):
                handler._send_json(result, result["status"])
            else:
                handler._send_json({"ok": True, **result})
        except ValueError as e:
            handler._send_json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            handler._send_json({"ok": False, "error": str(e)}, 500)
        return

    if path == "/api/sample-identity-check":
        try:
            payload = json.loads(handler._read_body(max_bytes=ctx.MAX_UPLOAD_BYTES).decode("utf-8") or "{}")
            with ctx.connect_db() as conn:
                result = ctx.check_sample_identity_conflicts(conn, payload)
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

        with ctx.connect_db() as conn:
            sample_row = conn.execute(
                "SELECT id FROM sample_records WHERE id = ? AND deleted_at IS NULL",
                (sample_id,),
            ).fetchone()
            if not sample_row:
                handler._send_json({"ok": False, "error": "样机不存在"}, 404)
                return

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
        if missing_after_write:
            ctx.unlink_asset_relative_paths(written_paths, warn_label="清理未入库照片文件")
            handler._send_json({"ok": False, "error": "样机不存在"}, 404)
            return
        handler._send_json({"ok": True, **result, "uploaded": uploaded})
    except ValueError as e:
        handler._send_json({"ok": False, "error": str(e)}, 400)
    except Exception as e:
        if "written_paths" in locals():
            ctx.unlink_asset_relative_paths(written_paths, warn_label="清理上传失败照片文件")
        handler._send_json({"ok": False, "error": str(e)}, 500)


def handle_delete(handler, ctx) -> None:
    parsed = urlparse(handler.path)
    route = handler._sample_photo_route(unquote(parsed.path))
    if not route or not route[1]:
        handler._send_json({"ok": False, "error": "Not Found"}, 404)
        return

    sample_id, photo_id = route
    try:
        asset_paths: list[str] = []
        result: dict | None = None
        with ctx.write_db_connection() as conn:
            sample_row = conn.execute(
                "SELECT id FROM sample_records WHERE id = ? AND deleted_at IS NULL",
                (sample_id,),
            ).fetchone()
            if not sample_row:
                handler._send_json({"ok": False, "error": "样机不存在"}, 404)
                return
            asset_rows = conn.execute(
                """
                SELECT relative_path FROM sample_assets
                WHERE sample_id = ? AND id IN (?, ?) AND kind IN ('photo', 'photo_thumb') AND deleted_at IS NULL
                """,
                (sample_id, photo_id, ctx.thumbnail_asset_id(photo_id)),
            ).fetchall()
            if not asset_rows:
                handler._send_json({"ok": False, "error": "照片不存在"}, 404)
                return
            asset_paths = [str(asset["relative_path"] or "") for asset in asset_rows if asset["relative_path"]]
            conn.execute(
                """
                UPDATE sample_assets SET deleted_at = ?
                WHERE sample_id = ? AND id IN (?, ?) AND kind IN ('photo', 'photo_thumb')
                """,
                (ctx.now_iso(), sample_id, photo_id, ctx.thumbnail_asset_id(photo_id)),
            )
            result = ctx.commit_sample_asset_mutation(conn, sample_id, "delete_sample_photo", "删除样机外观照片", handler.client_address[0])
        ctx.unlink_asset_relative_paths(asset_paths, warn_label="删除照片文件")
        handler._send_json({"ok": True, **(result or {})})
    except Exception as e:
        handler._send_json({"ok": False, "error": str(e)}, 500)


def handle_patch(handler, ctx) -> None:
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
        payload = json.loads(handler._read_body(max_bytes=ctx.MAX_UPLOAD_BYTES).decode("utf-8") or "{}")
        name = str(payload.get("name") or "").strip()
        if not name:
            handler._send_json({"ok": False, "error": "照片名称不能为空"}, 400)
            return
        with ctx.write_db_connection() as conn:
            row = conn.execute(
                """
                SELECT id
                FROM sample_assets
                WHERE sample_id = ? AND id = ? AND kind = 'photo' AND deleted_at IS NULL
                """,
                (sample_id, photo_id),
            ).fetchone()
            if not row:
                handler._send_json({"ok": False, "error": "照片不存在"}, 404)
                return
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
            conn.commit()
        handler._send_json({"ok": True, "revision": new_revision, "updated_at": ts, "sampleId": sample_id, "photos": photos})
    except json.JSONDecodeError:
        handler._send_json({"ok": False, "error": "请求体不是有效 JSON"}, 400)
    except Exception as e:
        traceback.print_exc()
        handler._send_json({"ok": False, "error": str(e)}, 500)


def handle_put(handler, ctx) -> None:
    parsed = urlparse(handler.path)
    if parsed.path != "/api/state":
        handler._send_json({"ok": False, "error": "Not Found"}, 404)
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
            handler._send_json({"ok": False, **result}, int(result.get("status", 400)))
            return

        handler._send_json({"ok": True, **result})
    except json.JSONDecodeError:
        handler._send_json({"ok": False, "error": "请求体不是有效 JSON"}, 400)
    except ValueError as e:
        handler._send_json({"ok": False, "error": str(e)}, 400)
    except Exception as e:
        handler._send_json({"ok": False, "error": str(e)}, 500)
