"""Standalone in-memory backend fixtures for the tracked regression suites."""

import base64
import copy
import sqlite3
import sys
from contextlib import contextmanager, nullcontext
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import server


def empty_state():
    return {
        "version": "V7",
        "currentProjectId": None,
        "currentStageId": None,
        "users": [],
        "projects": [],
        "sampleLibrary": {"categories": [], "logs": []},
    }


class BorrowedConnection:
    """Let request scopes settle transactions while the test owns the DB lifetime."""

    def __init__(self, conn):
        self.conn = conn

    def __getattr__(self, name):
        return getattr(self.conn, name)

    def __enter__(self):
        self.conn.__enter__()
        return self

    def __exit__(self, *args):
        return self.conn.__exit__(*args)

    def close(self):
        pass


@contextmanager
def patched_server_db(conn):
    borrowed = BorrowedConnection(conn)
    with patch.object(server, "connect_db", return_value=borrowed), patch.object(server, "DB_LOCK", nullcontext()):
        yield


def state_conn(data):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    try:
        server.ensure_schema(conn)
        conn.execute(
            "INSERT INTO app_state (id, data_json, revision, updated_at) VALUES (1, ?, 1, ?)",
            (server.json_dumps(server.split_state_for_storage(data)), server.now_iso()),
        )
        server.sync_project_library(conn, data)
        server.sync_sample_library(conn, data)
        return conn
    except Exception:
        conn.close()
        raise


def seed_state(data, *_unused, **_ignored):
    """测试专用造数：直接写临时库，不属于应用接口，也不做合并或兼容转换。"""
    # Tests must explicitly select their own directory or an in-memory connection.
    with server.write_db_connection() as conn:
        databases = conn.execute('PRAGMA database_list').fetchall()
        for row in databases:
            if row[2] and Path(row[2]).resolve() == (ROOT / 'data/testchamber.sqlite').resolve():
                raise RuntimeError('Test fixture refuses the business database')
        data = copy.deepcopy(data)
        from server_modules import task_reservations
        task_reservations.reconcile_state_reservations(data)
        # Inline bytes are a test-fixture convenience only; production receives
        # multipart uploads and persists indexed metadata.
        for category in (data.get('sampleLibrary') or {}).get('categories') or []:
            for sample in category.get('samples') or []:
                for index, photo in enumerate(sample.get('photos') or []):
                    if photo.get('dataUrl'):
                        content = base64.b64decode(photo['dataUrl'].split(',', 1)[1], validate=True)
                        sample['photos'][index] = server.store_asset_bytes(conn, sample['id'], content,
                            photo.get('name', 'photo.jpg'), 'image/jpeg', photo_id=photo['id'])
        server.sync_project_library(conn, data, allow_empty=True)
        server.sync_sample_library(conn, data, allow_empty=True)
        row = conn.execute('SELECT revision FROM app_state WHERE id=1').fetchone()
        revision = (int(row[0]) if row else 0) + 1
        updated = server.now_iso()
        conn.execute('INSERT OR REPLACE INTO app_state (id,data_json,revision,updated_at) VALUES (1,?,?,?)',
                     (server.json_dumps(server.split_state_for_storage(data)), revision, updated))
        conn.commit()
    return True, {'revision': revision, 'updated_at': updated}


def export_bytes():
    path, filename = server.build_export_bundle_file()
    try:
        return path.read_bytes(), filename
    finally:
        path.unlink(missing_ok=True)
