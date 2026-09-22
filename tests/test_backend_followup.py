"""Second-pass business regressions; all fixtures are isolated in-memory DBs."""
import copy
import json
import unittest

from backend_fixture import empty_state, patched_server_db, server, state_conn
from server_modules import mutation_summary, project_queries, record_writers, sample_history, sample_queries, task_queries


class BackendFollowupTests(unittest.TestCase):
    def setUp(self):
        self.data = empty_state()
        self.data["projects"] = [{"id": "p", "name": "项目", "stages": [
            {"id": "stage", "name": "阶段", "tasks": []},
        ]}]
        self.data["sampleLibrary"]["categories"] = [
            {"id": "pool", "name": "样机池", "samples": [
                {"id": "s1", "sn": "SN-1", "status": "闲置", "location": "原位置"},
            ]},
            {"id": "other", "name": "其他池", "samples": [
                {"id": "s2", "sn": "SN-2", "status": "闲置", "location": "其他位置"},
            ]},
        ]
        self.conn = state_conn(self.data)
        self.conn.commit()
        self.addCleanup(self.conn.close)

    def mutate(self, method, payload):
        with patched_server_db(self.conn):
            return method(copy.deepcopy(payload), "127.0.0.1")

    def seed_tasks(self, tasks):
        self.data["projects"][0]["stages"][0]["tasks"] = tasks
        server.sync_project_library(self.conn, self.data)
        self.conn.commit()

    def snapshot(self):
        return list(self.conn.iterdump())

    def sample(self, sid="s1"):
        row = self.conn.execute("SELECT * FROM sample_records WHERE id = ?", (sid,)).fetchone()
        return sample_queries.sample_from_db_row(row)

    def archived_task(self, **extra):
        return {"id": "archived", "status": "进行中", "sampleIds": ["s1"], "archived": True, **extra}

    def test_batch_create_checks_stale_and_invalid_revisions_before_writing(self):
        for revision in (0, "invalid"):
            with self.subTest(revision=revision):
                before = self.snapshot()
                ok, result = self.mutate(server.commit_task_batch_mutation, {
                    "projectId": "p", "stageId": "stage", "revision": revision,
                    "action": "create_tasks_batch", "createIfMissing": True,
                    "tasks": [{"id": "new", "status": "待下发", "sampleIds": []}],
                })
                self.assertFalse(ok, result)
                self.assertIn(result["error_code"], {"TASK_REVISION_CONFLICT", "TASK_REVISION_INVALID"})
                self.assertEqual(self.snapshot(), before)

    def test_archived_nonterminal_task_does_not_block_stage_delete(self):
        self.seed_tasks([self.archived_task()])
        ok, result = self.mutate(server.commit_stage_mutation, {
            "projectId": "p", "stageId": "stage", "deleteStage": True,
        })
        self.assertTrue(ok, result)
        self.assertIsNotNone(self.conn.execute("SELECT deleted_at FROM project_stages WHERE id='stage'").fetchone()[0])

    def test_archived_nonterminal_task_does_not_require_project_release_payload(self):
        self.seed_tasks([self.archived_task()])
        ok, result = self.mutate(server.commit_project_mutation, {"projectId": "p", "deleteProject": True})
        self.assertTrue(ok, result)

    def test_archived_nonterminal_task_does_not_require_destroy_mutation(self):
        self.seed_tasks([self.archived_task()])
        ok, result = self.mutate(server.commit_sample_mutation, {"sampleId": "s1", "deleteSample": True})
        self.assertTrue(ok, result)
        self.assertIsNone(self.conn.execute("SELECT id FROM sample_records WHERE id='s1'").fetchone())

    def test_completed_result_not_locked_by_archived_or_json_deleted_task(self):
        completed = {"id": "completed", "status": "正常完成", "completed": True, "sampleIds": ["s1"]}
        for hidden in (self.archived_task(), self.archived_task(archived=False, deletedAt="2026-09-21")):
            with self.subTest(hidden=hidden):
                self.seed_tasks([hidden, completed])
                ok, result = self.mutate(server.commit_task_mutation, {
                    "projectId": "p", "stageId": "stage", "taskId": "completed", "task": completed,
                    "action": "upload_task_result", "samples": [{**self.sample(), "location": "追加结果位置"}],
                })
                self.assertTrue(ok, result)
                self.assertEqual(self.sample()["location"], "追加结果位置")

    def test_pool_mutation_cannot_edit_another_pool_sample(self):
        before = self.snapshot()
        ok, result = self.mutate(server.commit_sample_category_mutation, {
            "categoryId": "pool", "category": {"id": "pool", "name": "不应改名"},
            "samples": [{**self.sample("s2"), "location": "越界位置"}],
        })
        self.assertFalse(ok, result)
        self.assertEqual(self.snapshot(), before)

    def test_pool_create_cannot_insert_sample_into_another_or_missing_pool(self):
        for category_id in ("other", "missing"):
            with self.subTest(category_id=category_id):
                before = self.snapshot()
                ok, result = self.mutate(server.commit_sample_category_mutation, {
                    "categoryId": "pool", "category": {"id": "pool", "name": "不应改名"},
                    "createSamples": True,
                    "samples": [{"id": "new", "categoryId": category_id, "sn": "NEW-SN", "status": "闲置"}],
                })
                self.assertFalse(ok, result)
                self.assertEqual(self.snapshot(), before)

    def test_task_sample_ids_must_be_a_unique_array_of_nonempty_strings(self):
        task = {"id": "task", "status": "待下发", "sampleIds": ["s1"]}
        self.seed_tasks([task])
        for ids in ({"s1": True}, ["s1", "s1"], ["s1", ""], ["s1", None]):
            with self.subTest(ids=ids):
                before = self.snapshot()
                ok, result = self.mutate(server.commit_task_mutation, {
                    "projectId": "p", "stageId": "stage", "taskId": "task",
                    "action": "update_issue_record", "task": {**task, "sampleIds": ids},
                })
                self.assertFalse(ok, result)
                self.assertEqual(self.snapshot(), before)

    def test_task_owner_dropdown_value_matches_with_deep_keywords(self):
        self.seed_tasks([
            {"id": "t1", "status": "待下发", "sampleIds": [], "owner": "林测试/00107", "testItem": "温度测试"},
            {"id": "t2", "status": "待下发", "sampleIds": [], "owner": "周测试/00108", "testItem": "温度测试"},
        ])
        normal = task_queries.list_stage_tasks_page(self.conn, "stage", {"ownerName": ["林测试/00107"]})
        deep = task_queries.list_stage_tasks_page(self.conn, "stage", {"ownerName": ["林测试/00107"], "caseKeyword": ["温度"]})
        self.assertEqual(normal["total"], 1)
        self.assertEqual(deep["total"], 1)
        self.assertEqual(deep["stats"]["statusCounts"], {"待下发": 1})

    def test_task_owner_options_remain_available_after_selecting_a_person(self):
        self.seed_tasks([
            {"id": "t1", "status": "待下发", "sampleIds": [], "owner": "林测试/00107", "testItem": "温度测试"},
            {"id": "t2", "status": "待下发", "sampleIds": [], "owner": "周测试/00108", "testItem": "振动测试"},
        ])
        for extra in ({}, {"caseKeyword": ["温度"]}):
            with self.subTest(extra=extra):
                page = task_queries.list_stage_tasks_page(self.conn, "stage", {"ownerName": ["林测试/00107"], **extra})
                self.assertEqual(set(page["stats"]["ownerNames"]), {"林测试/00107", "周测试/00108"})

    def test_task_deep_search_keeps_progress_fallback_fields(self):
        self.data["projects"][0]["stages"][0]["progress"] = [
            {"id": "progress", "category": "可靠性", "testItem": "温度测试"},
        ]
        self.seed_tasks([{"id": "t1", "progressId": "progress", "status": "待下发", "sampleIds": []}])
        for query in ({"categoryKeyword": ["可靠性"]}, {"caseKeyword": ["温度"]}):
            with self.subTest(query=query):
                page = task_queries.list_stage_tasks_page(self.conn, "stage", query)
                self.assertEqual(page["total"], 1)

    def test_person_filter_treats_wildcards_as_literal_text(self):
        self.seed_tasks([
            {"id": "t1", "status": "待下发", "sampleIds": [], "owner": "测试_A/1"},
            {"id": "t2", "status": "待下发", "sampleIds": [], "owner": "测试BA/2"},
        ])
        page = task_queries.list_stage_tasks_page(self.conn, "stage", {"ownerName": ["测试_A"]})
        self.assertEqual([row["task"]["id"] for row in page["rows"]], ["t1"])

    def test_rejected_pool_destroy_cannot_mark_historical_sample_destroyed(self):
        self.seed_tasks([{"id": "completed", "status": "正常完成", "sampleIds": ["s1"]}])
        before = self.snapshot()
        ok, result = self.mutate(server.commit_sample_category_mutation, {
            "categoryId": "pool", "deleteCategory": True,
            "sampleEvents": [{"id": "bad-event", "sampleId": "s2", "source": "销毁"}],
        })
        self.assertFalse(ok, result)
        self.assertEqual(self.snapshot(), before)

    def test_string_false_is_not_a_destructive_operation_flag(self):
        cases = (
            (server.commit_sample_mutation, {"sampleId": "s1", "deleteSample": "false", "sample": self.sample()}),
            (server.commit_sample_category_mutation, {"categoryId": "pool", "deleteCategory": "false", "category": {"id": "pool"}}),
            (server.commit_project_mutation, {"projectId": "p", "deleteProject": "false", "project": {"id": "p"}}),
            (server.commit_stage_mutation, {"projectId": "p", "stageId": "stage", "deleteStage": "false", "stage": {"id": "stage"}}),
        )
        for method, payload in cases:
            with self.subTest(method=method.__name__):
                before = self.snapshot()
                ok, result = self.mutate(method, payload)
                self.assertFalse(ok, result)
                self.assertEqual(result["status"], 400)
                self.assertEqual(self.snapshot(), before)

    def test_archived_history_survives_parent_stage_deletion(self):
        self.seed_tasks([self.archived_task(logs=[{"id": "old-log", "action": "开始测试"}])])
        before = sample_history.list_sample_history_page(self.conn, "s1", {})
        self.assertEqual(before["total"], 1)
        ok, result = self.mutate(server.commit_stage_mutation, {"projectId": "p", "stageId": "stage", "deleteStage": True})
        self.assertTrue(ok, result)
        after = sample_history.list_sample_history_page(self.conn, "s1", {})
        self.assertEqual(after["total"], 1)
        self.assertIsNotNone(self.conn.execute("SELECT id FROM task_logs WHERE id='old-log'").fetchone())

    def test_archived_history_remains_searchable_after_parent_stage_deletion(self):
        self.seed_tasks([self.archived_task(testItem="旧归档温循用例")])
        ok, result = self.mutate(server.commit_stage_mutation, {"projectId": "p", "stageId": "stage", "deleteStage": True})
        self.assertTrue(ok, result)
        self.assertEqual(sample_history.list_sample_history_page(self.conn, "s1", {})["total"], 1)
        page = sample_queries.list_samples_page(self.conn, "pool", {"keyword": ["旧归档温循用例"]})
        self.assertEqual([sample["id"] for sample in page["items"]], ["s1"])

    def test_progress_task_counts_cover_all_pages_and_update_after_mutation(self):
        self.seed_tasks([
            {"id": f"t{i:03}", "status": "待下发" if i % 2 else "正常完成",
             "sampleIds": [], "progressId": "pg1" if i < 100 else "pg2"} for i in range(125)
        ] + [
            self.archived_task(progressId="pg1"),
            {"id": "removed", "status": "待下发", "sampleIds": [], "progressId": "pg2", "deletedAt": "2026-09-21"},
            {"id": "no-progress", "status": "待下发", "sampleIds": []},
        ])
        page = task_queries.list_stage_tasks_page(self.conn, "stage", {"pageSize": ["25"]})
        self.assertEqual(len(page["rows"]), 25)
        stage = project_queries.load_project_detail(self.conn, "p")["stages"][0]
        self.assertEqual(stage["progressTaskCounts"], {"pg1": 100, "pg2": 25})
        self.assertEqual(stage["taskCount"], 126)
        self.assertEqual(sum(stage["statusCounts"].values()), 126)
        ok, result = self.mutate(server.commit_task_batch_mutation, {
            "projectId": "p", "stageId": "stage", "action": "create_tasks_batch", "createIfMissing": True,
            "tasks": [{"id": "new", "status": "待下发", "sampleIds": [], "progressId": "pg2"}],
        })
        self.assertTrue(ok, result)
        self.assertEqual(result["affected"]["stageSummaries"][0]["progressTaskCounts"], {"pg1": 100, "pg2": 26})

    def test_empty_stage_has_empty_progress_counts(self):
        stage = project_queries.load_project_detail(self.conn, "p")["stages"][0]
        self.assertEqual(stage["progressTaskCounts"], {})

    def test_revisions_reject_booleans_and_noninteger_numbers(self):
        for value in (True, False, 1.0, 1.5, "1.5", float("inf")):
            with self.subTest(value=value):
                before = self.snapshot()
                ok, result = self.mutate(server.commit_project_mutation, {
                    "projectId": "p", "project": {"id": "p", "name": "不应改名"}, "revision": value,
                })
                self.assertFalse(ok, result)
                self.assertEqual(result["error_code"], "MUTATION_REVISION_INVALID")
                self.assertEqual(self.snapshot(), before)

    def test_sample_search_and_exclusion_treat_percent_as_literal(self):
        page = task_queries.list_task_sample_candidates_page(self.conn, {"keyword": ["%"]})
        self.assertEqual(page["total"], 0)
        excluded = task_queries.list_task_sample_candidates_page(self.conn, {"excludeKeyword": ["%"]})
        self.assertEqual(excluded["total"], 2)

    def test_sample_history_search_treats_percent_as_literal(self):
        self.data["sampleLibrary"]["categories"][0]["samples"].extend(self.data["sampleLibrary"]["categories"][1]["samples"])
        self.data["sampleLibrary"]["categories"][1]["samples"] = []
        server.sync_sample_library(self.conn, self.data)
        self.seed_tasks([
            {"id": "t1", "status": "正常完成", "sampleIds": ["s1"], "testItem": "容量 50%"},
            {"id": "t2", "status": "正常完成", "sampleIds": ["s2"], "testItem": "容量 5000"},
        ])
        page = sample_queries.list_samples_page(self.conn, "pool", {"keyword": ["50%"]})
        self.assertEqual([item["id"] for item in page["items"]], ["s1"])

    def test_sample_people_filter_uses_literal_substrings_in_both_paths(self):
        self.data["sampleLibrary"]["categories"][0]["samples"].extend(self.data["sampleLibrary"]["categories"][1]["samples"])
        self.data["sampleLibrary"]["categories"][1]["samples"] = []
        for sample, person in zip(self.data["sampleLibrary"]["categories"][0]["samples"], ("Team_A/1", "TeamBA/2")):
            sample.update(owner=person, borrower=person)
        server.sync_sample_library(self.conn, self.data)
        for field in ("owner", "borrower"):
            for extra in ({}, {"keyword": ["SN"]}):
                with self.subTest(field=field, extra=extra):
                    page = sample_queries.list_samples_page(self.conn, "pool", {field: ["Team_A"], **extra})
                    self.assertEqual([item["id"] for item in page["items"]], ["s1"])

    def test_archived_task_cannot_excuse_missing_finish_sample_payload(self):
        self.seed_tasks([self.archived_task(), {"id": "running", "status": "进行中", "sampleIds": ["s1"]}])
        before = self.snapshot()
        ok, result = self.mutate(server.commit_task_mutation, {
            "projectId": "p", "stageId": "stage", "taskId": "running", "action": "finish_task_result",
            "task": {"id": "running", "status": "正常完成", "sampleIds": ["s1"]},
        })
        self.assertFalse(ok, result)
        self.assertEqual(result["error_code"], "TASK_SAMPLE_PAYLOAD_MISMATCH")
        self.assertEqual(self.snapshot(), before)

    def test_tested_item_names_do_not_depend_on_loaded_task_pages(self):
        self.seed_tasks([
            {"id": f"t{i:03}", "status": "正常完成", "sampleIds": ["s1"], "testItem": f"用例{i%4}"} for i in range(125)
        ] + [
            {"id": "archived", "status": "异常终止", "sampleIds": ["s1"], "testItem": "归档用例", "archived": True},
            {"id": "planned", "status": "待下发", "sampleIds": ["s1"], "testItem": "尚未测试"},
            {"id": "empty", "status": "正常完成", "sampleIds": ["s1"], "testItem": "  "},
            {"id": "removed", "status": "正常完成", "sampleIds": [], "testItem": "退出引用", "removedSampleRecords": [{"sampleId": "s1"}]},
            {"id": "deleted", "status": "正常完成", "sampleIds": ["s1"], "testItem": "已删除用例"},
        ])
        self.conn.execute("UPDATE project_tasks SET deleted_at='2026-09-21' WHERE id='deleted'")
        self.conn.commit()
        expected = {"用例0", "用例1", "用例2", "用例3", "归档用例"}
        candidate = task_queries.list_task_sample_candidates_page(self.conn, {"selectedIds": ["s1"]})
        self.assertEqual(set(candidate["selectedItems"][0]["testedItemNames"]), expected)
        self.assertEqual(candidate["items"][0]["testedItemNames"], [])
        for query in ({}, {"keyword": ["SN-1"]}):
            page = sample_queries.list_samples_page(self.conn, "pool", query)
            self.assertEqual(set(page["items"][0]["testedItemNames"]), expected)
        detail = sample_queries.load_sample_category_detail(self.conn, "pool")
        self.assertEqual(set(detail["samples"][0]["testedItemNames"]), expected)
        affected = mutation_summary.build_mutation_affected_summary(self.conn, sample_ids=["s1", "s2"])
        self.assertEqual(set(affected["samples"][0]["testedItemNames"]), expected)
        self.assertEqual(affected["samples"][1]["testedItemNames"], [])

    def test_started_task_updates_tested_names_without_persisting_derived_field(self):
        task = {"id": "new", "status": "待下发", "sampleIds": ["s1"], "testItem": "新增用例"}
        self.seed_tasks([task])
        ok, result = self.mutate(server.commit_task_mutation, {
            "projectId": "p", "stageId": "stage", "taskId": "new", "action": "start_task",
            "task": {**task, "status": "进行中"}, "samples": [self.sample()],
        })
        self.assertTrue(ok, result)
        self.assertEqual(result["affected"]["samples"][0]["testedItemNames"], ["新增用例"])
        record_writers.update_sample_record(self.conn, {**self.sample(), "testedItemNames": ["stale"]})
        self.assertNotIn("testedItemNames", json.loads(self.conn.execute("SELECT data_json FROM sample_records WHERE id='s1'").fetchone()[0]))


if __name__ == "__main__":
    unittest.main()
