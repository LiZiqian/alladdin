"""SQLite schema definition and structural migrations."""

from __future__ import annotations

import sqlite3


STRUCTURAL_SCHEMA_ID = "structural_schema_v1"


def ensure_table_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    existing = {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def ensure_static_schema(conn: sqlite3.Connection) -> None:
    """Create tables, indexes, and structural compatibility columns."""
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
        CREATE TABLE IF NOT EXISTS project_ip_access (
            project_id TEXT NOT NULL,
            ip_address TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('viewer', 'contributor', 'project_admin')),
            enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
            device_label TEXT,
            user_note TEXT,
            created_by_ip TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_seen_at TEXT,
            PRIMARY KEY(project_id, ip_address),
            FOREIGN KEY(project_id) REFERENCES project_records(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_ip_access_ip ON project_ip_access(ip_address, enabled, project_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sample_pool_ip_access (
            category_id TEXT NOT NULL,
            ip_address TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('pool_viewer', 'pool_maintainer', 'pool_admin')),
            enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
            device_label TEXT,
            user_note TEXT,
            created_by_ip TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_seen_at TEXT,
            PRIMARY KEY(category_id, ip_address),
            FOREIGN KEY(category_id) REFERENCES sample_categories(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_pool_ip_access_ip ON sample_pool_ip_access(ip_address, enabled, category_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS security_audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            time TEXT NOT NULL,
            client_ip TEXT NOT NULL,
            action TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            resource_id TEXT,
            allowed INTEGER NOT NULL CHECK(allowed IN (0, 1)),
            actor_role TEXT,
            detail_json TEXT NOT NULL DEFAULT '{}'
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_security_audit_time ON security_audit_log(time, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_security_audit_resource ON security_audit_log(resource_type, resource_id, time)")
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS trg_audit_log_security_write
        AFTER INSERT ON audit_log
        BEGIN
            INSERT INTO security_audit_log
            (time, client_ip, action, resource_type, resource_id, allowed, actor_role, detail_json)
            VALUES (
                NEW.time,
                COALESCE(NEW.client_ip, ''),
                COALESCE(NEW.action, 'business_write'),
                'business_write',
                '',
                1,
                '',
                '{"source":"audit_log","atomic":true}'
            );
        END
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
    ensure_table_column(conn, "sample_records", "has_problem", "INTEGER NOT NULL DEFAULT 0")
    ensure_table_column(conn, "sample_records", "effective_status", "TEXT")
    ensure_table_column(conn, "sample_records", "board_sn", "TEXT")
    ensure_table_column(conn, "sample_records", "is_reassembled", "INTEGER NOT NULL DEFAULT 0")
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
            project_id TEXT,
            stage_id TEXT,
            task_id TEXT,
            deleted_at TEXT
        )
        """
    )
    ensure_table_column(conn, "sample_assets", "project_id", "TEXT")
    ensure_table_column(conn, "sample_assets", "stage_id", "TEXT")
    ensure_table_column(conn, "sample_assets", "task_id", "TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_assets_sample ON sample_assets(sample_id, kind, deleted_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sample_assets_context ON sample_assets(sample_id, project_id, task_id, kind, deleted_at)")
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
    ensure_table_column(conn, "project_tasks", "flow_status", "TEXT")
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
