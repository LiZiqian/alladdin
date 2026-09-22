from __future__ import annotations

import copy


def iter_samples(data: dict):
    for category in data.get("sampleLibrary", {}).get("categories", []) or []:
        for sample in category.get("samples", []) or []:
            yield category, sample


def find_sample(data: dict, sample_id: str) -> tuple[dict | None, dict | None]:
    for category, sample in iter_samples(data):
        if str(sample.get("id")) == str(sample_id):
            return category, sample
    return None, None


def sample_index_by_id(data: dict) -> dict[str, dict]:
    return {
        str(sample.get("id")): sample
        for _, sample in iter_samples(data)
        if sample.get("id")
    }


def split_state_for_storage(data: dict, app_version: str) -> dict:
    stored = copy.deepcopy(data)
    stored["version"] = app_version
    stored["projects"] = []
    stored["projectsExternalized"] = {
        "schema": "project_tables_v1",
        "note": "Projects, stages, tasks and task logs are stored in normalized SQLite tables.",
    }
    stored["sampleLibrary"] = {
        "externalized": True,
        "schema": "sample_tables_v1",
        "note": "样机库数据已外置到 sample_categories / sample_records / sample_assets 表。",
    }
    return stored
