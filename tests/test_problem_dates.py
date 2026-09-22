"""Creation dates survive both incremental edits and full-state/import writes."""
import copy
import json
import unittest

from backend_fixture import empty_state, state_conn, server
from server_modules import import_commit, record_writers


class ProblemDateTests(unittest.TestCase):
    def setUp(self):
        self.record = {"id": "problem", "description": "黑斑", "source": "测试任务",
                       "createdAt": "2026-09-20T10:30:00.000Z"}
        self.legacy = {"id": "legacy", "description": "旧问题", "source": "初检"}
        self.sample = {"id": "sample", "categoryId": "pool", "sn": "S1", "status": "闲置",
                       "problemRecords": [self.record, self.legacy]}
        self.task = {"id": "task", "sampleIds": ["sample"], "testItem": "测试",
                     "resultDraft": {"samples": [{"sid": "sample", "problemRecords": [self.record, self.legacy]}]}}
        self.state = empty_state()
        self.state["sampleLibrary"]["categories"] = [{"id": "pool", "samples": [self.sample]}]
        self.state["projects"] = [{"id": "project", "stages": [{"id": "stage", "tasks": [self.task]}]}]
        self.conn = state_conn(copy.deepcopy(self.state))
        self.addCleanup(self.conn.close)

    def saved(self, table, key):
        return json.loads(self.conn.execute(f"SELECT data_json FROM {table} WHERE id=?", (key,)).fetchone()[0])

    def assert_dates(self, records):
        self.assertEqual(records[0]["createdAt"], self.record["createdAt"])
        self.assertNotIn("createdAt", records[1], "editing legacy records cannot invent a date")

    def test_sample_edit_preserves_date_and_missing_legacy_date(self):
        sample = copy.deepcopy(self.sample)
        for record in sample["problemRecords"]:
            record["createdAt"] = "2099-01-01"
            record["description"] += " edited"
        record_writers.update_sample_record(self.conn, sample)
        saved = self.saved("sample_records", "sample")
        self.assert_dates(saved["problemRecords"])
        self.assertTrue(saved["problemRecords"][0]["description"].endswith("edited"))
        del sample["problemRecords"][0]["createdAt"]
        record_writers.update_sample_record(self.conn, sample)
        self.assert_dates(self.saved("sample_records", "sample")["problemRecords"])

    def test_task_draft_and_completed_result_keep_date(self):
        task = copy.deepcopy(self.task)
        draft_only = {**self.record, "id": "draft-only", "description": "尚未同步的问题"}
        task["resultDraft"]["samples"][0]["problemRecords"].append(draft_only)
        record_writers.upsert_task_record(self.conn, task, "project", "stage")
        task["resultUploads"] = [copy.deepcopy(task["resultDraft"])]
        for container in [task["resultDraft"], *task["resultUploads"]]:
            for record in container["samples"][0]["problemRecords"]:
                record["createdAt"] = "2099-01-01"
        record_writers.upsert_task_record(self.conn, task, "project", "stage")
        saved = self.saved("project_tasks", "task")
        self.assert_dates(saved["resultDraft"]["samples"][0]["problemRecords"])
        self.assert_dates(saved["resultUploads"][0]["samples"][0]["problemRecords"])
        self.assertEqual(saved["resultUploads"][0]["samples"][0]["problemRecords"][2]["createdAt"], self.record["createdAt"])

    def test_full_state_keeps_dates_in_both_tables(self):
        state = copy.deepcopy(self.state)
        sample = state["sampleLibrary"]["categories"][0]["samples"][0]
        for record in sample["problemRecords"]:
            record["createdAt"] = "2099-01-01"
        server.sync_sample_library(self.conn, state)
        server.sync_project_library(self.conn, state)
        self.assert_dates(self.saved("sample_records", "sample")["problemRecords"])
        self.assert_dates(self.saved("project_tasks", "task")["resultDraft"]["samples"][0]["problemRecords"])

    def test_import_merges_identity_without_rewriting_or_duplicating_date(self):
        incoming = copy.deepcopy(self.state)
        records = incoming["sampleLibrary"]["categories"][0]["samples"][0]["problemRecords"]
        records[0]["createdAt"] = "2099-01-01"
        records[1]["createdAt"] = "2099-01-01"
        current = copy.deepcopy(self.state)
        self.assertEqual(import_commit.merge_import_sample_subrecords(current, incoming, {"sample": "sample"}), (0, 0))
        self.assert_dates(current["sampleLibrary"]["categories"][0]["samples"][0]["problemRecords"])


if __name__ == "__main__":
    unittest.main()
