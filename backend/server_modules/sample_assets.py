from __future__ import annotations

import base64
import mimetypes
import re
import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import quote, unquote_to_bytes


@dataclass(frozen=True)
class AssetStorageContext:
    data_dir: Path
    sample_data_dir: Path
    now_iso: Callable[[], str]


def safe_segment(value: object, fallback: str = "item") -> str:
    text = str(value or "").strip()
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", text)
    text = text.strip("._-")
    return (text or fallback)[:96]


def url_for_asset(sample_id: str, asset_id: str) -> str:
    return f"/api/samples/{quote(str(sample_id), safe='')}/photos/{quote(str(asset_id), safe='')}"


def thumbnail_asset_id(photo_id: str) -> str:
    return f"{photo_id}__thumb"


def validate_safe_photo_upload(content: bytes, declared_mime: object = "") -> str:
    """Return a canonical safe bitmap MIME after signature validation."""
    data = bytes(content or b"")
    detected = ""
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        detected = "image/jpeg"
    elif len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
        detected = "image/png"
    elif len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        detected = "image/webp"
    declared = str(declared_mime or "").split(";", 1)[0].strip().lower()
    aliases = {"image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg"}
    declared = aliases.get(declared, declared)
    if not detected or declared not in {"", detected}:
        raise ValueError("照片仅支持经过文件签名校验的 JPEG、PNG 或 WebP 位图")
    return detected


def file_ext(original_name: str, mime_type: str) -> str:
    suffix = Path(original_name or "").suffix.lower()
    if suffix and re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
        return suffix
    guessed = mimetypes.guess_extension(mime_type or "") or ".bin"
    if guessed == ".jpe":
        guessed = ".jpg"
    return guessed


def path_inside_data(ctx: AssetStorageContext, relative_path: str) -> Path:
    data_dir = ctx.data_dir.resolve()
    target = (ctx.data_dir / relative_path).resolve()
    if data_dir not in target.parents and target != data_dir:
        raise ValueError("非法文件路径")
    return target


def normalize_photo_meta(ctx: AssetStorageContext, sample_id: str, photo: dict) -> dict:
    photo_id = str(photo.get("id") or f"photo_{uuid.uuid4().hex}")
    thumb_id = str(photo.get("thumbId") or photo.get("thumbnailId") or "")
    name = str(photo.get("name") or photo.get("originalName") or "外观照片")
    mime_type = str(photo.get("type") or photo.get("mimeType") or mimetypes.guess_type(name)[0] or "application/octet-stream")
    relative_path = str(photo.get("relativePath") or "")
    size = int(photo.get("size") or 0)
    uploaded_at = str(photo.get("uploadedAt") or photo.get("createdAt") or ctx.now_iso())
    meta = {
        "id": photo_id,
        "name": name,
        "type": mime_type,
        "size": size,
        "url": str(photo.get("url") or url_for_asset(sample_id, photo_id)),
        "relativePath": relative_path,
        "uploadedAt": uploaded_at,
        "projectId": str(photo.get("projectId") or ""),
        "stageId": str(photo.get("stageId") or ""),
        "taskId": str(photo.get("taskId") or ""),
    }
    thumb_url = str(photo.get("thumbUrl") or photo.get("thumbnailUrl") or "")
    thumb_relative_path = str(photo.get("thumbRelativePath") or photo.get("thumbnailRelativePath") or "")
    if thumb_id or thumb_url or thumb_relative_path:
        thumb_id = thumb_id or thumbnail_asset_id(photo_id)
        meta.update({
            "thumbId": thumb_id,
            "thumbUrl": thumb_url or url_for_asset(sample_id, thumb_id),
            "thumbnailUrl": thumb_url or url_for_asset(sample_id, thumb_id),
            "thumbRelativePath": thumb_relative_path,
        })
    return meta


def attach_thumbnail_meta(photo_meta: dict, thumb_meta: dict | None) -> dict:
    if not thumb_meta:
        return photo_meta
    photo_meta["thumbId"] = thumb_meta["id"]
    photo_meta["thumbUrl"] = thumb_meta["url"]
    photo_meta["thumbnailUrl"] = thumb_meta["url"]
    photo_meta["thumbRelativePath"] = thumb_meta.get("relativePath", "")
    photo_meta["thumbType"] = thumb_meta.get("type", "")
    photo_meta["thumbSize"] = thumb_meta.get("size", 0)
    return photo_meta


def write_sample_asset_file(
    ctx: AssetStorageContext,
    sample_id: str,
    asset_id: str,
    content: bytes,
    original_name: str,
    mime_type: str,
    *,
    uploaded_at: str | None = None,
    file_prefix: str = "photo",
) -> dict:
    ext = file_ext(original_name, mime_type)
    file_name = f"{safe_segment(asset_id, file_prefix)}{ext}"
    target_dir = ctx.sample_data_dir / safe_segment(sample_id, "sample") / "photos"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / file_name
    target.write_bytes(content)
    relative_path = target.relative_to(ctx.data_dir).as_posix()
    created_at = uploaded_at or ctx.now_iso()
    return {
        "id": asset_id,
        "name": original_name or file_name,
        "type": mime_type or mimetypes.guess_type(file_name)[0] or "application/octet-stream",
        "size": len(content),
        "url": url_for_asset(sample_id, asset_id),
        "relativePath": relative_path,
        "uploadedAt": created_at,
    }


