from __future__ import annotations

from pathlib import Path
from urllib.parse import unquote


ALLOWED_STATIC_PREFIXES = ("/js/", "/css/", "/templates/")
FORBIDDEN_SEGMENT_PREFIXES = ("data", "backend", ".git", ".claude", "docs")
FORBIDDEN_EXTENSIONS = {".sqlite", ".db", ".py", ".bat", ".ps1", ".md", ".json", ".log", ".zip"}


def path_parts(path: str) -> list[str]:
    return path.strip("/").split("/") if path.strip("/") else []


def sample_photo_route(path: str) -> tuple[str, str | None] | None:
    parts = path_parts(path)
    if len(parts) in (4, 5) and parts[0] == "api" and parts[1] == "samples" and parts[3] == "photos":
        sample_id = unquote(parts[2])
        photo_id = unquote(parts[4]) if len(parts) >= 5 else None
        return sample_id, photo_id
    return None


def sample_events_route(path: str) -> str | None:
    parts = path_parts(path)
    if len(parts) == 4 and parts[0] == "api" and parts[1] == "samples" and parts[3] == "events":
        return unquote(parts[2])
    return None


def sample_history_route(path: str) -> str | None:
    parts = path_parts(path)
    if len(parts) == 4 and parts[0] == "api" and parts[1] == "samples" and parts[3] == "history":
        return unquote(parts[2])
    return None


def sample_archive_route(path: str) -> str | None:
    parts = path_parts(path)
    if len(parts) == 4 and parts[0] == "api" and parts[1] == "samples" and parts[3] == "archive":
        return unquote(parts[2])
    return None


def stage_tasks_route(path: str) -> str | None:
    parts = path_parts(path)
    if len(parts) == 4 and parts[0] == "api" and parts[1] == "stages" and parts[3] == "tasks":
        return unquote(parts[2])
    return None


def stage_tasks_batch_route(path: str) -> str | None:
    parts = path_parts(path)
    if len(parts) == 5 and parts[0] == "api" and parts[1] == "stages" and parts[3] == "tasks" and parts[4] == "batch":
        return unquote(parts[2])
    return None


def project_detail_route(path: str) -> str | None:
    parts = path_parts(path)
    if len(parts) == 3 and parts[0] == "api" and parts[1] == "projects" and parts[2] != "summary":
        return unquote(parts[2])
    return None


def project_mutation_route(path: str) -> str | None:
    parts = path_parts(path)
    if len(parts) == 4 and parts[0] == "api" and parts[1] == "projects" and parts[3] == "mutation":
        return unquote(parts[2])
    return None


def stage_mutation_route(path: str) -> str | None:
    parts = path_parts(path)
    if len(parts) == 4 and parts[0] == "api" and parts[1] == "stages" and parts[3] == "mutation":
        return unquote(parts[2])
    return None


def sample_category_samples_route(path: str) -> str | None:
    parts = path_parts(path)
    if len(parts) == 4 and parts[0] == "api" and parts[1] == "sample-categories" and parts[3] == "samples":
        return unquote(parts[2])
    return None


def sample_category_detail_route(path: str) -> str | None:
    parts = path_parts(path)
    if len(parts) == 3 and parts[0] == "api" and parts[1] == "sample-categories":
        return unquote(parts[2])
    return None


def task_mutation_route(path: str) -> str | None:
    parts = path_parts(path)
    if len(parts) == 4 and parts[0] == "api" and parts[1] == "tasks" and parts[3] == "mutation":
        return unquote(parts[2])
    return None


def sample_mutation_route(path: str) -> str | None:
    parts = path_parts(path)
    if len(parts) == 4 and parts[0] == "api" and parts[1] == "samples" and parts[3] == "mutation":
        return unquote(parts[2])
    return None


def sample_category_mutation_route(path: str) -> str | None:
    parts = path_parts(path)
    if len(parts) == 4 and parts[0] == "api" and parts[1] == "sample-categories" and parts[3] == "mutation":
        return unquote(parts[2])
    return None


def is_public_static_path(path: str) -> bool:
    """Allow only frontend runtime assets, never runtime data or code files."""
    if not any(path.startswith(prefix) for prefix in ALLOWED_STATIC_PREFIXES):
        return False
    parts = path.lstrip("/").split("/")
    if any(part.startswith(".") for part in parts):
        return False
    if parts and parts[0] in FORBIDDEN_SEGMENT_PREFIXES:
        return False
    if Path(path).suffix.lower() in FORBIDDEN_EXTENSIONS:
        return False
    return True
