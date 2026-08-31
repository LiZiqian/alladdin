import copy
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import server  # noqa: E402
from backend.server_modules import access_control, bundle_preview_service, import_bundle_service, import_commit  # noqa: E402


REMOTE_IP = "10.31.118.62"


@contextmanager
def same_connection(conn):
    yield conn


def export_state():
    return {
        "version": "V7",
        "testCaseMaster": [{"secret": "global-test-case"}],
        "futurePrivateTopLevel": {"secret": "must-not-export"},
        "users": [{"name": "global-secret"}],
        "currentProjectId": "p2",
        "currentStageId": "st2",
        "projects": [
            {
                "id": "p1", "name": "Allowed", "defaultSampleCategoryId": "c1",
                "stages": [{"id": "st1", "name": "Stage 1", "tasks": [{
                    "id": "t1", "projectId": "p1", "stageId": "st1", "testItem": "Allowed result",
                    "sampleIds": ["s1"], "resultUploads": [{"samples": [{"sampleId": "s1", "photos": [{"id": "p1-photo"}]}]}],
                }]}],
            },
            {
                "id": "p2", "name": "Forbidden", "defaultSampleCategoryId": "c1",
                "stages": [{"id": "st2", "name": "Secret Stage", "tasks": [{
                    "id": "t2", "projectId": "p2", "stageId": "st2", "testItem": "Forbidden result",
                    "sampleIds": ["s2"], "result": "secret",
                }]}],
            },
        ],
        "sampleLibrary": {
            "categories": [{
                "id": "c1", "name": "Shared Pool", "description": "pool",
                "samples": [
                    {
                        "id": "s1", "categoryId": "c1", "sn": "SN-1", "status": "闲置",
                        "problemRecords": [{"projectId": "p2", "detail": "other project secret"}],
                        "currentProjectId": "p2", "currentTaskId": "t2",
                        "photos": [
                            {"id": "public-photo-1", "relativePath": "samples/s1/public.jpg"},
                            {"id": "p1-photo", "relativePath": "samples/s1/p1.jpg"},
                            {"id": "p2-photo", "relativePath": "samples/s1/p2.jpg"},
                        ],
                    },
                    {
                        "id": "s2", "categoryId": "c1", "sn": "SN-2", "status": "测试中",
                        "currentProjectId": "p2", "currentTaskId": "t2",
                        "photos": [
                            {"id": "public-photo-2", "relativePath": "samples/s2/public.jpg"},
                            {"id": "p2-photo-2", "relativePath": "samples/s2/p2.jpg"},
                        ],
                    },
                ],
            }],
            "logs": [
                {"id": "public-event", "sampleId": "s1", "eventType": "入库"},
                {"id": "p1-event", "sampleId": "s1", "projectId": "p1", "stageId": "st1", "taskId": "t1", "result": "pass"},
                {"id": "p2-event", "sampleId": "s1", "projectId": "p2", "stageId": "st2", "taskId": "t2", "result": "secret"},
            ],
        },
    }


def fixture_conn(state):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    server.ensure_schema(conn)
    conn.execute(
        "INSERT INTO app_state(id, data_json, revision, updated_at) VALUES(1, ?, 1, ?)",
        (server.json_dumps(server.split_state_for_storage(state)), server.now_iso()),
    )
    server.sync_project_library(conn, state)
    server.sync_sample_library(conn, state)
    now = server.now_iso()
    conn.execute("INSERT INTO project_ip_access(project_id,ip_address,role,enabled,created_at,updated_at) VALUES('p1',?,'project_admin',1,?,?)", (REMOTE_IP, now, now))
    conn.execute("INSERT INTO sample_pool_ip_access(category_id,ip_address,role,enabled,created_at,updated_at) VALUES('c1',?,'pool_admin',1,?,?)", (REMOTE_IP, now, now))
    assets = [
        ("public-photo-1", "s1", None, None), ("p1-photo", "s1", "p1", "t1"), ("p2-photo", "s1", "p2", "t2"),
        ("public-photo-2", "s2", None, None), ("p2-photo-2", "s2", "p2", "t2"),
    ]
    for asset_id, sample_id, project_id, task_id in assets:
        conn.execute(
            """INSERT INTO sample_assets
               (id,sample_id,kind,original_name,file_name,relative_path,mime_type,size,created_at,project_id,task_id)
               VALUES(?,?,'photo',?,?,?,'image/jpeg',1,?,?,?)
               ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, task_id=excluded.task_id""",
            (asset_id, sample_id, asset_id, f"{asset_id}.jpg", f"samples/{sample_id}/{asset_id}.jpg", now, project_id, task_id),
        )
    conn.commit()
    return conn


