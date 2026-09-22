"""Exercise archive uploads, range playback, isolation and portable file identity."""
import http.client
from backend_fixture import seed_state, export_bytes
import io
import json
import threading
import unittest
import zipfile
from unittest.mock import patch

import test_transfer_integrity as fixture
from server_modules import sample_files, chamber_package

server = fixture.server


class SampleFileTests(unittest.TestCase):
    def setUp(self):
        fixture.ImportCommitTests.setUp(self)
        fixture.ImportCommitTests.save(self, fixture.state_with_samples({"id": "s", "sn": "A"}, {"id": "other", "sn": "B"}))
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=10)
        try:
            conn.request(method, path, body, headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def upload(self, category="ct", files=None, sample_id="s"):
        boundary = "sample-files-test-boundary"
        body = f'--{boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\n{category}\r\n'.encode()
        for name, content in files or [("model.STL", b"solid model\nendsolid model\n")]:
            body += (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{name}"\r\n'
                     'Content-Type: application/octet-stream\r\n\r\n').encode() + content + b"\r\n"
        body += f"--{boundary}--\r\n".encode()
        status, _, raw = self.request("POST", f"/api/samples/{sample_id}/files", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
        return status, json.loads(raw)

    def test_additive_files_are_separate_from_photos_and_survive_sample_edits(self):
        self.assertEqual(self.upload()[0], 200)
        status, result = self.upload("pointcloud", [("scan.ply", b"ply\nformat ascii 1.0\nend_header\n")])
        self.assertEqual(status, 200, result)
        self.assertEqual({item["kind"] for item in result["files"]}, {"ct_model", "point_cloud"})
        self.assertEqual(result["photos"], [])
        before = result["files"]
        data, rev, _ = server.get_state(compact=True)
        data["sampleLibrary"]["categories"][0]["samples"][0]["notes"] = "kept"
        self.assertTrue(seed_state(data, rev, "local")[0])
        _, _, raw = self.request("GET", "/api/samples/s/files")
        self.assertEqual(json.loads(raw)["files"], before)
        file = before[0]
        self.assertEqual(self.request("GET", "/api/samples/other/files/" + file["id"])[0], 404)
        self.assertEqual(self.request("GET", "/api/samples/s/photos/" + file["id"])[0], 404)
        status, headers, content = self.request("GET", file["url"] + "?download=1")
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers["Content-Disposition"])
        self.assertTrue(content)
        self.assertEqual(self.request("DELETE", file["url"])[0], 200)
        self.assertEqual(self.request("GET", file["url"])[0], 404)
        self.assertFalse((server.DATA_DIR / file["relativePath"]).exists())
        self.assertEqual(self.request("DELETE", file["url"])[0], 404)

    def test_video_ranges_and_suffixes(self):
        status, result = self.upload(files=[("slices.mp4", b"0123456789")])
        self.assertEqual(status, 200, result)
        url = result["files"][0]["url"]
        for requested, expected, content_range in [("bytes=2-5", b"2345", "bytes 2-5/10"), ("bytes=-3", b"789", "bytes 7-9/10"), ("bytes=8-", b"89", "bytes 8-9/10")]:
            code, headers, raw = self.request("GET", url, headers={"Range": requested})
            self.assertEqual(code, 206)
            self.assertEqual(raw, expected)
            self.assertEqual(headers["Content-Range"], content_range)
            self.assertEqual(headers["Content-Type"], "video/mp4")
        for invalid in ("bytes=20-", "bytes=6-2", "bytes=-0", "bytes=0-1,4-5"):
            self.assertEqual(self.request("GET", url, headers={"Range": invalid})[0], 416)

    def test_invalid_batch_and_rollback_leave_no_assets(self):
        for category, files in [("ct", [("okay.stl", b"ok"), ("bad.exe", b"bad")]), ("pointcloud", [("wrong.stl", b"no")]), ("ct", [("empty.mp4", b"")])]:
            self.assertEqual(self.upload(category, files)[0], 400)
        with patch.object(server, "commit_sample_asset_mutation", side_effect=ValueError("rollback")):
            self.assertEqual(self.upload()[0], 400)
        self.assertEqual(json.loads(self.request("GET", "/api/samples/s/files")[2])["files"], [])
        self.assertEqual([path for path in server.SAMPLE_DATA_DIR.rglob("*") if path.is_file()], [])

    def test_full_and_sample_archive_roundtrip_keeps_files_and_reimport_is_idempotent(self):
        self.upload(files=[("model.stl", b"STL"), ("slices.webm", b"VIDEO")])
        self.upload("pointcloud", [("scan.ply", b"PLY")])
        original = json.loads(self.request("GET", "/api/samples/s/files")[2])["files"]
        expected = {item["id"]: (server.DATA_DIR / item["relativePath"]).read_bytes() for item in original}
        raw, _ = export_bytes()
        path, _ = server.build_sample_archive_file("s")
        sample_zip = path.read_bytes()
        path.unlink()
        for package in (raw, sample_zip):
            with zipfile.ZipFile(io.BytesIO(package)) as archive:
                index = json.loads(archive.read("assets/index.json"))
                self.assertEqual(len([item for item in index["assets"] if item["kind"] == "sample_file"]), 3)
                for item in index["assets"]:
                    self.assertEqual(archive.read(item["zipPath"]), expected[item["metadataId"]])
        # A fresh database receives the binary content, then the same import adds no duplicate.
        fixture.ImportCommitTests.save(self, fixture.state_with_samples())
        for package in (sample_zip, sample_zip, raw):
            result = fixture.preview(package)
            self.assertIn("previewId", result)
            decisions = server.sample_archive_default_decisions(result) if hasattr(server, "sample_archive_default_decisions") else {
                item["conflictId"]: {"action": "apply_field_choices", "fieldChoices": {}} for item in result.get("conflicts", [])}
            committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": decisions})
            self.assertTrue(committed["ok"], committed)
            files = json.loads(self.request("GET", "/api/samples/s/files")[2])["files"]
            self.assertEqual(len(files), 3)
            for item in files:
                self.assertEqual((server.DATA_DIR / item["relativePath"]).read_bytes(), expected[item["id"]])
                self.assertEqual(item["url"], sample_files.file_url("s", item["id"]))


if __name__ == "__main__":
    unittest.main()
