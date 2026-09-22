"""Persisted photo MIME metadata must remain a single safe response header."""
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from server_modules import http_handler, http_helpers


class HttpContentTypeIntegrityTests(unittest.TestCase):
    def make_handler(self, context=None):
        cls = http_handler.create_handler(server_version="qa", now_iso=lambda: "qa",
                                         json_dumps=json.dumps, runtime_context=lambda: context,
                                         max_upload_bytes=4096)
        handler = cls.__new__(cls)
        handler.path = "/api/samples/s/photos/photo"
        handler.request_version = "HTTP/1.1"
        handler.requestline = "GET " + handler.path + " HTTP/1.1"
        handler.command = "GET"
        handler.wfile = io.BytesIO()
        handler.log_message = lambda *_: None
        return handler

    def assert_binary_response(self, handler, mime):
        headers, body = handler.wfile.getvalue().split(b"\r\n\r\n", 1)
        self.assertEqual(body, b"photo-bytes")
        self.assertEqual(headers.count(b"HTTP/"), 1)
        self.assertIn(b" 200 ", headers)
        self.assertIn(b"\r\nContent-Type: " + mime.encode("ascii") + b"\r\n", headers)
        self.assertNotIn(b"X-Injected", headers)

    def test_controls_and_nonascii_mime_cannot_split_headers_or_fail_encoding(self):
        for mime in ("image/png\r\nX-Injected: true", "image/png\nX-Injected: true",
                     "image/图片", "image/png\x00", "image/png\x7f", "image/png\x85"):
            with self.subTest(mime=mime):
                handler = self.make_handler()
                http_helpers.send_bytes(handler, b"photo-bytes", mime)
                self.assert_binary_response(handler, "application/octet-stream")

    def test_normal_types_and_parameters_keep_their_existing_response(self):
        for mime in ("image/png", "image/svg+xml", "application/vnd.test+json", "text/html; charset=utf-8"):
            with self.subTest(mime=mime):
                handler = self.make_handler()
                http_helpers.send_bytes(handler, b"photo-bytes", mime)
                self.assert_binary_response(handler, mime)

    def test_photo_get_normalizes_legacy_database_mime_metadata(self):
        with tempfile.TemporaryDirectory(prefix="tc-mime-") as temp:
            root = Path(temp)
            database = root / "test.sqlite"
            (root / "photo.png").write_bytes(b"photo-bytes")
            with closing(sqlite3.connect(database)) as conn:
                conn.execute("CREATE TABLE sample_assets (id, sample_id, kind, relative_path, mime_type, deleted_at)")
                conn.execute("INSERT INTO sample_assets VALUES ('photo', 's', 'photo', 'photo.png', ?, NULL)",
                             ("image/png\r\nX-Injected: true",))
                conn.commit()
            def connect():
                conn = sqlite3.connect(database)
                conn.row_factory = sqlite3.Row
                return conn
            context = SimpleNamespace(connect_db=connect, begin_read_snapshot=lambda conn: conn.execute("BEGIN"),
                                      path_inside_data=lambda path: root / path)
            for mime in ("image/png\r\nX-Injected: true", "image/图片"):
                with self.subTest(mime=mime):
                    with closing(connect()) as conn:
                        conn.execute("UPDATE sample_assets SET mime_type = ?", (mime,))
                        conn.commit()
                    handler = self.make_handler(context)
                    handler.do_GET()
                    self.assert_binary_response(handler, "application/octet-stream")


if __name__ == "__main__":
    unittest.main()
