"""Second-pass migration regressions; all writes stay in isolated temporary roots."""
import copy
import io
import json
import threading
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import test_transfer_integrity as previous

chamber_package, preview, server, state_with_samples = (
    previous.chamber_package, previous.preview, previous.server, previous.state_with_samples)


def v2_zip(state):
    package = chamber_package.build_export_package(state, data_dir=server.DATA_DIR,
        app_version="7", server_version="7", exported_at="2026-09-21", export_id="followup",
        deployment_id="followup", revision=1)
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w") as archive:
        for path, text in chamber_package.package_payloads(package).items():
            archive.writestr(path, text)
    return result.getvalue()


def add_task(state, *, project="project", stage="stage", task="task", samples=None, status="待下发"):
    state["projects"] = [{"id": project, "name": project, "stages": [{"id": stage, "name": stage,
        "tasks": [{"id": task, "status": status, "category": "category", "testItem": task,
                   "sampleIds": samples or [], "logs": []}]}]}]
    return state["projects"][0]["stages"][0]["tasks"][0]


def choose_incoming(result):
    return {item["conflictId"]: {"action": "apply_field_choices",
            "fieldChoices": {key: "incoming" for key in item.get("diffFields", [])}}
            for item in result["conflicts"] if item["type"] == "field_conflict"}


