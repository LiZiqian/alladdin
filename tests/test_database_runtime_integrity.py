"""Migration and shutdown regressions using disposable runtime directories."""
import contextlib
import io
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from server_modules import runtime_paths, server_runner, storage_core


class DatabaseRuntimeIntegrityTests(unittest.TestCase):
    def test_owned_write_connections_close_after_commit_or_rollback(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "owned.sqlite"
            with sqlite3.connect(db) as setup:
                setup.execute("CREATE TABLE saved (value TEXT)")
            setup.close()
            for fail in (False, True):
                with self.subTest(fail=fail):
                    conn = storage_core.connect_db(db)
                    try:
                        with storage_core.write_db_connection_from_factory(lambda: conn):
                            conn.execute("INSERT INTO saved VALUES (?)", (str(fail),))
                            if fail:
                                raise RuntimeError("rollback")
                    except RuntimeError:
                        self.assertTrue(fail)
                    with self.assertRaises(sqlite3.ProgrammingError):
                        conn.execute("SELECT 1")
            with sqlite3.connect(db) as reader:
                self.assertEqual(reader.execute("SELECT value FROM saved").fetchall(), [("False",)])
            reader.close()

    def test_borrowed_write_connection_stays_open_and_uncommitted(self):
        conn = sqlite3.connect(":memory:")
        try:
            conn.execute("CREATE TABLE saved (value TEXT)")
            conn.execute("BEGIN")
            with storage_core.write_db_connection_from_factory(lambda: conn):
                conn.execute("INSERT INTO saved VALUES ('pending')")
            self.assertTrue(conn.in_transaction)
            conn.rollback()
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM saved").fetchone()[0], 0)
        finally:
            conn.close()

    def test_nested_scope_after_manual_commit_keeps_outer_connection_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "nested.sqlite"
            with storage_core.write_db_connection(db) as conn:
                conn.execute("CREATE TABLE saved (value TEXT)")
                conn.commit()
                with storage_core.write_db_connection_from_factory(lambda: conn):
                    conn.execute("INSERT INTO saved VALUES ('inner')")
                self.assertTrue(conn.in_transaction)
                conn.execute("INSERT INTO saved VALUES ('outer')")
            with self.assertRaises(sqlite3.ProgrammingError):
                conn.execute("SELECT 1")
            with sqlite3.connect(db) as reader:
                self.assertEqual(reader.execute("SELECT value FROM saved").fetchall(), [("inner",), ("outer",)])
            reader.close()



    def test_server_closes_socket_on_stop_and_serve_failure(self):
        paths = SimpleNamespace(root_dir="root", data_dir="data", db_path="db", sample_data_dir="samples", import_preview_dir="previews", export_dir="exports")
        for error in (KeyboardInterrupt(), RuntimeError("serve failed")):
            with self.subTest(error=type(error).__name__):
                httpd = Mock()
                httpd.serve_forever.side_effect = error
                with patch.object(sys, "argv", ["server"]), patch.object(server_runner, "ThreadingHTTPServer", return_value=httpd), contextlib.redirect_stdout(io.StringIO()):
                    try:
                        server_runner.run_server(description="test", default_data_dir="data", prepare_runtime_data_root=lambda *a, **kw: SimpleNamespace(migrated=False, skipped=""), init_db=lambda: None, handler_cls=object, runtime_paths=lambda: paths)
                    except RuntimeError:
                        pass
                httpd.server_close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
