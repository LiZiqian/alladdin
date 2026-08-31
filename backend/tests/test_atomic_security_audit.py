from __future__ import annotations

import sqlite3
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import server  # noqa: E402


class AtomicSecurityAuditTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        server.ensure_schema(self.conn)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()

    def test_business_audit_is_mirrored_inside_same_transaction(self):
        self.conn.execute("BEGIN")
        self.conn.execute(
            """
            INSERT INTO audit_log
            (time, user, action, remark, revision_before, revision_after, client_ip)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (server.now_iso(), "tester", "update_project", "atomic", 1, 2, "10.31.118.62"),
        )
        row = self.conn.execute(
            "SELECT action, client_ip, resource_type, allowed, detail_json "
            "FROM security_audit_log ORDER BY id DESC LIMIT 1"
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["action"], "update_project")
        self.assertEqual(row["client_ip"], "10.31.118.62")
        self.assertEqual(row["resource_type"], "business_write")
        self.assertEqual(row["allowed"], 1)
        self.assertIn('"atomic":true', row["detail_json"])

        self.conn.rollback()
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM security_audit_log").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
