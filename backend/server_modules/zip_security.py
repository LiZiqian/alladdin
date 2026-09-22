"""Safe ZIP extraction for import packages."""

from __future__ import annotations

import re
import zipfile
from pathlib import Path


MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_TOTAL_BYTES = 500 * 1024 * 1024
ALLOWED_PREFIXES = (
    "manifest.json",
    "checksums.json",
    "dossier.json",
    "sample/",
    "domains/",
    "assets/index.json",
    "assets/samples/",
)
DANGEROUS_RE = re.compile(
    r"(^|[/\\])\.\.[/\\]"
    r"|^[/\\]"
    r"|^[A-Za-z]:[/\\]"
)
RESERVED_NAME_RE = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.IGNORECASE)


def safe_relative_member_name(name: object, *, directory: bool = False) -> str | None:
    """Use one portable name for extraction, checksum and asset lookup.

    Windows aliases (case, trailing dots and alternate data streams) must not
    let two archive members write the same file or a device outside the package.
    """
    if not isinstance(name, str) or not name or "\\" in name:
        return None
    normalized = name[:-1] if directory and name.endswith("/") else name
    parts = normalized.split("/")
    for part in parts:
        if (not part or part in (".", "..") or part[-1:] in (".", " ")
                or any(ord(char) < 32 or char in '<>:"|?*' for char in part)
                or RESERVED_NAME_RE.match(part)):
            return None
    return normalized


def safe_extract_zip(zf: zipfile.ZipFile, dest_dir: str | Path) -> None:
    dest = Path(dest_dir).resolve()
    total_bytes = 0
    members = []
    seen_paths = set()
    file_paths = set()

    for entry in zf.infolist():
        name = entry.filename
        normalized = safe_relative_member_name(name, directory=entry.is_dir())

        if normalized is None:
            raise ValueError(f"ZIP 包含不安全路径: {name}")

        mode = (entry.external_attr >> 16) & 0o170000
        if mode == 0o120000:
            raise ValueError(f"ZIP 包含符号链接，拒绝: {name}")

        allowed = any(normalized == prefix or (prefix.endswith("/") and normalized.startswith(prefix))
                      for prefix in ALLOWED_PREFIXES)
        if entry.is_dir():
            allowed = allowed or any(prefix.startswith(normalized + "/") for prefix in ALLOWED_PREFIXES)
        if not allowed:
            raise ValueError(f"ZIP 包含不允许的文件: {name}")

        key = normalized.casefold()
        if key in seen_paths:
            raise ValueError(f"ZIP 包含重复路径: {name}")
        seen_paths.add(key)
        if not entry.is_dir():
            file_paths.add(key)

        target = (dest / normalized).resolve()
        try:
            target.relative_to(dest)
        except ValueError:
            raise ValueError(f"ZIP 路径越界: {name}")

        file_size = entry.file_size
        if file_size > MAX_FILE_BYTES:
            raise ValueError(f"ZIP 文件过大 ({file_size} bytes): {name}")
        total_bytes += file_size
        if total_bytes > MAX_TOTAL_BYTES:
            raise ValueError(f"ZIP 总解压大小超过 {MAX_TOTAL_BYTES} bytes")
        members.append((entry, target, key))

    for entry, target, key in members:
        if any("/".join(key.split("/")[:index]) in file_paths for index in range(1, len(key.split("/")))):
            raise ValueError(f"ZIP 文件与目录路径冲突: {entry.filename}")

        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(entry) as src, open(target, "wb") as dst:
                while True:
                    chunk = src.read(8192)
                    if not chunk:
                        break
                    dst.write(chunk)
