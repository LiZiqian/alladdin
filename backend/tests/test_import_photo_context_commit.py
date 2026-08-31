from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import server  # noqa: E402


def bundle_bytes(state: dict) -> bytes:
    manifest = {
        "format": "testchamber-export-bundle-v1",
        "appVersion": "V7",
        "exportedAt": server.now_iso(),
        "exportId": "same-id-photo-context",
        "sourceDeploymentId": "deployment-A",
        "revision": 1,
        "projectCount": 1,
        "sampleCount": 1,
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        archive.writestr("state.json", json.dumps(state, ensure_ascii=False))
        archive.writestr("checksums.json", "{}")
        archive.writestr("assets/samples/sample1/photos/photo1.jpg", b"\xff\xd8\xff\xd9")
        archive.writestr("assets/samples/sample1/photos/photo1-thumb.jpg", b"\xff\xd8\xff\xd9")
    return output.getvalue()


def multipart(zip_payload: bytes) -> tuple[dict, bytes]:
    boundary = "----PhotoContextBoundary"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="bundle"; filename="bundle.zip"\r\n'
        "Content-Type: application/zip\r\n\r\n"
    ).encode() + zip_payload + f"\r\n--{boundary}--\r\n".encode()
    return {"Content-Type": f"multipart/form-data; boundary={boundary}"}, body


class ImportPhotoContextCommitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tcv7_photo_context_")
        self.originals = {
            name: getattr(server, name)
            for name in (
                "DATA_DIR", "SAMPLE_DATA_DIR", "IMPORT_PREVIEW_DIR", "EXPORT_DIR",
                "DB_PATH", "DEPLOYMENT_FILE", "_RUNTIME_PATHS",
            )
        }
        data_dir = Path(self.temp.name) / "data"
        server.DATA_DIR = data_dir
        server.SAMPLE_DATA_DIR = data_dir / "samples"
        server.IMPORT_PREVIEW_DIR = data_dir / "import-previews"
        server.EXPORT_DIR = data_dir / "exports"
        server.DB_PATH = data_dir / "test.sqlite"
        server.DEPLOYMENT_FILE = data_dir / "deployment.json"
        server._RUNTIME_PATHS = server.runtime_paths.build_runtime_paths(data_dir)
        server._IMPORT_PREVIEWS.clear()
        server.ensure_dirs()
        server.init_db()

    def tearDown(self):
        server._IMPORT_PREVIEWS.clear()
        for name, value in self.originals.items():
            setattr(server, name, value)
        self.temp.cleanup()

    def test_same_id_project_and_stage_preserve_imported_result_photo_context(self):
        state, revision, _ = server.get_state()
        state["projects"] = [{
            "id": "p1",
            "name": "Same Project",
            "testCaseMaster": [],
            "locations": [],
            "members": [],
            "stages": [{
                "id": "st1",
                "projectId": "p1",
                "name": "Same Stage",
                "bom": [],
                "strategy": [],
                "skuNames": [],
                "progress": [],
                "tasks": [],
            }],
        }]
        state["sampleLibrary"] = {
            "categories": [{
                "id": "pool1",
                "name": "Pool",
                "samples": [{
                    "id": "sample1",
                    "categoryId": "pool1",
                    "sampleNo": "S1",
                    "status": "闲置",
                    "borrowDate": "",
                    "importDate": "",
                    "schemeNo": "",
                    "sourceSkuName": "",
                    "initialResults": [],
                    "sourceStageName": "",
                    "initialResult": "",
                    "photos": [],
                }],
            }],
            "logs": [],
        }
        ok, result = server.save_state(state, revision, "127.0.0.1", remark="fixture", user="test")
        self.assertTrue(ok, result)

        incoming = {
            "version": "V7",
            "users": [],
            "projects": [{
                "id": "p1",
                "name": "Same Project",
                "stages": [{
                    "id": "st1",
                    "projectId": "p1",
                    "name": "Same Stage",
                    "tasks": [{
                        "id": "t1",
                        "projectId": "p1",
                        "stageId": "st1",
                        "testItem": "Imported Result",
                        "sampleIds": ["sample1"],
                        "resultUploads": [{"samples": [{"sampleId": "sample1", "photos": [{"id": "photo1"}]}]}],
                    }],
                }],
            }],
            "sampleLibrary": {
                "categories": [{
                    "id": "pool1",
                    "name": "Pool",
                    "samples": [{
                        "id": "sample1",
                        "categoryId": "pool1",
                        "sampleNo": "S1",
                        "status": "闲置",
                        "photos": [{
                            "id": "photo1",
                            "name": "result.jpg",
                            "type": "image/jpeg",
                            "relativePath": "samples/sample1/photos/photo1.jpg",
                            "thumbId": "photo1__thumb",
                            "thumbRelativePath": "samples/sample1/photos/photo1-thumb.jpg",
                            "projectId": "p1",
                            "stageId": "st1",
                            "taskId": "t1",
                        }],
                    }],
                }],
                "logs": [],
            },
        }
        headers, body = multipart(bundle_bytes(incoming))
        preview = server.analyze_import_bundle(headers, body)
        self.assertFalse(preview.get("blockers"), preview)
        self.assertFalse(preview.get("conflicts"), preview)
        committed = server.commit_import_bundle({"previewId": preview["previewId"], "decisions": {}})
        self.assertFalse(committed.get("status"), committed)

        with server.connect_db() as conn:
            rows = conn.execute(
                "SELECT id, project_id, stage_id, task_id FROM sample_assets "
                "WHERE sample_id='sample1' ORDER BY id"
            ).fetchall()
        self.assertEqual([row["id"] for row in rows], ["photo1", "photo1__thumb"])
        self.assertEqual(
            {(row["project_id"], row["stage_id"], row["task_id"]) for row in rows},
            {("p1", "st1", "t1")},
        )


if __name__ == "__main__":
    unittest.main()
