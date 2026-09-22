"""Deleting task containers must leave sample problem provenance intact."""
import copy
import json
import unittest

from backend_fixture import empty_state, state_conn
from server_modules import record_writers


class ProblemTaskProvenanceTests(unittest.TestCase):
    def test_deleted_task_stage_and_project_retain_problem_references(self):
        problem = {
            "id": "problem", "description": "黑斑", "source": "测试任务",
            "projectId": "project", "stageId": "stage", "taskId": "task",
            "taskLabel": "历史项目 - V3 - B - 弯折测试",
            "taskLabelFormat": "project-stage-scheme-task",
        }
        legacy = {"id": "legacy", "description": "旧问题", "source": "测试任务",
                  "taskLabel": "旧项目 - V2 - 温度测试"}
        task = {"id": "task", "testItem": "弯折测试", "skuIndex": 2,
                "status": "正常完成", "sampleIds": ["sample"], "completed": True}
        state = empty_state()
        state["projects"] = [{"id": "project", "name": "项目", "stages": [
            {"id": "stage", "name": "V3", "skuNames": ["A", "B"], "tasks": [task]}]}]
        state["sampleLibrary"]["categories"] = [{"id": "pool", "name": "pool", "samples": [
            {"id": "sample", "sn": "S1", "status": "闲置", "problemRecords": [problem, legacy]}]}]
        for kind in ("archive", "task", "stage", "project"):
            with self.subTest(kind=kind):
                conn = state_conn(copy.deepcopy(state))
                try:
                    if kind == "archive":
                        record_writers.upsert_task_record(conn, {**task, "archived": True, "deletedAt": "2026-09-21"}, "project", "stage")
                    elif kind == "task":
                        record_writers.delete_task_record(conn, "task")
                        self.assertIsNone(conn.execute("SELECT id FROM project_tasks WHERE id='task'").fetchone())
                    elif kind == "stage":
                        record_writers.delete_stage_record(conn, "stage")
                    else:
                        record_writers.delete_project_record(conn, "project")
                    saved = json.loads(conn.execute("SELECT data_json FROM sample_records WHERE id='sample'").fetchone()[0])
                    self.assertEqual(saved["problemRecords"], [problem, legacy])
                    # Subsequent sample edits must also retain the archived references.
                    record_writers.update_sample_record(conn, {**saved, "notes": "独立编辑"})
                    saved = json.loads(conn.execute("SELECT data_json FROM sample_records WHERE id='sample'").fetchone()[0])
                    self.assertEqual(saved["problemRecords"], [problem, legacy])
                finally:
                    conn.close()


if __name__ == "__main__":
    unittest.main()
