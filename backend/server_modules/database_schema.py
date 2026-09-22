"""Current SQLite schema. Unsupported historical layouts are rejected without migration."""

from __future__ import annotations

import sqlite3


STRUCTURAL_SCHEMA_ID = "structural_schema_v1"


def ensure_static_schema(conn: sqlite3.Connection) -> None:
    """Create the current schema on a fresh database; validate existing storage first."""
    assert_current_schema(conn)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            data_json TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            time TEXT NOT NULL,
            user TEXT,
            action TEXT,
            remark TEXT,
            revision_before INTEGER,
            revision_after INTEGER,
            client_ip TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sample_categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            data_json TEXT NOT NULL,
            created_at TEXT,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sample_records (
            id TEXT PRIMARY KEY,
            category_id TEXT NOT NULL,
            sample_no TEXT,
            sn TEXT,
            imei TEXT,
            board_sn TEXT,
            is_reassembled INTEGER NOT NULL DEFAULT 0,
            status TEXT,
            has_problem INTEGER NOT NULL DEFAULT 0,
            effective_status TEXT,
            location TEXT,
            owner TEXT,
            borrower TEXT,
            data_json TEXT NOT NULL,
            created_at TEXT,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            FOREIGN KEY(category_id) REFERENCES sample_categories(id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_category ON sample_records(category_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_sn ON sample_records(sn)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_imei ON sample_records(imei)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_board_sn ON sample_records(board_sn)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_identity_active ON sample_records(deleted_at, is_reassembled, sn, imei, board_sn)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_status ON sample_records(status)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_category_active ON sample_records(category_id, deleted_at, status)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_category_created ON sample_records(category_id, deleted_at, created_at, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_category_effective_created ON sample_records(category_id, deleted_at, effective_status, created_at, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_category_problem_created ON sample_records(category_id, deleted_at, has_problem, created_at, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_category_reassembled_created ON sample_records(category_id, deleted_at, is_reassembled, created_at, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_category_owner_created ON sample_records(category_id, deleted_at, owner, created_at, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_category_borrower_created ON sample_records(category_id, deleted_at, borrower, created_at, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_owner ON sample_records(owner)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_records_borrower ON sample_records(borrower)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sample_assets (
            id TEXT PRIMARY KEY,
            sample_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            original_name TEXT,
            file_name TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            mime_type TEXT,
            size INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            created_by TEXT,
            deleted_at TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_assets_sample ON sample_assets(sample_id, kind, deleted_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_assets_path ON sample_assets(relative_path COLLATE NOCASE)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_assets_filename ON sample_assets(file_name COLLATE NOCASE)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sample_events (
            id TEXT PRIMARY KEY,
            sample_id TEXT,
            time TEXT,
            event_type TEXT,
            project_id TEXT,
            stage_id TEXT,
            task_id TEXT,
            test_item TEXT,
            user TEXT,
            data_json TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_events_sample ON sample_events(sample_id, time)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS project_records (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            code TEXT,
            owner TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            data_json TEXT NOT NULL,
            created_at TEXT,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_records_active ON project_records(deleted_at, sort_order)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS project_stages (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            data_json TEXT NOT NULL,
            created_at TEXT,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            FOREIGN KEY(project_id) REFERENCES project_records(id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_stages_project ON project_stages(project_id, deleted_at, sort_order)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS project_tasks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            stage_id TEXT NOT NULL,
            progress_id TEXT,
            category TEXT,
            test_item TEXT,
            sku_index INTEGER,
            status TEXT,
            flow_status TEXT,
            owner TEXT,
            sample_ids_json TEXT NOT NULL DEFAULT '[]',
            data_json TEXT NOT NULL,
            created_at TEXT,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            deleted_at TEXT,
            FOREIGN KEY(project_id) REFERENCES project_records(id),
            FOREIGN KEY(stage_id) REFERENCES project_stages(id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_tasks_stage ON project_tasks(stage_id, deleted_at, status)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_tasks_progress ON project_tasks(progress_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id, deleted_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_tasks_stage_sku ON project_tasks(stage_id, deleted_at, sku_index)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_tasks_stage_owner ON project_tasks(stage_id, deleted_at, owner)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_tasks_stage_updated ON project_tasks(stage_id, deleted_at, updated_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_tasks_stage_created ON project_tasks(stage_id, deleted_at, created_at, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_tasks_stage_flow_created ON project_tasks(stage_id, deleted_at, flow_status, created_at, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_tasks_stage_sku_created ON project_tasks(stage_id, deleted_at, sku_index, created_at, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_tasks_project_created ON project_tasks(project_id, deleted_at, created_at, id)")
    # Match task_queries.task_visibility_sql(): archived history remains stored,
    # while workspace counts/pages avoid parsing every task's JSON on each read.
    document = "CASE WHEN json_valid(data_json) THEN data_json ELSE '{}' END"
    visible_task = f"deleted_at IS NULL AND COALESCE(json_extract({document}, '$.archived'), 0) = 0 AND COALESCE(json_extract({document}, '$.deletedAt'), '') = ''"
    conn.execute(f"CREATE INDEX IF NOT EXISTS idx_project_tasks_visible_project ON project_tasks(project_id) WHERE {visible_task}")
    conn.execute(f"CREATE INDEX IF NOT EXISTS idx_project_tasks_visible_stage_created ON project_tasks(stage_id, deleted_at, created_at, id, flow_status, owner, sku_index) WHERE {visible_task}")
    conn.execute(f"CREATE INDEX IF NOT EXISTS idx_project_tasks_visible_stage_flow ON project_tasks(stage_id, deleted_at, flow_status, created_at, id) WHERE {visible_task}")
    conn.execute(f"CREATE INDEX IF NOT EXISTS idx_project_tasks_visible_stage_owner ON project_tasks(stage_id, deleted_at, owner) WHERE {visible_task}")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS project_task_samples (
            task_id TEXT NOT NULL,
            sample_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            stage_id TEXT NOT NULL,
            test_item TEXT,
            status TEXT,
            flow_status TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(task_id, sample_id),
            FOREIGN KEY(task_id) REFERENCES project_tasks(id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_task_samples_sample ON project_task_samples(sample_id, flow_status, task_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_task_samples_task ON project_task_samples(task_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS task_logs (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            project_id TEXT,
            stage_id TEXT,
            time TEXT,
            action TEXT,
            user TEXT,
            data_json TEXT NOT NULL,
            FOREIGN KEY(task_id) REFERENCES project_tasks(id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, time)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_task_logs_stage ON task_logs(stage_id, time)")
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)",
        (STRUCTURAL_SCHEMA_ID,),
    )


def assert_current_schema(conn: sqlite3.Connection) -> None:
    """启动前只读检查：拒绝旧库，不能通过补列/回填悄悄改写用户数据。

    外置表和查询列是当前存储合同；空数据库由 ensure_static_schema 创建。
    schema_migrations 中的历史记录不再驱动任何升级代码。
    """
    import json
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not tables:
        return
    required = {
        'app_state': {'data_json', 'revision', 'updated_at'},
        'project_records': {'data_json'},
        'project_stages': {'data_json'},
        'project_tasks': {'flow_status', 'data_json'},
        'project_task_samples': {'task_id', 'sample_id'},
        'sample_records': {'has_problem', 'effective_status', 'board_sn', 'is_reassembled'},
        'sample_categories': {'data_json'},
        'sample_assets': {'relative_path'},
        'sample_events': {'data_json'},
    }
    for table, columns in required.items():
        actual = {row[1] for row in conn.execute(f'PRAGMA table_info({table})')}
        if not columns <= actual:
            raise ValueError(f'不支持旧数据库结构：{table} 缺少现行字段；请使用当前格式数据库。')
    row = conn.execute('SELECT data_json FROM app_state WHERE id=1').fetchone()
    if row:
        stored = json.loads(row[0])
        if not stored.get('projectsExternalized') or not (stored.get('sampleLibrary') or {}).get('externalized'):
            raise ValueError('不支持内嵌全量状态的旧数据库；请使用当前外置表格式。')