class TransferFollowupTests(unittest.TestCase):
    setUp = previous.ImportCommitTests.setUp
    save = previous.ImportCommitTests.save

    def test_new_v2_project_preserves_absent_optional_task_fields(self):
        incoming = state_with_samples({"id": "sample", "sn": "SN"})
        task = add_task(incoming, samples=["sample"])
        task["resultUploads"] = []
        self.save(incoming)
        raw = v2_zip(server.get_state()[0])
        self.save({"projects": [], "sampleLibrary": {"categories": [], "logs": []}})
        result = preview(raw)
        committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": {}})
        self.assertTrue(committed["ok"], committed)
        saved = server.get_state()[0]["projects"][0]["stages"][0]["tasks"][0]
        self.assertNotIn("removedSampleRecords", saved)
        self.assertNotIn("sampleFaultRecords", saved)
        self.assertEqual(saved["resultUploads"], [])
        self.assertEqual(preview(raw)["conflicts"], [])

    def test_same_task_payload_updates_are_presented_before_commit(self):
        initial = state_with_samples({"id": "sample", "sn": "SN"})
        add_task(initial)
        self.save(initial)
        incoming = server.get_state()[0]
        task = incoming["projects"][0]["stages"][0]["tasks"][0]
        updates = {
            "sampleIds": ["sample"],
            "resultDraft": {"overallResult": "不通过", "samples": [{"sampleId": "sample", "result": "不通过", "fault": "无故障"}]},
            "resultUploads": [{"id": "upload", "samples": [{"sampleId": "sample", "result": "通过", "fault": "无故障"}]}],
            "sampleFaultRecords": [{"sampleId": "sample", "description": "new fault"}],
            "removedSampleRecords": [{"sampleId": "sample", "reason": "history"}],
            "logs": [{"id": "new-log", "action": "new task history"}],
        }
        task.update(updates)
        result = preview(v2_zip(incoming))
        field = next((item for item in result["conflicts"] if item.get("incomingId") == "task"), {})
        self.assertTrue(set(updates) <= set(field.get("diffFields", [])), result)
        committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": choose_incoming(result)})
        self.assertTrue(committed["ok"], committed)
        saved = server.get_state()[0]["projects"][0]["stages"][0]["tasks"][0]
        for key, value in updates.items():
            if key != "logs":
                self.assertEqual(saved[key], value, key)
        self.assertEqual(saved["logs"][0]["action"], "new task history")

    def test_incoming_missing_optional_field_choice_removes_old_value(self):
        self.save(state_with_samples({"id": "sample", "sn": "SN", "notes": "obsolete"}))
        incoming = server.get_state()[0]
        incoming["sampleLibrary"]["categories"][0]["samples"][0].pop("notes")
        result = preview(v2_zip(incoming))
        committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": choose_incoming(result)})
        self.assertTrue(committed["ok"], committed)
        saved = server.get_state()[0]["sampleLibrary"]["categories"][0]["samples"][0]
        self.assertNotIn("notes", saved)

    def test_identity_merge_occupancy_is_visible_in_preview(self):
        initial = state_with_samples({"id": "main-sample", "sn": "SN"})
        add_task(initial, project="main", stage="main-stage", task="main-task", samples=["main-sample"], status="进行中")
        self.save(initial)
        incoming = state_with_samples({"id": "incoming-sample", "sn": "SN"})
        add_task(incoming, project="incoming", stage="incoming-stage", task="incoming-task", samples=["incoming-sample"], status="进行中")
        result = preview(v2_zip(incoming))
        occupancy = next((item for item in result["conflicts"] if item["type"] == "task_occupancy_conflict"), None)
        self.assertIsNotNone(occupancy, result)
        decisions = {item["conflictId"]: {"action": "merge_into_existing" if item["type"] == "sample_identity_conflict" else "import_no_occupy"}
                     for item in result["conflicts"]}
        committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": decisions})
        self.assertTrue(committed["ok"], committed)
        tasks = {task["id"]: task for project in server.get_state()[0]["projects"] for stage in project["stages"] for task in stage["tasks"]}
        self.assertEqual(tasks["main-task"]["sampleIds"], ["main-sample"])
        self.assertEqual(tasks["incoming-task"]["sampleIds"], [])

    def test_task_history_merge_and_skip_occupancy_keeps_main_reservation(self):
        initial = state_with_samples({"id": "sample", "sn": "SN"})
        add_task(initial, samples=["sample"], status="进行中")
        self.save(initial)
        incoming = server.get_state()[0]
        task = incoming["projects"][0]["stages"][0]["tasks"][0]
        task["id"] = "other-task"
        result = preview(v2_zip(incoming))
        decisions = {item["conflictId"]: {"action": "merge_into_existing" if item["type"] == "task_name_conflict" else "import_no_occupy"}
                     for item in result["conflicts"]}
        committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": decisions})
        self.assertTrue(committed["ok"], committed)
        tasks = server.get_state()[0]["projects"][0]["stages"][0]["tasks"]
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["sampleIds"], ["sample"])

    def test_identity_edit_does_not_apply_conditional_occupancy_removal(self):
        initial = state_with_samples({"id": "main-sample", "sn": "SN"})
        add_task(initial, project="main", stage="main-stage", task="main-task", samples=["main-sample"], status="进行中")
        self.save(initial)
        incoming = state_with_samples({"id": "incoming-sample", "sn": "SN"})
        add_task(incoming, project="incoming", stage="incoming-stage", task="incoming-task", samples=["incoming-sample"], status="进行中")
        result = preview(v2_zip(incoming))
        decisions = {item["conflictId"]: ({"action": "import_as_new_with_identity_edit", "newSN": "DIFFERENT"}
                    if item["type"] == "sample_identity_conflict" else {"action": "import_no_occupy"})
                    for item in result["conflicts"]}
        committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": decisions})
        self.assertTrue(committed["ok"], committed)
        tasks = {task["id"]: task for project in server.get_state()[0]["projects"] for stage in project["stages"] for task in stage["tasks"]}
        self.assertEqual(tasks["incoming-task"]["sampleIds"], ["incoming-sample"])
        self.assertEqual(tasks["main-task"]["sampleIds"], ["main-sample"])

    def test_external_package_json_is_strict_and_cleans_rejected_preview(self):
        state = state_with_samples({"id": "sample", "sn": "SN"})
        raw = v2_zip(state)
        bad_json = [b'{"x":NaN}', b'{"x":Infinity}', b'{"x":1e999}', b'{"x":"\\ud800"}', b'{"x":1,"x":2}']
        for member in ["manifest.json", "checksums.json", chamber_package.DOMAIN_PATHS["app"], chamber_package.ASSET_INDEX_PATH]:
            for content in bad_json:
                with self.subTest(member=member, content=content):
                    stream = io.BytesIO()
                    with zipfile.ZipFile(io.BytesIO(raw)) as original, zipfile.ZipFile(stream, "w") as modified:
                        for name in original.namelist():
                            if name != member:
                                modified.writestr(name, original.read(name))
                        modified.writestr(member, content)
                    before = set(server._IMPORT_PREVIEWS)
                    with self.assertRaises(ValueError):
                        preview(stream.getvalue())
                    self.assertEqual(set(server._IMPORT_PREVIEWS), before)
        for content in bad_json:
            with self.subTest(legacy=content):
                out = io.BytesIO()
                with zipfile.ZipFile(out, "w") as archive:
                    archive.writestr("manifest.json", json.dumps({"format": "testchamber-export-bundle-v1"}))
                    archive.writestr("state.json", content)
                with self.assertRaises(ValueError):
                    preview(out.getvalue())

    def test_import_postcommit_failure_keeps_committed_photo_files(self):
        from server_modules import import_bundle_service
        state = state_with_samples({"id": "sample", "sn": "SN", "photos": [{"id": "photo", "name": "photo.jpg",
            "type": "image/jpeg", "size": 5, "relativePath": "samples/sample/photos/photo.jpg"}]})
        result = preview(previous.make_zip(state, files={"assets/samples/sample/photos/photo.jpg": b"PHOTO"}))
        original = import_bundle_service.commit_merged_import_state
        def fail_after_commit(*args, **kwargs):
            ok, committed = original(*args, **kwargs)
            self.assertTrue(ok, committed)
            raise OSError("injected response failure after durable commit")
        with patch.object(import_bundle_service, "commit_merged_import_state", side_effect=fail_after_commit):
            response = server.commit_import_bundle({"previewId": result["previewId"], "decisions": {}})
        self.assertFalse(response["ok"])
        sample = server.get_state()[0]["sampleLibrary"]["categories"][0]["samples"][0]
        photo = sample["photos"][0]
        self.assertEqual((server.DATA_DIR / photo["relativePath"]).read_bytes(), b"PHOTO")

    def test_expiry_cleanup_cannot_remove_an_active_commit_preview(self):
        from server_modules import import_preview_cache
        result = preview(v2_zip(state_with_samples({"id": "sample", "sn": "SN"})))
        preview_id = result["previewId"]
        started, resume = threading.Event(), threading.Event()
        original = import_preview_cache.load_payload
        def paused(entry):
            data = original(entry)
            started.set()
            if not resume.wait(5):
                raise RuntimeError("test failed to resume preview read")
            return data
        with patch.object(import_preview_cache, "load_payload", side_effect=paused), ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(server.commit_import_bundle, {"previewId": preview_id, "decisions": {}})
            try:
                self.assertTrue(started.wait(5))
                server._IMPORT_PREVIEWS[preview_id]["_ts"] = 0
                server._cleanup_expired_previews()
                retained = preview_id in server._IMPORT_PREVIEWS
            finally:
                resume.set()
            error = None
            try:
                committed = pending.result(timeout=5)
            except Exception as exc:
                error = exc
            self.assertTrue(retained, f"active preview was removed; worker exception: {error}")
            self.assertIsNone(error)
            self.assertTrue(committed["ok"], committed)

    def test_duplicate_commit_is_rejected_while_first_owns_preview(self):
        from server_modules import import_preview_cache
        result = preview(v2_zip(state_with_samples({"id": "sample", "sn": "SN"})))
        payload = {"previewId": result["previewId"], "decisions": {}}
        started, resume = threading.Event(), threading.Event()
        original = import_preview_cache.load_payload
        def paused_once(entry):
            data = original(entry)
            if not started.is_set():
                started.set()
                if not resume.wait(5):
                    raise RuntimeError("test failed to resume preview read")
            return data
        with patch.object(import_preview_cache, "load_payload", side_effect=paused_once), ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(server.commit_import_bundle, payload)
            try:
                self.assertTrue(started.wait(5))
                duplicate = server.commit_import_bundle(payload)
            finally:
                resume.set()
            first = pending.result(timeout=5)
        self.assertEqual(duplicate.get("error_code"), "IMPORT_PREVIEW_BUSY", duplicate)
        self.assertTrue(first["ok"], first)

    def test_preview_cache_counts_compressed_and_extracted_files(self):
        state = state_with_samples({"id": "sample", "sn": "SN", "notes": "x" * 40000})
        result = preview(v2_zip(state))
        entry = server._IMPORT_PREVIEWS[result["previewId"]]
        actual_bytes = sum(path.stat().st_size for path in Path(entry["_tmp_dir"]).rglob("*") if path.is_file())
        self.assertEqual(entry["_cache_bytes"], actual_bytes)

    def test_merged_sample_result_photos_use_target_asset_urls(self):
        self.save(state_with_samples({"id": "target-sample", "sn": "SN"}))
        photo = {"id": "photo", "name": "photo.jpg", "type": "image/jpeg", "size": 5,
                 "relativePath": "samples/source-sample/photos/photo.jpg",
                 "url": "/api/samples/source-sample/photos/photo"}
        incoming = state_with_samples({"id": "source-sample", "sn": "SN", "photos": [photo]})
        task = add_task(incoming, samples=["source-sample"], status="正常完成")
        task["resultUploads"] = [{"id": "upload", "samples": [{"sampleId": "source-sample", "photos": [copy.deepcopy(photo)]}]}]
        incoming["sampleLibrary"]["logs"] = [{"id": "external", "sampleId": "source-sample", "type": "external_history",
            "resultPhotos": [copy.deepcopy(photo)], "time": "2026-09-21T01:00:00"}]
        result = preview(previous.make_zip(incoming, files={"assets/samples/source-sample/photos/photo.jpg": b"PHOTO"}))
        decisions = {item["conflictId"]: {"action": "merge_into_existing"} for item in result["conflicts"]}
        committed = server.commit_import_bundle({"previewId": result["previewId"], "decisions": decisions})
        self.assertTrue(committed["ok"], committed)
        saved = server.get_state()[0]
        target_photo = saved["sampleLibrary"]["categories"][0]["samples"][0]["photos"][0]
        task_photo = saved["projects"][0]["stages"][0]["tasks"][0]["resultUploads"][0]["samples"][0]["photos"][0]
        event_photo = saved["sampleLibrary"]["logs"][0]["resultPhotos"][0]
        self.assertEqual(task_photo["url"], target_photo["url"])
        self.assertEqual(event_photo["url"], target_photo["url"])
        self.assertEqual(task_photo["relativePath"], target_photo["relativePath"])

    def test_sample_archive_hops_preserve_one_history_row_per_source_task(self):
        initial = state_with_samples({"id": "sample", "sn": "SN"})
        task = add_task(initial, samples=["sample"], status="正常完成")
        task.update({"result": "通过", "completedAt": "2026-09-20T12:00:00"})
        initial["sampleLibrary"]["logs"] = [
            {"id": "start", "sampleId": "sample", "projectId": "project", "stageId": "stage", "taskId": "task",
             "type": "start", "time": "2026-09-20T11:00:00"},
            {"id": "finish", "sampleId": "sample", "projectId": "project", "stageId": "stage", "taskId": "task",
             "type": "finish", "time": "2026-09-20T12:00:00", "result": "通过"},
        ]
        self.save(initial)
        counts = []
        for hop in range(3):
            path, _ = server.build_sample_archive_file("sample")
            archive = path.read_bytes()
            path.unlink()
            self.save({"projects": [], "sampleLibrary": {"categories": [], "logs": []}})
            result = preview(archive)
            committed = server.commit_sample_archive({"previewId": result["previewId"]})
            self.assertTrue(committed["ok"], committed)
            with closing(server.connect_db()) as conn:
                history = server.list_sample_history_page(conn, "sample", {})
            counts.append((len(server.get_state()[0]["sampleLibrary"]["logs"]), history["total"]))
        self.assertEqual(counts, [(3, 1), (3, 1), (3, 1)])
        self.assertEqual(history["items"][0]["result"], "通过")
        self.assertEqual(history["items"][0]["status"], "正常完成")
        self.assertEqual(history["items"][0]["taskSampleCount"], 1)

    def test_archive_history_distinguishes_tasks_from_different_deployments(self):
        state = state_with_samples({"id": "sample", "sn": "SN"})
        state["sampleLibrary"]["logs"] = [
            {"id": "a", "sampleId": "sample", "sourceTaskId": "same-task-id", "sourceDeploymentId": "A", "result": "通过"},
            {"id": "b", "sampleId": "sample", "sourceTaskId": "same-task-id", "sourceDeploymentId": "B", "result": "不通过"},
        ]
        self.save(state)
        with closing(server.connect_db()) as conn:
            history = server.list_sample_history_page(conn, "sample", {})
        self.assertEqual(history["total"], 2)
        self.assertEqual({item["result"] for item in history["items"]}, {"通过", "不通过"})

    def test_archive_summary_preserves_authoritative_result_and_date_across_hops(self):
        for latest in ("通过", ""):
            with self.subTest(latest=latest):
                state = state_with_samples({"id": "sample", "sn": "SN"})
                task = add_task(state, samples=["sample"], status="正常完成")
                task.update({"latestResult": latest, "resultDate": "2026-09-20",
                             "completedAt": "2026-09-20T12:00:00"})
                state["sampleLibrary"]["logs"] = [{
                    "id": "finish", "sampleId": "sample", "projectId": "project", "stageId": "stage", "taskId": "task",
                    "type": "finish", "time": "2026-09-20T12:00:00", "result": "不通过",
                    "taskStatus": "异常终止", "taskSampleCount": 99,
                }]
                self.save(state)
                with closing(server.connect_db()) as conn:
                    original = server.list_sample_history_page(conn, "sample", {})["items"][0]
                for hop in range(2):
                    path, _ = server.build_sample_archive_file("sample")
                    raw = path.read_bytes()
                    path.unlink()
                    self.save({"projects": [], "sampleLibrary": {"categories": [], "logs": []}})
                    result = preview(raw)
                    committed = server.commit_sample_archive({"previewId": result["previewId"]})
                    self.assertTrue(committed["ok"], committed)
                    with closing(server.connect_db()) as conn:
                        history = server.list_sample_history_page(conn, "sample", {})
                    self.assertEqual(history["total"], 1)
                    row = history["items"][0]
                    for field in ("result", "date", "status", "taskSampleCount"):
                        self.assertEqual(row[field], original[field], (hop, field))
                    self.assertEqual(next(log for log in row["logs"] if log["id"] == "finish")["result"], "不通过")

    def test_archive_reimport_selects_latest_source_revision_not_event_id(self):
        source = state_with_samples({"id": "sample", "sn": "SN"})
        task = add_task(source, samples=["sample"], status="正常完成")
        task.update({"resultDate": "2026-09-20", "completedAt": "2026-09-20T12:00:00"})
        archives = []
        for result in ("通过", "不通过"):
            task["latestResult"] = result
            self.save(source)
            path, _ = server.build_sample_archive_file("sample")
            archives.append(path.read_bytes())
            path.unlink()
        self.save({"projects": [], "sampleLibrary": {"categories": [], "logs": []}})
        for raw, expected in ((archives[0], "通过"), (archives[1], "不通过"),
                              (archives[0], "不通过"), (archives[1], "不通过")):
            result = preview(raw)
            committed = server.commit_sample_archive({"previewId": result["previewId"]})
            self.assertTrue(committed["ok"], committed)
            with closing(server.connect_db()) as conn:
                history = server.list_sample_history_page(conn, "sample", {})
            self.assertEqual(history["total"], 1)
            self.assertEqual(history["items"][0]["result"], expected)
            self.assertEqual(history["items"][0]["date"], "2026-09-20")
        self.assertEqual(len(server.get_state()[0]["sampleLibrary"]["logs"]), 2)

    def test_archive_rejects_state_and_history_from_different_revisions(self):
        from server_modules import bundle_preview_service
        state = state_with_samples({"id": "sample", "sn": "SN"})
        task = add_task(state, samples=["sample"], status="正常完成")
        task.update({"latestResult": "通过", "resultDate": "2026-09-20"})
        self.save(state)
        old_history = bundle_preview_service._sample_archive_history
        def concurrent_write(ctx, sample_id):
            task["latestResult"] = "不通过"
            self.save(state)
            return old_history(ctx, sample_id)
        before_files = set(server.EXPORT_DIR.glob("*.zip"))
        with patch.object(bundle_preview_service, "_sample_archive_history", side_effect=concurrent_write):
            with self.assertRaisesRegex(ValueError, "重试"):
                server.build_sample_archive_file("sample")
        self.assertEqual(set(server.EXPORT_DIR.glob("*.zip")), before_files)
        path, _ = server.build_sample_archive_file("sample")
        with zipfile.ZipFile(path) as archive:
            dossier = json.loads(archive.read("dossier.json"))
        path.unlink()
        self.assertEqual(dossier["history"][0]["result"], "不通过")

    def test_selected_task_carries_draft_snapshot_and_log_sample_dependencies(self):
        from server_modules import migration_scope
        state = state_with_samples(*[{"id": sid, "sn": sid} for sid in ("draft", "snapshot", "log", "outside")])
        task = add_task(state)
        task["resultDraft"] = {"samples": [{"sampleId": "draft", "result": "通过"}]}
        task["sampleSnapshots"] = {"snapshot": {"id": "snapshot", "sn": "snapshot"}}
        task["logs"] = [{"id": "event", "sampleId": "log"}]
        selected = migration_scope.filter_state_by_selection(state, {"taskIds": ["task"]})
        selected_ids = {sample["id"] for category in selected["sampleLibrary"]["categories"] for sample in category["samples"]}
        self.assertEqual(selected_ids, {"draft", "snapshot", "log"})
        tree = migration_scope.build_selection_tree(state)
        self.assertEqual(set(tree["projects"][0]["stages"][0]["tasks"][0]["sampleIds"]), selected_ids)

    def test_sample_archive_rejects_a_missing_explicit_target_pool(self):
        from server_modules import bundle_preview_service
        current = state_with_samples({"id": "sample", "sn": "SN"})
        with self.assertRaisesRegex(ValueError, "样机池"):
            bundle_preview_service._prepare_sample_archive_import_state(current, current, "deleted-pool")

    def test_sample_archive_rejects_malformed_decisions_without_writing(self):
        initial = state_with_samples({"id": "sample", "sn": "SN"})
        self.save(initial)
        path, _ = server.build_sample_archive_file("sample")
        result = preview(path.read_bytes())
        path.unlink()
        before = server.get_state()
        response = server.commit_sample_archive({"previewId": result["previewId"], "decisions": ["unexpected"]})
        self.assertEqual(response.get("status"), 400, response)
        self.assertEqual(server.get_state(), before)

    def test_archive_history_pages_share_one_read_snapshot(self):
        from server_modules import bundle_preview_service
        initial = state_with_samples({"id": "sample", "sn": "SN"})
        initial["sampleLibrary"]["logs"] = [
            {"id": f"event-{index:02}", "sampleId": "sample", "time": f"2026-09-20T12:{index:02}:00"}
            for index in range(51)
        ]
        self.save(initial)
        original = server.list_sample_history_page
        def concurrent_insert(conn, sample_id, query):
            page = original(conn, sample_id, query)
            if query["page"] == ["1"]:
                latest = server.get_state()[0]
                latest["sampleLibrary"]["logs"].append({"id": "newest", "sampleId": "sample", "time": "2026-09-20T13:00:00"})
                self.save(latest)
            return page
        ctx = replace(server._bundle_preview_context(), list_sample_history_page=concurrent_insert)
        history = bundle_preview_service._sample_archive_history(ctx, "sample")
        self.assertEqual(len(history), 51)
        self.assertEqual(len({row["key"] for row in history}), 51)


if __name__ == "__main__":
    unittest.main()
