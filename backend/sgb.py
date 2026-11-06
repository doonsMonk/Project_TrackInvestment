"""Sovereign Gold Bond prices: NSE's own feed for the live price, sgb.vercel.app for the rest.

NSE publishes the day's traded price of every live SGB series as JSON (the data behind
https://www.nseindia.com/market-data/sovereign-gold-bond), and answers the app's own client identity. It carries no
issue dates, interest dates or history, and its "issue_price" is the discounted online price rather than the face
value interest is paid on. sgb.vercel.app, a server-rendered page whose __NEXT_DATA__ block lists every series with
face value, issue date, interest dates, a short daily history and the IBJA gold price RBI redeems at, fills those in
and stands in for the price when NSE is unreachable. Both are read at most every few hours and cached in the quotes
table under "SGB:<symbol>" (the IBJA price under "GOLD:IBJA"), so the app keeps working offline on the last values.
"""
import json
import re
import sqlite3
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

from . import quotes

PAGE_URL = "https://sgb.vercel.app"
NSE_URL = "https://www.nseindia.com/api/sovereign-gold-bonds"
PREFIX = "SGB:"
IBJA_SYMBOL = "GOLD:IBJA"
FEED_NSE = "NSE"                       # quote_meta.exchange when the latest price came from NSE's feed
FEED_PAGE = "NSE via sgb.vercel.app"   # ... or from the page
STALE_AFTER = timedelta(hours=6)
RETRY_FAILED_AFTER = timedelta(minutes=10)
HTTP_TIMEOUT = 25
IST = timezone(timedelta(hours=5, minutes=30))

_page: dict | None = None   # {"fetched", "ibja", "updated", "issues": {symbol: issue}}
_nse: dict | None = None    # {"fetched", "date", "rows": {symbol: {"ltp", "prev_close", "issue_price"}}}
_page_failure: tuple[datetime, str] | None = None
_nse_failure: tuple[datetime, str] | None = None


class SgbSourceError(Exception):
    """A source could not be reached, has changed shape, or does not list the series."""


def normalize_code(code: str | None) -> str:
    return (code or "").strip().upper()


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


# ---------------------------------------------------------------- sgb.vercel.app (details, history, IBJA, fallback price)

