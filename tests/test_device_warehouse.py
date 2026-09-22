"""Warehouse groups persist independently of project/sample records."""
import json
import sqlite3
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from backend_fixture import seed_state
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from server_modules import device_warehouse


class WarehouseTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE app_state(id INTEGER PRIMARY KEY, data_json TEXT, revision INTEGER, updated_at TEXT);
            CREATE TABLE audit_log(time TEXT, user TEXT, action TEXT, remark TEXT,
              revision_before INTEGER, revision_after INTEGER, client_ip TEXT);
        """)
        self.original = {"projects": [], "sampleLibrary": {"externalized": True}, "customField": "keep"}
        self.conn.execute("INSERT INTO app_state VALUES(1, ?, 1, 'before')", (json.dumps(self.original),))
        self.conn.commit()

        @contextmanager
        def write():
            with self.conn:
                yield self.conn
        self.ctx = SimpleNamespace(write_db_connection=write, now_iso=lambda: "2026-09-21T12:00:00Z", json_dumps=json.dumps)

    def tearDown(self):
        self.conn.close()

    def save(self, revision=0, **values):
        return device_warehouse.save_group(self.ctx, {
            "expectedRevision": revision,
            "group": {"id": "group_1", "region": "深圳", "department": "可靠性实验室", **values}
        }, "127.0.0.1")

    def test_create_edit_read_and_preserve_unrelated_data(self):
        self.assertEqual(device_warehouse.read_warehouse(self.conn), {"revision": 0, "groups": []})
        ok, result = self.save(region=" 深圳 ")
        self.assertTrue(ok)
        self.assertEqual(result["warehouse"]["groups"][0]["region"], "深圳")
        ok, result = self.save(1, department="硬件实验室")
        self.assertTrue(ok)
        fresh = device_warehouse.read_warehouse(self.conn)
        self.assertEqual(fresh["revision"], 2)
        self.assertEqual(len(fresh["groups"]), 1)
        self.assertEqual(fresh["groups"][0]["department"], "硬件实验室")
        state = json.loads(self.conn.execute("SELECT data_json FROM app_state").fetchone()[0])
        self.assertEqual({key: state[key] for key in self.original}, self.original)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0], 2)

    def test_conflicts_and_duplicates_do_not_write(self):
        self.assertTrue(self.save()[0])
        self.assertFalse(self.save()[0], 'repeat or stale writes cannot create another card')
        self.assertFalse(self.save(1, id="group_2")[0], 'the same region/department cannot be duplicated')
        self.assertEqual(device_warehouse.read_warehouse(self.conn)["revision"], 1)
        self.assertTrue(self.save(1, id="group_2", region="北京")[0], 'same department in another region is valid')

    def test_invalid_fields_do_not_write(self):
        for values in ({"region": " "}, {"department": ""}, {"region": []}, {"department": "a" * 81}, {"id": "../bad"}):
            with self.subTest(values=values):
                self.assertFalse(self.save(**values)[0])
        self.assertFalse(self.save(True)[0])
        self.assertEqual(device_warehouse.read_warehouse(self.conn)["revision"], 0)

    def device(self, revision=1, group_id="group_1", **values):
        return device_warehouse.save_warehouse(self.ctx, {"expectedRevision": revision, "groupId": group_id,
            "device": {"id": "device_1", "name": "恒温恒湿试验箱", "code": "EQ-001", "model": "TH-800",
                       "owner": "负责人", "location": "A01", "status": "闲置", **values}}, "127.0.0.1")

    def test_device_create_edit_and_reload_keep_group_and_other_data(self):
        self.assertTrue(self.save()[0])
        ok, result = self.device(name=" 恒温恒湿试验箱 ")
        self.assertTrue(ok, result)
        created = result["warehouse"]["groups"][0]["devices"][0]
        self.assertEqual(created["name"], "恒温恒湿试验箱")
        self.assertEqual(created["createdAt"], self.ctx.now_iso())
        self.ctx.now_iso = lambda: "2026-09-22T12:00:00Z"
        ok, result = self.device(2, status="使用中", owner="新负责人")
        self.assertTrue(ok, result)
        fresh = device_warehouse.read_warehouse(self.conn)
        self.assertEqual(len(fresh["groups"][0]["devices"]), 1)
        saved = fresh["groups"][0]["devices"][0]
        self.assertEqual(saved["createdAt"], created["createdAt"])
        self.assertEqual(saved["status"], "使用中")
        self.assertEqual(saved["owner"], "新负责人")
        self.assertTrue(self.save(3, region="东莞")[0])
        self.assertEqual(device_warehouse.read_warehouse(self.conn)["groups"][0]["devices"], [saved])
        state = json.loads(self.conn.execute("SELECT data_json FROM app_state").fetchone()[0])
        self.assertEqual({key: state[key] for key in self.original}, self.original)

    def test_device_rejects_duplicate_codes_stale_edits_and_cross_group_identity(self):
        self.assertTrue(self.save()[0])
        self.assertTrue(self.device()[0])
        self.assertEqual(self.device(1)[1]["status"], 409)
        self.assertEqual(self.device(2, id="other", code=" eq-001 ")[1]["status"], 409)
        self.assertTrue(self.save(2, id="group_2", region="北京")[0])
        self.assertEqual(self.device(3, group_id="group_2", code="EQ-002")[1]["status"], 409)
        self.assertEqual(self.device(3, group_id="group_2", id="other")[1]["status"], 409)
        self.assertTrue(self.device(3, group_id="group_2", id="other", code="EQ-002")[0])
        groups = device_warehouse.read_warehouse(self.conn)["groups"]
        self.assertEqual([len(group["devices"]) for group in groups], [1, 1])

    def test_invalid_device_fields_never_write(self):
        self.assertTrue(self.save()[0])
        for values in ({"name": " "}, {"code": ""}, {"name": []}, {"model": "a" * 101},
                       {"notes": "a" * 2001}, {"id": "../bad"}, {"status": "未知"}):
            with self.subTest(values=values):
                self.assertFalse(self.device(**values)[0])
        self.assertFalse(self.device(True)[0])
        self.assertEqual(self.device(group_id="missing")[1]["status"], 404)
        self.assertEqual(device_warehouse.read_warehouse(self.conn)["revision"], 1)



if __name__ == "__main__":
    unittest.main()
