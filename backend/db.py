"""Encrypted storage ("vault") for the portfolio database.

While unlocked, the whole SQLite database lives in memory. On disk it exists only as
one AES-256-GCM encrypted file (data/portfolio.enc) whose key is derived from the
user's password with scrypt. Nothing about the password is stored anywhere, so a
forgotten password means the data cannot be recovered. That is deliberate.

Every API request acquires the vault (a process-wide lock), uses the in-memory
connection, and on release the database is re-encrypted and written back if any
row changed. Writes go to a temp file first and are swapped in atomically.

File layout: MAGIC(8) | salt(16) | nonce(12) | ciphertext + GCM tag
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
import sys
import threading
import time
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"ITVAULT1"
SALT_LEN = 16
NONCE_LEN = 12
KEY_LEN = 32
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**15, 8, 1
SCRYPT_MAXMEM = 128 * 1024 * 1024
MIN_PASSWORD_LEN = 8


def _resolve_data_dir() -> Path:
    """Where the vault file lives.

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


def _idle_lock_seconds() -> int:
    """Auto-lock after this many idle seconds (INVESTMENT_TRACKER_IDLE_LOCK_MINUTES, default 30, 0 disables)."""
    try:
        minutes = int(os.environ.get("INVESTMENT_TRACKER_IDLE_LOCK_MINUTES", "30"))
    except ValueError:
        minutes = 30
    return max(0, minutes) * 60


DATA_DIR = _resolve_data_dir()
VAULT_PATH = DATA_DIR / "portfolio.enc"
LEGACY_DB_PATH = DATA_DIR / "portfolio.db"  # unencrypted database from versions before the vault
IDLE_LOCK_SECONDS = _idle_lock_seconds()

FUNDS_TABLE = """
CREATE TABLE IF NOT EXISTS {name} (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    kind          TEXT    NOT NULL DEFAULT 'MF' CHECK (kind IN ('MF', 'STOCK', 'NPS', 'EPF')),
    scheme_code   INTEGER,                      -- AMFI scheme code (mutual funds; used by mfapi.in)
    symbol        TEXT,                         -- ticker symbol (stocks; used by the quote source), e.g. ALL.AX
    exchange      TEXT,                         -- stocks: exchange name as reported by the quote source
    currency      TEXT    NOT NULL DEFAULT 'INR',  -- currency of amounts, NAVs / prices and units' value
    details       TEXT,                         -- kind-specific JSON (NPS: pension fund manager, tier, scheme ids)
    folio_number  TEXT    NOT NULL DEFAULT '',  -- folio (mutual funds) or account (stocks)
    locked        INTEGER NOT NULL DEFAULT 0,    -- 1 = under lock-in, 0 = open / redeemable
    lock_in_until TEXT,                          -- optional ISO date, informational
    notes         TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
"""

TXN_TABLE = """
CREATE TABLE IF NOT EXISTS {name} (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_id      INTEGER NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
    date         TEXT    NOT NULL,               -- ISO YYYY-MM-DD
    folio_number TEXT    NOT NULL DEFAULT '',
    scheme       TEXT    NOT NULL DEFAULT '',    -- NPS: scheme letter (E / C / G / A); blank for other kinds
    type         TEXT    NOT NULL CHECK (type IN ('SIP', 'LUMPSUM', 'REDEMPTION', 'DIVIDEND', 'BONUS', 'SWITCH_IN', 'SWITCH_OUT', 'CHARGE')),
    amount       REAL    NOT NULL,                -- never negative; type gives the direction (0 for BONUS)
    nav          REAL    NOT NULL,                -- price per unit; informational (may be 0) for DIVIDEND / BONUS
    units        REAL    NOT NULL,                -- never negative; sales / switches out / charges reduce holdings
    rate         REAL,                             -- EPF: interest rate % applicable (informational)
    notes        TEXT    NOT NULL DEFAULT ''
);
"""

