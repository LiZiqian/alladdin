"""HTTP multipart/form-data parsing helpers."""

from __future__ import annotations

from email.parser import BytesParser
from email.policy import default as email_policy


def parse_multipart(headers, raw: bytes) -> tuple[dict[str, str], list[dict]]:
    content_type = headers.get("Content-Type", "")
    envelope = (
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
        + raw
    )
    message = BytesParser(policy=email_policy).parsebytes(envelope)
    if message.get_content_type() != "multipart/form-data" or not message.get_boundary():
        raise ValueError("请求必须使用带 boundary 的 multipart/form-data")
    if not message.is_multipart() or any(part.defects for part in message.walk()):
        raise ValueError("上传内容不完整或 multipart 格式损坏，请重新上传")
    fields: dict[str, str] = {}
    files: list[dict] = []
    for part in message.iter_parts():
        disposition = part.get("Content-Disposition", "")
        if "form-data" not in disposition:
            continue
        name = part.get_param("name", header="content-disposition") or ""
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        if filename:
            files.append({
                "field": name,
                "filename": filename,
                "mime_type": part.get_content_type() or "application/octet-stream",
                "content": payload,
            })
        else:
            fields[name] = payload.decode("utf-8", errors="replace")
    return fields, files
