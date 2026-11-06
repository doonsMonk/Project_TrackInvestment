"""Stock prices and exchange rates: Yahoo Finance's public chart / search endpoints.

Any listed stock or ETF on any exchange is addressed by its Yahoo symbol (RELIANCE.NS, BHP.AX,
AAPL, VOD.L ...). Exchange rates are the same kind of series under symbols like 'AUDINR=X'.
Daily closes are cached in the encrypted database (table `quotes`) exactly like NAVs, so the app
keeps working offline with the last-fetched values; a symbol is re-fetched when its cache is older
than STALE_AFTER or when a refresh is forced from the UI.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone


def _base_currency() -> str:
    cur = (os.environ.get("INVESTMENT_TRACKER_BASE_CURRENCY") or "INR").strip().upper()
    return cur if len(cur) == 3 and cur.isalpha() else "INR"


BASE_CURRENCY = _base_currency()  # portfolio totals are expressed in this currency

SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search?q={q}&quotesCount=15&newsCount=0&listsCount=0"
# period1/period2 rather than range=max: range=max quietly downgrades to monthly bars.
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1=0&period2={period2}&interval=1d&events=&includePrePost=false"
STALE_AFTER = timedelta(hours=6)
RETRY_FAILED_AFTER = timedelta(minutes=10)
HTTP_TIMEOUT = 20
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InvestmentTracker/0.3"

# Some markets are quoted in minor units (pence, cents); convert to the major unit so that prices,
# amounts and the currency code all agree.
MINOR_UNITS = {"GBp": ("GBP", 100.0), "GBX": ("GBP", 100.0), "ZAc": ("ZAR", 100.0), "ILA": ("ILS", 100.0)}

# symbol -> (last failed attempt, error), so an outage doesn't slow every page load; the error is
# reported again (without a new request) until the retry window has passed
_last_failure: dict[str, tuple[datetime, str]] = {}


class QuoteSourceError(Exception):
    """Raised when the price service can't be reached, doesn't know the symbol, or returns junk."""


def normalize_symbol(symbol: str) -> str:
    return (symbol or "").strip().upper()


def fx_symbol(currency: str | None, base: str = BASE_CURRENCY) -> str | None:
    """Quote symbol for converting `currency` into `base`, or None when no conversion is needed."""
    cur = (currency or base).strip().upper()
    return None if cur == base else f"{cur}{base}=X"


def _get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise QuoteSourceError("Symbol not found") from e
        if e.code == 429:
            raise QuoteSourceError("Price source is rate-limiting requests; try again in a few minutes") from e
        raise QuoteSourceError(f"Price source returned HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise QuoteSourceError(f"Could not reach price source: {e}") from e
    except json.JSONDecodeError as e:
        raise QuoteSourceError("Price source returned invalid JSON") from e


# ---------------------------------------------------------------- remote calls

def search(query: str) -> list[dict]:
    """Symbols matching a name or ticker, stocks and ETFs first."""
    data = _get_json(SEARCH_URL.format(q=urllib.parse.quote(query.strip())))
    out = []
    for q in (data.get("quotes") or []) if isinstance(data, dict) else []:
        sym = q.get("symbol")
        if not sym:
            continue
        out.append(
            {
                "symbol": str(sym),
                "name": str(q.get("longname") or q.get("shortname") or sym),
                "exchange": str(q.get("exchDisp") or q.get("exchange") or ""),
                "exchange_code": str(q.get("exchange") or ""),
                "type": str(q.get("quoteType") or ""),
            }
        )
    rank = {"EQUITY": 0, "ETF": 1}
    out.sort(key=lambda x: rank.get(x["type"], 2))
    return out


def fetch_history(symbol: str) -> tuple[dict, list[tuple[str, float]]]:
    """(meta, ascending [(iso_date, close)]) for a symbol. Dates are the exchange's local trading day."""
    payload = _get_json(CHART_URL.format(symbol=urllib.parse.quote(symbol), period2=int(time.time()) + 86400))
    chart = payload.get("chart") if isinstance(payload, dict) else None
    if not isinstance(chart, dict):
        raise QuoteSourceError(f"Unexpected response for {symbol}")
    if chart.get("error"):
        raise QuoteSourceError(str((chart["error"] or {}).get("description") or f"Unknown symbol {symbol}"))
    result = (chart.get("result") or [None])[0]
    if not isinstance(result, dict):
        raise QuoteSourceError(f"No price data for {symbol}")
    meta = result.get("meta") or {}
    granularity = str(meta.get("dataGranularity") or "1d")
    if granularity != "1d":
        raise QuoteSourceError(f"Price source returned {granularity} bars for {symbol} instead of daily data")
    raw_currency = str(meta.get("currency") or "")
    if raw_currency in MINOR_UNITS:  # case-sensitive: 'GBp' is pence, 'GBP' is pounds
        currency, scale = MINOR_UNITS[raw_currency]
    else:
        currency, scale = raw_currency.upper(), 1.0
    offset = int(meta.get("gmtoffset") or 0)
    timestamps = result.get("timestamp") or []
    closes = (((result.get("indicators") or {}).get("quote") or [{}])[0] or {}).get("close") or []
    rows: dict[str, float] = {}
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        try:
            day = datetime.fromtimestamp(int(ts) + offset, tz=timezone.utc).date().isoformat()
            rows[day] = float(close) / scale  # a later intraday point for the same day replaces the earlier one
        except (ValueError, OverflowError, TypeError):
            continue
    if not rows:
        raise QuoteSourceError(f"No price data for {symbol}")
    info = {
        "name": str(meta.get("longName") or meta.get("shortName") or symbol),
        "exchange": str(meta.get("fullExchangeName") or meta.get("exchangeName") or ""),
        "currency": currency or None,
        "quote_type": str(meta.get("instrumentType") or ""),
    }
    return info, sorted(rows.items())


