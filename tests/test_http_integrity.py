import io
import sqlite3
import sys
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from backend_fixture import seed_state
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from server_modules import http_helpers, http_api, http_routes, http_multipart
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import server


class HttpIntegrityTests(unittest.TestCase):
    def handler(self, body=b'{}', length=None):
        headers = Message()
        headers['Content-Length'] = str(len(body)) if length is None else length
        return SimpleNamespace(headers=headers, rfile=io.BytesIO(body))

    def test_body_rejects_invalid_lengths_before_reading(self):
        for length in ('-1', '+2', '2.0', 'bad'):
            with self.subTest(length=length):
                handler = self.handler(length=length)
                with self.assertRaises(ValueError):
                    http_helpers.read_body(handler, 10)
                self.assertEqual(handler.rfile.tell(), 0)

    def test_body_rejects_truncated_or_ambiguous_framing(self):
        with self.assertRaises(ValueError):
            http_helpers.read_body(self.handler(length='4'), 10)
        handler = self.handler()
        handler.headers['Content-Length'] = '3'
        with self.assertRaises(ValueError):
            http_helpers.read_body(handler, 10)
        handler = self.handler()
        handler.headers['Transfer-Encoding'] = 'chunked'
        with self.assertRaises(ValueError):
            http_helpers.read_body(handler, 10)

    def test_normal_and_bounded_bodies(self):
        self.assertEqual(http_helpers.read_body(self.handler(), 2), b'{}')
        self.assertEqual(http_helpers.read_body(self.handler(b''), 2), b'')
        with self.assertRaises(ValueError):
            http_helpers.read_body(self.handler(), 1)

    def test_explicit_empty_export_scope_is_not_omitted(self):
        self.assertEqual(http_api._selection_from_query({'projectIds': ['']}), {'projectIds': []})
        self.assertEqual(http_api._selection_from_query({}), {})

    def test_non_object_json_is_rejected_without_calling_mutations(self):
        routes = [('/api/projects/p/mutation', http_api.handle_patch),
                  ('/api/samples/s/photos/p', http_api.handle_patch), ('/api/import-bundle/commit', http_api.handle_post),
                  ('/api/samples/archive/commit', http_api.handle_post), ('/api/sample-identity-check', http_api.handle_post)]
        for path, method in routes:
            for body in (b'null', b'[]', b'42', b'"value"'):
                with self.subTest(path=path, body=body):
                    handler = self.handler(body)
                    handler.path = path
                    handler.client_address = ('127.0.0.1', 1)
                    handler._read_body = lambda **_: body
                    replies = []
                    handler._send_json = lambda payload, status=200: replies.append((payload, status))
                    for name in ('sample_photo', 'project_mutation', 'stage_mutation', 'stage_tasks_batch', 'task_mutation', 'sample_mutation', 'sample_category_mutation'):
                        setattr(handler, '_' + name + '_route', getattr(http_routes, name + '_route'))
                    method(handler, SimpleNamespace(MAX_UPLOAD_BYTES=1000))
                    self.assertEqual(replies[0][1], 400)

    def test_photo_route_does_not_ignore_extra_segments(self):
        self.assertEqual(http_routes.sample_photo_route('/api/samples/s/photos/p'), ('s', 'p'))
        self.assertIsNone(http_routes.sample_photo_route('/api/samples/s/photos/p/extra'))

    def test_mutation_ids_are_decoded_exactly_once_after_segment_splitting(self):
        # Imported IDs may contain a slash or literal percent-encoded text.
        for encoded, expected in [('sample%2Flegacy', 'sample/legacy'), ('sample%252Flegacy', 'sample%2Flegacy'), ('%E6%A0%B7%E6%9C%BA', '样机')]:
            with self.subTest(encoded=encoded):
                handler = self.handler()
                handler.path = '/api/samples/' + encoded + '/mutation'
                handler.client_address = ('127.0.0.1', 1)
                handler._read_body = lambda **_: b'{}'
                replies, seen = [], []
                handler._send_json = lambda payload, status=200: replies.append((payload, status))
                for name in ('sample_photo', 'project_mutation', 'stage_mutation', 'stage_tasks_batch', 'task_mutation', 'sample_mutation', 'sample_category_mutation'):
                    setattr(handler, '_' + name + '_route', getattr(http_routes, name + '_route'))
                def commit(payload, _ip):
                    seen.append(payload['sampleId'])
                    return True, {}
                http_api.handle_patch(handler, SimpleNamespace(MAX_UPLOAD_BYTES=1000, commit_sample_mutation=commit))
                self.assertEqual(replies[0][1], 200)
                self.assertEqual(seen, [expected])

    def test_multipart_rejects_truncated_boundary(self):
        headers = {'Content-Type': 'multipart/form-data; boundary=qa'}
        body = b'--qa\r\nContent-Disposition: form-data; name="photos"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nimage\r\n--qa--\r\n'
        self.assertEqual(http_multipart.parse_multipart(headers, body)[1][0]['content'], b'image')
        with self.assertRaises(ValueError):
            http_multipart.parse_multipart(headers, body[:-10])
        with self.assertRaises(ValueError):
            http_multipart.parse_multipart({'Content-Type': 'multipart/form-data'}, body)

    def test_http_read_response_uses_one_snapshot_and_closes_connection(self):
        with tempfile.TemporaryDirectory(prefix='tc-http-snapshot-') as temp:
            path = Path(temp) / 'snapshot.sqlite'
            writer = sqlite3.connect(path)
            self.addCleanup(writer.close)
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('CREATE TABLE marker (revision INTEGER)')
            writer.execute('INSERT INTO marker VALUES (1)')
            writer.commit()
            reader = sqlite3.connect(path)
            def compose(conn):
                revision = conn.execute('SELECT revision FROM marker').fetchone()[0]
                writer.execute('UPDATE marker SET revision = 2')
                writer.commit()
                second = conn.execute('SELECT revision FROM marker').fetchone()[0]
                return {'observedRevision': second}, revision, 'qa'
            replies = []
            handler = SimpleNamespace(path='/api/bootstrap', _sample_archive_route=http_routes.sample_archive_route,
                                      _send_json=lambda payload, status=200: replies.append((payload, status)))
            ctx = SimpleNamespace(connect_db=lambda: reader, begin_read_snapshot=server.begin_read_snapshot,
                                  compose_bootstrap_state=compose, APP_VERSION='qa')
            http_api.handle_get(handler, ctx)
            self.assertEqual(replies[0][1], 200)
            self.assertEqual(replies[0][0]['revision'], 1)
            self.assertEqual(replies[0][0]['data']['observedRevision'], 1)
            with self.assertRaises(sqlite3.ProgrammingError):
                reader.execute('SELECT 1')
            writer.close()