def upsert_sample_asset_meta(
    ctx: AssetStorageContext,
    conn: sqlite3.Connection,
    sample_id: str,
    meta: dict,
    kind: str,
    *,
    uploaded_by: str = "",
) -> None:
    asset_id = str(meta.get("id") or "")
    relative_path = str(meta.get("relativePath") or "")
    file_name = Path(relative_path).name if relative_path else safe_segment(asset_id, "asset")
    conn.execute(
        """
        INSERT INTO sample_assets
        (id, sample_id, kind, original_name, file_name, relative_path, mime_type, size, created_at, created_by,
         project_id, stage_id, task_id, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
            sample_id = excluded.sample_id,
            kind = excluded.kind,
            original_name = excluded.original_name,
            file_name = excluded.file_name,
            relative_path = excluded.relative_path,
            mime_type = excluded.mime_type,
            size = excluded.size,
            created_at = excluded.created_at,
            created_by = excluded.created_by,
            project_id = excluded.project_id,
            stage_id = excluded.stage_id,
            task_id = excluded.task_id,
            deleted_at = NULL
        """,
        (
            asset_id,
            sample_id,
            kind,
            str(meta.get("name") or file_name),
            file_name,
            relative_path,
            str(meta.get("type") or mimetypes.guess_type(file_name)[0] or "application/octet-stream"),
            int(meta.get("size") or 0),
            str(meta.get("uploadedAt") or ctx.now_iso()),
            uploaded_by,
            str(meta.get("projectId") or "") or None,
            str(meta.get("stageId") or "") or None,
            str(meta.get("taskId") or "") or None,
        ),
    )


def store_asset_bytes(
    ctx: AssetStorageContext,
    conn: sqlite3.Connection,
    sample_id: str,
    content: bytes,
    original_name: str,
    mime_type: str,
    *,
    photo_id: str | None = None,
    uploaded_at: str | None = None,
    uploaded_by: str = "",
) -> dict:
    asset_id = photo_id or f"photo_{uuid.uuid4().hex}"
    meta = write_sample_asset_file(
        ctx,
        sample_id,
        asset_id,
        content,
        original_name,
        mime_type,
        uploaded_at=uploaded_at,
        file_prefix="photo",
    )
    upsert_sample_asset_meta(ctx, conn, sample_id, meta, "photo", uploaded_by=uploaded_by)
    return meta


def store_thumbnail_bytes(
    ctx: AssetStorageContext,
    conn: sqlite3.Connection,
    sample_id: str,
    photo_id: str,
    content: bytes,
    original_name: str,
    mime_type: str,
    *,
    uploaded_at: str | None = None,
    uploaded_by: str = "",
) -> dict:
    asset_id = thumbnail_asset_id(photo_id)
    meta = write_sample_asset_file(
        ctx,
        sample_id,
        asset_id,
        content,
        original_name,
        mime_type,
        uploaded_at=uploaded_at,
        file_prefix="thumb",
    )
    upsert_sample_asset_meta(ctx, conn, sample_id, meta, "photo_thumb", uploaded_by=uploaded_by)
    return meta


def materialize_data_url_photo(ctx: AssetStorageContext, conn: sqlite3.Connection, sample_id: str, photo: dict) -> dict | None:
    data_url = str(photo.get("dataUrl") or "")
    match = re.match(r"^data:([^;,]+)?(;base64)?,(.*)$", data_url, flags=re.S)
    if not match:
        return None
    mime_type = match.group(1) or photo.get("type") or "application/octet-stream"
    is_base64 = bool(match.group(2))
    payload = match.group(3) or ""
    try:
        content = base64.b64decode(payload, validate=False) if is_base64 else unquote_to_bytes(payload)
    except Exception:
        return None
    return store_asset_bytes(
        ctx,
        conn,
        sample_id,
        content,
        str(photo.get("name") or "外观照片"),
        str(mime_type),
        photo_id=str(photo.get("id") or f"photo_{uuid.uuid4().hex}"),
        uploaded_at=str(photo.get("uploadedAt") or ctx.now_iso()),
    )


