from __future__ import annotations

from pathlib import Path
from typing import Callable


STATIC_ASSET_CACHE = "public, max-age=0, must-revalidate"


def send_security_headers(handler) -> None:
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("X-Frame-Options", "DENY")
    handler.send_header("Content-Security-Policy", "frame-ancestors 'none'")


def send_json(handler, payload: dict, *, status: int = 200, json_dumps: Callable[[object], str]) -> None:
    data = json_dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    send_security_headers(handler)
    handler.end_headers()
    handler.wfile.write(data)


def send_bytes(handler, data: bytes, content_type: str, *, status: int = 200, cache: str = "no-store") -> None:
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", cache)
    send_security_headers(handler)
    handler.end_headers()
    handler.wfile.write(data)


def send_file(handler, target: Path, content_type: str, *, cache: str = STATIC_ASSET_CACHE) -> None:
    stat = target.stat()
    etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
    if handler.headers.get("If-None-Match") == etag:
        handler.send_response(304)
        handler.send_header("ETag", etag)
        handler.send_header("Cache-Control", cache)
        send_security_headers(handler)
        handler.end_headers()
        return
    data = target.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", cache)
    handler.send_header("ETag", etag)
    send_security_headers(handler)
    handler.end_headers()
    handler.wfile.write(data)


def read_body(handler, max_bytes: int) -> bytes:
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except (TypeError, ValueError):
        raise ValueError("Content-Length 格式不正确")
    if length < 0:
        raise ValueError("Content-Length 不能为负数")
    if length > max_bytes:
        raise ValueError(f"上传内容超过限制：{max_bytes // 1024 // 1024}MB")
    body = handler.rfile.read(length)
    if len(body) != length:
        raise ValueError("请求体未完整上传")
    return body
