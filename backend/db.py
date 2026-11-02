"""SQLite connection helpers and schema."""
from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path


def _resolve_data_dir() -> Path:
    """Where portfolio.db lives.

    1. INVESTMENT_TRACKER_DATA environment variable, if set.
    2. Packaged exe: a `data` folder next to the exe (portable, easy to back up),
       falling back to %LOCALAPPDATA%\\InvestmentTracker\\data if that isn't writable.
    3. Dev checkout: <project>/data.
    """
    env = os.environ.get("INVESTMENT_TRACKER_DATA")
    if env:
        return Path(env)
    if getattr(sys, "frozen", False):
        beside_exe = Path(sys.executable).resolve().parent / "data"
        try:
            beside_exe.mkdir(parents=True, exist_ok=True)
            probe = beside_exe / ".write_test"
            probe.touch()
            probe.unlink()
            return beside_exe
        except OSError:
            local = os.environ.get("LOCALAPPDATA") or str(Path.home())
            return Path(local) / "InvestmentTracker" / "data"
    return Path(__file__).resolve().parent.parent / "data"


DATA_DIR = _resolve_data_dir()
DB_PATH = DATA_DIR / "portfolio.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS funds (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    scheme_code   INTEGER NOT NULL,              -- AMFI scheme code (used by mfapi.in)
    folio_number  TEXT    NOT NULL DEFAULT '',
    locked        INTEGER NOT NULL DEFAULT 0,    -- 1 = under lock-in, 0 = open / redeemable
    lock_in_until TEXT,                          -- optional ISO date, informational
    notes         TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_id      INTEGER NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
    date         TEXT    NOT NULL,               -- ISO YYYY-MM-DD
    folio_number TEXT    NOT NULL DEFAULT '',
    type         TEXT    NOT NULL CHECK (type IN ('SIP', 'LUMPSUM')),
    amount       REAL    NOT NULL,
    nav          REAL    NOT NULL,
    units        REAL    NOT NULL,
    notes        TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_txn_fund_date ON transactions(fund_id, date);

CREATE TABLE IF NOT EXISTS nav_history (
    scheme_code INTEGER NOT NULL,
    date        TEXT    NOT NULL,                -- ISO YYYY-MM-DD
    nav         REAL    NOT NULL,
    PRIMARY KEY (scheme_code, date)
);

CREATE TABLE IF NOT EXISTS scheme_meta (
    scheme_code     INTEGER PRIMARY KEY,
    scheme_name     TEXT,
    fund_house      TEXT,
    scheme_category TEXT,
    last_fetched    TEXT                         -- ISO datetime of last successful fetch
);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db() -> None:
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()
