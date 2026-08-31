import io
import json
import sqlite3
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import server  # noqa: E402
from backend.server_modules import access_control, http_helpers, sample_assets, sample_constraints  # noqa: E402


REMOTE_IP = "10.31.118.62"


@contextmanager
def same_connection(conn):
    yield conn


def fixture_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    server.ensure_schema(conn)
    state = {
        "version": "V7",
        "projects": [{
            "id": "p1",
            "name": "Project",
            "defaultSampleCategoryId": "c1",
            "stages": [{
                "id": "st1",
                "name": "Original Stage",
                "tasks": [{
                    "id": "t1",
                    "projectId": "p1",
                    "stageId": "st1",
                    "status": "进行中",
                    "testItem": "Original Test",
                    "plan": {"days": 3},
                    "sampleIds": ["s1", "s2"],
                    "logs": [],
                }],
            }],
        }],
        "sampleLibrary": {
            "categories": [
                {"id": "c1", "name": "Source", "samples": [{"id": "s1", "categoryId": "c1", "sn": "SN-1", "status": "测试中"}]},
                {"id": "c2", "name": "Other", "samples": [
                    {"id": "s2", "categoryId": "c2", "sn": "SN-2", "status": "测试中"},
                    {"id": "s3", "categoryId": "c2", "sn": "SN-3", "status": "闲置"},
                ]},
            ],
            "logs": [],
        },
    }
    conn.execute(
        "INSERT INTO app_state(id,data_json,revision,updated_at) VALUES(1,?,1,?)",
        (server.json_dumps(server.split_state_for_storage(state)), server.now_iso()),
    )
    server.sync_project_library(conn, state)
    server.sync_sample_library(conn, state)
    now = server.now_iso()
    conn.execute(
        "INSERT INTO sample_pool_ip_access(category_id,ip_address,role,enabled,created_at,updated_at) VALUES('c1',?,'pool_admin',1,?,?)",
        (REMOTE_IP, now, now),
    )
    conn.commit()
    return conn


def current_task(conn):
    row = conn.execute("SELECT * FROM project_tasks WHERE id = 't1'").fetchone()
    task = json.loads(row["data_json"] or "{}")
    task.update({
        "id": "t1",
        "projectId": "p1",
        "stageId": "st1",
        "sampleIds": json.loads(row["sample_ids_json"] or "[]"),
    })
    return task