def _get_html(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": quotes.USER_AGENT, "Accept": "text/html"})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise SgbSourceError(f"sgb.vercel.app returned HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise SgbSourceError(f"Could not reach sgb.vercel.app: {e}") from e


def _ymd(d) -> str | None:
    try:
        return date(int(d["year"]), int(d["month"]), int(d["day"])).isoformat()
    except (TypeError, KeyError, ValueError):
        return None


def parse_page(html: str) -> dict:
    """{"ibja", "updated", "issues": {symbol: {...}}} from the page's embedded JSON."""
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not m:
        raise SgbSourceError("sgb.vercel.app has changed: no data block found")
    try:
        data = json.loads(m.group(1))["props"]["initialProps"]["pageProps"]["data"]
    except (ValueError, KeyError, TypeError) as e:
        raise SgbSourceError("sgb.vercel.app has changed: data block not understood") from e
    updated_ms = data.get("lastUpdated")
    updated = (datetime.fromtimestamp(updated_ms / 1000, tz=IST).date().isoformat()
               if isinstance(updated_ms, (int, float)) and updated_ms > 0 else date.today().isoformat())
    issues: dict[str, dict] = {}
    for raw in data.get("issues") or []:
        if not isinstance(raw, dict):
            continue
        sym = normalize_code(raw.get("symbol"))
        if not sym:
            continue
        rows: dict[str, float] = {}
        for p in ((raw.get("marketData") or {}).get("last30Days") or []):
            try:
                d = date.fromisoformat(str(p.get("date"))).isoformat()
            except (TypeError, ValueError):
                continue
            c = _num(p.get("close"))
            if c:
                rows[d] = c
        ltp = _num(raw.get("ltp"))
        if ltp and (not rows or updated >= max(rows)):
            rows[updated] = ltp  # the traded price is newer than the stored history
        issues[sym] = {
            "symbol": sym,
            "name": str(raw.get("companyName") or sym).strip(),
            "isin": raw.get("isin") or None,
            "ltp": ltp,
            "prev_close": _num(raw.get("prevClose")),
            "face_value": _num(raw.get("faceValue")),
            "interest_rate": _num(raw.get("interestRate")) or 2.5,
            "issue_date": _ymd(raw.get("date") or {}),
            "maturity_years": int(raw.get("maturityYears") or 8),
            "next_interest": _ymd(raw.get("nextInterestPaymentDate") or {}),
            "last_interest": _ymd(raw.get("lastInterestPaymentDate") or {}),
            "matured": bool(raw.get("isMatured")),
            "bse_code": raw.get("bseCode"),
            "press_release": (raw.get("documents") or {}).get("redemptionPressRelease") or None,
            "price_date": max(rows) if rows else None,
            "history": sorted(rows.items()),
        }
    if not issues:
        raise SgbSourceError("sgb.vercel.app listed no bonds")
    return {"ibja": _num(data.get("ibjaPrice")), "updated": updated, "issues": issues}


def _load_page(force: bool = False) -> dict:
    global _page, _page_failure
    now = datetime.now()
    if _page and not force and now - _page["fetched"] < STALE_AFTER:
        return _page
    if _page_failure and not force and now - _page_failure[0] < RETRY_FAILED_AFTER:
        if _page:
            return _page
        raise SgbSourceError(_page_failure[1])
    try:
        parsed = parse_page(_get_html(PAGE_URL))
    except SgbSourceError as e:
        _page_failure = (now, str(e))
        if _page:
            return _page  # stale but usable
        raise
    _page_failure = None
    _page = {"fetched": now, **parsed}
    return _page


# ---------------------------------------------------------------- NSE (today's traded price)

def _get_nse_json():
    try:
        return quotes._get_json(NSE_URL)
    except quotes.QuoteSourceError as e:
        raise SgbSourceError(f"NSE: {e}") from e


def parse_nse(data) -> dict:
    """{"date", "rows": {symbol: {"ltp", "prev_close", "issue_price"}}} from NSE's sovereign-gold-bonds JSON."""
    if not isinstance(data, dict) or not isinstance(data.get("data"), list):
        raise SgbSourceError("NSE's SGB feed has changed: no data list")
    try:
        day = datetime.strptime(str(data.get("timestamp") or "")[:20], "%d-%b-%Y %H:%M:%S").date().isoformat()
    except ValueError:
        day = datetime.now(IST).date().isoformat()
    rows: dict[str, dict] = {}
    for raw in data["data"]:
        if not isinstance(raw, dict):
            continue
        sym = normalize_code(raw.get("symbol"))
        ltp = _num(raw.get("ltP"))
        if sym and ltp:
            rows[sym] = {"ltp": ltp, "prev_close": _num(raw.get("prevClose")), "issue_price": _num(raw.get("issue_price"))}
    if not rows:
        raise SgbSourceError("NSE's SGB feed listed no bonds")
    return {"date": day, "rows": rows}


def _load_nse(force: bool = False) -> dict:
    global _nse, _nse_failure
    now = datetime.now()
    if _nse and not force and now - _nse["fetched"] < STALE_AFTER:
        return _nse
    if _nse_failure and not force and now - _nse_failure[0] < RETRY_FAILED_AFTER:
        if _nse:
            return _nse
        raise SgbSourceError(_nse_failure[1])
    try:
        parsed = parse_nse(_get_nse_json())
    except SgbSourceError as e:
        _nse_failure = (now, str(e))
        if _nse:
            return _nse
        raise
    _nse_failure = None
    _nse = {"fetched": now, **parsed}
    return _nse


def _sources(force: bool) -> tuple[dict | None, dict | None, list[str]]:
    """(page, nse, errors): each source or None when it is unavailable right now."""
    errors = []
    page = nse = None
    try:
        page = _load_page(force)
    except SgbSourceError as e:
        errors.append(str(e))
    try:
        nse = _load_nse(force)
    except SgbSourceError as e:
        errors.append(str(e))
    return page, nse, errors


def _minimal(symbol: str, nse_row: dict | None) -> dict:
    """What we know about a series when only NSE answers: the symbol and today's price."""
    return {"symbol": symbol, "name": symbol, "isin": None, "ltp": nse_row["ltp"] if nse_row else None,
            "prev_close": nse_row["prev_close"] if nse_row else None, "face_value": None, "interest_rate": 2.5,
            "issue_date": None, "maturity_years": 8, "next_interest": None, "last_interest": None, "matured": False,
            "bse_code": None, "press_release": None, "price_date": None, "history": []}


def list_issues(force: bool = False) -> list[dict]:
    """Every series known, without the price history: live ones first, newest first. NSE's price overrides
    the page's when it has one."""
    page, nse, errors = _sources(force)
    if page is None and nse is None:
        raise SgbSourceError("; ".join(errors))
    issues = {sym: dict(i) for sym, i in (page["issues"] if page else {}).items()}
    if nse:
        for sym, row in nse["rows"].items():
            i = issues.setdefault(sym, _minimal(sym, row))
            i["ltp"], i["prev_close"], i["price_date"] = row["ltp"], row["prev_close"], nse["date"]
    out = sorted(issues.values(), key=lambda i: i["issue_date"] or "", reverse=True)
    out.sort(key=lambda i: i["matured"])
    return [{k: v for k, v in i.items() if k != "history"} for i in out]


def issue_info(code: str, force: bool = False) -> dict | None:
    """The series' details (face value, issue date, ...), or just its price when only NSE answers; None when
    neither source lists the code; an error when neither source can be reached."""
    sym = normalize_code(code)
    page, nse, errors = _sources(force)
    if page is None and nse is None:
        raise SgbSourceError("; ".join(errors))
    info = page["issues"].get(sym) if page else None
    row = nse["rows"].get(sym) if nse else None
    if info is None and row is None:
        return None
    info = dict(info) if info else _minimal(sym, row)
    if row:
        info["ltp"], info["prev_close"], info["price_date"] = row["ltp"], row["prev_close"], nse["date"]
    return info


# ---------------------------------------------------------------- cache in the quotes table

def _is_stale(conn: sqlite3.Connection, code: str, force: bool) -> bool:
    if force:
        return True
    row = conn.execute("SELECT last_fetched FROM quote_meta WHERE symbol = ?", (PREFIX + code,)).fetchone()
    if not row or not row["last_fetched"]:
        return True
    return datetime.now() - datetime.fromisoformat(row["last_fetched"]) >= STALE_AFTER


_META_UPSERT = """
    INSERT INTO quote_meta(symbol, name, exchange, currency, quote_type, last_fetched) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET name = excluded.name, exchange = excluded.exchange, currency = excluded.currency,
        quote_type = excluded.quote_type, last_fetched = excluded.last_fetched
"""


def refresh_many(conn: sqlite3.Connection, codes, force: bool = False) -> dict[str, str]:
    """Refresh the stale series among `codes`: the page's history and price, overlaid with NSE's price for the
    day. Returns {"SGB:<code>": error} for codes neither source knows, or for all of them when both are down."""
    todo = [c for c in dict.fromkeys(normalize_code(c) for c in codes if c) if _is_stale(conn, c, force)]
    if not todo:
        return {}
    page, nse, errors = _sources(force)
    if page is None and nse is None:
        return {PREFIX + c: "; ".join(errors) for c in todo}
    result: dict[str, str] = {}
    now = datetime.now().isoformat(timespec="seconds")
    with conn:
        for code in todo:
            issue = page["issues"].get(code) if page else None
            row = nse["rows"].get(code) if nse else None
            if issue is None and row is None:
                result[PREFIX + code] = f"{code} is not in the Sovereign Gold Bond lists at NSE or sgb.vercel.app"
                continue
            rows = dict(issue["history"]) if issue else {}
            if row:
                rows[nse["date"]] = row["ltp"]
            sym = PREFIX + code
            conn.executemany("INSERT OR REPLACE INTO quotes(symbol, date, close) VALUES (?, ?, ?)", [(sym, d, c) for d, c in rows.items()])
            conn.execute(_META_UPSERT, (sym, issue["name"] if issue else code, FEED_NSE if row else FEED_PAGE, "INR", "SGB", now))
        if page and page.get("ibja"):
            conn.execute("INSERT OR REPLACE INTO quotes(symbol, date, close) VALUES (?, ?, ?)", (IBJA_SYMBOL, page["updated"], page["ibja"]))
            conn.execute(_META_UPSERT, (IBJA_SYMBOL, "IBJA gold price, per gram", None, "INR", "GOLD", now))
    return result


def refresh_code(conn: sqlite3.Connection, code: str, force: bool = False) -> None:
    errors = refresh_many(conn, [code], force)
    if errors:
        raise SgbSourceError(next(iter(errors.values())))


# ---------------------------------------------------------------- cache reads

def get_history(conn: sqlite3.Connection, code: str) -> list[tuple[str, float]]:
    return quotes.get_history(conn, PREFIX + normalize_code(code))


def latest(conn: sqlite3.Connection, code: str) -> tuple[str, float] | None:
    return quotes.latest(conn, PREFIX + normalize_code(code))


def on_or_before(conn: sqlite3.Connection, code: str, iso_date: str) -> tuple[str, float] | None:
    return quotes.on_or_before(conn, PREFIX + normalize_code(code), iso_date)


def meta(conn: sqlite3.Connection, code: str) -> dict | None:
    return quotes.meta(conn, PREFIX + normalize_code(code))


def ibja(conn: sqlite3.Connection) -> tuple[str, float] | None:
    return quotes.latest(conn, IBJA_SYMBOL)
