import json
import sys
import tempfile
import unittest
from pathlib import Path
from backend_fixture import seed_state

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import server
from server_modules import sample_history, sample_queries


class SampleHistoryCountTests(unittest.TestCase):
    def setUp(self):
        test_root = ROOT / "batch_import_test_data"
        test_root.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix="sample-history-counts-", dir=test_root)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(server._apply_runtime_paths, server._RUNTIME_PATHS)
        server.prepare_runtime_data_root(Path(self.tmp.name))
        server.init_db()
        state, revision, _ = server.get_state()
        state["projects"] = [{"id": "p", "name": "P", "stages": [{"id": "st", "name": "ST", "tasks": [
            {"id": "task", "testItem": "T", "status": "待下发", "sampleIds": ["s"], "logs": []},
            {"id": "linked", "testItem": "L", "status": "正常完成", "sampleIds": ["s"], "logs": []},
        ]}]}]
        state["sampleLibrary"] = {"categories": [{"id": "pool", "name": "Pool", "samples": [
            {"id": "s", "sn": "COUNT-1", "status": "闲置"},
            {"id": "empty", "sn": "COUNT-0", "status": "闲置"},
        ]}], "logs": []}
        ok, result = seed_state(state, revision, "127.0.0.1")
        self.assertTrue(ok, result)

    def test_page_counts_match_history_groups_and_filtered_pages(self):
        with server.connect_db() as conn:
            events = [
                ("a", "task", {}), ("b", "task", {}),
                ("c", "", {"sourceDeploymentId": "remote", "sourceTaskId": "t"}),
                ("d", "", {"sourceDeploymentId": "remote", "sourceTaskId": "t"}),
                ("e", "", {"sourceDeploymentId": "other", "sourceTaskId": "t"}),
                ("f", "gone-task", {}), ("g", "", {}),
                ("h", "", {"taskId": "task"}),
            ]
            for eid, task_id, log in events:
                conn.execute("INSERT INTO sample_events (id,sample_id,time,task_id,data_json) VALUES (?,?,?,?,?)",
                             (eid, "s", "2026-09-21", task_id, json.dumps(log)))
            conn.execute("INSERT INTO sample_events (id,sample_id,data_json) VALUES ('bad','s','[]')")
            conn.execute("UPDATE project_tasks SET deleted_at='2026-09-21' WHERE id='linked'")
            expected = sample_history.list_sample_history_page(conn, "s", {})["total"]
            self.assertEqual(expected, 6)
            for query in ({}, {"keyword": ["COUNT-1"]}):
                items = sample_queries.list_samples_page(conn, "pool", query)["items"]
                self.assertEqual(next(item for item in items if item["id"] == "s")["testHistoryCount"], expected)
            items = sample_queries.load_sample_category_detail(conn, "pool")["samples"]
            self.assertEqual(next(item for item in items if item["id"] == "empty")["testHistoryCount"], 0)
            queries = []
            conn.set_trace_callback(queries.append)
            sample_history.attach_sample_history_counts(conn, [{"id": "s"}, {"id": "empty"}])
            conn.set_trace_callback(None)
            self.assertEqual(len(queries), 2, "counts use two batch queries rather than per-card history requests")


if __name__ == "__main__":
    unittest.main()
