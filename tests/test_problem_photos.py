"""Problem/photo linkage regressions. Uses an in-memory database and temp files."""
import copy
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from server_modules import problem_photos, http_api, record_writers, database_schema, sample_history, chamber_package, import_commit


class ProblemPhotosTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.addCleanup(self.conn.close)
        database_schema.ensure_static_schema(self.conn)
        self.conn.execute("INSERT INTO sample_categories (id, name, data_json, created_at, updated_at) VALUES ('pool', 'pool', '{}', '', '')")
        record_writers.update_sample_record(self.conn, {"id": "s", "categoryId": "pool", "sn": "s"}, create_if_missing=True)
        self.conn.execute("""INSERT INTO sample_assets
            (id, sample_id, kind, file_name, original_name, relative_path, created_at)
            VALUES ('photo_A', 's', 'photo', 'a.png', 'same.png', 'samples/a.png', '')""")

    def test_roundtrip_rename_and_attachment_only_edit(self):
        records = [{"id": "problem", "description": "黑斑", "photoIds": ["photo_A"]}]
        record_writers.update_sample_record(self.conn, {"id": "s", "sn": "s", "problemRecords": records})
        loaded = json.loads(self.conn.execute("SELECT data_json FROM sample_records WHERE id='s'").fetchone()[0])
        self.assertEqual(loaded["problemRecords"], records)
        self.conn.execute("UPDATE sample_assets SET original_name='renamed.png' WHERE id='photo_A'")
        records[0]["photoIds"] = []
        record_writers.update_sample_record(self.conn, {**loaded, "problemRecords": records})
        self.assertEqual(problem_photos.photo_reference_reason(self.conn, 's', 'photo_A'), '')
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM sample_assets").fetchone()[0], 1)

    def test_new_dangling_or_wrong_owner_links_rejected(self):
        for pid in ['missing', 'photo_A']:
            with self.subTest(pid=pid), self.assertRaises(ValueError):
                problem_photos.validate_problem_photos(self.conn, 'other', [{'photoIds': [pid]}])
        with self.assertRaises(ValueError):
            record_writers.update_sample_record(self.conn, {"id": "s", "problemRecords": [{"description": "x", "photoIds": ["missing"]}]})
        # A persisted dangling link does not get a compatibility exemption.
        self.conn.execute("UPDATE sample_records SET data_json=? WHERE id='s'", (json.dumps({'problemRecords': [{'photoIds': ['missing']}]}),))
        with self.assertRaises(ValueError):
            record_writers.update_sample_record(self.conn, {"id": "s", "problemRecords": [{"photoIds": ['missing']}]})

    def test_task_draft_validates_and_history_resolves_record_images(self):
        draft = {"resultDraft": {"samples": [{"sid": "s", "problemRecords": [{"photoIds": ['photo_A']}]}]}}
        problem_photos.validate_task_problem_photos(self.conn, draft)
        draft['resultDraft']['samples'][0]['sid'] = 'wrong'
        with self.assertRaises(ValueError): problem_photos.validate_task_problem_photos(self.conn, draft)
        task = {"resultUploads": [{"time": "today", "samples": [{"sampleId": "s", "problemRecords": [{"photoIds": ['photo_A']}]}]}]}
        photos = sample_history.sample_task_result_photos(task, 's', {'photo_A': {'id': 'photo_A', 'name': 'renamed.png', 'url': '/photo_A'}})
        self.assertEqual(photos[0]['id'], 'photo_A')
        self.assertEqual(photos[0]['url'], '/photo_A')

    def test_delete_endpoint_refuses_problem_task_and_event_references(self):
        @contextmanager
        def connection(): yield self.conn
        response = []
        handler = SimpleNamespace(path='/api/samples/s/photos/photo_A', client_address=('127.0.0.1', 1),
            _sample_photo_route=lambda _: ('s', 'photo_A'), _send_json=lambda body, status=200: response.append((status, body)))
        ctx = SimpleNamespace(write_db_connection=connection)
        self.conn.execute("UPDATE sample_records SET data_json=? WHERE id='s'", (json.dumps({'problemRecords': [{'photoIds': ['photo_A']}]}),))
        http_api.handle_delete(handler, ctx)
        self.assertEqual(response[-1][0], 409)
        self.assertEqual(response[-1][1]['error_code'], 'PHOTO_IN_USE')
        self.conn.execute("UPDATE sample_records SET data_json='{}' WHERE id='s'")
        self.conn.execute("""INSERT INTO project_tasks (id, project_id, stage_id, data_json, created_at, updated_at)
            VALUES ('task', 'p', 'stage', ?, '', '')""", (json.dumps({'resultDraft': {'samples': [{'sid': 's', 'problemRecords': [{'photoIds': ['photo_A']}]}]}}),))
        http_api.handle_delete(handler, ctx)
        self.assertEqual(response[-1][0], 409)
        self.conn.execute("DELETE FROM project_tasks")
        self.conn.execute("INSERT INTO sample_events (id,sample_id,time,data_json) VALUES ('e','s','',?)", (json.dumps({'resultPhotos': [{'id': 'photo_A'}]}),))
        http_api.handle_delete(handler, ctx)
        self.assertEqual(response[-1][0], 409)
        self.assertIsNone(self.conn.execute("SELECT deleted_at FROM sample_assets WHERE id='photo_A'").fetchone()[0])

    def test_export_import_and_mapped_sample_preserve_links(self):
        record = {'id': 'problem', 'description': '黑斑', 'photoIds': ['photo_A']}
        state = {'projects': [], 'sampleLibrary': {'categories': [{'id': 'pool', 'name': 'pool', 'samples': [
            {'id': 's', 'sn': 's', 'problemRecords': [record], 'photos': [{'id': 'photo_A', 'name': 'same.png'}]}]}], 'logs': []}}
        with tempfile.TemporaryDirectory() as tmp:
            package = chamber_package.build_export_package(state, data_dir=Path(tmp), app_version='7', server_version='7', exported_at='today', export_id='e', deployment_id='d', revision=1)
            restored = chamber_package.state_from_domain_documents(package['manifest'], package['domains'])
        incoming = restored['sampleLibrary']['categories'][0]['samples'][0]
        self.assertEqual(incoming['problemRecords'], [record])
        current = copy.deepcopy(state)
        target = current['sampleLibrary']['categories'][0]['samples'][0]
        target.update(id='mapped', photos=[], problemRecords=[])
        import_commit.merge_import_sample_subrecords(current, restored, {'s': 'mapped'})
        self.assertEqual(target['problemRecords'][0]['photoIds'], [target['photos'][0]['id']])
        incoming['problemRecords'][0]['photoIds'].append('photo_B')
        incoming['photos'].append({'id': 'photo_B', 'name': 'same.png'})
        import_commit.merge_import_sample_subrecords(current, restored, {'s': 'mapped'})
        self.assertEqual(len(target['problemRecords']), 1)
        self.assertEqual(target['problemRecords'][0]['photoIds'], ['photo_A', 'photo_B'])


if __name__ == '__main__': unittest.main()