# ---------------------------------------------------------------- cache logic

def _recent_failure(symbol: str, force: bool) -> str | None:
    failed = _last_failure.get(symbol)
    if failed and not force and datetime.now() - failed[0] < RETRY_FAILED_AFTER:
        return failed[1]
    return None


def _is_stale(conn: sqlite3.Connection, symbol: str, force: bool) -> bool:
    if force:
        return True
    row = conn.execute("SELECT last_fetched FROM quote_meta WHERE symbol = ?", (symbol,)).fetchone()
    if not row or not row["last_fetched"]:
        return True
    return datetime.now() - datetime.fromisoformat(row["last_fetched"]) >= STALE_AFTER


def _safe_fetch(symbol: str):
    try:
        return fetch_history(symbol)
    except Exception as e:  # noqa: BLE001 - reported per symbol to the caller
        return e


def _store(conn: sqlite3.Connection, symbol: str, info: dict, rows: list[tuple[str, float]]) -> None:
    with conn:
        conn.executemany(
            "INSERT OR REPLACE INTO quotes(symbol, date, close) VALUES (?, ?, ?)", [(symbol, d, c) for d, c in rows]
        )
        conn.execute(
            """
            INSERT INTO quote_meta(symbol, name, exchange, currency, quote_type, last_fetched)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol) DO UPDATE SET
                name = excluded.name, exchange = excluded.exchange, currency = excluded.currency,
                quote_type = excluded.quote_type, last_fetched = excluded.last_fetched
            """,
            (symbol, info.get("name"), info.get("exchange"), info.get("currency"), info.get("quote_type"),
             datetime.now().isoformat(timespec="seconds")),
        )


def refresh_many(conn: sqlite3.Connection, symbols, force: bool = False) -> dict[str, str]:
    """Fetch stale symbols in parallel, store serially. Returns {symbol: error} for failures."""
    errors: dict[str, str] = {}
    todo = []
    for s in dict.fromkeys(normalize_symbol(s) for s in symbols if s):
        recent = _recent_failure(s, force)
        if recent:
            errors[s] = recent  # still failing as far as we know; don't hammer the source
        elif _is_stale(conn, s, force):
            todo.append(s)
    if not todo:
        return errors
    with ThreadPoolExecutor(max_workers=min(6, len(todo))) as ex:
        results = list(ex.map(_safe_fetch, todo))
    for symbol, res in zip(todo, results):
        if isinstance(res, Exception):
            _last_failure[symbol] = (datetime.now(), str(res))
            errors[symbol] = str(res)
        else:
            _last_failure.pop(symbol, None)
            _store(conn, symbol, *res)
    return errors


def refresh_symbol(conn: sqlite3.Connection, symbol: str, force: bool = False) -> None:
    symbol = normalize_symbol(symbol)
    errors = refresh_many(conn, [symbol], force)
    if symbol in errors:
        raise QuoteSourceError(errors[symbol])


# ---------------------------------------------------------------- cache reads

def get_history(conn: sqlite3.Connection, symbol: str) -> list[tuple[str, float]]:
    """Ascending (iso_date, close)."""
    return [
        (r["date"], r["close"])
        for r in conn.execute("SELECT date, close FROM quotes WHERE symbol = ? ORDER BY date", (symbol,))
    ]


def latest(conn: sqlite3.Connection, symbol: str) -> tuple[str, float] | None:
    r = conn.execute("SELECT date, close FROM quotes WHERE symbol = ? ORDER BY date DESC LIMIT 1", (symbol,)).fetchone()
    return (r["date"], r["close"]) if r else None


def on_or_before(conn: sqlite3.Connection, symbol: str, iso_date: str) -> tuple[str, float] | None:
    r = conn.execute(
        "SELECT date, close FROM quotes WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1", (symbol, iso_date)
    ).fetchone()
    return (r["date"], r["close"]) if r else None


def meta(conn: sqlite3.Connection, symbol: str) -> dict | None:
    r = conn.execute("SELECT * FROM quote_meta WHERE symbol = ?", (symbol,)).fetchone()
    return dict(r) if r else None
