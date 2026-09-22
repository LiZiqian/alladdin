"""Import/export regressions using isolated data roots only."""
import copy
import hashlib
import io
import json
import sys
import tempfile
import threading
import unittest
import warnings
import zipfile
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr
from pathlib import Path
from backend_fixture import export_bytes
from backend_fixture import seed_state
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import server
from server_modules import bundle_preview_service, chamber_package, import_commit, import_diff, migration_scope, zip_security


def state_with_samples(*samples):
    return {"projects": [], "sampleLibrary": {"categories": [{"id": "pool", "name": "pool", "samples": list(samples)}], "logs": []}}


def make_zip(state, manifest=None, files=None):
    # Fixtures follow the same V2 domain/index/checksum contract as production.
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        for name, data in (files or {}).items():
            relative = name.removeprefix("assets/")
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        package = chamber_package.build_export_package(state, data_dir=root, app_version="7.3.0",
            server_version="7.3.0", exported_at="2026-09-22", export_id="fixture", deployment_id="fixture", revision=1)
        if manifest is not None:
            package["manifest"] = manifest
        payloads = chamber_package.package_payloads(package)
        checksums = {name: hashlib.sha256(value.encode()).hexdigest() for name, value in payloads.items()}
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as archive:
            for name, value in payloads.items(): archive.writestr(name, value)
            archive.writestr("checksums.json", json.dumps(checksums))
            for asset in package["assetIndex"]["assets"]:
                if asset["exists"]:
                    archive.write(root / asset["sourceRelativePath"], asset["zipPath"])
        return out.getvalue()


def preview(raw):
    boundary = "test-transfer-boundary"
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="archive.zip"\r\n'
            'Content-Type: application/zip\r\n\r\n').encode() + raw + f"\r\n--{boundary}--\r\n".encode()
    return server.analyze_import_bundle({"Content-Type": f"multipart/form-data; boundary={boundary}"}, body)


class PackageValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="tc-transfer-package-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.package = chamber_package.build_export_package(state_with_samples({"id": "s1", "sn": "A"}),
            data_dir=self.root, app_version="7", server_version="7", exported_at="2026-09-20", export_id="e",
            deployment_id="d", revision=1)

    def validate(self, package):
        chamber_package.validate_domain_documents(package["manifest"], package["domains"], package["assetIndex"])

    def test_valid_package_and_roundtrip(self):
        self.validate(self.package)
        state = chamber_package.state_from_domain_documents(self.package["manifest"], self.package["domains"])
        chamber_package.validate_state_structure(state)
        self.assertEqual(state["sampleLibrary"]["categories"][0]["samples"][0]["id"], "s1")

    def test_unknown_protocol_and_schema_are_rejected(self):
        for key, value in (("format", "future-format"), ("schemaVersion", 3), ("schemaVersion", True),
                           ("packageKind", "unknown"), ("scope", "unknown"), ("domainPaths", {})):
            with self.subTest(key=key, value=value):
                package = copy.deepcopy(self.package)
                package["manifest"][key] = value
                with self.assertRaises(ValueError): self.validate(package)

    def test_duplicate_ids_or_orphan_rows_are_rejected_before_rehydration(self):
        package = copy.deepcopy(self.package)
        package["domains"]["samples"].append({"id": "s1", "categoryId": "pool"})
        package["manifest"].pop("counts")
        with self.assertRaisesRegex(ValueError, "重复"): self.validate(package)
        package["domains"]["samples"] = [{"id": "orphan", "categoryId": "missing"}]
        with self.assertRaisesRegex(ValueError, "不存在"): self.validate(package)

    def test_hidden_nested_rows_are_rejected(self):
        package = copy.deepcopy(self.package)
        package["domains"]["sampleCategories"][0]["samples"] = [{"id": "hidden"}]
        with self.assertRaisesRegex(ValueError, "嵌套"): self.validate(package)

    def test_unsafe_or_duplicate_legacy_ids_are_rejected(self):
        for sid in ("../outside", "a/b", "a\\b", "a:stream", "NUL", "s.", " s"):
            with self.subTest(sid=sid), self.assertRaises(ValueError):
                chamber_package.validate_state_structure(state_with_samples({"id": sid}))
        with self.assertRaisesRegex(ValueError, "重复"):
            chamber_package.validate_state_structure(state_with_samples({"id": "s"}, {"id": "s"}))

    def test_duplicate_zip_paths_cannot_overwrite_payloads(self):
        for paths in (("state.json", "state.json"), ("domains/a.json", "domains/A.json"),
                      ("domains/a", "domains/a/file.json")):
            out = io.BytesIO()
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(out, "w") as archive:
                    for name in paths: archive.writestr(name, "{}")
            with zipfile.ZipFile(io.BytesIO(out.getvalue())) as archive, self.assertRaises(ValueError):
                zip_security.safe_extract_zip(archive, self.root / "extract")

    def test_zip_requires_exact_payload_names_and_portable_paths(self):
        for path in ("manifest.json.exe", "state.json/child", "domains/a:stream", "domains/NUL", "domains/a.", "domains/../state.json"):
            out = io.BytesIO()
            with zipfile.ZipFile(out, "w") as archive: archive.writestr(path, "{}")
            with zipfile.ZipFile(io.BytesIO(out.getvalue())) as archive, self.assertRaises(ValueError):
                zip_security.safe_extract_zip(archive, self.root / "extract")

    def test_explicit_empty_selection_never_exports_full_state(self):
        state = state_with_samples({"id": "s"})
        self.assertEqual(migration_scope.filter_state_by_selection(state, None), state)
        with self.assertRaises(ValueError): migration_scope.filter_state_by_selection(state, {"sampleIds": []})


