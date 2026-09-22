"""Import preview cache helpers.

Preview cache entries are owned by backend/server.py for process lifetime
and route code, while cleanup and payload persistence live here.
"""

from __future__ import annotations

import json
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Callable


_CACHE_LOCK = threading.RLock()


class PreviewBusyError(ValueError):
    pass


@contextmanager
def claim_preview(entries: dict[str, dict], key: str):
    """Lease one preview without holding a lock during import or database I/O."""
    with _CACHE_LOCK:
        entry = entries.get(key)
        if entry is None:
            raise ValueError("previewId 无效或已过期")
        if entry.get("_in_use"):
            raise PreviewBusyError("该预览正在导入，请等待当前操作完成")
        entry["_in_use"] = True
    try:
        yield entry
    finally:
        with _CACHE_LOCK:
            entry.pop("_in_use", None)


def put_entry(entries: dict[str, dict], key: str, entry: dict) -> None:
    with _CACHE_LOCK:
        entries[key] = entry


def remove_entry(entries: dict[str, dict], key: str) -> None:
    with _CACHE_LOCK:
        entries.pop(key, None)


def preview_id() -> str:
    return f"import_preview_{uuid.uuid4().hex}"


def cleanup_preview_temp(entries: dict[str, dict], preview_id_value: str) -> None:
    with _CACHE_LOCK:
        entry = entries.get(preview_id_value)
    _cleanup_entry_temp(entry)


def _cleanup_entry_temp(entry: dict | None) -> None:
    if not entry:
        return
    tmp_dir = entry.get("_tmp_dir")
    if tmp_dir and Path(tmp_dir).is_dir():
        shutil.rmtree(tmp_dir, ignore_errors=True)


def cleanup_expired_previews(
    entries: dict[str, dict],
    *,
    ttl_seconds: int,
    max_entries: int,
    max_cached_bytes: int,
) -> None:
    removed = []
    with _CACHE_LOCK:
        cutoff = time.time() - ttl_seconds
        expired = [key for key, value in entries.items() if value.get("_ts", 0) < cutoff and not value.get("_in_use")]
        for key in expired:
            removed.append(entries.pop(key))

        total_bytes = sum(int(value.get("_cache_bytes") or 0) for value in entries.values())
        ordered = sorted(((key, value) for key, value in entries.items() if not value.get("_in_use")),
                         key=lambda item: float(item[1].get("_ts") or 0))
        for key, entry in ordered:
            if len(entries) <= max_entries and total_bytes <= max_cached_bytes:
                break
            removed.append(entries.pop(key))
            total_bytes -= int(entry.get("_cache_bytes") or 0)
    for entry in removed:
        _cleanup_entry_temp(entry)


def store_payload(tmp_path: Path, incoming: dict, result: dict, json_dumps: Callable[..., str]) -> Path:
    payload_path = tmp_path / "preview_payload.json"
    payload_path.write_text(
        json_dumps({"incoming": incoming, "result": result}),
        encoding="utf-8",
    )
    return payload_path


def load_payload(entry: dict) -> tuple[dict, dict]:
    if not entry:
        return {}, {}
    payload_path = entry.get("_payload_path")
    if payload_path and Path(payload_path).is_file():
        payload = json.loads(Path(payload_path).read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or not isinstance(payload.get("incoming"), dict) or not isinstance(payload.get("result"), dict):
            raise ValueError("导入预览缓存损坏，请重新选择文件导入")
        return payload.get("incoming") or {}, payload.get("result") or {}
    return entry.get("_incoming") or {}, entry.get("result") or {}
