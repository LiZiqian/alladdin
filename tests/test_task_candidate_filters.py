"""Candidate filters use the same three independent status axes as sample pools."""

import json
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from server_modules import database_schema, task_queries


class TaskCandidateFilterTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.addCleanup(self.conn.close)
        database_schema.ensure_static_schema(self.conn)
        for category_id, deleted_at in (("pool1", None), ("pool2", None), ("deleted_pool", "2026-09-20")):
            self.conn.execute(
                "INSERT INTO sample_categories (id, name, data_json, updated_at, deleted_at) VALUES (?, ?, '{}', '', ?)",
                (category_id, category_id, deleted_at),
            )
        fixtures = [
            ("a", "pool1", "target-a", "闲置", False, False),
            ("b", "pool1", "target-b", "闲置", True, False),
            ("c", "pool1", "target-c", "闲置", True, True),
            ("d", "pool1", "target-d", "测试中", True, True),
            ("e", "pool1", "skip-target-e", "闲置", True, True),
            ("f", "pool2", "target-f", "闲置", True, True),
            ("g", "pool1", "target-g", "取走分析", False, True),
            ("h", "pool1", "target-h", "闲置", False, False),
            ("i", "deleted_pool", "target-i", "闲置", True, True),
        ]
        for sample_id, category_id, sn, status, fault, reassembled in fixtures:
            # Boolean fields deliberately live only in indexed columns, as in
            # compact records; filtering cannot depend on JSON text matching.
            payload = {"id": sample_id, "sn": sn, "status": status}
            self.conn.execute(
                """INSERT INTO sample_records
                   (id, category_id, sn, status, has_problem, is_reassembled, data_json, created_at, updated_at,
                    sample_no, imei, owner, borrower, location)
                   VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '', '', '', '', '')""",
                (sample_id, category_id, sn, status, int(fault), int(reassembled), json.dumps(payload)),
            )

    def candidates(self, **query):
        return task_queries.list_task_sample_candidates_page(
            self.conn, {key: [str(value)] for key, value in query.items()}
        )

    def ids(self, **query):
        return {sample["id"] for sample in self.candidates(**query)["items"]}

    def test_fault_and_reassembly_are_independent(self):
        self.assertEqual(self.ids(), set("abcdefgh"))
        self.assertEqual(self.ids(problemState="fault"), set("bcdef"))
        self.assertEqual(self.ids(problemState="ok"), set("agh"))
        self.assertEqual(self.ids(reassembled="reassembled"), set("cdefg"))
        self.assertEqual(self.ids(reassembled="normal"), set("abh"))
        self.assertEqual(self.ids(problemState="ok", reassembled="normal"), set("ah"))
        self.assertEqual(self.ids(problemState="", reassembled=""), set("abcdefgh"))

    def test_all_filters_combine_before_count_and_pagination(self):
        query = dict(categoryId="pool1", problemState="fault", reassembled="reassembled", status="闲置", keyword="target")
        page = self.candidates(**query, pageSize=1, page=2)
        self.assertEqual((page["total"], page["totalPages"], page["page"]), (2, 2, 2))
        self.assertEqual([sample["id"] for sample in page["items"]], ["e"])
        page = self.candidates(**query, excludeKeyword="skip", pageSize=1, page=2)
        self.assertEqual((page["total"], page["totalPages"], page["page"]), (1, 1, 1))
        self.assertEqual([sample["id"] for sample in page["items"]], ["c"])

    def test_selected_samples_survive_conflicting_filters_and_stay_out_of_candidates(self):
        page = self.candidates(
            categoryId="pool1", problemState="ok", reassembled="normal", status="闲置",
            selectedIds="f,d,a,missing", pageSize=1,
        )
        self.assertEqual([sample["id"] for sample in page["selectedItems"]], ["f", "d", "a"])
        self.assertEqual(page["selectedMissingIds"], ["missing"])
        self.assertEqual(page["selectedCount"], 4)
        self.assertEqual(page["total"], 1)
        self.assertEqual([sample["id"] for sample in page["items"]], ["h"])
        self.assertTrue(all(sample["selectable"] for sample in page["selectedItems"]))

    def test_canonical_normalization_and_false_values(self):
        page = self.candidates(problemState="无故障", reassembled="0", status="闲置")
        self.assertEqual({sample["id"] for sample in page["items"]}, set("ah"))
        self.assertEqual(page["filters"]["problemState"], "ok")
        self.assertEqual(page["filters"]["reassembled"], "normal")
        self.assertTrue(all(not sample["hasProblem"] and not sample["isReassembled"] for sample in page["items"]))

    def test_filter_does_not_bypass_availability_or_deleted_records(self):
        page = self.candidates(problemState="fault", reassembled="reassembled", status="测试中")
        self.assertEqual([sample["id"] for sample in page["items"]], ["d"])
        self.assertFalse(page["items"][0]["selectable"])
        self.assertIn("测试中", page["items"][0]["disabledReason"])
        self.conn.execute("UPDATE sample_records SET deleted_at = '2026-09-20' WHERE id = 'c'")
        self.assertEqual(self.ids(problemState="fault", reassembled="reassembled", status="闲置"), set("ef"))


if __name__ == "__main__":
    unittest.main()