class ImportCommitTests(unittest.TestCase):
    def setUp(self):
        test_root = ROOT / "batch_import_test_data"
        test_root.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix="tc-transfer-commit-", dir=test_root)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(server._apply_runtime_paths, server._RUNTIME_PATHS)
        self.addCleanup(server._IMPORT_PREVIEWS.clear)
        server.prepare_runtime_data_root(Path(self.tmp.name))
        server.init_db()

    def save(self, state):
        _, rev, _ = server.get_state()
        ok, result = seed_state(state, rev, "127.0.0.1")
        self.assertTrue(ok, result)

    def test_selection_keeps_decision_attached_to_original_sample(self):
        self.save(state_with_samples({"id": "s1", "sn": "A", "owner": "old1"}, {"id": "s2", "sn": "B", "owner": "old2"}))
        incoming = server.get_state()[0]
        samples = incoming["sampleLibrary"]["categories"][0]["samples"]
        samples[0]["owner"], samples[1]["owner"] = "new1", "new2"
        result = preview(make_zip(incoming))
        conflicts = {item["incomingId"]: item for item in result["conflicts"]}
        decisions = {conflicts["s1"]["conflictId"]: {"action": "skip"},
                     conflicts["s2"]["conflictId"]: {"action": "apply_field_choices", "fieldChoices": {"owner": "incoming"}}}
        result = server.commit_import_bundle({"previewId": result["previewId"], "decisions": decisions, "selection": {"sampleIds": ["s2"]}})
        self.assertTrue(result["ok"], result)
        saved = {sample["id"]: sample for sample in server.get_state()[0]["sampleLibrary"]["categories"][0]["samples"]}
        self.assertEqual((saved["s1"]["owner"], saved["s2"]["owner"]), ("old1", "new2"))

    def test_explicit_empty_import_selection_is_rejected_without_changes(self):
        result = preview(make_zip(state_with_samples({"id": "s1", "sn": "A"})))
        before = server.get_state()
        committed = server.commit_import_bundle({"previewId": result["previewId"], "selection": {"sampleIds": []}})
        self.assertFalse(committed["ok"])
        self.assertEqual(server.get_state(), before)

    def test_malformed_decision_is_a_validation_error(self):
        self.save(state_with_samples({"id": "s1", "sn": "A", "owner": "old"}))
        result = preview(make_zip(state_with_samples({"id": "s1", "sn": "A", "owner": "new"})))
        cid = result["conflicts"][0]["conflictId"]
        before = server.get_state()
        for decision in ([], {"action": "not-real"}, {"action": "apply_field_choices", "fieldChoices": []}):
            committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": {cid: decision}})
            self.assertEqual(committed["status"], 400, committed)
            self.assertEqual(server.get_state(), before)

    def test_identity_preview_matches_across_fields_and_case(self):
        self.save(state_with_samples({"id": "existing", "sn": "Serial-A"}))
        result = preview(make_zip(state_with_samples({"id": "incoming", "imei": " serial-a "})))
        conflict = next(item for item in result["conflicts"] if item["type"] == "sample_identity_conflict")
        self.assertEqual(conflict["currentId"], "existing")

    def test_many_incoming_samples_can_merge_photos_into_one_target(self):
        self.save(state_with_samples({"id": "existing", "sn": "A", "photos": []}))
        incoming = state_with_samples(*[
            {"id": sid, "sn": "A", "photos": [{"id": pid, "name": "same.jpg", "type": "image/jpeg", "size": 3,
               "relativePath": f"samples/{sid}/photos/same.jpg", "url": f"/api/samples/{sid}/photos/{pid}"}]}
            for sid, pid in (("one", "p1"), ("two", "p2"))
        ])
        result = preview(make_zip(incoming, files={"assets/samples/one/photos/same.jpg": b"ONE",
                                                   "assets/samples/two/photos/same.jpg": b"TWO"}))
        decisions = {item["conflictId"]: {"action": "merge_into_existing"} for item in result["conflicts"]}
        committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": decisions})
        self.assertTrue(committed["ok"], committed)
        photos = server.get_state()[0]["sampleLibrary"]["categories"][0]["samples"][0]["photos"]
        self.assertEqual({photo["id"] for photo in photos}, {"p1", "p2"})
        self.assertEqual({photo["id"]: (server.DATA_DIR / photo["relativePath"]).read_bytes() for photo in photos},
                         {"p1": b"ONE", "p2": b"TWO"})
        self.assertEqual(committed["stats"]["photosAdded"], 2)

    def test_existing_photo_id_and_content_survive_reimport(self):
        source = server.SAMPLE_DATA_DIR / "existing" / "photos" / "same.jpg"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(b"KEEP")
        self.save(state_with_samples({"id": "existing", "sn": "A", "photos": [{"id": "p1", "name": "same.jpg",
                  "relativePath": "samples/existing/photos/same.jpg", "size": 4, "type": "image/jpeg"}]}))
        incoming = state_with_samples({"id": "incoming", "sn": "A", "photos": [{"id": "p1", "name": "different.jpg",
                  "relativePath": "samples/incoming/photos/different.jpg", "size": 7, "type": "image/jpeg"}]})
        result = preview(make_zip(incoming, files={"assets/samples/incoming/photos/different.jpg": b"REPLACE"}))
        decisions = {item["conflictId"]: {"action": "merge_into_existing"} for item in result["conflicts"]}
        committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": decisions})
        self.assertTrue(committed["ok"], committed)
        photo = server.get_state()[0]["sampleLibrary"]["categories"][0]["samples"][0]["photos"][0]
        self.assertEqual((server.DATA_DIR / photo["relativePath"]).read_bytes(), b"KEEP")
        self.assertEqual(committed["stats"]["photosAdded"], 0)

    def test_rejected_commit_removes_new_photo_files_and_preserves_database(self):
        incoming = state_with_samples({"id": "bad", "sn": "same", "imei": "SAME", "photos": [{"id": "p",
            "relativePath": "samples/bad/photos/one.jpg", "type": "image/jpeg", "size": 3}]})
        result = preview(make_zip(incoming, files={"assets/samples/bad/photos/one.jpg": b"ONE"}))
        before = server.get_state()
        committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": {}})
        self.assertFalse(committed["ok"], committed)
        self.assertEqual(committed["error_code"], "SAMPLE_IDENTITY_CONFLICT")
        self.assertEqual(server.get_state(), before)
        self.assertEqual([path for path in server.SAMPLE_DATA_DIR.rglob("*") if path.is_file()], [])

    def test_result_upload_references_follow_sample_merge(self):
        data = {"projects": [{"id": "target-project", "stages": [{"id": "target-stage", "tasks": [{
            "id": "task", "sampleIds": ["old", "new"], "resultUploads": [{"samples": [{"sampleId": "old"}]}],
            "resultDraft": {"samples": [{"sampleId": "old"}]}, "sampleSnapshots": {"old": {"id": "old"}},
        }]}]}], "sampleLibrary": {"categories": []}}
        import_commit.apply_id_maps(data, {}, {}, {}, {"old": "new"})
        task = data["projects"][0]["stages"][0]["tasks"][0]
        self.assertEqual(task["sampleIds"], ["new"])
        self.assertEqual(task["resultUploads"][0]["samples"][0]["sampleId"], "new")
        self.assertEqual((task["projectId"], task["stageId"]), ("target-project", "target-stage"))
        self.assertEqual(task["sampleSnapshots"], {"new": {"id": "new"}})
        self.assertEqual(task["resultDraft"]["samples"][0]["sampleId"], "new")

    def test_import_without_occupancy_preserves_main_reservation_and_history(self):
        current = state_with_samples({"id": "s", "sn": "A"})
        current["projects"] = [{"id": "main", "name": "main", "stages": [{"id": "main-stage", "name": "EVT", "tasks": [
            {"id": "running", "status": "进行中", "sampleIds": ["s"]},
        ]}]}]
        self.save(current)
        incoming = state_with_samples({"id": "s", "sn": "A"})
        incoming["projects"] = [{"id": "imported", "name": "imported", "stages": [{"id": "imported-stage", "name": "EVT", "tasks": [
            {"id": "another-running", "status": "进行中", "sampleIds": ["s"]},
        ]}]}]
        result = preview(make_zip(incoming))
        decisions = {item["conflictId"]: {"action": "import_no_occupy" if item["type"] == "task_occupancy_conflict" else "skip"}
                     for item in result["conflicts"]}
        committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": decisions})
        self.assertTrue(committed["ok"], committed)
        state = server.get_state()[0]
        tasks = {task["id"]: task for project in state["projects"] for stage in project["stages"] for task in stage["tasks"]}
        self.assertEqual(tasks["running"]["sampleIds"], ["s"])
        self.assertEqual(tasks["another-running"]["sampleIds"], [])
        self.assertEqual(tasks["another-running"]["removedSampleRecords"][0]["sampleId"], "s")

    def test_photo_id_cannot_steal_an_unrelated_samples_asset(self):
        source = server.SAMPLE_DATA_DIR / "existing" / "photos" / "keep.jpg"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(b"KEEP")
        self.save(state_with_samples({"id": "existing", "sn": "A", "photos": [{"id": "shared", "name": "keep.jpg",
                  "relativePath": "samples/existing/photos/keep.jpg", "size": 4, "type": "image/jpeg"}]}))
        incoming = state_with_samples({"id": "unrelated", "sn": "B", "photos": [{"id": "shared", "name": "new.jpg",
                  "relativePath": "samples/unrelated/photos/new.jpg", "size": 3, "type": "image/jpeg"}]})
        result = preview(make_zip(incoming, files={"assets/samples/unrelated/photos/new.jpg": b"NEW"}))
        before = server.get_state()
        committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": {}})
        self.assertEqual(committed["error_code"], "IMPORT_PHOTO_ID_CONFLICT")
        self.assertEqual(server.get_state(), before)
        self.assertEqual(source.read_bytes(), b"KEEP")

    def test_colliding_event_ids_append_once_and_preserve_original_history(self):
        current = state_with_samples({"id": "s", "sn": "A"})
        current["sampleLibrary"]["logs"] = [{"id": "event", "sampleId": "s", "reason": "keep local", "time": "2026-09-19"}]
        self.save(current)
        incoming = server.get_state()[0]
        incoming["sampleLibrary"]["logs"] = [{"id": "event", "sampleId": "s", "reason": "external detail", "time": "2026-09-20"}]
        for expected_added in (1, 0):
            result = preview(make_zip(incoming))
            decisions = {item["conflictId"]: {"action": "apply_field_choices", "fieldChoices": {}} for item in result["conflicts"]}
            committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": decisions})
            self.assertTrue(committed["ok"], committed)
            self.assertEqual(committed["stats"]["sampleEventsAdded"], expected_added)
        events = server.get_state()[0]["sampleLibrary"]["logs"]
        self.assertEqual(len(events), 2)
        self.assertEqual({event["id"]: event["reason"] for event in events}["event"], "keep local")
        self.assertEqual({event["reason"] for event in events}, {"keep local", "external detail"})

    def test_export_rejects_files_changed_after_snapshot_and_cleans_partial_zip(self):
        path = server.SAMPLE_DATA_DIR / "s" / "photos" / "p.jpg"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"KEEP")
        self.save(state_with_samples({"id": "s", "sn": "A", "photos": [{"id": "p", "size": 4,
            "relativePath": "samples/s/photos/p.jpg", "type": "image/jpeg"}]}))
        prepare = bundle_preview_service.prepare_export_bundle_parts
        for mode in ("delete", "change"):
            with self.subTest(mode=mode):
                path.write_bytes(b"KEEP")
                before = set(server.EXPORT_DIR.glob("*.zip"))
                def change_after_snapshot(*args, **kwargs):
                    result = prepare(*args, **kwargs)
                    path.unlink() if mode == "delete" else path.write_bytes(b"EDIT")
                    return result
                with patch.object(bundle_preview_service, "prepare_export_bundle_parts", side_effect=change_after_snapshot):
                    with self.assertRaisesRegex(ValueError, "导出期间.*重试"):
                        server.build_export_bundle_file()
                self.assertEqual(set(server.EXPORT_DIR.glob("*.zip")), before)
        path.write_bytes(b"KEEP")
        raw, _ = export_bytes()
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            self.assertEqual(archive.read("assets/samples/s/photos/p.jpg"), b"KEEP")

    def test_v2_roundtrip_does_not_invent_empty_business_field_conflicts(self):
        data = state_with_samples({"id": "s", "sn": "A"})
        data["projects"] = [{"id": "p", "name": "P", "stages": [{"id": "st", "name": "S", "tasks": [
            {"id": "t", "category": "C", "testItem": "T", "status": "待下发", "sampleIds": []},
        ]}]}]
        self.save(data)
        raw, _ = export_bytes()
        self.assertEqual(preview(raw)["conflicts"], [])
        for left, right in ((None, False), (None, 0), (None, []), (False, 0), ("", [])):
            self.assertEqual(import_diff.diff_fields({"custom": left}, {"custom": right}), {"custom"})

    def test_export_distinguishes_concurrent_deletion_from_historical_missing_file(self):
        path = server.SAMPLE_DATA_DIR / "s" / "photos" / "p.jpg"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"KEEP")
        self.save(state_with_samples({"id": "s", "sn": "A", "photos": [{"id": "p", "size": 4,
            "relativePath": "samples/s/photos/p.jpg", "type": "image/jpeg"}]}))
        build = chamber_package.build_export_package
        def delete_before_hash(*args, **kwargs):
            with server.write_db_connection() as conn:
                conn.execute("DELETE FROM sample_assets WHERE id = 'p'")
                server.unlink_asset_relative_paths(["samples/s/photos/p.jpg"])
            return build(*args, **kwargs)
        with patch.object(chamber_package, "build_export_package", side_effect=delete_before_hash):
            with self.assertRaisesRegex(ValueError, "导出期间.*重试"):
                server.build_export_bundle_file()
        self.save(state_with_samples({"id": "s", "sn": "A", "photos": [{"id": "p", "size": 4,
            "relativePath": "samples/s/photos/p.jpg", "type": "image/jpeg"}]}))
        raw, _ = export_bytes()
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            index = json.loads(archive.read("assets/index.json"))
            self.assertFalse(index["assets"][0]["exists"])

    def test_http_export_retries_after_concurrent_photo_delete_without_a_broken_zip(self):
        photos = []
        for photo_id in ("p", "q"):
            path = server.SAMPLE_DATA_DIR / "s" / "photos" / f"{photo_id}.jpg"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(photo_id.encode())
            photos.append({"id": photo_id, "relativePath": f"samples/s/photos/{photo_id}.jpg", "size": 1, "type": "image/jpeg"})
        self.save(state_with_samples({"id": "s", "sn": "A", "photos": photos}))
        finished_export = threading.Event()
        class QuietHandler(server.Handler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                try:
                    super().do_GET()
                finally:
                    finished_export.set()
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        ready, resume = threading.Event(), threading.Event()
        base_url = f"http://127.0.0.1:{httpd.server_address[1]}"
        build = chamber_package.build_export_package
        def pause_after_snapshot(*args, **kwargs):
            ready.set()
            if not resume.wait(5):
                raise RuntimeError("test synchronization timeout")
            return build(*args, **kwargs)
        def request(path, method="GET"):
            try:
                with urllib.request.urlopen(urllib.request.Request(base_url + path, method=method), timeout=10) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as exc:
                return exc.code, exc.read()
        try:
            with redirect_stderr(io.StringIO()), patch.object(chamber_package, "build_export_package", side_effect=pause_after_snapshot), ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(request, "/api/export-bundle")
                self.assertTrue(ready.wait(5))
                self.assertEqual(request("/api/samples/s/photos/p", "DELETE")[0], 200)
                resume.set()
                status, raw = pending.result(timeout=10)
                self.assertEqual(status, 500)
                self.assertIn("重试导出", json.loads(raw)["error"])
            self.assertTrue(finished_export.wait(5))
            finished_export.clear()
            status, raw = request("/api/export-bundle")
            self.assertEqual(status, 200)
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                assets = json.loads(archive.read("assets/index.json"))["assets"]
                self.assertEqual(len(assets), 1)
                for asset in assets:
                    content = archive.read(asset["zipPath"])
                    self.assertEqual((len(content), hashlib.sha256(content).hexdigest()), (asset["bytes"], asset["sha256"]))
            self.assertTrue(finished_export.wait(5))
            self.assertEqual(list(server.EXPORT_DIR.glob("*.zip")), [])
        finally:
            resume.set()
            httpd.shutdown()
            httpd.server_close()
            worker.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
