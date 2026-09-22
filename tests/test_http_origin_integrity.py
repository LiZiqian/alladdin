"""Browser requests from another site must not mutate the local platform."""

import http.client
import json
import io
import socket
import sys
import threading
import time
import unittest
from email.message import Message
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from server_modules import http_handler, http_helpers


class OriginHeaderTests(unittest.TestCase):
    def test_rejected_body_drain_is_bounded_and_ignores_ambiguous_lengths(self):
        for values in (("9999999999999999999999",), ("65537",), ("2", "2"), ("-1",)):
            headers = Message()
            for value in values:
                headers["Content-Length"] = value
            source = io.BytesIO(b"{}")
            http_helpers.discard_rejected_body(SimpleNamespace(headers=headers, rfile=source))
            self.assertEqual(source.tell(), 0)

    def test_origin_matching_normalizes_host_case_and_default_port(self):
        for host, origin in (("LOCALHOST:9398", "http://localhost:9398"),
                             ("test.local", "http://test.local:80"),
                             ("test.local:80", "http://test.local"),
                             ("[::1]:9398", "http://[::1]:9398")):
            with self.subTest(host=host, origin=origin):
                self.assertTrue(http_helpers.request_origin_is_allowed({"Host": host, "Origin": origin}))

    def test_ambiguous_host_or_origin_is_rejected(self):
        for duplicate in ("Host", "Origin"):
            headers = Message()
            headers["Host"] = "localhost:9398"
            headers["Origin"] = "http://localhost:9398"
            headers[duplicate] = headers[duplicate]
            self.assertFalse(http_helpers.request_origin_is_allowed(headers))
        for origin in ("", "http://user@localhost:9398", "http://localhost:invalid",
                       "http://localhost:9398#fragment", "http://localhost:9398?query"):
            self.assertFalse(http_helpers.request_origin_is_allowed({"Host": "localhost:9398", "Origin": origin}))
        self.assertFalse(http_helpers.request_origin_is_allowed({"Host": "localhost:80", "Origin": "http://localhost:0"}))


class HttpOriginIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.writes = []
        def commit(payload, client_ip):
            self.writes.append(payload)
            return True, {"revision": 2}
        ctx = SimpleNamespace(MAX_UPLOAD_BYTES=4096, commit_project_mutation=commit)
        handler = http_handler.create_handler(
            server_version="test", now_iso=lambda: "test", json_dumps=json.dumps,
            runtime_context=lambda: ctx, max_upload_bytes=4096,
        )
        handler.log_message = lambda *_: None
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = "http://127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, headers, method="PATCH"):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            conn.request(method, "/api/projects/p/mutation", "{}", headers)
            response = conn.getresponse()
            body = json.loads(response.read())
            return response.status, body
        finally:
            conn.close()

    def test_foreign_null_or_malformed_origin_is_rejected_before_write(self):
        for origin in ("https://unrelated.example", "null", self.origin + "/path",
                       self.origin + "@unrelated.example", self.origin + ", " + self.origin,
                       "http://127.0.0.1:1", "https" + self.origin[4:]):
            with self.subTest(origin=origin):
                status, _ = self.request({"Origin": origin, "Content-Type": "text/plain"})
                self.assertEqual(status, 403)
        self.assertEqual(self.writes, [])

    def test_same_origin_and_nonbrowser_requests_remain_supported(self):
        for headers in ({"Origin": self.origin, "Content-Type": "application/json"},
                        {"Content-Type": "application/json"}):
            self.assertEqual(self.request(headers)[0], 200)
        self.assertEqual(len(self.writes), 2)

    def test_cross_site_fetch_metadata_blocks_all_mutating_methods(self):
        for method in ("POST", "PATCH", "DELETE"):
            with self.subTest(method=method):
                status, _ = self.request({"Sec-Fetch-Site": "cross-site"}, method)
                self.assertEqual(status, 403)
        self.assertEqual(self.writes, [])

    def test_rejected_truncated_body_cannot_delay_response_indefinitely(self):
        with socket.create_connection(self.server.server_address, timeout=2) as conn:
            started = time.monotonic()
            conn.sendall(b"PATCH /api/projects/p/mutation HTTP/1.1\r\nHost: localhost\r\nOrigin: null\r\nContent-Length: 20\r\n\r\n{")
            response = conn.recv(4096)
            self.assertIn(b"403", response)
            self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual(self.writes, [])


if __name__ == "__main__":
    unittest.main()