class PhotoUploadIntegrityTests(unittest.TestCase):
    def setUp(self):
        test_root = Path(__file__).resolve().parents[1] / 'batch_import_test_data'
        test_root.mkdir(exist_ok=True)
        root = tempfile.TemporaryDirectory(prefix='tc-photo-upload-', dir=test_root)
        assert Path(root.name).resolve().is_relative_to(test_root.resolve())
        self.addCleanup(root.cleanup)
        self.addCleanup(server._apply_runtime_paths, server._RUNTIME_PATHS)
        server.prepare_runtime_data_root(Path(root.name))
        server.init_db()
        state, revision, _ = server.get_state()
        state['sampleLibrary'] = {'categories': [{'id': 'pool', 'samples': [{'id': 's', 'sn': 'QA', 'status': '闲置'}]}], 'logs': []}
        self.assertTrue(seed_state(state, revision, '127.0.0.1')[0])
        self.ctx = server.http_runtime_context()
        self.ctx.parse_multipart = lambda *_: ({}, [{'field': 'photos', 'filename': 'qa.png', 'mime_type': 'image/png', 'content': b'qa-image'}])
        self.replies = []
        self.handler = SimpleNamespace(path='/api/samples/s/photos', headers={}, client_address=('127.0.0.1', 1),
                                       _sample_photo_route=http_routes.sample_photo_route, _read_body=lambda **_: b'',
                                       _send_json=lambda payload, status=200: self.replies.append((payload, status)))

    def test_disconnected_response_does_not_delete_committed_photo(self):
        def send(payload, status=200):
            if payload.get('ok'):
                raise BrokenPipeError('client closed after commit')
            self.replies.append((payload, status))
        self.handler._send_json = send
        http_api.handle_post(self.handler, self.ctx)
        with server.connect_db() as conn:
            photo = conn.execute('SELECT relative_path FROM sample_assets WHERE sample_id = ?', ('s',)).fetchone()
            self.assertIsNotNone(photo)
            self.assertTrue((server.DATA_DIR / photo['relative_path']).is_file())

    def test_validation_failure_cleans_earlier_files(self):
        self.ctx.parse_multipart = lambda *_: ({}, [{'field': 'photos', 'filename': name, 'mime_type': 'image/png', 'content': b'qa-image'} for name in ('a.png', 'b.png')])
        original = self.ctx.write_sample_asset_file
        calls = []
        def write(*args, **kwargs):
            if calls:
                raise ValueError('invalid second photo')
            meta = original(*args, **kwargs)
            calls.append(meta)
            return meta
        self.ctx.write_sample_asset_file = write
        http_api.handle_post(self.handler, self.ctx)
        self.assertEqual(self.replies[0][1], 400)
        self.assertFalse((server.DATA_DIR / calls[0]['relativePath']).exists())
        with server.connect_db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM sample_assets').fetchone()[0], 0)

    def test_failure_after_database_commit_keeps_referenced_photo(self):
        original = self.ctx.commit_sample_asset_mutation
        def commit_then_fail(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError('response assembly failed after commit')
        self.ctx.commit_sample_asset_mutation = commit_then_fail
        http_api.handle_post(self.handler, self.ctx)
        self.assertEqual(self.replies[0][1], 500)
        with server.connect_db() as conn:
            photos = conn.execute('SELECT relative_path FROM sample_assets WHERE deleted_at IS NULL').fetchall()
            self.assertEqual(len(photos), 1)
            self.assertEqual((server.DATA_DIR / photos[0]['relative_path']).read_bytes(), b'qa-image')

    def test_database_failure_rolls_back_metadata_and_cleans_written_photo(self):
        self.ctx.commit_sample_asset_mutation = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError('db failure'))
        http_api.handle_post(self.handler, self.ctx)
        self.assertEqual(self.replies[0][1], 500)
        with server.connect_db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM sample_assets').fetchone()[0], 0)
        self.assertEqual([p for p in server.SAMPLE_DATA_DIR.rglob('*') if p.is_file()], [])


if __name__ == '__main__':
    unittest.main()