def call_json(conn, method, path, *, ip=REMOTE_IP, body=None, headers=None):
    handler = object.__new__(server.Handler)
    handler.path = path
    handler.headers = headers or {}
    handler.client_address = (ip, 12345)
    raw = b"" if body is None else (body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8"))
    handler._read_body = lambda max_bytes=server.MAX_UPLOAD_BYTES: raw
    result = {}
    handler._send_json = lambda payload, status=200: result.update(status=status, payload=payload)
    with mock.patch.object(server, "connect_db", lambda: same_connection(conn)), mock.patch.object(
        server, "write_db_connection", lambda: same_connection(conn)
    ):
        getattr(server.Handler, method)(handler)
    return result


def destroy_payload(conn, **task_changes):
    task = current_task(conn)
    task.update({
        "status": "异常终止",
        "completed": True,
        "completionType": "异常终止",
        "completedAt": server.now_iso(),
        "endDate": "2026-08-30",
        "resultDate": "2026-08-30",
        "latestResult": "不通过",
        "sampleIds": [],
        **task_changes,
    })
    return {
        "sampleId": "s1",
        "deleteSample": True,
        "action": "destroy_sample",
        "taskMutations": [{
            "projectId": "p1",
            "stageId": "st1",
            "taskId": "t1",
            "stage": {"id": "st1", "projectId": "p1", "name": "FORGED STAGE"},
            "task": task,
        }],
        "samples": [{"id": "s2", "sn": "FORGED-SN", "status": "取走分析"}],
        "sampleEvents": [],
    }


class DestroyAuthorizationTests(unittest.TestCase):
    def _commit(self, conn, payload):
        with mock.patch.object(server, "connect_db", lambda: same_connection(conn)), mock.patch.object(
            server, "write_db_connection", lambda: same_connection(conn)
        ):
            return server.commit_sample_mutation(payload, REMOTE_IP)

    def test_remote_pool_admin_cannot_forge_task_plan_test_or_result(self):
        for forged in (
            {"testItem": "FORGED"},
            {"plan": {"days": 999}},
            {"result": "FORGED"},
        ):
            conn = fixture_conn()
            ok, result = self._commit(conn, destroy_payload(conn, **forged))
            self.assertFalse(ok)
            self.assertEqual(result["errorCode"], "DESTROY_TASK_REWRITE_DENIED")
            self.assertEqual(conn.execute("SELECT revision FROM app_state WHERE id=1").fetchone()["revision"], 1)
            self.assertIsNotNone(conn.execute("SELECT 1 FROM sample_records WHERE id='s1'").fetchone())

    def test_remote_destroy_rejects_unrelated_nested_sample(self):
        conn = fixture_conn()
        payload = destroy_payload(conn)
        payload["samples"].append({"id": "s3", "sn": "FORGED"})
        ok, result = self._commit(conn, payload)
        self.assertFalse(ok)
        self.assertEqual(result["errorCode"], "DESTROY_SAMPLE_SCOPE_DENIED")
        self.assertEqual(conn.execute("SELECT revision FROM app_state WHERE id=1").fetchone()["revision"], 1)

    def test_remote_destroy_accepts_empty_linkage_and_rebuilds_side_effects_from_db(self):
        conn = fixture_conn()
        payload = {"sampleId": "s1", "deleteSample": True, "action": "destroy_sample"}
        ok, result = self._commit(conn, payload)
        self.assertTrue(ok, result)
        task = current_task(conn)
        self.assertEqual(task["testItem"], "Original Test")
        self.assertEqual(task["plan"], {"days": 3})
        self.assertEqual(task["status"], "异常终止")
        self.assertEqual(task["sampleIds"], [])
        stage = json.loads(conn.execute("SELECT data_json FROM project_stages WHERE id='st1'").fetchone()["data_json"])
        self.assertEqual(stage["name"], "Original Stage")
        sibling = conn.execute("SELECT sn, effective_status FROM sample_records WHERE id='s2'").fetchone()
        self.assertEqual(sibling["sn"], "SN-2")
        self.assertEqual(sibling["effective_status"], "闲置")

    def test_identity_conflict_in_unreadable_pool_is_redacted(self):
        conn = fixture_conn()
        raw = sample_constraints.check_sample_identity_conflicts(conn, {"categoryId": "c1", "sn": "SN-3"})
        clean = access_control.sanitize_identity_conflicts(conn, raw, REMOTE_IP)
        conflict = clean["conflicts"][0]
        self.assertTrue(conflict["restricted"])
        self.assertNotIn("sample", conflict)
        self.assertNotIn("conflictId", conflict)
        self.assertNotIn("categoryId", conflict)

    def test_batch_assignment_requires_pool_view_and_project_binding(self):
        conn = fixture_conn()
        now = server.now_iso()
        conn.execute(
            "INSERT INTO project_ip_access(project_id,ip_address,role,enabled,created_at,updated_at) VALUES('p1',?,'project_admin',1,?,?)",
            (REMOTE_IP, now, now),
        )
        payload = {
            "projectId": "p1",
            "stageId": "st1",
            "action": "create_tasks_batch",
            "tasks": [{"id": "new", "sampleIds": ["s2"]}],
        }
        allowed, failure = access_control.authorize_task_mutation(conn, payload, REMOTE_IP, batch=True)
        self.assertFalse(allowed)
        self.assertEqual(failure["errorCode"], "POOL_ACCESS_REQUIRED")
        conn.execute(
            "INSERT INTO sample_pool_ip_access(category_id,ip_address,role,enabled,created_at,updated_at) VALUES('c2',?,'pool_viewer',1,?,?)",
            (REMOTE_IP, now, now),
        )
        allowed, failure = access_control.authorize_task_mutation(conn, payload, REMOTE_IP, batch=True)
        self.assertFalse(allowed)
        self.assertEqual(failure["errorCode"], "PROJECT_POOL_BINDING_REQUIRED")

    def test_contributor_cannot_overwrite_history_master_or_unknown_task_field(self):
        conn = fixture_conn()
        now = server.now_iso()
        conn.execute(
            "INSERT INTO project_ip_access(project_id,ip_address,role,enabled,created_at,updated_at) VALUES('p1',?,'contributor',1,?,?)",
            (REMOTE_IP, now, now),
        )
        task = current_task(conn)
        task["priority"] = "FORGED"
        allowed, failure = access_control.authorize_task_mutation(conn, {
            "taskId": "t1", "projectId": "p1", "stageId": "st1",
            "action": "update_issue_record", "task": task,
        }, REMOTE_IP)
        self.assertFalse(allowed)
        self.assertEqual(failure["errorCode"], "TASK_FIELDS_DENIED")

        task = current_task(conn)
        allowed, failure = access_control.authorize_task_mutation(conn, {
            "taskId": "t1", "projectId": "p1", "stageId": "st1",
            "action": "upload_task_result", "task": task,
            "samples": [{"id": "s1", "location": "FORGED"}],
        }, REMOTE_IP)
        self.assertFalse(allowed)
        self.assertEqual(failure["errorCode"], "TASK_SAMPLE_FIELDS_DENIED")

        stored = json.loads(conn.execute("SELECT data_json FROM project_tasks WHERE id='t1'").fetchone()["data_json"])
        stored["customServerField"] = "must-preserve"
        conn.execute("UPDATE project_tasks SET data_json=? WHERE id='t1'", (server.json_dumps(stored),))
        omitted = current_task(conn)
        omitted.pop("customServerField", None)
        allowed, failure = access_control.authorize_task_mutation(conn, {
            "taskId": "t1", "projectId": "p1", "stageId": "st1",
            "action": "update_issue_record", "task": omitted,
        }, REMOTE_IP)
        self.assertFalse(allowed)
        self.assertIn("customServerField", failure["fields"])

        forged_workflow = current_task(conn)
        allowed, failure = access_control.authorize_task_mutation(conn, {
            "taskId": "t1", "projectId": "p1", "stageId": "st1",
            "action": "start_task", "task": forged_workflow,
            "samples": [{"id": "s1", "status": "闲置", "currentProjectId": "p-forged"}],
        }, REMOTE_IP)
        self.assertFalse(allowed)
        self.assertEqual(failure["errorCode"], "TASK_SAMPLE_WORKFLOW_DENIED")

    def test_remote_pool_sample_update_preserves_hidden_project_fields(self):
        conn = fixture_conn()
        row = conn.execute("SELECT data_json FROM sample_records WHERE id='s1'").fetchone()
        stored = json.loads(row["data_json"] or "{}")
        stored.update({
            "problemRecords": [{"projectId": "p1", "detail": "secret"}],
            "currentProjectId": "p1",
            "currentStageId": "st1",
            "currentTaskId": "t1",
        })
        conn.execute("UPDATE sample_records SET data_json=? WHERE id='s1'", (server.json_dumps(stored),))
        conn.execute("UPDATE sample_pool_ip_access SET role='pool_maintainer' WHERE category_id='c1' AND ip_address=?", (REMOTE_IP,))
        conn.commit()
        ok, result = self._commit(conn, {
            "sampleId": "s1",
            "action": "sample_detail_update",
            "sample": {"id": "s1", "categoryId": "c1", "location": "New Rack", "status": "测试中"},
        })
        self.assertTrue(ok, result)
        saved = json.loads(conn.execute("SELECT data_json FROM sample_records WHERE id='s1'").fetchone()["data_json"])
        self.assertEqual(saved["location"], "New Rack")
        self.assertEqual(saved["problemRecords"][0]["detail"], "secret")
        self.assertEqual(saved["currentTaskId"], "t1")

    def test_unscoped_business_events_and_history_are_redacted(self):
        conn = fixture_conn()
        event = {"id": "external", "sampleId": "s1", "projectName": "Secret", "testItem": "RF", "result": "fail", "resultPhotos": [{"id": "x"}]}
        clean_events = access_control.filter_sample_events_for_actor(conn, [event], REMOTE_IP)
        self.assertTrue(clean_events[0]["redacted"])
        self.assertNotIn("result", clean_events[0])
        history = {"items": [{"key": "external", "task": None, "projectName": "Secret", "stageName": "S", "testItem": "RF", "logs": [event], "result": "fail", "problems": ["secret"], "resultPhotos": [{"id": "x"}]}]}
        clean_history = access_control.filter_sample_history_for_actor(conn, history, REMOTE_IP)
        self.assertTrue(clean_history["items"][0]["redacted"])
        self.assertEqual(clean_history["items"][0]["resultPhotos"], [])

    def test_bitmap_signature_validation_rejects_active_content(self):
        for content, mime in ((b"<html><script>alert(1)</script>", "image/jpeg"), (b"<svg onload='x'/>", "image/svg+xml")):
            with self.assertRaises(ValueError):
                sample_assets.validate_safe_photo_upload(content, mime)
        self.assertEqual(sample_assets.validate_safe_photo_upload(b"\xff\xd8\xffdata", "image/jpeg"), "image/jpeg")

    def test_http_photo_upload_rejects_html_disguised_as_jpeg(self):
        conn = fixture_conn()
        boundary = "----security-boundary"
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="photos"; filename="attack.jpg"\r\n'
            "Content-Type: image/jpeg\r\n\r\n"
        ).encode() + b"<html><script>alert(1)</script>" + f"\r\n--{boundary}--\r\n".encode()
        response = call_json(conn, "do_POST", "/api/samples/s1/photos", body=body, headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
            "Host": "10.31.118.61:9398",
            "Origin": "http://10.31.118.61:9398",
        })
        self.assertEqual(response["status"], 400)
        self.assertIn("JPEG", response["payload"]["error"])

    def test_cross_origin_write_is_blocked_but_same_origin_is_allowed(self):
        conn = fixture_conn()
        rule = {"ipAddress": "10.31.118.70", "role": "viewer", "enabled": True}
        blocked = call_json(conn, "do_POST", "/api/projects/p1/access-rules", ip="127.0.0.1", body=rule, headers={
            "Host": "127.0.0.1:9398", "Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site",
        })
        self.assertEqual(blocked["status"], 403)
        allowed = call_json(conn, "do_POST", "/api/projects/p1/access-rules", ip="127.0.0.1", body=rule, headers={
            "Host": "127.0.0.1:9398", "Origin": "http://127.0.0.1:9398", "Sec-Fetch-Site": "same-origin",
        })
        self.assertEqual(allowed["status"], 200)
        dns_rebind = call_json(
            conn, "do_GET", "/api/state", ip="127.0.0.1",
            headers={"Host": "evil.example:9398"},
        )
        self.assertEqual(dns_rebind["status"], 403)

    def test_candidate_selected_ids_cannot_enumerate_unbound_pool(self):
        conn = fixture_conn()
        now = server.now_iso()
        conn.execute(
            "INSERT INTO project_ip_access(project_id,ip_address,role,enabled,created_at,updated_at) VALUES('p1',?,'project_admin',1,?,?)",
            (REMOTE_IP, now, now),
        )
        conn.execute(
            "INSERT INTO sample_pool_ip_access(category_id,ip_address,role,enabled,created_at,updated_at) VALUES('c2',?,'pool_viewer',1,?,?)",
            (REMOTE_IP, now, now),
        )
        conn.commit()
        response = call_json(conn, "do_GET", "/api/task-sample-candidates?projectId=p1&selectedIds=s3")
        self.assertEqual(response["status"], 403)
        self.assertNotIn("SN-3", json.dumps(response["payload"], ensure_ascii=False))

    def test_remote_imported_sample_hidden_fields_are_discarded(self):
        conn = fixture_conn()
        category_before = conn.execute("SELECT name,description,data_json FROM sample_categories WHERE id='c1'").fetchone()
        payload = {
            # A pool maintainer may submit only the category ID; sample import
            # must not replace the pool record with placeholder/empty data.
            "categoryId": "c1", "category": {"id": "c1"}, "action": "import_samples", "createSamples": True,
            "samples": [{
                "id": "s4", "categoryId": "c1", "sn": "SN-4", "status": "闲置",
                "currentProjectId": "p1", "currentTaskId": "t1",
                "problemRecords": [{"detail": "injected"}], "resultUploads": [{"secret": True}],
            }],
        }
        with mock.patch.object(server, "connect_db", lambda: same_connection(conn)), mock.patch.object(
            server, "write_db_connection", lambda: same_connection(conn)
        ):
            ok, result = server.commit_sample_category_mutation(payload, REMOTE_IP)
        self.assertTrue(ok, result)
        saved = json.loads(conn.execute("SELECT data_json FROM sample_records WHERE id='s4'").fetchone()["data_json"])
        self.assertNotIn("currentProjectId", saved)
        self.assertNotIn("currentTaskId", saved)
        self.assertEqual(saved.get("problemRecords") or [], [])
        self.assertNotIn("resultUploads", saved)
        category_after = conn.execute("SELECT name,description,data_json FROM sample_categories WHERE id='c1'").fetchone()
        self.assertEqual(tuple(category_after), tuple(category_before))

    def test_pool_search_headers_acl_validation_and_stale_project_acl(self):
        conn = fixture_conn()
        row = conn.execute("SELECT data_json FROM sample_records WHERE id='s1'").fetchone()
        sample = json.loads(row["data_json"] or "{}")
        sample["problemRecords"] = [{"description": "UNIQUE_PROJECT_SECRET_934"}]
        conn.execute("UPDATE sample_records SET data_json=? WHERE id='s1'", (server.json_dumps(sample),))
        response = call_json(conn, "do_GET", "/api/sample-categories/c1/samples?keyword=UNIQUE_PROJECT_SECRET_934")
        self.assertEqual(response["status"], 200)
        self.assertEqual(response["payload"]["total"], 0)

        class HeaderHandler:
            def __init__(self):
                self.headers, self.sent, self.wfile = {}, {}, io.BytesIO()
            def send_response(self, status):
                self.status = status
            def send_header(self, name, value):
                self.sent[name] = value
            def end_headers(self):
                pass
        handler = HeaderHandler()
        http_helpers.send_json(handler, {"ok": True}, json_dumps=server.json_dumps)
        self.assertEqual(handler.sent["X-Frame-Options"], "DENY")
        self.assertIn("frame-ancestors 'none'", handler.sent["Content-Security-Policy"])

        with self.assertRaises(ValueError):
            access_control.upsert_access_rule(conn, "project", "p1", {
                "ipAddress": "10.31.118.70", "role": "viewer", "enabled": "false",
            }, actor_ip="127.0.0.1", now=server.now_iso())
        with self.assertRaises(ValueError):
            access_control.upsert_access_rule(conn, "project", "p1", {
                "ipAddress": "10.31.118.70", "role": "viewer", "deviceLabel": "x" * 101,
            }, actor_ip="127.0.0.1", now=server.now_iso())

        server.update_project_record(conn, {"id": "p-empty", "name": "Empty"}, create_if_missing=True)
        now = server.now_iso()
        conn.execute(
            "INSERT INTO project_ip_access(project_id,ip_address,role,enabled,created_at,updated_at) VALUES('p-empty',?,'viewer',1,?,?)",
            (REMOTE_IP, now, now),
        )
        conn.commit()
        with mock.patch.object(server, "connect_db", lambda: same_connection(conn)), mock.patch.object(
            server, "write_db_connection", lambda: same_connection(conn)
        ):
            ok, result = server.commit_project_mutation({
                "projectId": "p-empty", "deleteProject": True, "project": {"id": "p-empty"},
            }, "127.0.0.1")
        self.assertTrue(ok, result)
        self.assertEqual(access_control.project_role(conn, "p-empty", REMOTE_IP), "none")
        self.assertFalse(conn.execute("SELECT 1 FROM project_ip_access WHERE project_id='p-empty'").fetchone())

    def test_pool_maintenance_event_cannot_inject_project_results(self):
        conn = fixture_conn()
        allowed, failure = access_control.authorize_sample_mutation(conn, {
            "sampleId": "s1", "action": "sample_detail_update",
            "sample": {"id": "s1", "categoryId": "c1", "location": "Rack B"},
            "sampleEvents": [{
                "id": "forged-result-event", "sampleId": "s1", "source": "维护",
                "result": "secret", "attachments": [{"id": "x"}],
            }],
        }, REMOTE_IP)
        self.assertFalse(allowed)
        self.assertEqual(failure["errorCode"], "EVENT_FIELDS_DENIED")

    def test_forged_destroy_action_is_canonical_in_both_audits(self):
        conn = fixture_conn()
        ok, result = self._commit(conn, {"sampleId": "s1", "deleteSample": True, "action": "rename_sample"})
        self.assertTrue(ok, result)
        self.assertEqual(conn.execute("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()["action"], "destroy_sample")
        self.assertEqual(conn.execute("SELECT action FROM security_audit_log WHERE allowed=1 ORDER BY id DESC LIMIT 1").fetchone()["action"], "destroy_sample")


if __name__ == "__main__":
    unittest.main()
