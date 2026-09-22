"""Retired protocols fail explicitly; current storage and business writes remain intact."""
import copy
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

from backend_fixture import empty_state, patched_server_db, server, state_conn
from server_modules import chamber_package, database_schema, runtime_paths, status_normalization
import test_transfer_integrity as fixture


class CurrentContractTests(unittest.TestCase):
    setUp = fixture.ImportCommitTests.setUp

    def test_retired_http_state_routes_are_absent(self):
        before = server.get_state()
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        try:
            for method, path, expected in [('GET', '/api/state', 404), ('PUT', '/api/state', 501),
                                           ('GET', '/api/bootstrap', 200), ('GET', '/api/health', 200)]:
                with self.subTest(method=method, path=path):
                    client = http.client.HTTPConnection(*httpd.server_address, timeout=5)
                    try:
                        client.request(method, path)
                        response = client.getresponse()
                        response.read()
                        self.assertEqual(response.status, expected)
                    finally:
                        client.close()
        finally:
            httpd.shutdown()
            worker.join(timeout=5)
            httpd.server_close()
        self.assertEqual(server.get_state(), before)
        for name in ('save_state', 'merge_state', 'commit_data_mutation', 'build_export_bundle',
                     'materialize_data_url_photo', 'validate_external_data_root'):
            self.assertFalse(hasattr(server, name), name)

    def test_v1_manifest_is_rejected_even_without_old_payload(self):
        with self.assertRaisesRegex(ValueError, '不受支持'):
            chamber_package.validate_manifest({'format': 'testchamber-export-bundle-v1'})

    def test_old_layout_is_rejected_before_any_schema_change(self):
        conn = sqlite3.connect(':memory:')
        try:
            conn.execute('CREATE TABLE app_state (id INTEGER, data_json TEXT)')
            conn.execute('INSERT INTO app_state VALUES (1, ?)', (json.dumps(empty_state()),))
            before = list(conn.iterdump())
            with self.assertRaisesRegex(ValueError, '不支持旧数据库'):
                database_schema.ensure_static_schema(conn)
            self.assertEqual(list(conn.iterdump()), before)
        finally:
            conn.close()

    def test_embedded_state_is_rejected_without_externalizing_it(self):
        conn = state_conn(empty_state())
        try:
            conn.execute('UPDATE app_state SET data_json=?', (json.dumps(empty_state()),))
            before = list(conn.iterdump())
            with self.assertRaisesRegex(ValueError, '内嵌'):
                database_schema.ensure_static_schema(conn)
            self.assertEqual(list(conn.iterdump()), before)
        finally:
            conn.close()

    def test_startup_ignores_sibling_legacy_data(self):
        with tempfile.TemporaryDirectory() as directory:
            platform = Path(directory) / 'Platform'
            platform.mkdir()
            sibling = Path(directory) / 'Platform_data'
            sibling.mkdir()
            old = sibling / 'testchamber.sqlite'
            old.write_bytes(b'old database must stay untouched')
            paths = runtime_paths.prepare_runtime_paths(platform)
            self.assertFalse(paths.db_path.exists())
            self.assertEqual(old.read_bytes(), b'old database must stay untouched')

    def test_legacy_statuses_and_inline_photos_fail_without_writes(self):
        before = server.get_state()
        for normalize, value in [(status_normalization.normalize_task_flow_status, 'Testing'),
                                 (status_normalization.normalize_task_result_value, 'PASS'),
                                 (status_normalization.normalize_sample_usage_status, '借出')]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize(value)
        with server.write_db_connection() as conn:
            with self.assertRaisesRegex(ValueError, '不支持内嵌照片'):
                server.normalize_sample_photos(conn, {'id': 's', 'photos': [{'dataUrl': 'data:image/png;base64,AA=='}]})
        self.assertEqual(server.get_state(), before)

    def test_canonical_normalization_preserves_free_text(self):
        source = {'status': '闲置', 'notes': '失败后借出；Pass / FAIL / OK',
                  'problemRecords': [{'id': 'problem', 'description': '待执行检查失败', 'taskLabel': '旧名不改字'}]}
        self.assertEqual(status_normalization.normalize_sample_payload(source), source)


if __name__ == '__main__':
    unittest.main()
