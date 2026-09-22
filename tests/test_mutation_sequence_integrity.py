"""Deterministic short-sequence checks across the incremental/state boundary."""
import copy
import json
import random
import sqlite3
import sys
import unittest
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend_fixture import empty_state, patched_server_db, server, state_conn
from server_modules import sample_queries, status_normalization, task_queries, task_reservations


class MutationSequenceIntegrityTests(unittest.TestCase):
    def samples(self, conn):
        return {row["id"]: sample_queries.sample_from_db_row(row) for row in conn.execute("SELECT * FROM sample_records WHERE deleted_at IS NULL")}

    def assert_affected_matches_state(self, conn, result):
        samples = self.samples(conn)
        for sample in result.get("affected", {}).get("samples", []):
            for key in ("status", "currentTaskId", "owner", "borrower", "location", "hasProblem", "categoryId"):
                self.assertEqual(sample.get(key), samples[sample["id"]].get(key), (sample["id"], key))
        for task in result.get("affected", {}).get("tasks", []):
            row = conn.execute("SELECT * FROM project_tasks WHERE id = ? AND deleted_at IS NULL", (task["id"],)).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual((task["projectId"], task["stageId"], task["sampleIds"]), (row["project_id"], row["stage_id"], json.loads(row["sample_ids_json"])))

    def assert_consistent(self, conn):
        state, revision, _ = server.compose_state(conn)
        projects = {p["id"]: p for p in state["projects"]}
        stages = {s["id"]: (p["id"], s) for p in state["projects"] for s in p["stages"]}
        tasks = {t["id"]: (p["id"], s["id"], t) for p in state["projects"] for s in p["stages"] for t in s["tasks"]}
        samples = self.samples(conn)
        self.assertEqual(set(projects), {r[0] for r in conn.execute("SELECT id FROM project_records WHERE deleted_at IS NULL")})
        self.assertEqual(set(stages), {r[0] for r in conn.execute("SELECT id FROM project_stages WHERE deleted_at IS NULL")})
        self.assertEqual(set(tasks), {r[0] for r in conn.execute("SELECT id FROM project_tasks WHERE deleted_at IS NULL")})
        for row in conn.execute("SELECT * FROM project_tasks"):
            task = json.loads(row["data_json"])
            self.assertEqual(row["status"], status_normalization.normalize_task_stored_status(task))
            self.assertEqual(row["flow_status"], task_queries.task_flow_status(task))
            self.assertEqual(json.loads(row["sample_ids_json"]), task.get("sampleIds", []))
            if not row["deleted_at"]:
                self.assertEqual(tasks[row["id"]][:2], (row["project_id"], row["stage_id"]))
                self.assertEqual(stages[row["stage_id"]][0], row["project_id"])
            expected = set(task.get("sampleIds") or []) & set(samples)
            if row["deleted_at"] and row["flow_status"] not in ("正常完成", "异常终止"):
                expected = set()
            links = list(conn.execute("SELECT * FROM project_task_samples WHERE task_id = ?", (row["id"],)))
            self.assertEqual({link["sample_id"] for link in links}, expected)
            for link in links:
                self.assertEqual((link["project_id"], link["stage_id"], link["flow_status"]), (row["project_id"], row["stage_id"], row["flow_status"]))
        reservations = {}
        for pid, stid, task in tasks.values():
            if not task_reservations.is_open(task):
                continue
            for sid in set(task.get("sampleIds") or []):
                reservations.setdefault(sid, []).append((pid, stid, task))
        for row in conn.execute("SELECT * FROM sample_records WHERE deleted_at IS NULL"):
            sample = samples[row["id"]]
            stored = json.loads(row["data_json"])
            self.assertEqual(row["status"], sample_queries.sample_effective_status(stored))
            self.assertEqual(row["effective_status"], row["status"])
            self.assertEqual(row["has_problem"], int(sample_queries.sample_has_problem(stored)))
            choices = reservations.get(row["id"], [])
            if choices:
                pid, stid, primary = min(choices, key=lambda x: ({"进行中": 0, "阻塞中": 1}.get(task_queries.task_flow_status(x[2]), 2), x[2].get("planStartDate") or "9999-12-31", x[2]["id"]))
                self.assertEqual((sample.get("currentProjectId"), sample.get("currentStageId"), sample.get("currentTaskId")), (pid, stid, primary["id"]))
                self.assertEqual(sample["status"], "测试中" if task_queries.task_flow_status(primary) == "进行中" else "在位等待")
            else:
                self.assertFalse(sample.get("currentTaskId"))
                self.assertEqual(sample["status"], "闲置")
        return state, revision

    def test_seeded_incremental_sequences_keep_all_representations_consistent(self):
        coverage = Counter()
        for seed in range(10):
            rng = random.Random(seed)
            data = empty_state()
            data["projects"] = [{"id": f"p{p}", "name": f"项目{p}", "stages": [{"id": f"st{p}_{s}", "name": f"阶段{s}", "tasks": []} for s in range(2)]} for p in range(2)]
            data["sampleLibrary"]["categories"] = [{"id": "pool", "name": "池", "samples": [{"id": f"s{s}", "sn": f"SN{s}", "status": "闲置"} for s in range(5)]}]
            conn = state_conn(data)
            conn.commit()
            try:
                for step in range(80):
                    state, revision = self.assert_consistent(conn)
                    projects = state["projects"]
                    stages = [(p, s) for p in projects for s in p["stages"]]
                    tasks = [(p, s, t) for p, s in stages for t in s["tasks"] if not t.get("archived")]
                    samples = self.samples(conn)
                    operation = rng.choice(["create", "assign", "start", "block", "restart", "finish", "archive", "delete", "edit_sample", "edit_stage", "edit_project", "delete_stage", "delete_project", "cross_task", "cross_stage"])
                    payload = {"revision": revision}
                    if not projects:
                        operation = "create_project"
                        method = server.commit_project_mutation
                        payload.update(projectId=f"p_new_{step}", project={"id": f"p_new_{step}", "name": "新项目"}, createIfMissing=True)
                    elif not stages:
                        operation = "create_stage"
                        method = server.commit_stage_mutation
                        payload.update(projectId=projects[0]["id"], stageId=f"st_new_{step}", stage={"id": f"st_new_{step}", "name": "新阶段"}, createIfMissing=True)
                    elif operation == "edit_sample":
                        sample = copy.deepcopy(rng.choice(list(samples.values())))
                        sample.update(owner=f"owner{step % 3}/00{step % 3}", location=f"位置{step}")
                        method = server.commit_sample_mutation
                        payload.update(sampleId=sample["id"], sample=sample)
                    elif operation in ("edit_project", "delete_project"):
                        project = copy.deepcopy(rng.choice(projects))
                        method = server.commit_project_mutation
                        payload.update(projectId=project["id"], project={**project, "name": f"修改项目{step}"})
                        if operation == "delete_project":
                            ids = {sid for stage in project["stages"] for task in stage["tasks"] if task_reservations.is_open(task) for sid in task.get("sampleIds") or []}
                            payload.update(deleteProject=True, samples=[samples[sid] for sid in sorted(ids)])
                    elif operation in ("edit_stage", "delete_stage", "cross_stage"):
                        project, stage = copy.deepcopy(rng.choice(stages))
                        method = server.commit_stage_mutation
                        payload.update(projectId=project["id"], stageId=stage["id"], stage={**stage, "name": f"修改阶段{step}"}, deleteStage=operation == "delete_stage")
                        if operation == "cross_stage":
                            payload["projectId"] = "unrelated-project"
                    else:
                        method = server.commit_task_mutation
                        candidates = [(p, s, t) for p, s, t in tasks if (
                            operation in ("cross_task",) or
                            (operation in ("assign", "start", "delete") and task_queries.task_flow_status(t) == "待下发") or
                            (operation == "block" and task_queries.task_flow_status(t) == "进行中") or
                            (operation == "restart" and task_queries.task_flow_status(t) == "阻塞中") or
                            (operation == "finish" and task_queries.task_flow_status(t) in ("进行中", "阻塞中")) or
                            (operation == "archive" and task_queries.task_flow_status(t) != "待下发"))]
                        if operation == "create" or not candidates:
                            operation = "create"
                            p, s = rng.choice(stages)
                            start = rng.randrange(1, 27)
                            task = {"id": f"t{seed}_{step}", "testItem": f"任务{step}", "status": "待下发", "sampleIds": [], "planStartDate": f"2026-10-{start:02}", "planEndDate": f"2026-10-{start+1:02}"}
                            payload.update(action="create_task_config", createIfMissing=True)
                            affected_ids = set()
                        else:
                            p, s, old_task = rng.choice(candidates)
                            task = copy.deepcopy(old_task)
                            affected_ids = set(task.get("sampleIds") or [])
                            actions = {"assign": "save_task_config", "start": "start_task", "block": "block_task", "restart": "restart_task", "finish": "finish_task_result", "archive": "archive_task_delete", "delete": "delete_task", "cross_task": "update_issue_record"}
                            payload["action"] = actions[operation]
                            if operation == "assign":
                                task["sampleIds"] = rng.sample(sorted(samples), rng.randrange(0, 3))
                                affected_ids = affected_ids | set(task["sampleIds"]) if set(old_task["sampleIds"]) != set(task["sampleIds"]) else set()
                            elif operation in ("start", "restart", "block", "finish"):
                                task["status"] = {"start": "进行中", "restart": "进行中", "block": "阻塞中", "finish": "正常完成"}[operation]
                                if operation == "finish":
                                    task["completed"] = True
                            elif operation == "archive":
                                if task_queries.task_flow_status(old_task) in ("正常完成", "异常终止"):
                                    affected_ids = set()
                                task.update(archived=True, deletedAt="2026-09-20")
                            elif operation == "delete":
                                payload["deleteMode"] = "delete"
                            elif operation == "cross_task":
                                affected_ids = set()
                        payload.update(projectId=p["id"], stageId=s["id"], taskId=task["id"], task=task, samples=[samples[sid] for sid in sorted(affected_ids)])
                        if operation == "cross_task":
                            payload["stageId"] = "foreign-stage"
                    before = server.compose_state(conn)
                    with self.subTest(seed=seed, step=step, operation=operation):
                        with patched_server_db(conn):
                            ok, result = method(copy.deepcopy(payload), "127.0.0.1")
                        coverage[(operation, ok)] += 1
                        if not ok:
                            self.assertEqual(server.compose_state(conn), before, result)
                        else:
                            self.assert_affected_matches_state(conn, result)
                        self.assert_consistent(conn)
                # Full-state persistence must keep the relational meaning of a
                # state produced entirely by incremental writes.
                conn.commit()
                clone = sqlite3.connect(":memory:")
                clone.row_factory = sqlite3.Row
                try:
                    conn.backup(clone)
                    state = server.compose_state(conn)[0]
                    server.sync_project_library(clone, state, allow_empty=True)
                    server.sync_sample_library(clone, state, allow_empty=True)
                    self.assert_consistent(clone)
                    def without_refresh_timestamps(value):
                        value = copy.deepcopy(value)
                        for project in value["projects"]:
                            for stage in project["stages"]:
                                for task in stage["tasks"]:
                                    for snapshot in (task.get("sampleSnapshots") or {}).values():
                                        snapshot.pop("updatedAt", None)
                        return value
                    self.assertEqual(without_refresh_timestamps(server.compose_state(clone)[0]), without_refresh_timestamps(state))
                finally:
                    clone.close()
            finally:
                conn.close()
        for operation in ("create", "assign", "start", "block", "restart", "finish", "archive", "delete", "edit_sample", "edit_stage", "edit_project", "delete_stage", "delete_project"):
            self.assertGreater(coverage[(operation, True)], 0, (operation, coverage))
        self.assertGreater(coverage[("cross_task", False)], 0)
        self.assertGreater(coverage[("cross_stage", False)], 0)
        self.sequence_coverage = {f"{operation}:{'accepted' if ok else 'rejected'}": count for (operation, ok), count in sorted(coverage.items())}

    def test_pool_and_sample_lifecycle_preserves_related_task_invariants(self):
        data = empty_state()
        data["projects"] = [{"id": "p", "name": "项目", "stages": [{"id": "st", "name": "阶段", "tasks": []}]}]
        data["sampleLibrary"]["categories"] = [{"id": "pool", "name": "池", "samples": [{"id": sid, "sn": sid, "status": "闲置"} for sid in ("s1", "s2", "s3")]}]
        conn = state_conn(data)
        conn.commit()
        self.addCleanup(conn.close)

        def mutate(method, payload):
            payload["revision"] = server.compose_state(conn)[1]
            with patched_server_db(conn):
                ok, result = method(copy.deepcopy(payload), "127.0.0.1")
            self.assertTrue(ok, result)
            self.assert_affected_matches_state(conn, result)
            self.assert_consistent(conn)

        mutate(server.commit_sample_category_mutation, {"categoryId": "newpool", "category": {"id": "newpool", "name": "新池"}, "createIfMissing": True, "createSamples": True, "samples": [{"id": "new", "categoryId": "newpool", "sn": "SN-new", "status": "闲置"}]})
        task = {"id": "t", "testItem": "测试", "status": "待下发", "sampleIds": ["s1", "s2"]}
        mutate(server.commit_task_mutation, {"projectId": "p", "stageId": "st", "taskId": "t", "task": task, "action": "create_task_config", "createIfMissing": True, "samples": [self.samples(conn)[sid] for sid in task["sampleIds"]]})
        task = {**task, "sampleIds": ["s2"]}
        mutate(server.commit_sample_mutation, {"sampleId": "s1", "deleteSample": True, "taskMutations": [{"projectId": "p", "stageId": "st", "taskId": "t", "task": task}]})
        task = {**task, "status": "进行中"}
        mutate(server.commit_task_mutation, {"projectId": "p", "stageId": "st", "taskId": "t", "task": task, "action": "start_task", "samples": [self.samples(conn)["s2"]]})
        task = {**task, "status": "异常终止", "completed": True, "sampleIds": []}
        mutate(server.commit_sample_category_mutation, {"categoryId": "pool", "deleteCategory": True, "taskMutations": [{"projectId": "p", "stageId": "st", "taskId": "t", "task": task}]})
        mutate(server.commit_sample_mutation, {"sampleId": "new", "deleteSample": True})
        mutate(server.commit_sample_category_mutation, {"categoryId": "newpool", "deleteCategory": True})


if __name__ == "__main__":
    unittest.main()
