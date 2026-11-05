"""NPS (National Pension System) scheme NAVs from NPS Trust (npstrust.org.in).

Every NPS scheme - SBI / ICICI / HDFC ... Scheme E / C / G / A, Tier I / II, and the newer GS / Direct / POP
variants - has a scheme id such as SM007001 (ICICI Prudential Pension Fund Scheme E, Tier I). Two public
resources are used:
  * the daily NAV file (tab-separated): every scheme with its id, name, pension fund manager and latest NAV
  * the endpoint behind the site's NAV chart, which returns one scheme's full daily history since 2009
Histories are cached in the `quotes` table under the symbol 'NPS:<scheme id>', exactly like stock prices,
so the app keeps working offline with the last-fetched values.
"""
from __future__ import annotations

import json
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from . import quotes

DAILY_URL = "https://npstrust.org.in/nav-report-excel"
HISTORY_URL = "https://npstrust.org.in/nav-graphs-details?lnavdata={pfm}&yearval=all&subcat={scheme}&vaname=&sector="
PREFIX = "NPS:"  # symbol prefix in the quotes table
SCHEME_LIST_TTL = timedelta(hours=6)
HTTP_TIMEOUT = 30
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InvestmentTracker/0.5"
SCHEME_ID_RE = re.compile(r"^SM\d{6}$")
LETTERS = ("E", "C", "G", "A")  # asset classes: equity, corporate bonds, government securities, alternatives

_scheme_list: dict = {"at": None, "rows": []}


class NpsSourceError(Exception):
    """Raised when NPS Trust can't be reached, doesn't know the scheme, or returns junk."""


def is_scheme_id(value: str) -> bool:
    return bool(SCHEME_ID_RE.match((value or "").strip().upper()))


def symbol(scheme_id: str) -> str:
    return PREFIX + scheme_id.strip().upper()


def pfm_id(scheme_id: str) -> str:
    """SM007001 -> PFM007 (the pension fund manager code the chart endpoint wants)."""
    return "PFM" + scheme_id.strip().upper()[2:5]


