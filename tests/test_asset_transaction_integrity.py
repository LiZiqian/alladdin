"""Asset table writes preserve ownership and transaction safety."""
import base64
import copy
import gc
import sys
import unittest
from pathlib import Path
from backend_fixture import seed_state
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
import test_transfer_integrity as fixture
from server_modules import sample_assets, storage_core
server, state_with_samples = fixture.server, fixture.state_with_samples


class AssetTransactionTests(unittest.TestCase):
    def setUp(self):
        self.assertIs(sample_assets, server.sample_assets)
        self.assertIs(storage_core, server.storage_core)
        fixture.ImportCommitTests.setUp(self)
        self.addCleanup(gc.collect)
    save = fixture.ImportCommitTests.save

    def inline(self, content=b"KEEP", photo_id="p"):
        return {"id": photo_id, "name": "photo.jpg", "dataUrl": "data:image/jpeg;base64," + base64.b64encode(content).decode()}

    def photo(self):
        return server.get_state()[0]["sampleLibrary"]["categories"][0]["samples"][0]["photos"][0]

    def test_sanitized_file_name_collisions_do_not_overwrite(self):
        first = server.write_sample_asset_file("s", "same/id", b"ONE", "photo.jpg", "image/jpeg")
        second = server.write_sample_asset_file("s", "same_id", b"TWO", "photo.jpg", "image/jpeg")
        self.assertNotEqual(first["relativePath"], second["relativePath"])
        self.assertEqual((server.DATA_DIR / first["relativePath"]).read_bytes(), b"ONE")
        self.assertEqual((server.DATA_DIR / second["relativePath"]).read_bytes(), b"TWO")

    def test_existing_asset_id_cannot_move_to_another_sample(self):
        self.save(state_with_samples({"id": "s", "sn": "A", "photos": [self.inline()]}))
        before = server.get_state()
        photo = self.photo()
        incoming = copy.deepcopy(before[0])
        incoming["sampleLibrary"]["categories"][0]["samples"].append({"id": "other", "sn": "B", "photos": [photo]})
        with self.assertRaisesRegex(ValueError, "归属|编号"):
            seed_state(incoming, before[1], "127.0.0.1")
        self.assertEqual(server.get_state(), before)
        self.assertEqual((server.DATA_DIR / photo["relativePath"]).read_bytes(), b"KEEP")

    def test_asset_path_cannot_be_claimed_by_another_photo(self):
        self.save(state_with_samples({"id": "s", "sn": "A", "photos": [self.inline()]}))
        state, rev, _ = server.get_state()
        photo = self.photo()
        other = {**photo, "id": "other-photo"}
        state["sampleLibrary"]["categories"][0]["samples"].append({"id": "other", "sn": "B", "photos": [other]})
        with self.assertRaisesRegex(ValueError, "路径"):
            seed_state(state, rev, "127.0.0.1")


    def test_failed_save_removes_new_files_and_preserves_old_files(self):
        self.save(state_with_samples({"id": "s", "sn": "A", "photos": [self.inline()]}))
        before = server.get_state()
        old_path = server.DATA_DIR / self.photo()["relativePath"]
        original = server.sync_sample_library
        def fail_after_sync(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError("injected after file writes and removals")
        with patch.object(server, "sync_sample_library", side_effect=fail_after_sync), self.assertRaises(RuntimeError):
            seed_state(state_with_samples({"id": "new", "sn": "B", "photos": [self.inline(b"NEW", "new-photo")]}), before[1], "127.0.0.1")
        self.assertEqual(server.get_state(), before)
        self.assertEqual(old_path.read_bytes(), b"KEEP")
        self.assertEqual([p for p in server.SAMPLE_DATA_DIR.rglob("*") if p.is_file()], [old_path])

    def test_successful_removal_deletes_files_after_commit(self):
        self.save(state_with_samples({"id": "s", "sn": "A", "photos": [self.inline()]}))
        path = server.DATA_DIR / self.photo()["relativePath"]
        self.save(state_with_samples())
        self.assertFalse(path.exists())

    def test_committed_files_survive_an_error_after_manual_commit(self):
        with self.assertRaisesRegex(RuntimeError, "after commit"):
            with server.write_db_connection() as conn:
                meta = server.store_asset_bytes(conn, "s", b"COMMITTED", "photo.jpg", "image/jpeg")
                conn.commit()
                raise RuntimeError("after commit")
        self.assertEqual((server.DATA_DIR / meta["relativePath"]).read_bytes(), b"COMMITTED")

    def test_nested_file_transaction_does_not_cleanup_before_outer_rollback(self):
        with self.assertRaisesRegex(RuntimeError, "outer rollback"):
            with server.write_db_connection() as conn:
                meta = server.store_asset_bytes(conn, "s", b"NEW", "photo.jpg", "image/jpeg")
                with storage_core.write_db_connection_from_factory(lambda: conn):
                    self.assertTrue((server.DATA_DIR / meta["relativePath"]).exists())
                self.assertTrue(conn.in_transaction)
                self.assertTrue((server.DATA_DIR / meta["relativePath"]).exists())
                raise RuntimeError("outer rollback")
        self.assertFalse((server.DATA_DIR / meta["relativePath"]).exists())
        self.assertIsNone(sample_assets._FILE_TRANSACTION.get())

    def test_scheduled_cleanup_keeps_a_file_still_referenced_after_commit(self):
        self.save(state_with_samples({"id": "s", "sn": "A", "photos": [self.inline()]}))
        photo = self.photo()
        with server.write_db_connection():
            server.unlink_asset_relative_paths([photo["relativePath"]])
        self.assertEqual((server.DATA_DIR / photo["relativePath"]).read_bytes(), b"KEEP")


    def test_thumbnail_id_cannot_overwrite_an_original_photo(self):
        self.save(state_with_samples({"id": "s", "sn": "A", "photos": [self.inline(photo_id="p__thumb")]}))
        before = server.get_state()
        with self.assertRaisesRegex(ValueError, "归属|类型"):
            with server.write_db_connection() as conn:
                server.store_thumbnail_bytes(conn, "s", "p", b"REPLACE", "thumb.jpg", "image/jpeg")
        self.assertEqual(server.get_state(), before)



    def test_legacy_path_alias_is_still_a_live_reference(self):
        self.save(state_with_samples({"id": "s", "sn": "A", "photos": [self.inline()]}))
        photo = self.photo()
        with server.write_db_connection() as conn:
            conn.execute("INSERT INTO sample_assets (id, sample_id, kind, file_name, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                         ("legacy-alias", "other", "photo", "p.jpg", "samples/s/photos/./p.jpg", server.now_iso()))
        with server.write_db_connection() as conn:
            conn.execute("DELETE FROM sample_assets WHERE id = ?", (photo["id"],))
            server.unlink_asset_relative_paths([photo["relativePath"]])
        self.assertEqual((server.DATA_DIR / photo["relativePath"]).read_bytes(), b"KEEP")

    def test_borrowed_transaction_without_outer_file_scope_rejects_file_effects(self):
        conn = server.connect_db()
        try:
            conn.execute("BEGIN")
            with self.assertRaisesRegex(RuntimeError, "外层 asset_file_transaction"):
                with storage_core.write_db_connection_from_factory(lambda: conn):
                    server.store_asset_bytes(conn, "s", b"UNTRACKED", "photo.jpg", "image/jpeg")
            self.assertTrue(conn.in_transaction)
            conn.rollback()
        finally:
            conn.close()
        self.assertEqual([p for p in server.SAMPLE_DATA_DIR.rglob("*") if p.is_file()], [])

    def test_qualified_module_name_shares_the_runtime_file_transaction(self):
        from backend.server_modules import sample_assets as qualified
        self.assertIs(qualified._FILE_TRANSACTION, sample_assets._FILE_TRANSACTION)
        self.save(state_with_samples({"id": "s", "sn": "A", "photos": [self.inline()]}))
        photo = self.photo()
        with self.assertRaises(RuntimeError):
            with server.write_db_connection() as conn:
                conn.execute("DELETE FROM sample_assets WHERE id = ?", (photo["id"],))
                qualified.unlink_asset_relative_paths(server._asset_context(), [photo["relativePath"]])
                raise RuntimeError("rollback across module aliases")
        self.assertEqual((server.DATA_DIR / photo["relativePath"]).read_bytes(), b"KEEP")

    def test_photo_response_query_failure_rolls_back_before_commit(self):
        self.save(state_with_samples({"id": "s", "sn": "A"}))
        before = server.get_state()
        with patch.object(server, "load_sample_photos", side_effect=RuntimeError("response query failed")):
            with self.assertRaisesRegex(RuntimeError, "response query"):
                with server.write_db_connection() as conn:
                    meta = server.store_asset_bytes(conn, "s", b"NEW", "photo.jpg", "image/jpeg")
                    server.commit_sample_asset_mutation(conn, "s", "upload_sample_photos", "test", "127.0.0.1")
        self.assertEqual(server.get_state(), before)
        self.assertFalse((server.DATA_DIR / meta["relativePath"]).exists())


if __name__ == "__main__":
    unittest.main()