FUND_COLUMNS = ["id", "name", "kind", "scheme_code", "symbol", "exchange", "currency", "details", "folio_number",
                "locked", "lock_in_until", "notes", "created_at"]
TXN_COLUMNS = ["id", "fund_id", "date", "folio_number", "scheme", "type", "amount", "nav", "units", "rate", "notes"]

SCHEMA = FUNDS_TABLE.format(name="funds") + TXN_TABLE.format(name="transactions") + """
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

-- Daily closing prices for stocks and exchange rates (FX pairs are symbols like 'AUDINR=X').
CREATE TABLE IF NOT EXISTS quotes (
    symbol TEXT NOT NULL,
    date   TEXT NOT NULL,                        -- ISO YYYY-MM-DD, exchange-local trading day
    close  REAL NOT NULL,
    PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS quote_meta (
    symbol       TEXT PRIMARY KEY,
    name         TEXT,
    exchange     TEXT,
    currency     TEXT,
    quote_type   TEXT,                           -- EQUITY, ETF, CURRENCY, ...
    last_fetched TEXT
);
"""


# ----------------------------------------------------------------- errors

class VaultError(Exception):
    """Base class for vault problems."""


class VaultNotSetUp(VaultError):
    """No encrypted database exists yet; the user must choose a password first."""


class VaultLocked(VaultError):
    """The encrypted database exists but has not been unlocked in this session."""


class WrongPassword(VaultError):
    """The password did not decrypt the vault."""


class VaultExists(VaultError):
    """Setup was attempted although a vault already exists."""


# ----------------------------------------------------------------- crypto helpers

def derive_key(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=KEY_LEN, maxmem=SCRYPT_MAXMEM
    )


def _encrypt(key: bytes, salt: bytes, plaintext: bytes) -> bytes:
    nonce = secrets.token_bytes(NONCE_LEN)
    return MAGIC + salt + nonce + AESGCM(key).encrypt(nonce, plaintext, MAGIC)


def _split(blob: bytes) -> tuple[bytes, bytes, bytes]:
    if len(blob) < len(MAGIC) + SALT_LEN + NONCE_LEN + 16 or not blob.startswith(MAGIC):
        raise VaultError("portfolio.enc is not a valid vault file")
    o = len(MAGIC)
    salt = blob[o : o + SALT_LEN]
    o += SALT_LEN
    nonce = blob[o : o + NONCE_LEN]
    o += NONCE_LEN
    return salt, nonce, blob[o:]


def _decrypt(key: bytes, blob: bytes) -> bytes:
    _, nonce, ciphertext = _split(blob)
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, MAGIC)
    except InvalidTag as e:
        raise WrongPassword("Wrong password") from e


def _memory_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _normalize_header(data: bytes) -> bytes:
    """Force rollback-journal mode in the SQLite header (bytes 18/19: 2 = WAL, 1 = legacy).

    Databases from the unencrypted version were in WAL mode. A deserialized in-memory
    database cannot use WAL, so a WAL header makes the first write fail with
    'unable to open database file'. In memory the mode is irrelevant, so rewrite it.
    """
    if len(data) >= 20 and (data[18] == 2 or data[19] == 2):
        patched = bytearray(data)
        patched[18] = 1
        patched[19] = 1
        return bytes(patched)
    return data


def _table_state(conn: sqlite3.Connection, name: str) -> tuple[str, set[str]]:
    row = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone()
    cols = {r[1] for r in conn.execute(f"PRAGMA table_info({name})")}
    return (row[0] if row else ""), cols


def _rebuild(conn: sqlite3.Connection, name: str, template: str, columns: list[str], existing: set[str], extra_sql: str = "") -> None:
    """Recreate `name` from `template` keeping ids and every column the old table had. SQLite cannot alter
    CHECK constraints or NOT NULL in place, so this is how schema changes are applied."""
    keep = ", ".join(c for c in columns if c in existing)
    conn.executescript(
        template.format(name=f"{name}_v2")
        + f"INSERT INTO {name}_v2 ({keep}) SELECT {keep} FROM {name};\n"
        + f"DROP TABLE {name};\n"
        + f"ALTER TABLE {name}_v2 RENAME TO {name};\n"
        + extra_sql
    )