def parse_name(name: str) -> dict:
    """'NPS TRUST A/C ICICI PRUDENTIAL PENSION FUND SCHEME E - TIER I DIRECT' -> letter E, tier I, variant DIRECT."""
    up = re.sub(r"\s+", " ", (name or "").upper()).strip()
    letter = None
    m = re.search(r"SCHEME\s*-?\s*([ECGA])\b", up)
    if m:
        letter = m.group(1)
    elif "TAX SAVER" in up:
        letter = "TS"
    tier = None
    m = re.search(r"TIER\s*-?\s*(II|I)\b", up)
    if m:
        tier = m.group(1)
    variant = ""
    for v in ("DIRECT", "POP", "GS"):
        if re.search(rf"\b{v}\s*$", up):
            variant = v
            break
    category = ""
    for c in ("CENTRAL GOVT", "STATE GOVT", "CORPORATE-CG", "TAX SAVER", "VATSALYA", "SANCHAY", "BALANCED ADVANTAGE", "DREAM EQUITY"):
        if c in up:
            category = c.title()
            break
    return {"letter": letter, "tier": tier, "variant": variant, "category": category}


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        raise NpsSourceError(f"NPS Trust returned HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise NpsSourceError(f"Could not reach NPS Trust: {e}") from e


# ---------------------------------------------------------------- scheme list

def fetch_schemes() -> list[dict]:
    """Every scheme in today's NAV file: id, pension fund manager, name, letter / tier / variant, latest NAV."""
    text = _get(DAILY_URL).decode("utf-8", "replace")
    rows: list[dict] = []
    for line in text.splitlines():
        parts = [p.strip() for p in line.split("\t")]
        if len(parts) < 6 or not is_scheme_id(parts[3]):
            continue
        try:
            nav_value = float(parts[5].replace(",", ""))
        except ValueError:
            continue
        sid = parts[3].upper()
        rows.append(
            {
                "id": sid,
                "pfm_id": pfm_id(sid),
                "pfm": parts[2],
                "name": re.sub(r"\s+", " ", parts[4]),
                "nav": nav_value,
                "date": parts[1][:10],
                **parse_name(parts[4]),
            }
        )
    if not rows:
        raise NpsSourceError("NPS Trust's NAV file had no schemes in it")
    return rows


def list_schemes(force: bool = False) -> list[dict]:
    """Cached scheme list (re-read from NPS Trust every few hours)."""
    at = _scheme_list["at"]
    if force or at is None or datetime.now() - at >= SCHEME_LIST_TTL:
        try:
            _scheme_list["rows"] = fetch_schemes()
            _scheme_list["at"] = datetime.now()
        except NpsSourceError:
            if not _scheme_list["rows"]:
                raise
    return _scheme_list["rows"]


def scheme_info(scheme_id: str) -> dict | None:
    sid = scheme_id.strip().upper()
    try:
        return next((s for s in list_schemes() if s["id"] == sid), None)
    except NpsSourceError:
        return None


# ---------------------------------------------------------------- history

def fetch_history(scheme_id: str) -> tuple[dict, list[tuple[str, float]]]:
    """(meta, ascending [(iso_date, nav)]) for one scheme from the NAV chart endpoint."""
    sid = scheme_id.strip().upper()
    if not is_scheme_id(sid):
        raise NpsSourceError(f"{scheme_id} is not an NPS scheme id (expected SMnnnnnn)")
    raw = _get(HISTORY_URL.format(pfm=pfm_id(sid), scheme=urllib.parse.quote(sid)))
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise NpsSourceError("NPS Trust returned invalid data") from e
    points = payload.get("data") if isinstance(payload, dict) else None
    rows: dict[str, float] = {}
    for p in points or []:
        try:
            ts, value = int(p[0]) // 1000, float(p[1])
        except (TypeError, ValueError, IndexError):
            continue
        if value > 0:
            rows[datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()] = value
    if not rows:
        raise NpsSourceError(f"No NAV history for {sid}; is the scheme id right?")
    info = scheme_info(sid) or {}
    meta = {"name": info.get("name") or sid, "exchange": "NPS Trust", "currency": "INR", "quote_type": "NPS"}
    return meta, sorted(rows.items())


def _safe_fetch(sid: str):
    try:
        return fetch_history(sid)
    except Exception as e:  # noqa: BLE001 - reported per scheme to the caller
        return e


def refresh_many(conn: sqlite3.Connection, scheme_ids, force: bool = False) -> dict[str, str]:
    """Fetch stale schemes in parallel, store serially. Returns {'NPS:<id>': error} for failures."""
    errors: dict[str, str] = {}
    todo = []
    for sid in dict.fromkeys((s or "").strip().upper() for s in scheme_ids if s):
        sym = symbol(sid)
        recent = quotes._recent_failure(sym, force)
        if recent:
            errors[sym] = recent
        elif quotes._is_stale(conn, sym, force):
            todo.append(sid)
    if not todo:
        return errors
    with ThreadPoolExecutor(max_workers=min(4, len(todo))) as ex:
        results = list(ex.map(_safe_fetch, todo))
    for sid, res in zip(todo, results):
        sym = symbol(sid)
        if isinstance(res, Exception):
            quotes._last_failure[sym] = (datetime.now(), str(res))
            errors[sym] = str(res)
        else:
            quotes._last_failure.pop(sym, None)
            quotes._store(conn, sym, *res)
    return errors


def refresh_scheme(conn: sqlite3.Connection, scheme_id: str, force: bool = False) -> None:
    errors = refresh_many(conn, [scheme_id], force)
    if errors:
        raise NpsSourceError(next(iter(errors.values())))


# ---------------------------------------------------------------- cache reads (delegated to the quotes table)

def get_history(conn: sqlite3.Connection, scheme_id: str) -> list[tuple[str, float]]:
    return quotes.get_history(conn, symbol(scheme_id))


def latest(conn: sqlite3.Connection, scheme_id: str) -> tuple[str, float] | None:
    return quotes.latest(conn, symbol(scheme_id))


def on_or_before(conn: sqlite3.Connection, scheme_id: str, iso_date: str) -> tuple[str, float] | None:
    return quotes.on_or_before(conn, symbol(scheme_id), iso_date)


def meta(conn: sqlite3.Connection, scheme_id: str) -> dict | None:
    return quotes.meta(conn, symbol(scheme_id))
