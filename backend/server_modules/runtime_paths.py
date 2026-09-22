"""Runtime data-root path management for TestChamber V7.

This module intentionally contains no business logic. It owns the physical
boundary between frontend, backend, and runtime data so backend/server.py can stay
focused on HTTP/API orchestration while data-root rules remain testable.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


DATA_ROOT_ENV_VAR = "TESTCHAMBER_DATA_DIR"
DATA_ROOT_MARKER_FILE = "platform-data.json"
DATA_ROOT_SCHEMA = "testchamber-data-root-v1"


@dataclass(frozen=True)
class RuntimePaths:
    data_dir: Path
    sample_data_dir: Path
    import_preview_dir: Path
    export_dir: Path
    db_path: Path
    deployment_file: Path


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def default_data_dir(platform_root: Path) -> Path:
    platform_root = Path(platform_root).resolve()
    return platform_root / "data"


def path_is_inside(child: Path, parent: Path) -> bool:
    child = Path(child).resolve()
    parent = Path(parent).resolve()
    return child == parent or parent in child.parents


def resolve_data_root(platform_root: Path, path_value: str | os.PathLike | None = None) -> Path:
    raw = path_value or os.environ.get(DATA_ROOT_ENV_VAR) or default_data_dir(platform_root)
    return Path(raw).expanduser().resolve()


def build_runtime_paths(data_root: Path) -> RuntimePaths:
    data_root = Path(data_root).expanduser().resolve()
    return RuntimePaths(
        data_dir=data_root,
        sample_data_dir=data_root / "samples",
        import_preview_dir=data_root / "import-previews",
        export_dir=data_root / "exports",
        db_path=data_root / "testchamber.sqlite",
        deployment_file=data_root / "deployment.json",
    )


def validate_project_data_root(data_root: Path, platform_root: Path) -> None:
    data_root = Path(data_root).resolve()
    platform_root = Path(platform_root).resolve()
    if not path_is_inside(data_root, platform_root):
        raise ValueError(
            f"数据目录必须位于项目目录内部: {data_root}。"
            f"请使用项目内路径，例如 {default_data_dir(platform_root)}。"
        )
    for reserved in ("frontend", "backend", ".git", ".claude"):
        reserved_path = platform_root / reserved
        if path_is_inside(data_root, reserved_path):
            raise ValueError(f"数据目录不能位于 {reserved}/ 内部: {data_root}。请使用 {default_data_dir(platform_root)}。")


def ensure_runtime_dirs(paths: RuntimePaths, *, platform_root: Path | None = None) -> None:
    paths.data_dir.mkdir(parents=True, exist_ok=True)
    paths.sample_data_dir.mkdir(parents=True, exist_ok=True)
    paths.import_preview_dir.mkdir(parents=True, exist_ok=True)
    paths.export_dir.mkdir(parents=True, exist_ok=True)
    marker_path = paths.data_dir / DATA_ROOT_MARKER_FILE
    if marker_path.is_file():
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            platform_value = str(Path(platform_root).resolve()) if platform_root else ""
            if marker.get("schema") == DATA_ROOT_SCHEMA and marker.get("dataRoot") == str(paths.data_dir) and marker.get("platformRoot") == platform_value:
                return
        except Exception:
            pass
    marker = {
        "schema": DATA_ROOT_SCHEMA,
        "createdAt": now_iso(),
        "dataRoot": str(paths.data_dir),
        "platformRoot": str(Path(platform_root).resolve()) if platform_root else "",
    }
    marker_path.write_text(json.dumps(marker, ensure_ascii=False, indent=2), encoding="utf-8")


def prepare_runtime_paths(platform_root: Path, data_root: str | os.PathLike | None = None) -> RuntimePaths:
    """只打开显式配置的数据根；启动不会扫描或导入同级历史目录。"""
    paths = build_runtime_paths(resolve_data_root(platform_root, data_root))
    validate_project_data_root(paths.data_dir, platform_root)
    ensure_runtime_dirs(paths, platform_root=platform_root)
    return paths