def _migrate(conn: sqlite3.Connection) -> bool:
    """Bring an older database up to the current schema. Returns True if anything changed."""
    changed = False
    fund_sql, fund_cols = _table_state(conn, "funds")
    if fund_sql and ("details" not in fund_cols or "'EPF'" not in fund_sql):
        # funds gained kind / symbol / exchange / currency (stocks), then details and the NPS kind. Foreign keys
        # must be off while the old table is dropped, or ON DELETE CASCADE would wipe the transactions.
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            _rebuild(conn, "funds", FUNDS_TABLE, FUND_COLUMNS, fund_cols)
            if conn.execute("PRAGMA foreign_key_check").fetchall():
                raise VaultError("database upgrade failed: transactions reference missing funds")
        finally:
            conn.execute("PRAGMA foreign_keys = ON")
        changed = True
    tx_sql, tx_cols = _table_state(conn, "transactions")
    if tx_sql and ("'CHARGE'" not in tx_sql or "scheme" not in tx_cols or "rate" not in tx_cols):  # quoted: the CHECK, not a comment
        # The CHECK constraint on `type` gained REDEMPTION, DIVIDEND / BONUS, then SWITCH_IN / SWITCH_OUT / CHARGE,
        # and the NPS scheme column arrived. Transactions are referenced by nothing else, so a plain rebuild.
        _rebuild(conn, "transactions", TXN_TABLE, TXN_COLUMNS, tx_cols,
                 "CREATE INDEX IF NOT EXISTS idx_txn_fund_date ON transactions(fund_id, date);\n")
        changed = True
    return changed


def _load_memory_db(data: bytes) -> tuple[sqlite3.Connection, bool]:
    """Deserialize into a fresh in-memory connection and apply schema updates. Returns (conn, migrated)."""
    conn = _memory_conn()
    conn.deserialize(_normalize_header(data))
    conn.executescript(SCHEMA)  # harmless on existing data; creates anything missing
    return conn, _migrate(conn)


def _check_password(password: str) -> None:
    if not isinstance(password, str) or len(password) < MIN_PASSWORD_LEN:
        raise VaultError(f"Password must be at least {MIN_PASSWORD_LEN} characters")


# ----------------------------------------------------------------- the vault