def upsert_existing_photo_asset(ctx: AssetStorageContext, conn: sqlite3.Connection, sample_id: str, photo: dict) -> dict:
    meta = normalize_photo_meta(ctx, sample_id, photo)
    relative_path = meta.get("relativePath") or ""
    file_name = Path(relative_path).name if relative_path else safe_segment(meta["id"], "photo")
    conn.execute(
        """
        INSERT INTO sample_assets
        (id, sample_id, kind, original_name, file_name, relative_path, mime_type, size, created_at, created_by,
         project_id, stage_id, task_id, deleted_at)
        VALUES (?, ?, 'photo', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
            sample_id = excluded.sample_id,
            kind = excluded.kind,
            original_name = excluded.original_name,
            file_name = excluded.file_name,
            relative_path = excluded.relative_path,
            mime_type = excluded.mime_type,
            size = excluded.size,
            created_at = excluded.created_at,
            project_id = excluded.project_id,
            stage_id = excluded.stage_id,
            task_id = excluded.task_id,
            deleted_at = NULL
        """,
        (
            meta["id"],
            sample_id,
            meta["name"],
            file_name,
            relative_path,
            meta["type"],
            meta["size"],
            meta["uploadedAt"],
            str(meta.get("projectId") or "") or None,
            str(meta.get("stageId") or "") or None,
            str(meta.get("taskId") or "") or None,
        ),
    )
    thumb_relative_path = meta.get("thumbRelativePath") or ""
    if thumb_relative_path:
        thumb_id = meta.get("thumbId") or thumbnail_asset_id(meta["id"])
        thumb_file_name = Path(thumb_relative_path).name
        conn.execute(
            """
            INSERT INTO sample_assets
            (id, sample_id, kind, original_name, file_name, relative_path, mime_type, size, created_at, created_by,
             project_id, stage_id, task_id, deleted_at)
            VALUES (?, ?, 'photo_thumb', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, NULL)
            ON CONFLICT(id) DO UPDATE SET
                sample_id = excluded.sample_id,
                kind = excluded.kind,
                original_name = excluded.original_name,
                file_name = excluded.file_name,
                relative_path = excluded.relative_path,
                mime_type = excluded.mime_type,
                size = excluded.size,
                created_at = excluded.created_at,
                project_id = excluded.project_id,
                stage_id = excluded.stage_id,
                task_id = excluded.task_id,
                deleted_at = NULL
            """,
            (
                thumb_id,
                sample_id,
                str(photo.get("thumbName") or photo.get("thumbnailName") or f"{meta['name']} 缩略图"),
                thumb_file_name,
                thumb_relative_path,
                str(photo.get("thumbType") or photo.get("thumbnailType") or "image/jpeg"),
                int(photo.get("thumbSize") or photo.get("thumbnailSize") or 0),
                meta["uploadedAt"],
                str(meta.get("projectId") or "") or None,
                str(meta.get("stageId") or "") or None,
                str(meta.get("taskId") or "") or None,
            ),
        )
    return meta


def normalize_sample_photos(ctx: AssetStorageContext, conn: sqlite3.Connection, sample: dict) -> list[dict]:
    sample_id = str(sample.get("id") or f"sample_{uuid.uuid4().hex}")
    sample["id"] = sample_id
    normalized: list[dict] = []
    for raw_photo in sample.get("photos", []) or []:
        if not isinstance(raw_photo, dict):
            continue
        if raw_photo.get("dataUrl"):
            meta = materialize_data_url_photo(ctx, conn, sample_id, raw_photo)
            if meta:
                normalized.append(meta)
            continue
        if raw_photo.get("url") or raw_photo.get("relativePath"):
            normalized.append(upsert_existing_photo_asset(ctx, conn, sample_id, raw_photo))
    return normalized


def remove_empty_dirs_up_to(path: Path, stop_dir: Path) -> None:
    stop_dir = stop_dir.resolve()
    cur = path.resolve()
    while cur != stop_dir and stop_dir in cur.parents:
        try:
            cur.rmdir()
        except OSError:
            break
        cur = cur.parent


def unlink_asset_relative_paths(ctx: AssetStorageContext, relative_paths: list[str], *, warn_label: str = "删除资产文件") -> None:
    for relative_path in relative_paths:
        try:
            target = path_inside_data(ctx, relative_path)
            if target.is_file():
                target.unlink()
                remove_empty_dirs_up_to(target.parent, ctx.sample_data_dir)
        except Exception as e:
            print(f"[WARN] {warn_label}失败：{e}")


def sample_asset_relative_paths(conn: sqlite3.Connection, sample_ids: list[str]) -> list[str]:
    if not sample_ids:
        return []
    placeholders = ",".join("?" for _ in sample_ids)
    rows = conn.execute(
        f"SELECT relative_path FROM sample_assets WHERE sample_id IN ({placeholders})",
        sample_ids,
    ).fetchall()
    return [str(row["relative_path"] or "") for row in rows if row["relative_path"]]


def cleanup_sample_asset_files(ctx: AssetStorageContext, conn: sqlite3.Connection, sample_ids: list[str]) -> None:
    unlink_asset_relative_paths(ctx, sample_asset_relative_paths(conn, sample_ids), warn_label="删除样机资产文件")
