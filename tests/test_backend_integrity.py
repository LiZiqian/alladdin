"""Regression coverage for incremental business writes and query consistency."""
import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend_fixture import empty_state, patched_server_db, server, state_conn
from server_modules import mutation_summary, project_queries, record_writers, sample_queries, status_normalization, task_queries


class BackendIntegrityTests(unittest.TestCase):
    def setUp(self):
        data = empty_state()
        data["projects"] = [
            {"id": "p1", "name": "项目1", "stages": [
                {"id": "st1", "name": "阶段1", "tasks": []},
                {"id": "st2", "name": "最新阶段名", "skuNames": ["最新SKU"], "tasks": []},
            ]},
            {"id": "p2", "name": "项目2", "stages": [
                {"id": "foreign", "name": "其他项目阶段", "tasks": []},
            ]},
        ]
        data["sampleLibrary"]["categories"] = [{"id": "pool", "name": "样机池", "samples": [
            {"id": "s1", "sn": "SN1", "status": "闲置", "location": "原位置1"},
            {"id": "s2", "sn": "SN2", "status": "闲置", "location": "原位置2"},
        ]}]
        self.data = data
        self.conn = state_conn(data)
        self.addCleanup(self.conn.close)

    def mutation(self, method, payload):
        with patched_server_db(self.conn):
            return method(copy.deepcopy(payload), "127.0.0.1")

    def sample(self, sid):
        return sample_queries.sample_from_db_row(self.conn.execute("SELECT * FROM sample_records WHERE id = ?", (sid,)).fetchone())

    def stage(self, sid):
        row = self.conn.execute("SELECT * FROM project_stages WHERE id = ?", (sid,)).fetchone()
        return {**dict(row), "payload": json.loads(row["data_json"])}

    def seed_tasks(self, tasks):
        self.data["projects"][0]["stages"][0]["tasks"] = tasks
        server.sync_project_library(self.conn, self.data)

    def test_sample_update_keeps_primary_payload_with_related_samples(self):
        ok, result = self.mutation(server.commit_sample_mutation, {
            "sampleId": "s1", "sample": {**self.sample("s1"), "location": "新位置1"},
            "samples": [{**self.sample("s2"), "location": "新位置2"}],
        })
        self.assertTrue(ok, result)
        self.assertEqual(self.sample("s1")["location"], "新位置1")
        self.assertEqual(self.sample("s2")["location"], "新位置2")

    def test_stage_edit_does_not_overwrite_sibling_business_fields(self):
        ok, result = self.mutation(server.commit_stage_mutation, {
            "projectId": "p1", "stageId": "st1", "stage": {"id": "st1", "name": "编辑主阶段"},
            "stages": [{"id": "st2", "name": "旧阶段名", "skuNames": []}, {"id": "st1"}],
        })
        self.assertTrue(ok, result)
        self.assertEqual(self.stage("st2")["name"], "最新阶段名")
        self.assertEqual(self.stage("st2")["payload"]["skuNames"], ["最新SKU"])
        self.assertEqual(self.stage("st2")["sort_order"], 0)

    def test_stage_sibling_cannot_move_other_project_stage(self):
        before = self.stage("st1")
        ok, result = self.mutation(server.commit_stage_mutation, {
            "projectId": "p1", "stageId": "st1", "stage": {"id": "st1", "name": "不应保存"},
            "stages": [{"id": "st1"}, {"id": "foreign", "name": "越界"}],
        })
        self.assertFalse(ok, result)
        self.assertEqual(result["error_code"], "STAGE_SCOPE_CONFLICT")
        self.assertEqual(self.stage("st1"), before)
        self.assertEqual(self.stage("foreign")["project_id"], "p2")

    def test_stage_delete_rechecks_live_sample_occupancy(self):
        self.seed_tasks([{"id": "t1", "status": "待下发", "sampleIds": ["s1"]}])
        ok, result = self.mutation(server.commit_stage_mutation, {
            "projectId": "p1", "stageId": "st1", "deleteStage": True, "stages": [{"id": "st2"}],
        })
        self.assertFalse(ok, result)
        self.assertEqual(result["error_code"], "STAGE_HAS_OCCUPIED_TASKS")
        self.assertIsNone(self.stage("st1")["deleted_at"])

    def test_sku_zero_matches_with_and_without_deep_keyword(self):
        self.seed_tasks([{"id": "t1", "status": "待下发", "skuIndex": 0, "testItem": "温度试验", "sampleIds": []}])
        normal = task_queries.list_stage_tasks_page(self.conn, "st1", {"sku": ["0"]})
        deep = task_queries.list_stage_tasks_page(self.conn, "st1", {"sku": ["0"], "caseKeyword": ["温度"]})
        self.assertEqual(normal["total"], 1)
        self.assertEqual(deep["total"], 1)

    def test_deep_query_status_counts_apply_exact_filters(self):
        self.seed_tasks([
            {"id": "t1", "status": "待下发", "testItem": "温度试验", "resultSummary": "needle", "sampleIds": []},
            {"id": "t2", "status": "进行中", "testItem": "振动试验", "resultSummary": "other", "sampleIds": []},
        ])
        page = task_queries.list_stage_tasks_page(self.conn, "st1", {"resultKeyword": ["needle"]})
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["stats"]["totalInStage"], 1)
        self.assertEqual(page["stats"]["statusCounts"], {"待下发": 1})

    def test_stage_sample_counts_cover_all_pages_and_exclude_archived_tasks(self):
        tasks = [{"id": f"running-{index:03}", "status": "进行中", "sampleIds": ["s1"]} for index in range(125)]
        tasks.extend([
            {"id": "running-other", "status": "进行中", "sampleIds": ["s2"]},
            {"id": "blocked", "status": "阻塞中", "sampleIds": ["s1", "s2"]},
            {"id": "finished", "status": "正常完成", "sampleIds": ["s1", "s2"]},
            {"id": "aborted", "status": "异常终止", "sampleIds": ["s1"]},
            {"id": "pending", "status": "待下发", "sampleIds": ["s1", "s2"]},
            {"id": "archived", "status": "进行中", "sampleIds": ["not-current"], "archived": True},
            {"id": "deleted", "status": "进行中", "sampleIds": ["not-current"], "deletedAt": "2026-09-20"},
            {"id": "database-deleted", "status": "进行中", "sampleIds": ["not-current"]},
        ])
        self.seed_tasks(tasks)
        self.conn.execute("UPDATE project_tasks SET deleted_at = '2026-09-20' WHERE id = 'database-deleted'")
        self.conn.commit()
        project = project_queries.load_project_detail(self.conn, "p1")
        first, empty = project["stages"]
        self.assertEqual(first["tasks"], [])
        self.assertEqual(first.get("usedSampleRuns"), 131)
        self.assertEqual(first.get("runningSampleCount"), 2)
        self.assertEqual(empty.get("usedSampleRuns"), 0)
        self.assertEqual(empty.get("runningSampleCount"), 0)
        page = task_queries.list_stage_tasks_page(self.conn, "st1", {"pageSize": ["50"]})
        self.assertEqual(len(page["rows"]), 50)
        full = project_queries.load_project_detail(self.conn, "p1", include_tasks=True)["stages"][0]
        self.assertEqual(full["usedSampleRuns"], first["usedSampleRuns"])
        self.assertEqual(full["runningSampleCount"], first["runningSampleCount"])

    def test_stage_usage_includes_removed_samples_once_per_task(self):
        self.seed_tasks([
            {"id": "finished", "status": "正常完成", "sampleIds": ["s1"],
             "removedSampleRecords": [{"sampleId": "s2"}, {"sampleId": "s2"}, {"sampleId": "s1"}, {"sid": "s3"}, {}]},
            {"id": "running", "status": "进行中", "sampleIds": ["s2"],
             "removedSampleRecords": [{"sampleId": "s1"}]},
            {"id": "pending", "status": "待下发", "sampleIds": ["s1"], "removedSampleRecords": [{"sampleId": "s4"}]},
            {"id": "archived", "status": "正常完成", "archived": True, "sampleIds": [], "removedSampleRecords": [{"sampleId": "s5"}]},
        ])
        stage = project_queries.load_project_detail(self.conn, "p1")["stages"][0]
        self.assertEqual(stage["usedSampleRuns"], 5)
        self.assertEqual(stage["runningSampleCount"], 1)
        task_queries.list_stage_tasks_page(self.conn, "st1", {"status": ["待下发"], "pageSize": ["1"]})
        self.assertEqual(project_queries.load_stage_sample_summaries(self.conn, ["st1"])[0]["usedSampleRuns"], 5)

    def test_task_mutation_returns_current_stage_sample_counts(self):
        self.seed_tasks([
            {"id": "first", "status": "进行中", "sampleIds": ["s1"]},
            {"id": "second", "status": "进行中", "sampleIds": ["s2"]},
        ])
        ok, result = self.mutation(server.commit_task_mutation, {
            "projectId": "p1", "stageId": "st1", "taskId": "first",
            "action": "block_task",
            "task": {"id": "first", "status": "阻塞中", "sampleIds": ["s1"]},
            "samples": [self.sample("s1")],
        })
        self.assertTrue(ok, result)
        self.assertEqual(result["affected"].get("stageSummaries"), [{
            "id": "st1", "usedSampleRuns": 2, "runningSampleCount": 1,
            "taskCount": 2, "statusCounts": {"进行中": 1, "阻塞中": 1}, "progressTaskCounts": {},
        }])

    def test_stage_mutation_summary_counts_unassigned_tasks_without_page_filters(self):
        self.seed_tasks([
            {"id": "running", "status": "进行中", "sampleIds": ["s1", "s2"], "owner": "Alice", "testItem": "temperature"},
            {"id": "unassigned", "status": "待下发", "sampleIds": [], "owner": "Bob", "testItem": "drop"},
            {"id": "running-empty", "status": "进行中", "sampleIds": [], "owner": "Bob", "testItem": "drop"},
            {"id": "complete", "status": "正常完成", "sampleIds": ["s1"], "owner": "Bob", "testItem": "drop"},
            {"id": "archived", "status": "进行中", "sampleIds": ["s2"], "archived": True},
        ])
        filtered = task_queries.list_stage_tasks_page(self.conn, "st1", {"ownerName": ["Alice"], "caseKeyword": ["temperature"]})
        self.assertEqual(filtered["stats"]["statusCounts"], {"进行中": 1})
        summaries = mutation_summary.build_mutation_affected_summary(self.conn, stage_ids=["st1", "st2"])["stageSummaries"]
        self.assertEqual(summaries, [
            {"id": "st1", "taskCount": 4, "statusCounts": {"待下发": 1, "进行中": 2, "正常完成": 1}, "usedSampleRuns": 3, "runningSampleCount": 2, "progressTaskCounts": {}},
            {"id": "st2", "taskCount": 0, "statusCounts": {}, "usedSampleRuns": 0, "runningSampleCount": 0, "progressTaskCounts": {}},
        ])
        project = project_queries.load_project_detail(self.conn, "p1")
        for stage, summary in zip(project["stages"], summaries):
            self.assertEqual({key: stage[key] for key in summary}, summary)

    def test_status_text_does_not_corrupt_ordinary_english_words(self):
        self.assertEqual(status_normalization.normalize_sample_payload({"notes": "BOOK TOKEN SMOKE OK"})["notes"], "BOOK TOKEN SMOKE OK")

    def test_record_mutations_reject_stale_revision_without_writes(self):
        mutations = [
            (server.commit_sample_mutation, {"sampleId": "s1", "sample": {**self.sample("s1"), "location": "旧页"}}),
            (server.commit_project_mutation, {"projectId": "p1", "project": {"id": "p1", "name": "旧页"}}),
            (server.commit_stage_mutation, {"projectId": "p1", "stageId": "st1", "stage": {"id": "st1", "name": "旧页"}}),
            (server.commit_sample_category_mutation, {"categoryId": "pool", "category": {"id": "pool", "name": "旧页"}}),
        ]
        before = server.compose_state(self.conn)
        for method, payload in mutations:
            with self.subTest(method=method.__name__):
                ok, result = self.mutation(method, {**payload, "revision": 0})
                self.assertFalse(ok, result)
                self.assertEqual(result["error_code"], "MUTATION_REVISION_CONFLICT")
                self.assertEqual(server.compose_state(self.conn), before)

    def test_reordering_stage_does_not_restore_stale_primary_fields(self):
        ok, result = self.mutation(server.commit_stage_mutation, {
            "projectId": "p1", "stageId": "st2", "action": "reorder_stages",
            "stage": {"id": "st2", "name": "旧阶段名", "skuNames": []},
            "stages": [{"id": "st2"}, {"id": "st1"}],
        })
        self.assertTrue(ok, result)
        self.assertEqual(self.stage("st2")["name"], "最新阶段名")

    def test_sample_search_combines_direct_and_history_matches(self):
        record_writers.update_sample_record(self.conn, {**self.sample("s1"), "notes": "needle"})
        record_writers.upsert_sample_events(self.conn, [{"id": "event1", "sampleId": "s2", "source": "needle"}])
        page = sample_queries.list_samples_page(self.conn, "pool", {"keyword": ["needle"]})
        self.assertEqual({item["id"] for item in page["items"]}, {"s1", "s2"})

    def test_sample_search_retains_deleted_stage_completed_history(self):
        self.seed_tasks([{"id": "t1", "status": "正常完成", "sampleIds": ["s1"], "testItem": "needle"}])
        record_writers.delete_stage_record(self.conn, "st1")
        page = sample_queries.list_samples_page(self.conn, "pool", {"keyword": ["needle"]})
        self.assertEqual([item["id"] for item in page["items"]], ["s1"])

    def test_keyword_sample_facet_counts_match_non_keyword_counts(self):
        record_writers.update_sample_record(self.conn, {**self.sample("s1"), "notes": "needle"})
        record_writers.update_sample_record(self.conn, {**self.sample("s2"), "notes": "needle", "problemRecords": [{"description": "failure"}], "status": "取走分析"})
        for filters in ({"problemState": ["fault"]}, {"status": ["闲置"]}):
            with self.subTest(filters=filters):
                normal = sample_queries.list_samples_page(self.conn, "pool", filters)
                searched = sample_queries.list_samples_page(self.conn, "pool", {**filters, "keyword": ["needle"]})
                for key in ("statusCounts", "problemCounts"):
                    self.assertEqual({k: v for k, v in normal["stats"][key].items() if v}, {k: v for k, v in searched["stats"][key].items() if v})

    def test_destroy_rejects_task_body_identity_mismatch(self):
        self.seed_tasks([
            {"id": "t1", "status": "待下发", "sampleIds": ["s1"]},
            {"id": "other", "status": "待下发", "sampleIds": []},
        ])
        ok, result = self.mutation(server.commit_sample_mutation, {
            "sampleId": "s1", "deleteSample": True,
            "taskMutations": [{"projectId": "p1", "stageId": "st1", "taskId": "t1",
                               "task": {"id": "other", "status": "待下发", "sampleIds": []}}],
        })
        self.assertFalse(ok, result)
        self.assertEqual(result["error_code"], "SAMPLE_DESTROY_SCOPE_CHANGED")
        self.assertIsNotNone(self.sample("s1"))

    def test_destroy_preserves_current_stage_and_other_reservations(self):
        self.seed_tasks([
            {"id": "t1", "status": "进行中", "sampleIds": ["s1", "s2"], "planStartDate": "2026-09-01", "planEndDate": "2026-09-02"},
            {"id": "next", "status": "待下发", "sampleIds": ["s2"], "planStartDate": "2026-10-01", "planEndDate": "2026-10-02"},
        ])
        ok, result = self.mutation(server.commit_sample_mutation, {
            "sampleId": "s1", "deleteSample": True,
            "taskMutations": [{"projectId": "p1", "stageId": "st1", "taskId": "t1",
                               "stage": {"id": "st1", "name": "旧阶段名称"},
                               "task": {"id": "t1", "status": "异常终止", "sampleIds": []}}],
            "samples": [{**self.sample("s2"), "sn": "STALE-SN", "status": "闲置"}],
        })
        self.assertTrue(ok, result)
        self.assertEqual(self.stage("st1")["name"], "阶段1")
        self.assertEqual(self.sample("s2")["sn"], "SN2")
        self.assertEqual(self.sample("s2")["currentTaskId"], "next")
        self.assertEqual(self.sample("s2")["status"], "在位等待")

    def test_project_detail_person_counts_are_global_and_keep_identity_text(self):
        record_writers.update_sample_record(self.conn, {**self.sample("s1"), "owner": "张三/001", "borrower": "李四/002"})
        record_writers.update_sample_record(self.conn, {**self.sample("s2"), "owner": "张三/001"})
        project = project_queries.load_project_detail(self.conn, "p1")
        self.assertEqual(project["samplePersonCounts"], {"owner": {"张三/001": 2}, "borrower": {"李四/002": 1}})
        self.conn.execute("UPDATE sample_records SET deleted_at = 'deleted' WHERE id = 's2'")
        self.assertEqual(project_queries.load_project_detail(self.conn, "p2")["samplePersonCounts"]["owner"], {"张三/001": 1})
        summary = mutation_summary.build_mutation_affected_summary(self.conn, sample_ids=["s1"])
        self.assertEqual(summary["samplePersonCounts"], {"owner": {"张三/001": 1}, "borrower": {"李四/002": 1}})
        record_writers.update_project_record(self.conn, project)
        stored = json.loads(self.conn.execute("SELECT data_json FROM project_records WHERE id = 'p1'").fetchone()[0])
        self.assertNotIn("samplePersonCounts", stored)

    def test_nested_legacy_terminal_status_is_not_reopened(self):
        for legacy in ("Fail", "FAIL", "失败"):
            with self.subTest(legacy=legacy):
                data = copy.deepcopy(self.data)
                data["projects"][0]["stages"][0]["tasks"] = [{"id": "t1", "status": legacy, "sampleIds": ["s1"]}]
                with self.assertRaises(ValueError):
                    status_normalization.normalize_state_payload(data)

    def test_nested_legacy_sample_fault_is_preserved(self):
        data = copy.deepcopy(self.data)
        data["sampleLibrary"]["categories"][0]["samples"][0]["status"] = "故障"
        with self.assertRaises(ValueError):
            status_normalization.normalize_state_payload(data)

    def test_sample_identity_update_is_rechecked_inside_write_transaction(self):
        before = self.sample("s1")
        ok, result = self.mutation(server.commit_sample_mutation, {
            "sampleId": "s1", "sample": {**before, "imei": "sn2"},
        })
        self.assertFalse(ok, result)
        self.assertEqual(result["error_code"], "SAMPLE_IDENTITY_CONFLICT")
        self.assertEqual(self.sample("s1"), before)

    def test_batch_sample_creation_rejects_duplicate_identities_atomically(self):
        before = server.compose_state(self.conn)
        ok, result = self.mutation(server.commit_sample_category_mutation, {
            "categoryId": "pool", "category": {"id": "pool", "name": "样机池"}, "createSamples": True,
            "samples": [{"id": "new1", "categoryId": "pool", "sn": "NEW-SN"},
                        {"id": "new2", "categoryId": "pool", "boardSn": "new-sn"}],
        })
        self.assertFalse(ok, result)
        self.assertEqual(result["error_code"], "SAMPLE_IDENTITY_CONFLICT")
        self.assertEqual(server.compose_state(self.conn), before)

    def test_reassembled_sample_can_share_identity(self):
        ok, result = self.mutation(server.commit_sample_mutation, {
            "sampleId": "s1", "sample": {**self.sample("s1"), "sn": "SN2", "isReassembled": True},
        })
        self.assertTrue(ok, result)

    def test_existing_identity_conflict_is_rejected_without_writes(self):
        record_writers.update_sample_record(self.conn, {**self.sample("s1"), "sn": "SN2"})
        before = server.compose_state(self.conn)
        ok, result = self.mutation(server.commit_sample_mutation, {
            "sampleId": "s1", "sample": {**self.sample("s1"), "notes": "Only a note"},
        })
        self.assertFalse(ok, result)
        self.assertEqual(result["error_code"], "SAMPLE_IDENTITY_CONFLICT")
        self.assertEqual(server.compose_state(self.conn), before)

    def test_invalid_project_or_stage_payload_cannot_commit_sample_side_effects(self):
        for method, scope in ((server.commit_project_mutation, {"projectId": "p1"}),
                              (server.commit_stage_mutation, {"projectId": "p1", "stageId": "st1"})):
            with self.subTest(method=method.__name__):
                before = server.compose_state(self.conn)
                incoming_status = "闲置" if self.sample("s1")["status"] == "取走分析" else "取走分析"
                ok, result = self.mutation(method, {**scope, "samples": [{**self.sample("s1"), "status": incoming_status}]})
                self.assertFalse(ok, result)
                self.assertEqual(server.compose_state(self.conn), before)

    def test_project_summary_cannot_overwrite_full_configuration(self):
        for markers in ({"_summaryOnly": True}, {"_summary": True}, {"_detailLoaded": False}):
            with self.subTest(markers=markers):
                ok, result = self.mutation(server.commit_project_mutation, {
                    "projectId": "p1", "project": {"id": "p1", "name": "摘要", **markers},
                })
                self.assertFalse(ok, result)
                self.assertEqual(result["error_code"], "PROJECT_DETAIL_REQUIRED")

    def test_category_summary_edit_keeps_unloaded_custom_metadata(self):
        category = {"id": "pool", "name": "样机池", "custom": {"purpose": "must survive"}}
        record_writers.update_sample_category_record(self.conn, category)
        ok, result = self.mutation(server.commit_sample_category_mutation, {
            "categoryId": "pool", "category": {"id": "pool", "name": "新池名", "sampleCount": 2, "statusCounts": {"闲置": 2}, "_summaryOnly": True},
        })
        self.assertTrue(ok, result)
        saved = json.loads(self.conn.execute("SELECT data_json FROM sample_categories WHERE id = 'pool'").fetchone()[0])
        self.assertEqual(saved["custom"], category["custom"])
        self.assertNotIn("sampleCount", saved)
        self.assertNotIn("_summaryOnly", saved)

    def test_legacy_effective_status_does_not_split_current_usage_counts(self):
        self.conn.execute("UPDATE sample_records SET effective_status = '故障' WHERE id = 's2'")
        category = sample_queries.list_sample_categories_summary(self.conn)[0]
        page = sample_queries.list_samples_page(self.conn, "pool", {})
        self.assertEqual(category["statusCounts"], {"闲置": 2})
        self.assertEqual(page["stats"]["statusCounts"], {"闲置": 2})

    def test_archived_tasks_stay_in_history_but_not_workspace_queries(self):
        self.seed_tasks([
            {"id": "live", "status": "待下发", "sampleIds": [], "testItem": "needle"},
            {"id": "archived", "status": "正常完成", "completed": True, "sampleIds": ["s1"], "archived": True, "deletedAt": "2026-09-01", "testItem": "needle"},
        ])
        for query in ({}, {"caseKeyword": ["needle"]}):
            page = task_queries.list_stage_tasks_page(self.conn, "st1", query)
            self.assertEqual([row["task"]["id"] for row in page["rows"]], ["live"])
            self.assertEqual(page["stats"]["totalInStage"], 1)
        project = project_queries.load_project_detail(self.conn, "p1", include_tasks=True)
        self.assertEqual(project["stages"][0]["taskCount"], 1)
        self.assertEqual([task["id"] for task in project["stages"][0]["tasks"]], ["live"])
        self.assertEqual(project_queries.list_project_summary(self.conn)[0]["taskCount"], 1)
        self.assertEqual(server.list_sample_history_page(self.conn, "s1", {})["total"], 1)
        self.assertEqual(len(project_queries.load_project_library(self.conn)[0]["stages"][0]["tasks"]), 2)

    def test_sample_page_people_options_cover_unloaded_pages(self):
        record_writers.update_sample_record(self.conn, {**self.sample("s1"), "owner": "张三/001", "borrower": "李四/002"})
        record_writers.update_sample_record(self.conn, {**self.sample("s2"), "owner": "王五/003"})
        page = sample_queries.list_samples_page(self.conn, "pool", {"pageSize": ["1"], "keyword": ["SN1"]})
        self.assertEqual(len(page["items"]), 1)
        self.assertEqual(set(page["stats"]["ownerNames"]), {"张三/001", "王五/003"})
        self.assertEqual(page["stats"]["borrowerNames"], ["李四/002"])

    def test_visible_task_queries_use_partial_indexes(self):
        visibility = task_queries.task_visibility_sql()
        queries = [
            f"SELECT project_id, COUNT(*) FROM project_tasks WHERE deleted_at IS NULL AND {visibility} GROUP BY project_id",
            f"SELECT id FROM project_tasks WHERE stage_id = 'st1' AND deleted_at IS NULL AND {visibility} ORDER BY created_at, id LIMIT 50",
        ]
        for query in queries:
            with self.subTest(query=query):
                plan = " ".join(str(row[3]) for row in self.conn.execute("EXPLAIN QUERY PLAN " + query))
                self.assertIn("visible", plan)


    def test_new_indexes_do_not_block_repair_of_legacy_invalid_task_json(self):
        self.seed_tasks([{"id": "legacy", "status": "待下发", "sampleIds": []}])
        for row in self.conn.execute("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_project_tasks_visible_%'").fetchall():
            self.conn.execute(f"DROP INDEX {row[0]}")
        self.conn.execute("UPDATE project_tasks SET data_json = 'invalid legacy json' WHERE id = 'legacy'")
        server.ensure_schema(self.conn)
        self.assertEqual(task_queries.list_stage_tasks_page(self.conn, "st1", {})["total"], 1)

    def test_sample_edits_cannot_bypass_task_scope_and_state_rules(self):
        self.seed_tasks([{"id": "t1", "status": "待下发", "sampleIds": []}])
        task_mutations = [{"projectId": "p2", "stageId": "foreign", "taskId": "t1", "task": {
            "id": "t1", "projectId": "p2", "stageId": "foreign", "status": "进行中", "sampleIds": ["s1"],
        }}]
        for method, scope in ((server.commit_sample_mutation, {"sampleId": "s1", "sample": self.sample("s1")}),
                              (server.commit_sample_category_mutation, {"categoryId": "pool", "category": {"id": "pool", "name": "池"}})):
            with self.subTest(method=method.__name__):
                before = server.compose_state(self.conn)
                ok, result = self.mutation(method, {**scope, "taskMutations": task_mutations})
                self.assertFalse(ok, result)
                self.assertEqual(server.compose_state(self.conn), before)

    def test_empty_pool_destroy_cannot_mutate_unrelated_task(self):
        record_writers.update_sample_category_record(self.conn, {"id": "empty", "name": "空池"}, create_if_missing=True)
        self.seed_tasks([{"id": "t1", "status": "待下发", "sampleIds": []}])
        before = server.compose_state(self.conn)
        ok, result = self.mutation(server.commit_sample_category_mutation, {
            "categoryId": "empty", "deleteCategory": True,
            "taskMutations": [{"projectId": "p2", "stageId": "foreign", "taskId": "t1", "task": {"id": "t1", "status": "正常完成", "sampleIds": []}}],
        })
        self.assertFalse(ok, result)
        self.assertEqual(server.compose_state(self.conn), before)

    def test_destroy_task_payload_cannot_add_samples_or_skip_required_termination(self):
        for current_status, remaining, incoming_status in (("待下发", ["s2"], "待下发"), ("进行中", [], "进行中")):
            with self.subTest(current_status=current_status):
                server.sync_sample_library(self.conn, self.data)
                self.seed_tasks([{"id": "t1", "status": current_status, "sampleIds": ["s1"]}])
                before = server.compose_state(self.conn)
                ok, result = self.mutation(server.commit_sample_mutation, {
                    "sampleId": "s1", "deleteSample": True,
                    "taskMutations": [{"projectId": "p1", "stageId": "st1", "taskId": "t1", "task": {"id": "t1", "status": incoming_status, "sampleIds": remaining}}],
                })
                self.assertFalse(ok, result)
                self.assertEqual(server.compose_state(self.conn), before)


if __name__ == "__main__":
    unittest.main()