class Vault:
    def __init__(self) -> None:
        # A plain Lock, not an RLock: FastAPI runs acquire() (dependency setup) and release() (teardown) in
        # threadpool threads, and they are not always the same thread. An RLock would refuse the release and
        # stay held, freezing every later request. Nothing here needs re-entrancy.
        self._guard = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        self._key: bytes | None = None
        self._salt: bytes | None = None
        self._saved_changes = 0
        self._last_activity = 0.0

    # ---- state -----------------------------------------------------------
    def exists(self) -> bool:
        return VAULT_PATH.exists()

    def has_legacy(self) -> bool:
        return LEGACY_DB_PATH.exists()

    def is_unlocked(self) -> bool:
        return self._conn is not None

    def state(self) -> str:
        if not self.exists():
            return "setup"
        return "unlocked" if self.is_unlocked() else "locked"

    def legacy_fund_count(self) -> int | None:
        """How many funds the old unencrypted database holds (shown on the setup screen)."""
        if not self.has_legacy():
            return None
        try:
            src = sqlite3.connect(LEGACY_DB_PATH)
            try:
                return src.execute("SELECT COUNT(*) FROM funds").fetchone()[0]
            finally:
                src.close()
        except sqlite3.Error:
            return None

    def prepare(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)

    # ---- lifecycle -------------------------------------------------------
    def setup(self, password: str) -> bool:
        """Create the vault. Migrates an existing unencrypted database if present. Returns True if migrated."""
        _check_password(password)
        with self._guard:
            if self.exists():
                raise VaultExists("A vault already exists; unlock it instead")
            self.prepare()
            salt = secrets.token_bytes(SALT_LEN)
            key = derive_key(password, salt)
            migrated = False
            if self.has_legacy():
                staging = _memory_conn()
                src = sqlite3.connect(LEGACY_DB_PATH)
                try:
                    src.backup(staging)
                finally:
                    src.close()
                # Re-load through serialize/deserialize so the (possibly WAL) header is normalised.
                conn, _ = _load_memory_db(staging.serialize())
                staging.close()
                migrated = True
            else:
                conn = _memory_conn()
                conn.executescript(SCHEMA)
            self._conn, self._key, self._salt = conn, key, salt
            self._write_blob()
            if migrated:
                self._retire_legacy()
            self._saved_changes = conn.total_changes
            self._touch()
            return migrated

    def unlock(self, password: str) -> None:
        with self._guard:
            if not self.exists():
                raise VaultNotSetUp()
            blob = VAULT_PATH.read_bytes()
            salt, _, _ = _split(blob)
            key = derive_key(password, salt)
            plaintext = _decrypt(key, blob)  # raises WrongPassword
            conn, migrated = _load_memory_db(plaintext)
            if self._conn is not None:
                self._conn.close()
            self._conn, self._key, self._salt = conn, key, salt
            if migrated:
                self._write_blob()  # persist the upgraded schema right away
            self._saved_changes = conn.total_changes
            self._touch()

    def lock(self) -> None:
        with self._guard:
            self._lock_held()

    def _lock_held(self) -> None:
        """Flush and forget the key; the caller holds the guard."""
        if self._conn is None:
            return
        try:
            self.save_if_dirty()
        finally:
            self._conn.close()
            self._conn = None
            self._key = None
            self._salt = None

    def change_password(self, current: str, new: str) -> None:
        _check_password(new)
        with self._guard:
            self._require_unlocked()
            if not hmac.compare_digest(derive_key(current, self._salt), self._key):
                raise WrongPassword("Current password is wrong")
            self._salt = secrets.token_bytes(SALT_LEN)
            self._key = derive_key(new, self._salt)
            self._write_blob()

    # ---- per-request access ----------------------------------------------
    def acquire(self) -> sqlite3.Connection:
        """Take the vault lock for one request and return the connection. Pair with release()."""
        self._guard.acquire()
        try:
            if IDLE_LOCK_SECONDS and self._conn is not None and time.monotonic() - self._last_activity > IDLE_LOCK_SECONDS:
                self._lock_held()
            self._require_unlocked()
            self._touch()
            return self._conn
        except Exception:
            self._guard.release()
            raise

    def release(self) -> None:
        try:
            self.save_if_dirty()
        finally:
            self._guard.release()

    def save_if_dirty(self) -> None:
        if self._conn is not None and self._conn.total_changes != self._saved_changes:
            self._write_blob()
            self._saved_changes = self._conn.total_changes

    # ---- internals -------------------------------------------------------
    def _require_unlocked(self) -> None:
        if self._conn is None:
            raise VaultLocked() if self.exists() else VaultNotSetUp()

    def _touch(self) -> None:
        self._last_activity = time.monotonic()

    def _write_blob(self) -> None:
        blob = _encrypt(self._key, self._salt, _normalize_header(self._conn.serialize()))
        tmp = VAULT_PATH.with_name(VAULT_PATH.name + ".tmp")
        with open(tmp, "wb") as fh:
            fh.write(blob)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, VAULT_PATH)

    def _retire_legacy(self) -> None:
        """Remove the unencrypted database, but only after proving the vault file decrypts."""
        _decrypt(self._key, VAULT_PATH.read_bytes())
        for suffix in ("", "-wal", "-shm"):
            try:
                Path(str(LEGACY_DB_PATH) + suffix).unlink()
            except FileNotFoundError:
                pass


vault = Vault()
