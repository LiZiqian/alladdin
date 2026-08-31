from __future__ import annotations

import json
import sqlite3

from server_modules import status_normalization


def json_obj(text: str | None, fallback: object | None = None):
    try:
        return json.loads(text or "")
    except Exception:
        return fallback


def first_query_value(query: dict[str, list[str]], name: str, default: str = "") -> str:
    values = query.get(name) or []
    if not values:
        return default
    return str(values[0] if values[0] is not None else default)


def to_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_page_params(query: dict[str, list[str]], *, default_size: int = 100, max_size: int = 500) -> tuple[int, int]:
    page = to_int(first_query_value(query, "page", "1"), 1)
    page_size = to_int(first_query_value(query, "pageSize", str(default_size)), default_size)
    page = max(1, page)
    page_size = min(max(1, page_size), max_size)
    return page, page_size


def paginate_list(items: list[dict], page: int, page_size: int) -> tuple[list[dict], dict]:
    total = len(items)
    total_pages = max(1, (total + page_size - 1) // page_size)
    page = min(max(1, page), total_pages)
    start = (page - 1) * page_size
    end = start + page_size
    return items[start:end], {
        "page": page,
        "pageSize": page_size,
        "total": total,
        "totalPages": total_pages,
    }


def query_value_present(query: dict[str, list[str]], name: str) -> bool:
    return bool(first_query_value(query, name, "").strip())


def load_sample_photo_counts_for(conn: sqlite3.Connection, sample_ids: list[str]) -> dict[str, int]:
    if not sample_ids:
        return {}
    placeholders = ",".join("?" for _ in sample_ids)
    rows = conn.execute(
        f"""
        SELECT sample_id, COUNT(*) AS count
        FROM sample_assets
        WHERE kind = 'photo' AND deleted_at IS NULL AND sample_id IN ({placeholders})
        GROUP BY sample_id
        """,
        sample_ids,
    ).fetchall()
    return {str(row["sample_id"]): int(row["count"] or 0) for row in rows}


def sample_has_problem(sample: dict) -> bool:
    if sample.get("hasProblem") in (True, 1, "1"):
        return True
    for key in ("problemState", "fault", "quality", "effectiveStatus", "effective_status", "status"):
        if status_normalization.normalize_sample_quality_value(sample.get(key)) == "有故障":
            return True
    for record in sample.get("problemRecords") or []:
        if isinstance(record, dict) and str(record.get("description") or "").strip():
            return True
        if isinstance(record, str) and record.strip():
            return True
    return False


def sample_is_reassembled(sample: dict) -> bool:
    raw = sample.get("isReassembled") if isinstance(sample, dict) else False
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return raw == 1
    text = str(raw or "").strip().lower()
    return text in {"是", "yes", "y", "true", "1", "重组", "reassembled"}


def sample_usage_status(sample: dict) -> str:
    return status_normalization.normalize_sample_usage_status(sample.get("status") if isinstance(sample, dict) else "")


def sample_effective_status(sample: dict) -> str:
    return sample_usage_status(sample)


def sample_usage_status_sql_expr(column: str = "status") -> str:
    value = f"TRIM(COALESCE({column}, ''))"
    return f"""
        CASE
            WHEN {value} IN ('测试中', '闲置', '在位等待', '已退库', '取走分析') THEN {value}
            WHEN {value} IN ('已分配') THEN '在位等待'
            WHEN {value} IN ('进入测试任务') THEN '测试中'
            WHEN {value} IN ('借出', '已借出') THEN '取走分析'
            WHEN {value} IN ('已归还', '待维修', '报废', '故障') THEN '闲置'
            ELSE '闲置'
        END
    """


def sample_search_text(sample: dict) -> str:
    chunks = [
        sample.get("sampleNo"),
        sample.get("sn"),
        sample.get("imei"),
        sample.get("boardSn"),
        sample.get("model"),
        sample.get("config"),
        sample.get("tag"),
        sample.get("schemeNo"),
        sample.get("sourceStageName"),
        sample.get("sourceSkuName"),
        sample.get("notes"),
        sample.get("owner"),
        sample.get("borrower"),
        sample.get("location"),
    ]
    for record in sample.get("problemRecords") or []:
        if isinstance(record, dict):
            chunks.extend([record.get("description"), record.get("source"), record.get("taskLabel")])
        else:
            chunks.append(record)
    return " ".join(str(x or "") for x in chunks).lower()


def sample_problem_state(query: dict[str, list[str]]) -> str:
    value = first_query_value(query, "problemState", "").strip().lower()
    if value in ("fault", "problem", "bad", "fail", "故障", "有故障"):
        return "fault"
    if value in ("ok", "pass", "normal", "good", "无故障"):
        return "ok"
    return ""


def sample_reassembly_state(query: dict[str, list[str]]) -> str:
    value = first_query_value(query, "reassembled", "").strip().lower()
    if value in ("reassembled", "true", "yes", "y", "1", "是", "重组"):
        return "reassembled"
    if value in ("normal", "false", "no", "n", "0", "否", "非重组"):
        return "normal"
    return ""


def sample_matches_query(sample: dict, query: dict[str, list[str]], *, history_matched: bool = False) -> bool:
    keyword = first_query_value(query, "keyword", "").strip().lower()
    if keyword and keyword not in sample_search_text(sample) and not history_matched:
        return False
    status = first_query_value(query, "status", "")
    if status and sample_effective_status(sample) != status_normalization.normalize_sample_usage_status(status):
        return False
    problem_state = sample_problem_state(query)
    if problem_state == "fault" and not sample_has_problem(sample):
        return False
    if problem_state == "ok" and sample_has_problem(sample):
        return False
    reassembly_state = sample_reassembly_state(query)
    if reassembly_state == "reassembled" and not sample_is_reassembled(sample):
        return False
    if reassembly_state == "normal" and sample_is_reassembled(sample):
        return False
    owner = first_query_value(query, "owner", "")
    if owner and owner not in str(sample.get("owner") or ""):
        return False
    borrower = first_query_value(query, "borrower", "")
    if borrower and borrower not in str(sample.get("borrower") or ""):
        return False
    return True


def sample_query_requires_python_scan(query: dict[str, list[str]]) -> bool:
    return query_value_present(query, "keyword")


def sample_history_search_cte(keyword: str) -> tuple[str, list[object]]:
    like = f"%{str(keyword or '').strip().lower()}%"
    sql = """
        WITH history_matches(sample_id) AS (
            SELECT DISTINCT e.sample_id
            FROM sample_events e
            WHERE LOWER(e.event_type) LIKE ?
               OR LOWER(e.test_item) LIKE ?
               OR LOWER(e.user) LIKE ?
               OR LOWER(e.data_json) LIKE ?
            UNION
            SELECT DISTINCT pts.sample_id
            FROM project_task_samples pts
            JOIN project_tasks t ON t.id = pts.task_id
            WHERE t.deleted_at IS NULL
              AND (
                    LOWER(pts.test_item) LIKE ?
                 OR LOWER(t.category) LIKE ?
                 OR LOWER(t.test_item) LIKE ?
                 OR LOWER(t.owner) LIKE ?
                 OR EXISTS (
                        SELECT 1
                        FROM json_each(t.data_json, '$.removedSampleRecords') removed
                        WHERE COALESCE(
                                  json_extract(removed.value, '$.sampleId'),
                                  json_extract(removed.value, '$.sid')
                              ) = pts.sample_id
                          AND LOWER(removed.value) LIKE ?
                    )
                 OR EXISTS (
                        SELECT 1
                        FROM json_each(t.data_json, '$.sampleFaultRecords') fault
                        WHERE COALESCE(
                                  json_extract(fault.value, '$.sampleId'),
                                  json_extract(fault.value, '$.sid')
                              ) = pts.sample_id
                          AND LOWER(fault.value) LIKE ?
                    )
                 OR EXISTS (
                        SELECT 1
                        FROM json_each(t.data_json, '$.resultUploads') upload
                        JOIN json_each(upload.value, '$.samples') result_sample
                        WHERE COALESCE(
                                  json_extract(result_sample.value, '$.sampleId'),
                                  json_extract(result_sample.value, '$.sid')
                              ) = pts.sample_id
                          AND LOWER(result_sample.value) LIKE ?
                    )
              )
        )
    """
    return sql, [like] * 11


def sample_sql_filter_parts(category_id: str, query: dict[str, list[str]], *, include_status: bool = True, include_problem: bool = True) -> tuple[list[str], list[object]]:
    where = ["category_id = ?", "deleted_at IS NULL"]
    args: list[object] = [category_id]
    if include_status:
        status = first_query_value(query, "status", "").strip()
        if status:
            where.append(f"{sample_usage_status_sql_expr()} = ?")
            args.append(status_normalization.normalize_sample_usage_status(status))
    if include_problem:
        problem_state = sample_problem_state(query)
        if problem_state == "fault":
            where.append("has_problem = 1")
        elif problem_state == "ok":
            where.append("has_problem = 0")
    owner = first_query_value(query, "owner", "").strip()
    if owner:
        where.append("owner LIKE ?")
        args.append(f"%{owner}%")
    borrower = first_query_value(query, "borrower", "").strip()
    if borrower:
        where.append("borrower LIKE ?")
        args.append(f"%{borrower}%")
    reassembly_state = sample_reassembly_state(query)
    if reassembly_state == "reassembled":
        where.append("COALESCE(is_reassembled, 0) = 1")
    elif reassembly_state == "normal":
        where.append("COALESCE(is_reassembled, 0) = 0")
    return where, args


def sample_from_db_row(row: sqlite3.Row) -> dict:
    sample = status_normalization.normalize_sample_payload(json_obj(row["data_json"], {}) or {})
    keys = set(row.keys())
    sample.update({
        "id": row["id"],
        "categoryId": row["category_id"],
        "sampleNo": row["sample_no"] or sample.get("sampleNo") or "",
        "sn": row["sn"] or sample.get("sn") or "",
        "imei": row["imei"] or sample.get("imei") or "",
        "boardSn": (row["board_sn"] if "board_sn" in keys else None) or sample.get("boardSn") or "",
        "isReassembled": bool(row["is_reassembled"]) if "is_reassembled" in keys and row["is_reassembled"] is not None else sample_is_reassembled(sample),
        "status": status_normalization.normalize_sample_usage_status(row["status"] or sample.get("status") or ""),
        "location": row["location"] or sample.get("location") or "",
        "owner": row["owner"] or sample.get("owner") or "",
        "borrower": row["borrower"] or sample.get("borrower") or "",
        "photos": [],
        "photosLoaded": False,
    })
    if "effective_status" in keys:
        sample["effectiveStatus"] = sample_effective_status(sample)
    if "has_problem" in keys:
        sample["hasProblem"] = bool(row["has_problem"])
    return sample


def list_sample_categories_summary(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT c.id, c.name, c.description, c.data_json, COUNT(r.id) AS sample_count
        FROM sample_categories c
        LEFT JOIN sample_records r ON r.category_id = c.id AND r.deleted_at IS NULL
        WHERE c.deleted_at IS NULL
        GROUP BY c.id
        ORDER BY c.sort_order, c.id
        """
    ).fetchall()
    usage_status_expr = sample_usage_status_sql_expr("status")
    status_rows = conn.execute(
        """
        SELECT category_id, {usage_status_expr} AS effective_status, COUNT(*) AS count
        FROM sample_records
        WHERE deleted_at IS NULL
        GROUP BY category_id, effective_status
        """.format(usage_status_expr=usage_status_expr)
    ).fetchall()
    status_by_category: dict[str, dict[str, int]] = {}
    for row in status_rows:
        status_by_category.setdefault(str(row["category_id"]), {})[str(row["effective_status"] or "闲置")] = int(row["count"] or 0)
    problem_rows = conn.execute(
        """
        SELECT category_id, has_problem, COUNT(*) AS count
        FROM sample_records
        WHERE deleted_at IS NULL
        GROUP BY category_id, has_problem
        """
    ).fetchall()
    problem_by_category: dict[str, dict[str, int]] = {}
    for row in problem_rows:
        key = "fault" if int(row["has_problem"] or 0) else "ok"
        problem_by_category.setdefault(str(row["category_id"]), {})[key] = int(row["count"] or 0)

    result = []
    for row in rows:
        cat = json_obj(row["data_json"], {}) or {}
        result.append({
            "id": row["id"],
            "name": row["name"] or cat.get("name") or "",
            "description": row["description"] or cat.get("description") or "",
            "sampleCount": int(row["sample_count"] or 0),
            "statusCounts": status_by_category.get(str(row["id"]), {}),
            "problemCounts": problem_by_category.get(str(row["id"]), {}),
        })
    return result


def list_samples_page(conn: sqlite3.Connection, category_id: str, query: dict[str, list[str]]) -> dict:
    page, page_size = parse_page_params(query, default_size=100, max_size=500)
    category_row = conn.execute(
        """
        SELECT id, name, description, data_json
        FROM sample_categories
        WHERE id = ? AND deleted_at IS NULL
        """,
        (category_id,),
    ).fetchone()
    if not category_row:
        raise KeyError("样机池不存在")
    total_in_category = int(conn.execute(
        "SELECT COUNT(*) AS count FROM sample_records WHERE category_id = ? AND deleted_at IS NULL",
        (category_id,),
    ).fetchone()["count"] or 0)

    if not sample_query_requires_python_scan(query):
        where, args = sample_sql_filter_parts(category_id, query, include_status=True)
        status_where, status_args = sample_sql_filter_parts(category_id, query, include_status=False)
        problem_where, problem_args = sample_sql_filter_parts(category_id, query, include_problem=False)
        total = int(conn.execute(
            f"SELECT COUNT(*) AS count FROM sample_records WHERE {' AND '.join(where)}",
            args,
        ).fetchone()["count"] or 0)
        total_pages = max(1, (total + page_size - 1) // page_size)
        page = min(max(1, page), total_pages)
        offset = (page - 1) * page_size

        usage_status_expr = sample_usage_status_sql_expr("status")
        status_rows = conn.execute(
            f"""
            SELECT {usage_status_expr} AS effective_status, COUNT(*) AS count
            FROM sample_records
            WHERE {" AND ".join(status_where)}
            GROUP BY effective_status
            """,
            status_args,
        ).fetchall()
        status_counts = {str(row["effective_status"] or "闲置"): int(row["count"] or 0) for row in status_rows}
        problem_rows = conn.execute(
            f"""
            SELECT has_problem, COUNT(*) AS count
            FROM sample_records
            WHERE {" AND ".join(problem_where)}
            GROUP BY has_problem
            """,
            problem_args,
        ).fetchall()
        problem_counts = {
            ("fault" if int(row["has_problem"] or 0) else "ok"): int(row["count"] or 0)
            for row in problem_rows
        }

        rows = conn.execute(
            f"""
            SELECT id, category_id, sample_no, sn, imei, board_sn, is_reassembled, status, has_problem, effective_status, location, owner, borrower, data_json
            FROM sample_records
            WHERE {" AND ".join(where)}
            ORDER BY created_at, id
            LIMIT ? OFFSET ?
            """,
            [*args, page_size, offset],
        ).fetchall()

        page_items = [sample_from_db_row(row) for row in rows]
        photo_counts = load_sample_photo_counts_for(conn, [str(item.get("id")) for item in page_items])
        for item in page_items:
            item["photoCount"] = photo_counts.get(str(item.get("id")), 0)

        cat = json_obj(category_row["data_json"], {}) or {}
        return {
            "page": page,
            "pageSize": page_size,
            "total": total,
            "totalPages": total_pages,
            "category": {
                "id": category_row["id"],
                "name": category_row["name"] or cat.get("name") or "",
                "description": category_row["description"] or cat.get("description") or "",
            },
            "stats": {
                "totalInCategory": total_in_category,
                "filtered": total,
                "statusCounts": status_counts,
                "problemCounts": problem_counts,
            },
            "items": page_items,
        }

    where = ["category_id = ?", "deleted_at IS NULL"]
    args: list[object] = [category_id]
    keyword = first_query_value(query, "keyword", "").strip().lower()
    safe_pool_search = first_query_value(query, "_safePoolSearch", "") == "1"
    history_cte = ""
    history_args: list[object] = []
    if keyword:
        like = f"%{keyword}%"
        if safe_pool_search:
            # A pool role may search only fields already visible in the pool
            # page.  Searching data_json or task/event history would leak
            # other projects through the filtered count even after response
            # redaction.
            history_cte = "WITH history_matches(sample_id) AS (SELECT NULL AS sample_id WHERE 0)"
            history_clause = ""
            searchable_fields = (
                "LOWER(sample_no) LIKE ? OR LOWER(sn) LIKE ? OR LOWER(imei) LIKE ? "
                "OR LOWER(board_sn) LIKE ? OR LOWER(owner) LIKE ? OR LOWER(borrower) LIKE ? "
                "OR LOWER(location) LIKE ?"
            )
            where.append(f"({searchable_fields})")
            args.extend([like] * 7)
        else:
            direct_match = conn.execute(
                """
                SELECT 1
                FROM sample_records
                WHERE category_id = ? AND deleted_at IS NULL
                  AND (
                        LOWER(sample_no) LIKE ? OR LOWER(sn) LIKE ? OR LOWER(imei) LIKE ?
                     OR LOWER(board_sn) LIKE ? OR LOWER(owner) LIKE ? OR LOWER(borrower) LIKE ?
                     OR LOWER(location) LIKE ? OR LOWER(data_json) LIKE ?
                  )
                LIMIT 1
                """,
                [category_id, *([like] * 8)],
            ).fetchone()
            if direct_match:
                history_cte = "WITH history_matches(sample_id) AS (SELECT NULL AS sample_id WHERE 0)"
            else:
                history_cte, history_args = sample_history_search_cte(keyword)
            history_clause = "" if direct_match else " OR history_matches.sample_id IS NOT NULL"
            where.append(
                f"""
                (LOWER(sample_no) LIKE ? OR LOWER(sn) LIKE ? OR LOWER(imei) LIKE ?
                 OR LOWER(board_sn) LIKE ? OR LOWER(owner) LIKE ? OR LOWER(borrower) LIKE ?
                 OR LOWER(location) LIKE ? OR LOWER(data_json) LIKE ?{history_clause})
                """
            )
            args.extend([like] * 8)
    owner = first_query_value(query, "owner", "").strip().lower()
    if owner:
        where.append("LOWER(owner) LIKE ?")
        args.append(f"%{owner}%")
    borrower = first_query_value(query, "borrower", "").strip().lower()
    if borrower:
        where.append("LOWER(borrower) LIKE ?")
        args.append(f"%{borrower}%")
    problem_state = sample_problem_state(query)
    if problem_state == "fault":
        where.append("has_problem = 1")
    elif problem_state == "ok":
        where.append("has_problem = 0")
    reassembly_state = sample_reassembly_state(query)
    if reassembly_state == "reassembled":
        where.append("COALESCE(is_reassembled, 0) = 1")
    elif reassembly_state == "normal":
        where.append("COALESCE(is_reassembled, 0) = 0")

    rows = conn.execute(
        f"""
        {history_cte}
        SELECT sample_records.id, category_id, sample_no, sn, imei, board_sn, is_reassembled,
               status, has_problem, effective_status, location, owner, borrower, data_json,
               CASE WHEN history_matches.sample_id IS NULL THEN 0 ELSE 1 END AS history_match
        FROM sample_records
        LEFT JOIN history_matches ON history_matches.sample_id = sample_records.id
        WHERE {" AND ".join(where)}
        ORDER BY created_at, id
        """,
        [*history_args, *args],
    ).fetchall()

    all_items: list[dict] = []
    status_counts: dict[str, int] = {}
    problem_counts = {"ok": 0, "fault": 0}
    for row in rows:
        sample = sample_from_db_row(row)
        effective = sample_effective_status(sample)
        status_counts[effective] = status_counts.get(effective, 0) + 1
        if sample_has_problem(sample):
            problem_counts["fault"] = problem_counts.get("fault", 0) + 1
        else:
            problem_counts["ok"] = problem_counts.get("ok", 0) + 1
        if not sample_matches_query(sample, query, history_matched=bool(row["history_match"])):
            continue
        sample["effectiveStatus"] = effective
        all_items.append(sample)

    page_items, meta = paginate_list(all_items, page, page_size)
    photo_counts = load_sample_photo_counts_for(conn, [str(item.get("id")) for item in page_items])
    for item in page_items:
        item["photoCount"] = photo_counts.get(str(item.get("id")), 0)

    cat = json_obj(category_row["data_json"], {}) or {}
    return {
        **meta,
        "category": {
            "id": category_row["id"],
            "name": category_row["name"] or cat.get("name") or "",
            "description": category_row["description"] or cat.get("description") or "",
        },
        "stats": {
            "totalInCategory": total_in_category,
            "filtered": len(all_items),
            "statusCounts": status_counts,
            "problemCounts": problem_counts,
        },
        "items": page_items,
    }


def load_sample_category_detail(
    conn: sqlite3.Connection,
    category_id: str,
    *,
    include_photos: bool = False,
    load_sample_photos=None,
) -> dict | None:
    category_row = conn.execute(
        """
        SELECT id, name, description, data_json
        FROM sample_categories
        WHERE id = ? AND deleted_at IS NULL
        """,
        (category_id,),
    ).fetchone()
    if not category_row:
        return None

    category = json_obj(category_row["data_json"], {}) or {}
    category.update({
        "id": category_row["id"],
        "name": category_row["name"] or category.get("name") or "",
        "description": category_row["description"] or category.get("description") or "",
        "samples": [],
    })

    sample_rows = conn.execute(
        """
        SELECT id, category_id, sample_no, sn, imei, board_sn, is_reassembled, status, location, owner, borrower, data_json
        FROM sample_records
        WHERE category_id = ? AND deleted_at IS NULL
        ORDER BY created_at, id
        """,
        (category_id,),
    ).fetchall()
    photo_counts = {} if include_photos else load_sample_photo_counts_for(conn, [str(row["id"]) for row in sample_rows])

    for row in sample_rows:
        sample = json_obj(row["data_json"], {}) or {}
        sample.update({
            "id": row["id"],
            "categoryId": row["category_id"],
            "sampleNo": row["sample_no"] or sample.get("sampleNo") or "",
            "sn": row["sn"] or sample.get("sn") or "",
            "imei": row["imei"] or sample.get("imei") or "",
            "status": row["status"] or sample.get("status") or "",
            "location": row["location"] or sample.get("location") or "",
            "owner": row["owner"] or sample.get("owner") or "",
            "borrower": row["borrower"] or sample.get("borrower") or "",
        })
        if include_photos:
            if load_sample_photos is None:
                raise ValueError("load_sample_photos callback is required when include_photos=True")
            sample["photos"] = load_sample_photos(conn, row["id"])
            sample["photoCount"] = len(sample["photos"])
            sample["photosLoaded"] = True
        else:
            sample["photos"] = []
            sample["photoCount"] = photo_counts.get(str(row["id"]), 0)
            sample["photosLoaded"] = False
        category["samples"].append(sample)

    category["sampleCount"] = len(category["samples"])
    category["samplesLoaded"] = True
    return category
