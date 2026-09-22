from __future__ import annotations

from types import SimpleNamespace
from typing import Mapping


HTTP_RUNTIME_FIELDS = (
    "APP_VERSION",
    "DATA_DIR",
    "ROOT_DIR",
    "FRONTEND_DIR",
    "INDEX_PATH",
    "MAX_UPLOAD_BYTES",
    "load_deployment_id",
    "now_iso",
    "build_export_bundle_file",
    "build_sample_archive_file",
    "first_query_value",
    "connect_db",
    "begin_read_snapshot",
    "compose_bootstrap_state",
    "list_project_summary",
    "load_project_detail",
    "list_sample_categories_summary",
    "list_task_sample_candidates_page",
    "list_sample_destroy_impact_scope",
    "load_sample_category_detail",
    "list_stage_tasks_page",
    "list_samples_page",
    "load_sample_photos",
    "path_inside_data",
    "load_sample_events",
    "list_sample_history_page",
    "analyze_import_bundle",
    "commit_import_bundle",
    "analyze_sample_archive",
    "commit_sample_archive",
    "check_sample_identity_conflicts",
    "parse_multipart",
    "write_sample_asset_file",
    "thumbnail_asset_id",
    "attach_thumbnail_meta",
    "write_db_connection",
    "upsert_sample_asset_meta",
    "commit_sample_asset_mutation",
    "unlink_asset_relative_paths",
    "json_obj",
    "json_dumps",
    "commit_project_mutation",
    "commit_stage_mutation",
    "commit_task_batch_mutation",
    "commit_task_mutation",
    "commit_sample_mutation",
    "commit_sample_category_mutation",
)


def build_context(namespace: Mapping[str, object]) -> SimpleNamespace:
    missing = [name for name in HTTP_RUNTIME_FIELDS if name not in namespace]
    if missing:
        raise KeyError(f"HTTP runtime context missing fields: {', '.join(missing)}")
    return SimpleNamespace(**{name: namespace[name] for name in HTTP_RUNTIME_FIELDS})
