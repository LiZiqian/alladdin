"""Invalid JSON must not enter persisted state or break later browser reads."""

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backend_fixture import empty_state, patched_server_db, server, state_conn
from server_modules import http_api, http_routes


class JsonIntegrityTests(unittest.TestCase):
    def handler(self, path, body):
        replies = []
        handler = SimpleNamespace(
            path=path, client_address=("127.0.0.1", 1),
            _read_body=lambda **_: body,
            _send_json=lambda payload, status=200: replies.append((payload, status)),
        )
        for name in ("sample_photo", "project_mutation", "stage_mutation", "stage_tasks_batch",
                     "task_mutation", "sample_mutation", "sample_category_mutation"):
            setattr(handler, "_" + name + "_route", getattr(http_routes, name + "_route"))
        return handler, replies

    def test_invalid_json_never_reaches_any_write_service(self):
        routes = [
                        ("/api/projects/p/mutation", http_api.handle_patch),
            ("/api/samples/s/photos/photo", http_api.handle_patch),
            ("/api/import-bundle/commit", http_api.handle_post),
            ("/api/samples/archive/commit", http_api.handle_post),
            ("/api/sample-identity-check", http_api.handle_post),
        ]
        invalid = [b'{"value":NaN}', b'{"value":Infinity}', b'{"value":-Infinity}',
                   b'{"value":1e999}', b'{"nested":[{"value":"\\ud800"}]}',
                   b'{"value":1' + b'0' * 400 + b'}',
                   b'{"\\udfff":"value"}', b'{"value":1,"value":2}',
                   b'{"nested":{"value":1,"value":2}}',
                   b'{"value":' + b'[' * 1500 + b'0' + b']' * 1500 + b'}']
        # No mutation functions exist on this context: an accidental dispatch
        # becomes HTTP 500 instead of the required clean HTTP 400 rejection.
        ctx = SimpleNamespace(MAX_UPLOAD_BYTES=10000)
        for path, method in routes:
            for body in invalid:
                with self.subTest(path=path, body=body[:80]):
                    handler, replies = self.handler(path, body)
                    method(handler, ctx)
                    self.assertEqual(replies[0][1], 400)

    def test_nonfinite_value_cannot_poison_saved_state(self):
        conn = state_conn(empty_state())
        self.addCleanup(conn.close)
        conn.commit()
        before = conn.execute("SELECT data_json, revision FROM app_state").fetchone()
        body = ('{"revision":1,"data":' + json.dumps(empty_state())[:-1] + ',"memo":NaN}}').encode()
        handler, replies = self.handler("/api/projects/p/mutation", body)
        with patched_server_db(conn):
            http_api.handle_patch(handler, server.http_runtime_context())
        self.assertEqual(replies[0][1], 400)
        after = conn.execute("SELECT data_json, revision FROM app_state").fetchone()
        self.assertEqual(tuple(after), tuple(before))

    def test_valid_unicode_and_json_types_are_preserved(self):
        expected = {"text": "样机😀", "false": False, "zero": 0, "empty": "",
                    "list": [], "object": {}, "none": None, "number": 1.25e100}
        for ensure_ascii in (False, True):
            body = json.dumps(expected, ensure_ascii=ensure_ascii).encode("utf-8")
            handler, _ = self.handler("/api/projects/p/mutation", body)
            actual = http_api._read_json_object(handler, SimpleNamespace(MAX_UPLOAD_BYTES=10000))
            self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
