from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import server as _server  # noqa: E402,F401
from backend.server_modules import import_bundle_service, import_commit  # noqa: E402


def project_tree(project_id: str = "p1", stage_id: str = "st1", task_id: str = "t1") -> dict:
    return {
        "id": project_id,
        "name": "Project",
        "stages": [{
            "id": stage_id,
            "projectId": project_id,
            "name": "Stage",
            "tasks": [{"id": task_id, "projectId": project_id, "stageId": stage_id}],
        }],
    }


def incoming_state() -> dict:
    return {
        "projects": [project_tree()],
        "sampleLibrary": {
            "categories": [{
                "id": "pool1",
                "samples": [{
                    "id": "sample1",
                    "photos": [{
                        "id": "photo1",
                        "thumbId": "photo1__thumb",
                        "projectId": "p1",
                        "stageId": "st1",
                        "taskId": "t1",
                    }],
                }],
            }],
        },
    }


class ImportPhotoIdentityMapTests(unittest.TestCase):
    def test_existing_same_id_ancestors_keep_new_task_photo_visible(self):
        incoming = incoming_state()
        current_projects = {"p1": project_tree()}
        project_map: dict[str, str] = {}
        stage_map: dict[str, str] = {}
        task_map = {"t1": "t1"}

        import_bundle_service.complete_accepted_identity_maps(
            incoming, current_projects, project_map, stage_map, task_map
        )
        import_commit.remap_import_photo_contexts(incoming, project_map, stage_map, task_map)

        self.assertEqual(project_map, {"p1": "p1"})
        self.assertEqual(stage_map, {"st1": "st1"})
        photo = incoming["sampleLibrary"]["categories"][0]["samples"][0]["photos"][0]
        self.assertEqual(
            (photo["projectId"], photo["stageId"], photo["taskId"]),
            ("p1", "st1", "t1"),
        )
        self.assertEqual(photo["thumbId"], "photo1__thumb")

    def test_existing_same_task_receiving_new_result_photo_gets_all_identity_maps(self):
        incoming = incoming_state()
        current_projects = {"p1": copy.deepcopy(incoming["projects"][0])}
        project_map: dict[str, str] = {}
        stage_map: dict[str, str] = {}
        task_map: dict[str, str] = {}

        import_bundle_service.complete_accepted_identity_maps(
            incoming, current_projects, project_map, stage_map, task_map
        )

        self.assertEqual(project_map, {"p1": "p1"})
        self.assertEqual(stage_map, {"st1": "st1"})
        self.assertEqual(task_map, {"t1": "t1"})

    def test_explicitly_skipped_stage_photo_fails_closed(self):
        incoming = incoming_state()
        current_projects = {"p1": project_tree()}
        project_map: dict[str, str] = {}
        stage_map: dict[str, str] = {}
        task_map: dict[str, str] = {}

        import_bundle_service.complete_accepted_identity_maps(
            incoming,
            current_projects,
            project_map,
            stage_map,
            task_map,
            skipped_stage_ids={"st1"},
            skipped_task_ids={"t1"},
        )
        import_commit.remap_import_photo_contexts(incoming, project_map, stage_map, task_map)

        photo = incoming["sampleLibrary"]["categories"][0]["samples"][0]["photos"][0]
        self.assertEqual(project_map, {"p1": "p1"})
        self.assertEqual(stage_map, {})
        self.assertEqual(task_map, {})
        self.assertEqual(photo["projectId"], "__restricted__")
        self.assertEqual(photo["stageId"], "")
        self.assertEqual(photo["taskId"], "")


if __name__ == "__main__":
    unittest.main()
