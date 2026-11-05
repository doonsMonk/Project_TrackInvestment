"""NAV data source: mfapi.in (free JSON API over AMFI's published NAV data).

All NAV history is cached in SQLite so the app keeps working offline with the
last-fetched values. A scheme is re-fetched when its cache is older than
STALE_AFTER, or when a refresh is forced from the UI.
"""
from __future__ import annotations

import json
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

MFAPI_BASE = "https://api.mfapi.in"
STALE_AFTER = timedelta(hours=6)
RETRY_FAILED_AFTER = timedelta(minutes=10)
HTTP_TIMEOUT = 15
USER_AGENT = "InvestmentTracker/0.1 (local)"

# scheme_code -> (last failed attempt, error), so an outage doesn't slow every page load; the error is
# reported again (without a new request) until the retry window has passed
_last_failure: dict[int, tuple[datetime, str]] = {}


class NavSourceError(Exception):
    """Raised when the upstream NAV service can't be reached or returns junk."""


def _get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise NavSourceError(f"NAV source returned HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise NavSourceError(f"Could not reach NAV source: {e}") from e
    except json.JSONDecodeError as e:
        raise NavSourceError("NAV source returned invalid JSON") from e


def _to_iso(dmy: str) -> str:
    """Convert DD-MM-YYYY (mfapi format) to ISO YYYY-MM-DD."""
    return datetime.strptime(dmy, "%d-%m-%Y").date().isoformat()


# ---------------------------------------------------------------- remote calls

def search_schemes(query: str) -> list[dict]:
    q = urllib.parse.quote(query.strip())
    data = _get_json(f"{MFAPI_BASE}/mf/search?q={q}")
    if not isinstance(data, list):
        return []
    out = []
    for item in data:
        try:
            out.append({"scheme_code": int(item["schemeCode"]), "scheme_name": str(item["schemeName"])})
        except (KeyError, ValueError, TypeError):
            continue
    return out


def fetch_history(scheme_code: int) -> tuple[dict, list[tuple[str, float]]]:
    payload = _get_json(f"{MFAPI_BASE}/mf/{scheme_code}")
    if not isinstance(payload, dict):
        raise NavSourceError(f"Unexpected response for scheme {scheme_code}")
    meta = payload.get("meta") or {}
    rows: list[tuple[str, float]] = []
    for item in payload.get("data") or []:
        try:
            rows.append((_to_iso(item["date"]), float(item["nav"])))
        except (KeyError, ValueError, TypeError):
            continue
    if not rows:
        raise NavSourceError(f"No NAV data returned for scheme {scheme_code}")
    return meta, rows


# ---------------------------------------------------------------- cache logic

def _recent_failure(code: int, force: bool) -> str | None:
    failed = _last_failure.get(code)
    if failed and not force and datetime.now() - failed[0] < RETRY_FAILED_AFTER:
        return failed[1]
    return None


def _is_stale(conn: sqlite3.Connection, code: int, force: bool) -> bool:
    if force:
        return True
    row = conn.execute("SELECT last_fetched FROM scheme_meta WHERE scheme_code = ?", (code,)).fetchone()
    if not row or not row["last_fetched"]:
        return True
    return datetime.now() - datetime.fromisoformat(row["last_fetched"]) >= STALE_AFTER


def _safe_fetch(code: int):
    try:
        return fetch_history(code)
    except Exception as e:  # noqa: BLE001 - reported per scheme to the caller
        return e


def _store(conn: sqlite3.Connection, code: int, meta: dict, rows: list[tuple[str, float]]) -> None:
    with conn:
        conn.executemany(
            "INSERT OR REPLACE INTO nav_history(scheme_code, date, nav) VALUES (?, ?, ?)",
            [(code, d, n) for d, n in rows],
        )
        conn.execute(
            """
            INSERT INTO scheme_meta(scheme_code, scheme_name, fund_house, scheme_category, last_fetched)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(scheme_code) DO UPDATE SET
                scheme_name     = excluded.scheme_name,
                fund_house      = excluded.fund_house,
                scheme_category = excluded.scheme_category,
                last_fetched    = excluded.last_fetched
            """,
            (
                code,
                meta.get("scheme_name"),
                meta.get("fund_house"),
                meta.get("scheme_category"),
                datetime.now().isoformat(timespec="seconds"),
            ),
        )


def refresh_many(conn: sqlite3.Connection, codes, force: bool = False) -> dict[int, str]:
    """Fetch stale schemes in parallel, store serially. Returns {code: error} for failures."""
    errors: dict[int, str] = {}
    todo = []
    for c in dict.fromkeys(codes):
        recent = _recent_failure(c, force)
        if recent:
            errors[c] = recent  # still failing as far as we know; don't hammer the source
        elif _is_stale(conn, c, force):
            todo.append(c)
    if not todo:
        return errors
    with ThreadPoolExecutor(max_workers=min(6, len(todo))) as ex:
        results = list(ex.map(_safe_fetch, todo))
    for code, res in zip(todo, results):
        if isinstance(res, Exception):
            _last_failure[code] = (datetime.now(), str(res))
            errors[code] = str(res)
        else:
            _last_failure.pop(code, None)
            _store(conn, code, *res)
    return errors


def refresh_scheme(conn: sqlite3.Connection, code: int, force: bool = False) -> None:
    errors = refresh_many(conn, [code], force)
    if code in errors:
        raise NavSourceError(errors[code])


# ---------------------------------------------------------------- cache reads

def get_history(conn: sqlite3.Connection, code: int) -> list[tuple[str, float]]:
    """Ascending (iso_date, nav)."""
    return [
        (r["date"], r["nav"])
        for r in conn.execute("SELECT date, nav FROM nav_history WHERE scheme_code = ? ORDER BY date", (code,))
    ]


def latest_nav(conn: sqlite3.Connection, code: int) -> tuple[str, float] | None:
    r = conn.execute(
        "SELECT date, nav FROM nav_history WHERE scheme_code = ? ORDER BY date DESC LIMIT 1", (code,)
    ).fetchone()
    return (r["date"], r["nav"]) if r else None


def nav_on_or_before(conn: sqlite3.Connection, code: int, iso_date: str) -> tuple[str, float] | None:
    r = conn.execute(
        "SELECT date, nav FROM nav_history WHERE scheme_code = ? AND date <= ? ORDER BY date DESC LIMIT 1",
        (code, iso_date),
    ).fetchone()
    return (r["date"], r["nav"]) if r else None


def scheme_meta(conn: sqlite3.Connection, code: int) -> dict | None:
    r = conn.execute("SELECT * FROM scheme_meta WHERE scheme_code = ?", (code,)).fetchone()
    return dict(r) if r else None
