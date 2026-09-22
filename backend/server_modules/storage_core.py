"""SQLite connection primitives for TestChamber data access."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from server_modules import sample_assets


def connect_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def write_db_connection(db_path: Path):
    """Open a SQLite write transaction without taking a process-wide lock."""
    with write_db_connection_from_factory(lambda: connect_db(db_path)) as conn:
        yield conn


@contextmanager
def write_db_connection_from_factory(connect_factory):
    """Open a SQLite write transaction using a caller-provided connection factory."""
    conn = connect_factory()
    if getattr(conn, "in_transaction", False) or sample_assets.has_asset_file_transaction(conn):
        # A nested caller does not own the outer transaction. In particular,
        # entering SQLite's own context manager here would commit it on exit.
        with sample_assets.asset_file_transaction(conn, owns_transaction=False):
            yield conn
        return
    try:
        # Resolve file effects only after SQLite has committed/rolled back, and
        # keep the connection open until the journal has checked references.
        with sample_assets.asset_file_transaction(conn):
            with conn:
                conn.execute("BEGIN IMMEDIATE")
                yield conn
    finally:
        conn.close()
