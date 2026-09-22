from __future__ import annotations

from pathlib import Path
import re
import time
from typing import Callable
from urllib.parse import urlsplit


STATIC_ASSET_CACHE = "public, max-age=0, must-revalidate"


def discard_rejected_body(handler, *, max_bytes: int = 65536, timeout: float = 0.2) -> None:
    """Drain a small rejected request so closing it does not reset the reply.

    Windows may discard the HTTP error response when a connection closes with
    unread body bytes. Both bytes and total elapsed time are bounded here;
    invalid framing and large uploads are simply closed, never parsed.
    """
    lengths = handler.headers.get_all("Content-Length") or []
    if handler.headers.get("Transfer-Encoding") or len(lengths) != 1:
        return
    length = str(lengths[0]).strip()
    if not re.fullmatch(r"[0-9]{1,8}", length) or int(length) > max_bytes:
        return
    remaining = int(length)
    previous_timeout = handler.connection.gettimeout()
    deadline = time.monotonic() + timeout
    try:
        while remaining:
            budget = deadline - time.monotonic()
            if budget <= 0:
                break
            handler.connection.settimeout(budget)
            chunk = handler.rfile.read1(min(remaining, 8192))
            if not chunk:
                break
            remaining -= len(chunk)
    except (OSError, ValueError):
        pass
    finally:
        handler.connection.settimeout(previous_timeout)


def request_origin_is_allowed(headers) -> bool:
    """Block cross-origin browser writes; headerless local API clients still work.

    The platform serves its UI and API from the same HTTP origin. This is not
    authentication: it prevents an unrelated webpage from submitting a form
    or simple fetch to a platform running on localhost or the intranet.
    """
    def values(name):
        if hasattr(headers, "get_all"):
            return headers.get_all(name) or []
        value = headers.get(name)
        return [] if value is None else [value]

    if any(str(value).strip().lower() == "cross-site" for value in values("Sec-Fetch-Site")):
        return False
    origins = values("Origin")
    if not origins:
        return True
    hosts = values("Host")
    if len(origins) != 1 or len(hosts) != 1:
        return False
    try:
        origin_text = str(origins[0]).strip()
        host_text = str(hosts[0]).strip()
        if not origin_text or not host_text or any(char.isspace() for char in origin_text + host_text):
            return False
        origin = urlsplit(origin_text)
        target = urlsplit("http://" + host_text)
        for parsed in (origin, target):
            if (parsed.scheme != "http" or not parsed.hostname or parsed.username is not None
                    or parsed.password is not None or parsed.path or parsed.query or parsed.fragment):
                return False
        return (origin.hostname.lower(), 80 if origin.port is None else origin.port) == (
            target.hostname.lower(), 80 if target.port is None else target.port)
    except ValueError:
        return False


def send_json(handler, payload: dict, *, status: int = 200, json_dumps: Callable[[object], str]) -> None:
    data = json_dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(data)


def send_bytes(handler, data: bytes, content_type: str, *, status: int = 200, cache: str = "no-store") -> None:
    # Photo MIME metadata may originate in imported archives or older databases.
    # Validate before starting the response: send_header neither escapes CR/LF
    # nor supports arbitrary Unicode, and cannot safely recover after headers.
    content_type = content_type.strip(" \t") if isinstance(content_type, str) else ""
    token = r"[A-Za-z0-9!#$%&'*+.^_`|~-]+"
    if not re.fullmatch(rf"{token}/{token}(?:[ \t]*;[\x20-\x7e\t]*)?", content_type):
        content_type = "application/octet-stream"
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", cache)
    handler.end_headers()
    handler.wfile.write(data)


def send_file(handler, target: Path, content_type: str, *, cache: str = STATIC_ASSET_CACHE) -> None:
    stat = target.stat()
    etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
    if handler.headers.get("If-None-Match") == etag:
        handler.send_response(304)
        handler.send_header("ETag", etag)
        handler.send_header("Cache-Control", cache)
        handler.end_headers()
        return
    data = target.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", cache)
    handler.send_header("ETag", etag)
    handler.end_headers()
    handler.wfile.write(data)


def read_body(handler, max_bytes: int) -> bytes:
    if handler.headers.get("Transfer-Encoding"):
        raise ValueError("不支持分块传输，请提供 Content-Length")
    lengths = (handler.headers.get_all("Content-Length") if hasattr(handler.headers, "get_all")
               else [handler.headers.get("Content-Length", "0")]) or ["0"]
    if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", str(lengths[0]).strip()):
        raise ValueError("Content-Length 必须是非负整数")
    length = int(str(lengths[0]).strip())
    if length > max_bytes:
        raise ValueError(f"上传内容超过限制：{max_bytes // 1024 // 1024}MB")
    body = handler.rfile.read(length)
    if len(body) != length:
        raise ValueError("请求体不完整，请重新上传")
    return body