class RemoteScopedExportTests(unittest.TestCase):
    def test_photo_context_round_trips_and_import_force_reclassifies_after_marker(self):
        state = export_state()
        conn = fixture_conn(state)
        exported = server.load_sample_photos(conn, "s1")
        p1_photo = next(photo for photo in exported if photo["id"] == "p1-photo")
        self.assertEqual((p1_photo["projectId"], p1_photo["stageId"], p1_photo["taskId"]), ("p1", "", "t1"))

        # Simulate a legacy Host-A package imported after Host B has already
        # recorded the one-time startup migration marker.
        legacy = copy.deepcopy(state)
        legacy_photo = next(
            photo
            for sample in legacy["sampleLibrary"]["categories"][0]["samples"]
            if sample["id"] == "s1"
            for photo in sample["photos"]
            if photo["id"] == "p1-photo"
        )
        legacy_photo.pop("projectId", None)
        legacy_photo.pop("stageId", None)
        legacy_photo.pop("taskId", None)
        conn.execute("UPDATE sample_assets SET project_id=NULL,stage_id=NULL,task_id=NULL WHERE id='p1-photo'")
        self.assertTrue(conn.execute(
            "SELECT 1 FROM schema_migrations WHERE id='20260830_sample_asset_project_context_v1'"
        ).fetchone())
        ctx = replace(
            server._import_bundle_commit_context(),
            write_db_connection=lambda: same_connection(conn),
        )
        ok, result = import_bundle_service.commit_merged_import_state(
            ctx, legacy, 1, "import-test", "legacy import", "tester"
        )
        self.assertTrue(ok, result)
        row = conn.execute("SELECT project_id,stage_id,task_id FROM sample_assets WHERE id='p1-photo'").fetchone()
        self.assertEqual((row["project_id"], row["stage_id"], row["task_id"]), ("p1", "st1", "t1"))

    def test_unscoped_external_history_photo_is_restricted(self):
        conn = fixture_conn(export_state())
        now = server.now_iso()
        conn.execute(
            """INSERT INTO sample_assets
               (id,sample_id,kind,original_name,file_name,relative_path,mime_type,size,created_at)
               VALUES('external-photo','s1','photo','external','external.jpg','samples/s1/external.jpg','image/jpeg',1,?)""",
            (now,),
        )
        event = {
            "id": "external-event", "sampleId": "s1", "eventType": "externalHistory",
            "projectName": "legacy secret", "result": "fail",
            "resultPhotos": [{"id": "external-photo"}],
        }
        conn.execute(
            """INSERT INTO sample_events
               (id,sample_id,time,event_type,project_id,stage_id,task_id,test_item,user,data_json)
               VALUES('external-event','s1',?,'externalHistory','','','','','',?)""",
            (now, server.json_dumps(event)),
        )
        server.backfill_sample_asset_context(conn, force=True)
        row = conn.execute("SELECT project_id FROM sample_assets WHERE id='external-photo'").fetchone()
        self.assertEqual(row["project_id"], "__restricted__")
        self.assertFalse(access_control.photo_is_visible(conn, "s1", "external-photo", REMOTE_IP))

    def test_import_photo_context_id_maps_and_unmapped_scope_fail_closed(self):
        incoming = {"sampleLibrary": {"categories": [{"id": "c", "samples": [{
            "id": "s", "photos": [
                {"id": "mapped", "projectId": "old-p", "stageId": "old-st", "taskId": "old-t"},
                {"id": "skipped", "projectId": "skipped-p", "stageId": "skipped-st", "taskId": "skipped-t"},
            ],
        }]}]}}
        import_commit.remap_import_photo_contexts(
            incoming,
            {"old-p": "new-p"},
            {"old-st": "new-st"},
            {"old-t": "new-t"},
        )
        photos = incoming["sampleLibrary"]["categories"][0]["samples"][0]["photos"]
        self.assertEqual((photos[0]["projectId"], photos[0]["stageId"], photos[0]["taskId"]), ("new-p", "new-st", "new-t"))
        self.assertEqual((photos[1]["projectId"], photos[1]["stageId"], photos[1]["taskId"]), ("__restricted__", "", ""))

    def test_legacy_task_photo_context_is_backfilled_and_not_public(self):
        state = export_state()
        conn = fixture_conn(state)
        conn.execute("UPDATE sample_assets SET project_id = NULL, stage_id = NULL, task_id = NULL WHERE id = 'p1-photo'")
        conn.execute("DELETE FROM schema_migrations WHERE id='20260830_sample_asset_project_context_v1'")
        conn.commit()
        self.assertTrue(access_control.photo_is_visible(conn, "s1", "p1-photo", REMOTE_IP))  # pool_admin sees legacy public before migration
        server.backfill_sample_asset_context(conn)
        row = conn.execute("SELECT project_id, stage_id, task_id FROM sample_assets WHERE id = 'p1-photo'").fetchone()
        self.assertEqual((row["project_id"], row["stage_id"], row["task_id"]), ("p1", "st1", "t1"))
        conn.execute("UPDATE sample_pool_ip_access SET role = 'pool_viewer' WHERE category_id = 'c1' AND ip_address = ?", (REMOTE_IP,))
        conn.execute("UPDATE project_ip_access SET enabled = 0 WHERE project_id = 'p1' AND ip_address = ?", (REMOTE_IP,))
        conn.commit()
        self.assertFalse(access_control.photo_is_visible(conn, "s1", "p1-photo", REMOTE_IP))
        self.assertTrue(access_control.photo_is_visible(conn, "s1", "public-photo-1", REMOTE_IP))

    def test_ambiguous_legacy_task_photo_is_restricted_not_public(self):
        state = export_state()
        state["projects"][1]["stages"][0]["tasks"][0]["resultUploads"] = [{
            "samples": [{"sampleId": "s1", "photos": [{"id": "p1-photo"}]}],
        }]
        conn = fixture_conn(state)
        now = server.now_iso()
        conn.execute("UPDATE sample_assets SET project_id=NULL,stage_id=NULL,task_id=NULL WHERE id='p1-photo'")
        conn.execute("DELETE FROM schema_migrations WHERE id='20260830_sample_asset_project_context_v1'")
        conn.execute(
            """INSERT INTO sample_assets(id,sample_id,kind,original_name,file_name,relative_path,mime_type,size,created_at)
               VALUES('p1-photo__thumb','s1','photo_thumb','thumb','thumb.jpg','samples/s1/thumb.jpg','image/jpeg',1,?)""",
            (now,),
        )
        server.backfill_sample_asset_context(conn)
        rows = conn.execute(
            "SELECT id,project_id FROM sample_assets WHERE id IN ('p1-photo','p1-photo__thumb') ORDER BY id"
        ).fetchall()
        self.assertEqual({row["project_id"] for row in rows}, {"__restricted__"})
        self.assertFalse(access_control.photo_is_visible(conn, "s1", "p1-photo", REMOTE_IP))

    def test_project_export_never_broadens_default_pool_or_other_project_history(self):
        state = export_state()
        conn = fixture_conn(state)
        scoped = access_control.build_remote_export_state(conn, state, {"projectIds": ["p1"]}, REMOTE_IP)
        self.assertEqual([project["id"] for project in scoped["projects"]], ["p1"])
        category = scoped["sampleLibrary"]["categories"][0]
        self.assertEqual([sample["id"] for sample in category["samples"]], ["s1"])
        sample = category["samples"][0]
        self.assertNotIn("problemRecords", sample)
        self.assertNotIn("currentProjectId", sample)
        self.assertEqual({photo["id"] for photo in sample["photos"]}, {"public-photo-1", "p1-photo"})
        self.assertEqual({event["id"] for event in scoped["sampleLibrary"]["logs"]}, {"public-event", "p1-event"})
        serialized = json.dumps(scoped, ensure_ascii=False)
        self.assertNotIn("Forbidden result", serialized)
        self.assertNotIn("p2-photo", serialized)
        self.assertNotIn("other project secret", serialized)
        self.assertNotIn("global-test-case", serialized)
        self.assertNotIn("futurePrivateTopLevel", scoped)

    def test_pool_export_contains_only_pool_master_public_photos_and_no_project_events(self):
        state = export_state()
        conn = fixture_conn(state)
        scoped = access_control.build_remote_export_state(conn, state, {"sampleCategoryIds": ["c1"]}, REMOTE_IP)
        self.assertEqual(scoped["projects"], [])
        self.assertEqual(scoped["sampleLibrary"]["logs"], [])
        samples = scoped["sampleLibrary"]["categories"][0]["samples"]
        self.assertEqual({sample["id"] for sample in samples}, {"s1", "s2"})
        self.assertEqual({photo["id"] for photo in samples[0]["photos"]}, {"public-photo-1"})
        self.assertEqual({photo["id"] for photo in samples[1]["photos"]}, {"public-photo-2"})
        serialized = json.dumps(scoped, ensure_ascii=False)
        self.assertNotIn("Allowed result", serialized)
        self.assertNotIn("Forbidden result", serialized)
        self.assertNotIn("p1-event", serialized)

    def test_remote_scope_rejects_mixed_and_unprivileged_selection(self):
        state = export_state()
        conn = fixture_conn(state)
        with self.assertRaises(ValueError):
            access_control.build_remote_export_state(conn, state, {"projectIds": ["p1"], "sampleCategoryIds": ["c1"]}, REMOTE_IP)
        with self.assertRaises(ValueError):
            access_control.build_remote_export_state(conn, state, {"taskIds": ["t1"]}, REMOTE_IP)
        with self.assertRaises(PermissionError):
            access_control.build_remote_export_state(conn, state, {"projectIds": ["p2"]}, REMOTE_IP)

    def test_payload_acl_is_limited_to_explicit_project(self):
        state = export_state()
        conn = fixture_conn(state)
        scoped = access_control.build_remote_export_state(conn, state, {"projectIds": ["p1"]}, REMOTE_IP)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ctx = bundle_preview_service.BundlePreviewContext(
                app_version="7.test", server_version="test", data_dir=root, export_dir=root,
                import_preview_dir=root, import_previews={}, import_preview_ttl_seconds=1,
                import_preview_max_entries=1, import_preview_max_state_bytes=1024 * 1024,
                import_preview_max_cached_bytes=1024 * 1024,
                get_state=lambda *args, **kwargs: (copy.deepcopy(state), 1, server.now_iso()),
                connect_db=lambda: conn, list_sample_history_page=lambda *args, **kwargs: {},
                load_deployment_id=lambda: "deployment-test", now_iso=server.now_iso,
                json_dumps=server.json_dumps, path_inside_data=lambda rel: root / rel,
                ensure_dirs=lambda: None, parse_multipart=lambda *args: ({}, []),
            )
            _data, package, payloads, _checksums, _filename = bundle_preview_service.prepare_export_bundle_parts(
                ctx,
                selection={"projectIds": ["p1"]},
                source_state=scoped,
                already_scoped=True,
            )
            policy = json.loads(payloads["access/access-policy.json"])
            self.assertEqual(policy["projectIds"], ["p1"])
            self.assertEqual(policy["samplePoolIds"], [])
            self.assertEqual({item["id"] for item in package["domains"]["projects"]}, {"p1"})
            self.assertEqual({item["id"] for item in package["domains"]["samples"]}, {"s1"})

            pool_scoped = access_control.build_remote_export_state(conn, state, {"sampleCategoryIds": ["c1"]}, REMOTE_IP)
            _data, pool_package, pool_payloads, _checksums, _filename = bundle_preview_service.prepare_export_bundle_parts(
                ctx,
                selection={"sampleCategoryIds": ["c1"]},
                source_state=pool_scoped,
                already_scoped=True,
            )
            pool_policy = json.loads(pool_payloads["access/access-policy.json"])
            self.assertEqual(pool_policy["projectIds"], [])
            self.assertEqual(pool_policy["samplePoolIds"], ["c1"])
            self.assertEqual(pool_package["domains"]["projects"], [])


if __name__ == "__main__":
    unittest.main()
