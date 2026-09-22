import copy
import json
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from backend_fixture import seed_state

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import server
from server_modules import import_commit, import_diff, record_writers, sample_queries, task_mutation_rules, task_queries, task_reservations


def task(task_id, start="", end="", samples=(), status="待下发"):
    return {"id": task_id, "testItem": task_id, "status": status, "planStartDate": start,
            "planEndDate": end, "sampleIds": list(samples), "owner": "测试员/001", "logs": []}


class ReservationTests(unittest.TestCase):
    def setUp(self):
        test_root = ROOT / "batch_import_test_data"
        test_root.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix="tc-reservations-", dir=test_root)
        assert Path(self.tmp.name).resolve().is_relative_to(test_root.resolve())
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(server._apply_runtime_paths, server._RUNTIME_PATHS)
        server.prepare_runtime_data_root(Path(self.tmp.name))
        server.init_db()
        state, revision, _ = server.get_state()
        state["projects"] = [{"id": "p1", "name": "测试项目", "stages": [{"id": "st1", "name": "阶段", "tasks": [
            task("a", "2026-10-01", "2026-10-03", ["s"]),
            task("b", "2026-10-04", "2026-10-06"),
            task("overlap", "2026-10-03", "2026-10-04"), task("undated"),
        ]}]}, {"id": "p2", "name": "另一个项目", "stages": [{"id": "st2", "name": "另一阶段", "tasks": [
            task("future", "2026-10-07", "2026-10-09")]}]}]
        state["sampleLibrary"] = {"categories": [{"id": "pool", "name": "样机池", "samples": [
            {"id": "s", "sn": "QA-001", "status": "在位等待", "currentTaskId": "a", "location": "测试室", "owner": "档案员"},
            {"id": "external", "sn": "QA-002", "status": "取走分析", "borrower": "分析员"},
            {"id": "orphan", "sn": "QA-003", "status": "测试中"},
            {"id": "idle", "sn": "QA-004", "status": "闲置"},
        ]}], "logs": []}
        ok, result = seed_state(state, revision, "127.0.0.1")
        self.assertTrue(ok, result)

    def sample(self, sid="s"):
        with server.connect_db() as conn:
            return sample_queries.sample_from_db_row(conn.execute("SELECT * FROM sample_records WHERE id = ?", (sid,)).fetchone())

    def mutate(self, tid, action="save_task_config", changes=None, sample_status=None, revision=None, samples=None):
        with server.connect_db() as conn:
            old = task_mutation_rules.existing_task(conn, tid)
            current_revision = conn.execute("SELECT revision FROM app_state WHERE id = 1").fetchone()[0]
            scope = conn.execute("SELECT project_id, stage_id FROM project_tasks WHERE id = ?", (tid,)).fetchone()
        incoming = {**old, **(changes or {})}
        ids = set(old["sampleIds"]) | set(incoming["sampleIds"])
        if action in ("set_task_plan", "update_issue_record", "save_task_result_draft") or (action == "save_task_config" and old["sampleIds"] == incoming["sampleIds"]):
            ids = set()
        if samples is None:
            samples = [self.sample(sid) for sid in ids]
            for sample in samples:
                if sample_status:
                    sample["status"] = sample_status
        return server.commit_task_mutation({
            "projectId": scope["project_id"], "stageId": scope["stage_id"], "taskId": tid, "task": incoming,
            "action": action, "revision": current_revision if revision is None else revision,
            "samples": samples, "sampleEvents": [], "deleteMode": "delete" if action == "delete_task" else "",
        }, "127.0.0.1")

    def assign(self, tid):
        ok, result = self.mutate(tid, changes={"sampleIds": ["s"]})
        self.assertTrue(ok, result)

    def candidates(self, tid="b", **draft):
        with server.connect_db() as conn:
            return task_queries.list_task_sample_candidates_page(conn, {"taskId": [tid], **{k: [v] for k, v in draft.items()}})

    def test_candidate_uses_draft_dates_and_explains_conflicts(self):
        rows = {item["id"]: item for item in self.candidates()["items"]}
        self.assertTrue(rows["s"]["selectable"])
        self.assertIn("错峰", rows["s"]["reservationHint"])
        self.assertFalse(rows["external"]["selectable"])
        self.assertFalse(rows["orphan"]["selectable"])
        for draft in ({"planStartDate": "2026-10-03"}, {"planEndDate": ""}, {"planStartDate": "2026-02-30"}):
            row = next(item for item in self.candidates(**draft)["items"] if item["id"] == "s")
            self.assertFalse(row["selectable"], draft)
            self.assertTrue(row["selectionConflict"])
        selected = self.candidates("overlap", selectedIds="s")["selectedItems"][0]
        self.assertTrue(selected["selectable"], "checked conflicts must still be removable")
        self.assertIn("重叠", selected["selectionConflict"])

    def test_disjoint_reservations_across_projects_and_reschedule(self):
        self.assign("b")
        self.assign("future")
        self.assertEqual(self.sample()["currentTaskId"], "a")
        before = server.get_state()
        for tid, changes in (("overlap", {"sampleIds": ["s"]}), ("undated", {"sampleIds": ["s"]}),
                             ("b", {"planStartDate": "2026-10-03"}), ("b", {"planEndDate": ""})):
            ok, result = self.mutate(tid, changes=changes)
            self.assertFalse(ok, result)
            self.assertEqual(result["error_code"], "SAMPLE_OCCUPANCY_CONFLICT")
            self.assertEqual(server.get_state(), before, "a rejected reservation is atomic")

    def test_execution_stays_exclusive_and_finish_promotes_next_reservation(self):
        self.assign("b")
        self.assign("future")
        ok, result = self.mutate("a", "start_task", {"status": "进行中"}, "测试中")
        self.assertTrue(ok, result)
        for status in ("进行中", "阻塞中"):
            if status == "阻塞中":
                self.assertTrue(self.mutate("a", "block_task", {"status": status}, "在位等待")[0])
            before = server.get_state()
            ok, result = self.mutate("b", "start_task", {"status": "进行中"}, "测试中")
            self.assertFalse(ok)
            self.assertEqual(result["error_code"], "SAMPLE_OCCUPANCY_CONFLICT")
            self.assertEqual(server.get_state(), before)
        ok, result = self.mutate("a", "finish_task_result", {"status": "正常完成", "completed": True}, "闲置")
        self.assertTrue(ok, result)
        self.assertEqual((self.sample()["status"], self.sample()["currentTaskId"]), ("在位等待", "b"))
        self.assertTrue(self.mutate("b", "start_task", {"status": "进行中"}, "测试中")[0])
        self.assertTrue(self.mutate("b", "finish_task_result", {"status": "正常完成", "completed": True}, "取走分析")[0])
        self.assertEqual(self.sample()["status"], "取走分析")
        self.assertIsNone(self.sample()["currentTaskId"])
        ok, result = self.mutate("future", "start_task", {"status": "进行中"}, "测试中")
        self.assertFalse(ok)
        self.assertEqual(result["error_code"], "SAMPLE_STATUS_NOT_SELECTABLE")

    def test_removed_sample_cannot_be_reassigned_by_finishing_old_task(self):
        self.assertTrue(self.mutate("a", "start_task", {"status": "进行中"}, "测试中")[0])
        ok, result = self.mutate("a", "temp_change_task", {
            "sampleIds": [], "removedSampleRecords": [{"sampleId": "s", "reason": "转交其他任务"}],
        }, "闲置")
        self.assertTrue(ok, result)
        self.assign("b")
        self.assertTrue(self.mutate("b", "start_task", {"status": "进行中"}, "测试中")[0])
        before = server.get_state()
        stale_sample = {**self.sample(), "status": "取走分析", "borrower": "旧任务取走人/002"}
        ok, result = self.mutate("a", "finish_task_result", {"status": "正常完成", "completed": True}, samples=[stale_sample])
        self.assertFalse(ok, result)
        self.assertEqual(result["error_code"], "SAMPLE_CURRENT_STATE_LOCKED")
        self.assertEqual(server.get_state(), before, "rejection must preserve the live holder and task atomically")
        ok, result = self.mutate("a", "finish_task_result", {"status": "正常完成", "completed": True}, samples=[])
        self.assertTrue(ok, result)
        self.assertEqual(self.sample()["currentTaskId"], "b")
        self.assertNotEqual(self.sample().get("borrower"), "旧任务取走人/002")

    def test_future_assignment_cannot_overwrite_running_sample_fields(self):
        self.assertTrue(self.mutate("a", "start_task", {"status": "进行中"}, "测试中")[0])
        stale = {**self.sample(), "status": "在位等待", "currentTaskId": "b", "location": "旧位置", "owner": "旧挂账人"}
        ok, result = self.mutate("b", changes={"sampleIds": ["s"]}, samples=[stale])
        self.assertTrue(ok, result)
        sample = self.sample()
        self.assertEqual((sample["status"], sample["currentTaskId"], sample["location"], sample["owner"]), ("测试中", "a", "测试室", "档案员"))
        self.assertTrue(self.mutate("b", "delete_task")[0])
        self.assertEqual((self.sample()["status"], self.sample()["currentTaskId"]), ("测试中", "a"))

    def test_removing_first_reservation_preserves_next_then_releases_last(self):
        self.assign("b")
        self.assertTrue(self.mutate("a", "delete_task")[0])
        self.assertEqual(self.sample()["currentTaskId"], "b")
        self.assertTrue(self.mutate("b", changes={"sampleIds": []})[0])
        self.assertEqual((self.sample()["status"], self.sample()["currentTaskId"]), ("闲置", None))

    def test_stale_revision_cannot_double_book(self):
        _, revision, _ = server.get_state()
        self.assign("b")
        before = server.get_state()
        ok, result = self.mutate("overlap", changes={"sampleIds": ["s"]}, revision=revision)
        self.assertFalse(ok)
        self.assertEqual(result["error_code"], "TASK_REVISION_CONFLICT")
        self.assertEqual(server.get_state(), before)

    def test_project_delete_keeps_other_projects_reservation(self):
        self.assign("future")
        stale = {**self.sample(), "status": "闲置", "currentTaskId": None, "owner": "旧值"}
        ok, result = server.commit_project_mutation({"projectId": "p1", "deleteProject": True,
                                                    "samples": [stale], "sampleEvents": []}, "127.0.0.1")
        self.assertTrue(ok, result)
        self.assertEqual((self.sample()["status"], self.sample()["currentTaskId"], self.sample()["owner"]), ("在位等待", "future", "档案员"))

    def test_concurrent_reservations_cannot_double_book(self):
        _, revision, _ = server.get_state()
        ready = threading.Barrier(2)
        def reserve(tid, project_id, stage_id):
            payload = {"revision": revision, "projectId": project_id, "stageId": stage_id, "taskId": tid,
                       "task": task(tid, "2026-10-04", "2026-10-06", ["s"]),
                       "action": "save_task_config", "samples": [self.sample()], "sampleEvents": []}
            ready.wait(timeout=5)
            return server.commit_task_mutation(payload, "127.0.0.1")
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(reserve, "b", "p1", "st1"), executor.submit(reserve, "future", "p2", "st2")]
            results = [future.result() for future in futures]
        self.assertEqual(sum(ok for ok, _ in results), 1, results)
        self.assertEqual(next(result["error_code"] for ok, result in results if not ok), "TASK_REVISION_CONFLICT")
        self.assertEqual(import_commit.detect_sample_occupancy_conflicts(server.get_state()[0]), [])

    def test_import_and_full_state_share_reservation_rules(self):
        self.assign("b")
        data, revision, _ = server.get_state()
        self.assertEqual(import_commit.detect_sample_occupancy_conflicts(data), [])
        self.assertTrue(seed_state(copy.deepcopy(data), revision, "127.0.0.1")[0])
        data, revision, _ = server.get_state()
        self.assertTrue(server.commit_merged_import_state(copy.deepcopy(data), revision, "127.0.0.1", "reservation import test", "tester")[0])
        incoming = copy.deepcopy(data)
        incoming["projects"] = [{"id": "p3", "name": "导入项目", "stages": [{"id": "st3", "tasks": [task("import", "2026-10-07", "2026-10-08", ["s"])]}]}]
        preview = import_diff.diff_import_bundle(data, incoming, {}, Path(self.tmp.name), asset_index={"assets": []})
        self.assertFalse(any(c["type"] == "task_occupancy_conflict" for c in preview["conflicts"]))
        incoming["projects"][0]["stages"][0]["tasks"][0]["planStartDate"] = "2026-10-03"
        preview = import_diff.diff_import_bundle(data, incoming, {}, Path(self.tmp.name), asset_index={"assets": []})
        self.assertTrue(any(c["type"] == "task_occupancy_conflict" for c in preview["conflicts"]))
        data["projects"][0]["stages"][0]["tasks"][1]["planStartDate"] = "2026-10-03"
        self.assertTrue(import_commit.detect_sample_occupancy_conflicts(data))
        before = server.get_state()
        ok, result = server.commit_merged_import_state(data, before[1], "127.0.0.1", "conflicting import", "tester")
        self.assertFalse(ok)
        self.assertEqual(result["error_code"], "SAMPLE_OCCUPANCY_CONFLICT")
        self.assertEqual(server.get_state(), before)

    def test_date_boundaries_and_terminal_tasks(self):
        a = task("a", "2026-10-01", "2026-10-03")
        self.assertTrue(task_reservations.conflict_reason(a, task("b", "2026-10-03", "2026-10-04")))
        self.assertFalse(task_reservations.conflict_reason(a, task("b", "2026-10-04", "2026-10-04")))
        for start, end in (("", ""), ("2026-02-30", "2026-03-01"), ("2026-10-05", "2026-10-04")):
            self.assertTrue(task_reservations.conflict_reason(a, task("b", start, end)))
        self.assertFalse(task_reservations.conflict_reason(a, {**a, "completed": True}))
        self.assertFalse(task_reservations.conflict_reason(a, {**a, "archived": True}))
        self.assertFalse(task_reservations.conflict_reason(a, {**a, "status": "异常终止"}))


if __name__ == "__main__":
    unittest.main()
