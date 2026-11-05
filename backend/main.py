"""FastAPI application: JSON API under /api plus the static frontend at /."""
from __future__ import annotations

import datetime as dt
import json
import sqlite3
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator

from . import calc, db, nav, nps, quotes

# In the PyInstaller build the frontend is unpacked under sys._MEIPASS; in a dev checkout it's <project>/frontend.
_BUNDLE_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
FRONTEND_DIR = _BUNDLE_ROOT / "frontend"

MF, STOCK, NPS, EPF = "MF", "STOCK", "NPS", "EPF"
EPF_SHARES = {"EE": "Employee share", "ER": "Employer share", "EPS": "Pension scheme (EPS)"}
BASE = quotes.BASE_CURRENCY
MF_CURRENCY = "INR"  # AMFI and NPS NAVs are always in rupees, whatever the portfolio currency is


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.vault.prepare()
    yield
    db.vault.lock()  # flush and forget the key on shutdown


VERSION = "0.6.2"
app = FastAPI(title="Investment Tracker", version=VERSION, lifespan=lifespan)


@app.middleware("http")
async def no_stale_caching(request, call_next):
    """The app window keeps a private browser profile. Without these headers the browser may keep serving an
    older app.js for hours after an upgrade (heuristic caching), so: API responses are never cached and
    static files are always revalidated (ETag / Last-Modified keep that cheap)."""
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    else:
        response.headers["Cache-Control"] = "no-cache"
    return response


def get_conn():
    """Per-request access to the encrypted database. 409 = no password set yet, 423 = locked."""
    try:
        conn = db.vault.acquire()
    except db.VaultNotSetUp as e:
        raise HTTPException(status_code=409, detail="No password set yet. Create one to start.") from e
    except db.VaultLocked as e:
        raise HTTPException(status_code=423, detail="Locked. Enter your password to continue.") from e
    try:
        yield conn
    finally:
        db.vault.release()


# ----------------------------------------------------------------- password / vault

class PasswordIn(BaseModel):
    password: str = Field(min_length=1, max_length=256)


class ChangePasswordIn(BaseModel):
    current: str = Field(min_length=1, max_length=256)
    new: str = Field(min_length=1, max_length=256)


@app.get("/api/auth/status")
def auth_status():
    v = db.vault
    return {
        "state": v.state(),  # setup | locked | unlocked
        "has_legacy": v.has_legacy(),
        "legacy_funds": v.legacy_fund_count(),
        "min_password_length": db.MIN_PASSWORD_LEN,
        "idle_lock_minutes": db.IDLE_LOCK_SECONDS // 60,
        "base_currency": BASE,
        "version": VERSION,
    }


@app.post("/api/quit")
def quit_app():
    """Ask this instance to shut down (used by a newer launcher to replace an older running instance).
    Local-only by construction: the server binds 127.0.0.1. The vault is locked before the process ends."""
    request_quit = getattr(app.state, "request_quit", None)
    if request_quit is None:
        raise HTTPException(status_code=501, detail="This instance cannot be stopped remotely.")
    db.vault.lock()
    request_quit()
    return {"ok": True, "version": VERSION}


@app.post("/api/auth/setup")
def auth_setup(body: PasswordIn):
    try:
        migrated = db.vault.setup(body.password)
    except db.VaultExists as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except db.VaultError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"state": "unlocked", "migrated": migrated}


@app.post("/api/auth/unlock")
def auth_unlock(body: PasswordIn):
    try:
        db.vault.unlock(body.password)
    except db.VaultNotSetUp as e:
        raise HTTPException(status_code=409, detail="No password set yet.") from e
    except db.WrongPassword as e:
        time.sleep(0.8)  # slow down guessing
        raise HTTPException(status_code=401, detail="Wrong password.") from e
    except db.VaultError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"state": "unlocked"}


@app.post("/api/auth/lock")
def auth_lock():
    db.vault.lock()
    return {"state": db.vault.state()}


@app.post("/api/auth/change-password")
def auth_change_password(body: ChangePasswordIn):
    try:
        db.vault.change_password(body.current, body.new)
    except db.VaultLocked as e:
        raise HTTPException(status_code=423, detail="Locked. Enter your password to continue.") from e
    except db.WrongPassword as e:
        time.sleep(0.8)
        raise HTTPException(status_code=401, detail="Current password is wrong.") from e
    except db.VaultError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"ok": True}


# ----------------------------------------------------------------- schemas

def _iso_date_or_none(v: Optional[str]) -> Optional[str]:
    if v in (None, ""):
        return None
    try:
        return dt.date.fromisoformat(v).isoformat()
    except ValueError as e:
        raise ValueError("date must be in YYYY-MM-DD format") from e


class FundIn(BaseModel):
    """A holding: a mutual fund (AMFI scheme code), a stock / ETF (quote symbol, any exchange, any currency),
    or an NPS account (pension fund manager + tier, with one NPS Trust scheme id per asset class E / C / G / A)."""

    name: str = Field(min_length=1, max_length=200)
    kind: Literal["MF", "STOCK", "NPS", "EPF"] = MF
    scheme_code: Optional[int] = Field(default=None, gt=0)
    symbol: Optional[str] = Field(default=None, max_length=40)
    currency: Optional[str] = Field(default=None, min_length=3, max_length=3,
                                    description="Fallback only; the quote source's currency is used when known")
    details: Optional[dict] = Field(default=None, description="NPS: {pfm, tier, variant, schemes: {E: 'SM007001', ...}}")
    folio_number: str = ""
    locked: bool = False
    lock_in_until: Optional[str] = None
    notes: str = ""

    @field_validator("lock_in_until")
    @classmethod
    def _v_lock(cls, v):
        return _iso_date_or_none(v)

    @field_validator("name", "folio_number", "notes")
    @classmethod
    def _strip(cls, v: str):
        return v.strip()

    @model_validator(mode="after")
    def _check_source(self):
        if self.kind == MF and not self.scheme_code:
            raise ValueError("scheme_code is required for a mutual fund")
        if self.kind == STOCK:
            self.symbol = quotes.normalize_symbol(self.symbol or "")
            if not self.symbol:
                raise ValueError("symbol is required for a stock")
            self.scheme_code = None
        else:
            self.symbol = None
        if self.kind == NPS:
            d = self.details or {}
            schemes = d.get("schemes") if isinstance(d, dict) else None
            if not isinstance(schemes, dict) or not schemes:
                raise ValueError("pick at least one NPS scheme (E, C, G or A)")
            clean = {}
            for letter, sid in schemes.items():
                key, value = str(letter).strip().upper(), str(sid).strip().upper()
                if not key or len(key) > 2 or not nps.is_scheme_id(value):
                    raise ValueError(f"'{sid}' is not an NPS scheme id (expected SMnnnnnn) for scheme {letter}")
                clean[key] = value
            self.details = {
                "pfm_id": nps.pfm_id(next(iter(clean.values()))),
                "pfm": str(d.get("pfm") or ""),
                "tier": str(d.get("tier") or ""),
                "variant": str(d.get("variant") or ""),
                "schemes": clean,
            }
            self.scheme_code = None
        elif self.kind == EPF:
            d = self.details if isinstance(self.details, dict) else {}
            # transfer links are written by the job-change action and only carried through here
            links = {k: d[k] for k in ("transferred_to", "transferred_from", "transferred_on", "transferred_to_name", "transferred_from_name") if d.get(k) not in (None, "")}
            self.details = {"employer": str(d.get("employer") or "").strip()[:120], **links}
            self.scheme_code = None
        else:
            self.details = None
        if self.currency:
            self.currency = self.currency.strip().upper()
            if not self.currency.isalpha():
                raise ValueError("currency must be a 3-letter code such as INR, USD or AUD")
        return self


class FundUpdate(FundIn):
    apply_folio_to_transactions: bool = False  # also rewrite transactions that carry the fund's old default folio


TxnType = Literal["SIP", "LUMPSUM", "REDEMPTION", "DIVIDEND", "BONUS", "SWITCH_IN", "SWITCH_OUT", "CHARGE"]
CASH_ONLY = ("DIVIDEND",)  # money in, no units
UNITS_ONLY = ("BONUS",)  # units in, no money
UNIT_MOVES = ("CHARGE",)  # units out, amount = their value (derived when not given)


def _check_txn_shape(t) -> None:
    """Shared rules: a dividend needs an amount and carries no units; bonus units need units and carry no
    money; a charge needs units (its value follows from the NAV); purchases, sales and switches need an
    amount plus a price or units (bulk rows may leave both to history)."""
    if t.type in CASH_ONLY:
        if not t.amount or t.amount <= 0:
            raise ValueError("a dividend needs the amount received")
        t.units = 0.0
    elif t.type in UNITS_ONLY:
        if not t.units or t.units <= 0:
            raise ValueError("bonus units / shares need the number received")
        t.amount = 0.0
    elif t.type in UNIT_MOVES:
        if not t.units or t.units <= 0:
            raise ValueError("a charge needs the number of units deducted")
        if t.nav is not None and t.nav <= 0:
            t.nav = None
    else:
        if not t.amount or t.amount <= 0:
            raise ValueError("amount must be positive")
        if t.units is not None and t.units <= 0:
            raise ValueError("units must be positive")
        if t.nav is not None and t.nav <= 0:
            t.nav = None


def _clean_scheme(v: str) -> str:
    return (v or "").strip().upper()[:3]  # NPS letters (E / C / G / A), EPF shares (EE / ER / EPS)


class TxnIn(BaseModel):
    date: str
    folio_number: str = ""
    scheme: str = Field(default="", description="NPS: the scheme letter (E / C / G / A); blank for funds and stocks")
    type: TxnType
    amount: float = Field(default=0, ge=0)
    nav: Optional[float] = Field(default=None, ge=0, description="Price per unit; required for purchases / sales unless units are given")
    units: Optional[float] = Field(default=None, ge=0, description="Defaults to amount / nav for purchases and sales")
    rate: Optional[float] = Field(default=None, ge=0, le=100, description="EPF: interest rate % applicable (informational)")
    notes: str = ""

    @field_validator("date")
    @classmethod
    def _v_date(cls, v):
        out = _iso_date_or_none(v)
        if out is None:
            raise ValueError("date is required")
        return out

    @field_validator("scheme")
    @classmethod
    def _v_scheme(cls, v):
        return _clean_scheme(v)

    @model_validator(mode="after")
    def _shape(self):
        _check_txn_shape(self)
        if self.type in UNIT_MOVES and not self.amount and self.nav is None:
            raise ValueError("a charge needs the NAV on that day (or the amount deducted)")
        return self


def _require_price(body: TxnIn, kind: str) -> None:
    """A single purchase / sale needs a price or units, except for EPF where a rupee is a unit."""
    if kind != EPF and body.type not in CASH_ONLY + UNITS_ONLY + UNIT_MOVES and body.nav is None and body.units is None:
        raise HTTPException(status_code=422, detail="NAV / price (or units) is required")


# ----------------------------------------------------------------- helpers

def _fund_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["locked"] = bool(d["locked"])
    d["kind"] = d.get("kind") or MF
    d["currency"] = (d.get("currency") or BASE).upper()
    raw = d.get("details")
    try:
        d["details"] = json.loads(raw) if raw else None
    except (TypeError, ValueError):
        d["details"] = None
    return d


def _nps_schemes(fund_or_row) -> dict[str, str]:
    """{letter: NPS Trust scheme id} for an NPS holding (row or dict), else {}."""
    details = fund_or_row["details"] if isinstance(fund_or_row, dict) else (fund_or_row["details"] if "details" in fund_or_row.keys() else None)
    if isinstance(details, str):
        try:
            details = json.loads(details)
        except ValueError:
            details = None
    schemes = (details or {}).get("schemes") if isinstance(details, dict) else None
    return dict(schemes) if isinstance(schemes, dict) else {}


def _txns(conn: sqlite3.Connection, fund_id: int) -> list[dict]:
    return [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM transactions WHERE fund_id = ? ORDER BY date DESC, id DESC", (fund_id,)
        )
    ]


def _fund_row(conn: sqlite3.Connection, fund_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM funds WHERE id = ?", (fund_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Fund not found")
    return row


def _sources(rows) -> tuple[list[int], list[str], list[str]]:
    """(AMFI scheme codes, quote symbols incl. FX pairs, NPS scheme ids) needed to value these holdings."""
    codes = [r["scheme_code"] for r in rows if (r["kind"] or MF) == MF and r["scheme_code"]]
    symbols = [r["symbol"] for r in rows if r["kind"] == STOCK and r["symbol"]]
    pairs = [p for p in (quotes.fx_symbol(r["currency"]) for r in rows) if p]
    nps_ids = [sid for r in rows if r["kind"] == NPS for sid in _nps_schemes(r).values()]
    return codes, symbols + pairs, nps_ids


def _auto_refresh(conn: sqlite3.Connection, rows, force: bool = False) -> dict[str, str]:
    """Refresh stale NAV / price / FX / NPS caches; never fail the request because a source is down."""
    codes, symbols, nps_ids = _sources(rows)
    errors: dict[str, str] = {}
    try:
        errors.update({str(k): v for k, v in nav.refresh_many(conn, codes, force).items()})
    except Exception as e:  # noqa: BLE001
        errors["*"] = str(e)
    try:
        errors.update(quotes.refresh_many(conn, symbols, force))
    except Exception as e:  # noqa: BLE001
        errors["*quotes"] = str(e)
    try:
        errors.update(nps.refresh_many(conn, nps_ids, force))
    except Exception as e:  # noqa: BLE001
        errors["*nps"] = str(e)
    return errors


def _prepare_source(conn: sqlite3.Connection, body: FundIn) -> tuple[Optional[str], str, Optional[str]]:
    """Fetch the price history behind a new / changed holding. Returns (error, currency, exchange)."""
    if body.kind == STOCK:
        error = None
        try:
            quotes.refresh_symbol(conn, body.symbol)
        except quotes.QuoteSourceError as e:
            error = str(e)
        m = quotes.meta(conn, body.symbol)
        currency = (m or {}).get("currency") or body.currency
        if not currency:
            raise HTTPException(
                status_code=422,
                detail=f"Could not look up {body.symbol}: {error}. Check the symbol (for example RELIANCE.NS, ALL.AX, AAPL).",
            )
        pair = quotes.fx_symbol(currency)
        if pair:
            quotes.refresh_many(conn, [pair])  # best effort; the page shows a warning if the rate is missing
        return error, currency, (m or {}).get("exchange")
    if body.kind == NPS:
        schemes = body.details["schemes"]
        errors = nps.refresh_many(conn, list(schemes.values()))
        missing = [sid for sid in schemes.values() if nps.latest(conn, sid) is None]
        if missing:
            why = next(iter(errors.values()), "no NAV history came back")
            raise HTTPException(status_code=422, detail=f"Could not fetch NAVs for {', '.join(missing)}: {why}")
        names = {}
        for letter, sid in schemes.items():
            info = nps.scheme_info(sid) or {}
            names[letter] = (nps.meta(conn, sid) or {}).get("name") or info.get("name") or sid
            if not body.details.get("pfm") and info.get("pfm"):
                body.details["pfm"] = info["pfm"]
            if not body.details.get("tier") and info.get("tier"):
                body.details["tier"] = info["tier"]
        body.details["names"] = names
        return ("; ".join(errors.values()) or None), MF_CURRENCY, None
    if body.kind == EPF:
        return None, MF_CURRENCY, None  # no price source: an EPF balance is deposits plus the interest you enter
    try:
        nav.refresh_scheme(conn, body.scheme_code)
        return None, MF_CURRENCY, None
    except nav.NavSourceError as e:
        return str(e), MF_CURRENCY, None


def _price_source(conn: sqlite3.Connection, fund: dict, with_history: bool):
    """(history, latest) for a fund or stock from its own price table."""
    if fund["kind"] == STOCK:
        sym = fund["symbol"]
        return (quotes.get_history(conn, sym) if with_history else []), quotes.latest(conn, sym)
    code = fund["scheme_code"]
    return (nav.get_history(conn, code) if with_history else []), nav.latest_nav(conn, code)


def _price_on_or_before(conn: sqlite3.Connection, row: sqlite3.Row, iso_date: str, scheme: str = ""):
    if row["kind"] == STOCK:
        return quotes.on_or_before(conn, row["symbol"], iso_date)
    if row["kind"] == NPS:
        sid = _nps_schemes(row).get(scheme)
        return nps.on_or_before(conn, sid, iso_date) if sid else None
    if row["kind"] == EPF:
        return (iso_date, 1.0)  # rupees in, rupees out: one unit is one rupee
    return nav.nav_on_or_before(conn, row["scheme_code"], iso_date)


def _fx(conn: sqlite3.Connection, currency: str) -> Optional[calc.RateSeries]:
    """Rates for converting `currency` to the base currency; None when none is needed or none is cached."""
    pair = quotes.fx_symbol(currency)
    if not pair:
        return None
    series = calc.RateSeries(quotes.get_history(conn, pair))
    return series if series else None


NO_FOLIO = "(none)"  # filter key for transactions whose folio is blank


def _nps_parts(conn: sqlite3.Connection, fund: dict, txns: list[dict], today: dt.date) -> list[dict]:
    """One summary per NPS scheme (E / C / G / A ...), each valued with its own NAV. Within a scheme, switches
    count as money entering / leaving it, so each scheme's XIRR is its own return."""
    schemes = _nps_schemes(fund)
    names = (fund["details"] or {}).get("names") or {}
    letters = [l for l in nps.LETTERS if l in schemes] + sorted(l for l in schemes if l not in nps.LETTERS)
    stray = sorted({t["scheme"] for t in txns if t["scheme"] not in schemes})
    parts = []
    for letter in letters + stray:
        sid = schemes.get(letter)
        latest = nps.latest(conn, sid) if sid else None
        meta = (nps.meta(conn, sid) or {}) if sid else {}
        parts.append(
            {
                "scheme": letter,
                "id": sid,
                "name": names.get(letter) or meta.get("name") or (f"Scheme {letter}" if sid else f"Scheme {letter or '?'} (not set up on this account)"),
                "summary": calc.summarize([t for t in txns if t["scheme"] == letter], latest, today, internal_flows=True),
            }
        )
    return parts


def fy_of(iso_date: str) -> str:
    """Indian financial year of a date: '2011-02-15' -> '2010-11'."""
    y, m = int(iso_date[:4]), int(iso_date[5:7])
    start = y if m >= 4 else y - 1
    return f"{start}-{(start + 1) % 100:02d}"


def _epf_parts(source: list[dict], today: dt.date) -> tuple[list[dict], dict]:
    """EPF: the employee and employer shares are two 'schemes' valued at one rupee per unit (deposits are
    units at cost 1, credited interest is zero-cost units), so the engine's summaries give balance, deposits,
    interest and XIRR without any interest arithmetic. The pension scheme (EPS) is tracked only as money paid."""
    one = (today.isoformat(), 1.0)
    parts = [{"scheme": k, "id": None, "name": EPF_SHARES[k], "summary": calc.summarize([t for t in source if t["scheme"] == k], one, today)} for k in ("EE", "ER")]
    corpus = [t for t in source if t["scheme"] in ("EE", "ER")]
    combined = calc.aggregate([p["summary"] for p in parts], calc.cashflows(corpus), today)
    eps = [t for t in source if t["scheme"] == "EPS"]
    pension_paid = sum(t["amount"] for t in eps if t["type"] in calc.PURCHASES) - sum(t["amount"] for t in eps if t["type"] == calc.REDEMPTION)
    own_flows = calc.cashflows([t for t in source if t["scheme"] == "EE"])
    own_flows += [(dt.date.fromisoformat(t["date"]), t["amount"]) for t in source if t["scheme"] == "ER" and t["type"] == calc.REDEMPTION]
    if combined["current_value"] > 0:
        own_flows.append((today, combined["current_value"]))
    combined.update(
        {
            "interest": round(parts[0]["summary"]["bonus_units"] + parts[1]["summary"]["bonus_units"], 2),
            "pension_paid": round(pension_paid, 2),
            "own_xirr": calc.xirr(own_flows) if any(a < 0 for _, a in own_flows) else None,  # employer share counted as gain
            "balance_employee": parts[0]["summary"]["current_value"],
            "balance_employer": parts[1]["summary"]["current_value"],
            "deposits_employee": parts[0]["summary"]["invested"],
            "deposits_employer": parts[1]["summary"]["invested"],
            "txn_count": len(source),  # including the pension-scheme rows
        }
    )
    return parts, combined


def _epf_years(all_txns: list[dict], today: dt.date) -> tuple[list[dict], Optional[str]]:
    """One row per financial year (deposits, pension, interest, rate, closing balances) plus the year whose
    interest has not been entered yet, if any."""
    years: dict[str, dict] = {}
    for t in all_txns:
        y = years.setdefault(t["date"] and fy_of(t["date"]), {"fy": fy_of(t["date"]), "deposit_ee": 0.0, "deposit_er": 0.0, "pension": 0.0,
                                                                "interest_ee": 0.0, "interest_er": 0.0, "withdrawn_ee": 0.0, "withdrawn_er": 0.0, "rate": None})
        sch, kind = t["scheme"], t["type"]
        if kind in calc.PURCHASES:
            if sch == "EE":
                y["deposit_ee"] += t["amount"]
            elif sch == "ER":
                y["deposit_er"] += t["amount"]
            elif sch == "EPS":
                y["pension"] += t["amount"]
        elif kind == calc.BONUS and sch in ("EE", "ER"):
            y["interest_ee" if sch == "EE" else "interest_er"] += t["units"]
        elif kind == calc.REDEMPTION and sch in ("EE", "ER"):
            y["withdrawn_ee" if sch == "EE" else "withdrawn_er"] += t["amount"]
        if t.get("rate") is not None:
            y["rate"] = t["rate"]
    rows = sorted(years.values(), key=lambda y: y["fy"])
    close_ee = close_er = 0.0
    for y in rows:
        close_ee += y["deposit_ee"] + y["interest_ee"] - y["withdrawn_ee"]
        close_er += y["deposit_er"] + y["interest_er"] - y["withdrawn_er"]
        y["closing_ee"], y["closing_er"] = round(close_ee, 2), round(close_er, 2)
        for k in ("deposit_ee", "deposit_er", "pension", "interest_ee", "interest_er", "withdrawn_ee", "withdrawn_er"):
            y[k] = round(y[k], 2)
    with_deposits = [y["fy"] for y in rows if y["deposit_ee"] or y["deposit_er"]]
    with_interest = [y["fy"] for y in rows if y["interest_ee"] or y["interest_er"]]
    pending = None
    if with_deposits:
        last_dep = max(with_deposits)
        if not with_interest or max(with_interest) < last_dep:
            pending = last_dep
    return rows, pending


def _epf_payload(fund: dict, all_txns: list[dict], txns: list[dict], today: dt.date, detail: bool,
                 folio: Optional[str], scheme: Optional[str]) -> dict:
    parts_all, full = _epf_parts(all_txns, today)
    parts, combined = (parts_all, full) if folio is None else _epf_parts(txns, today)
    view_txns = txns
    fund["summary"] = combined
    if scheme:
        want = _clean_scheme(scheme)
        part = next((p for p in parts if p["scheme"] == want), None)
        if part is None:
            raise HTTPException(status_code=404, detail="EPF shares are EE (employee) and ER (employer)")
        fund["summary"] = {**part["summary"], "interest": part["summary"]["bonus_units"], "pension_paid": combined["pension_paid"], "own_xirr": None}
        fund["scheme_filter"] = want
        view_txns = [t for t in txns if t["scheme"] == want]
    fund["schemes"] = parts
    fund["schemes_total"] = combined
    fund["closed"], fund["closed_on"] = full["closed"], full["closed_on"]
    moved_to = (fund["details"] or {}).get("transferred_to")
    if moved_to and not any(t["scheme"] in ("EE", "ER") for t in all_txns):
        # the balance went to the new employer's account; only the pension record stays here
        fund["closed"], fund["closed_on"] = True, (fund["details"] or {}).get("transferred_on")
    years, pending = _epf_years(all_txns, today)
    if moved_to:
        pending = None
    fund["epf"] = {"years": years, "pending_interest_fy": pending, "current_fy": fy_of(today.isoformat()), "shares": EPF_SHARES}
    if detail:
        fund["transactions"] = view_txns
        if folio is not None or scheme:
            fund["all_transactions"] = all_txns
        corpus = [t for t in txns if t["scheme"] in ("EE", "ER") and (not scheme or t["scheme"] == fund.get("scheme_filter"))]
        dates = sorted({t["date"] for t in corpus} | {today.isoformat()})
        fund["history"] = calc.value_history(corpus, [(d, 1.0) for d in dates])
        fund["folios"] = [
            {"folio": k or NO_FOLIO, "label": k or "No UAN", "summary": _epf_parts([t for t in all_txns if t["folio_number"] == k], today)[1]}
            for k in sorted({t["folio_number"] for t in all_txns}, key=lambda x: (x == "", x))
        ]
        fund["folios_total"] = full
    return fund


def _fund_payload(conn: sqlite3.Connection, row: sqlite3.Row, detail: bool = False, folio: Optional[str] = None,
                  scheme: Optional[str] = None) -> dict:
    """Holding with computed summary (in its own currency). With `folio`, summary / history / transactions are
    scoped to that folio; `folios` (per-folio summaries) and `folios_total` always cover the whole holding.
    For holdings in another currency, `base` carries the same summary converted to the base currency and,
    with detail, `history_base` the converted chart series. An NPS account additionally carries `schemes`
    (one summary per E / C / G scheme) and `schemes_total`; `scheme` scopes the view to one scheme."""
    fund = _fund_dict(row)
    all_txns = _txns(conn, fund["id"])
    today = dt.date.today()
    folio_keys = sorted({t["folio_number"] for t in all_txns}, key=lambda s: (s == "", s))
    fund["folio_count"] = len(folio_keys)
    fund["base_currency"] = BASE
    fund["needs_fx"] = fund["currency"] != BASE
    fund["scheme"] = None
    fund["quote"] = None
    fund["base"] = None

    txns = all_txns
    if folio is not None:
        want = "" if folio == NO_FOLIO else folio
        txns = [t for t in all_txns if t["folio_number"] == want]
        fund["folio_filter"] = folio

    if fund["kind"] == NPS:
        parts_all = _nps_parts(conn, fund, all_txns, today)
        full = calc.aggregate([p["summary"] for p in parts_all], calc.cashflows(all_txns), today)
        parts = parts_all if folio is None else _nps_parts(conn, fund, txns, today)
        combined = full if folio is None else calc.aggregate([p["summary"] for p in parts], calc.cashflows(txns), today)
        view_txns = txns
        fund["summary"] = combined
        if scheme:
            want = _clean_scheme(scheme)
            part = next((p for p in parts if p["scheme"] == want), None)
            if part is None:
                raise HTTPException(status_code=404, detail=f"No scheme {want} on this NPS account")
            fund["summary"] = part["summary"]
            fund["scheme_filter"] = want
            view_txns = [t for t in txns if t["scheme"] == want]
        fund["schemes"] = parts
        fund["schemes_total"] = combined
        fund["closed"], fund["closed_on"] = full["closed"], full["closed_on"]
        if detail:
            fund["transactions"] = view_txns
            if folio is not None or scheme:
                fund["all_transactions"] = all_txns
            histories = {
                p["scheme"]: calc.value_history([t for t in txns if t["scheme"] == p["scheme"]], nps.get_history(conn, p["id"]) if p["id"] else [])
                for p in parts
            }
            fund["history"] = histories.get(fund.get("scheme_filter"), []) if scheme else calc.combine_histories(list(histories.values()))
            fund["folios"] = [
                {
                    "folio": k or NO_FOLIO,
                    "label": k or "No PRAN",
                    "summary": calc.aggregate(
                        [p["summary"] for p in _nps_parts(conn, fund, [t for t in all_txns if t["folio_number"] == k], today)],
                        calc.cashflows([t for t in all_txns if t["folio_number"] == k]),
                        today,
                    ),
                }
                for k in folio_keys
            ]
            fund["folios_total"] = full
        return fund

    if fund["kind"] == EPF:
        return _epf_payload(fund, all_txns, txns, today, detail, folio, scheme)

    history, latest = _price_source(conn, fund, detail)
    fx = _fx(conn, fund["currency"])
    fund["summary"] = calc.summarize(txns, latest, today)
    full = fund["summary"] if folio is None else calc.summarize(all_txns, latest, today)
    fund["closed"] = full["closed"]  # sold out entirely (judged on every transaction, not the folio in view)
    fund["closed_on"] = full["closed_on"]
    fund["scheme"] = nav.scheme_meta(conn, fund["scheme_code"]) if fund["kind"] == MF else None
    fund["quote"] = quotes.meta(conn, fund["symbol"]) if fund["kind"] == STOCK else None
    if fx is not None:
        rate_date, rate = fx.latest
        txns_base = calc.convert_txns(txns, fx)
        fund["base"] = {
            "currency": BASE,
            "rate": rate,
            "rate_date": rate_date,
            "summary": calc.summarize(txns_base, calc.convert_latest(latest, fx), today),
        }
    if detail:
        fund["transactions"] = txns
        if folio is not None:
            fund["all_transactions"] = all_txns
        fund["history"] = calc.value_history(txns, history)
        if fx is not None:
            fund["history_base"] = calc.value_history(txns_base, calc.convert_history(history, fx))
            fund["_flows_base"] = calc.cashflows(txns_base)
        fund["folios"] = [
            {
                "folio": k or NO_FOLIO,
                "label": k or ("No account" if fund["kind"] == STOCK else "No folio"),
                "summary": calc.summarize([t for t in all_txns if t["folio_number"] == k], latest, today),
            }
            for k in folio_keys
        ]
        fund["folios_total"] = full
    return fund


# ----------------------------------------------------------------- scheme lookup (mfapi.in)

@app.get("/api/schemes/search")
def scheme_search(q: str = Query(min_length=2, max_length=100)):
    try:
        return nav.search_schemes(q)[:25]
    except nav.NavSourceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.get("/api/schemes/{code}/nav")
def scheme_nav(code: int, on: Optional[str] = None, conn: sqlite3.Connection = Depends(get_conn)):
    """Latest NAV, or the NAV on / just before a given ISO date (for pre-filling a transaction)."""
    try:
        on = _iso_date_or_none(on)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    try:
        nav.refresh_scheme(conn, code)
    except nav.NavSourceError as e:
        if nav.latest_nav(conn, code) is None:
            raise HTTPException(status_code=502, detail=str(e)) from e
    result = nav.nav_on_or_before(conn, code, on) if on else nav.latest_nav(conn, code)
    if not result:
        raise HTTPException(status_code=404, detail="No NAV available for that date")
    return {"scheme_code": code, "date": result[0], "nav": result[1], "requested": on}


# ----------------------------------------------------------------- stock lookup (quote source)

@app.get("/api/stocks/search")
def stock_search(q: str = Query(min_length=1, max_length=100)):
    """Symbols matching a company name or ticker, on any exchange."""
    try:
        return quotes.search(q)[:25]
    except quotes.QuoteSourceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.get("/api/stocks/{symbol}/quote")
def stock_quote(symbol: str, on: Optional[str] = None, conn: sqlite3.Connection = Depends(get_conn)):
    """Latest price, or the close on / just before a date, plus the symbol's name, exchange and currency."""
    symbol = quotes.normalize_symbol(symbol)
    try:
        on = _iso_date_or_none(on)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    try:
        quotes.refresh_symbol(conn, symbol)
    except quotes.QuoteSourceError as e:
        if quotes.latest(conn, symbol) is None:
            raise HTTPException(status_code=502, detail=str(e)) from e
    result = quotes.on_or_before(conn, symbol, on) if on else quotes.latest(conn, symbol)
    if not result:
        raise HTTPException(status_code=404, detail="No price available for that date")
    m = quotes.meta(conn, symbol) or {}
    return {
        "symbol": symbol,
        "date": result[0],
        "price": result[1],
        "requested": on,
        "name": m.get("name"),
        "exchange": m.get("exchange"),
        "currency": m.get("currency"),
        "quote_type": m.get("quote_type"),
        "base_currency": BASE,
    }


# ----------------------------------------------------------------- NPS lookup (NPS Trust)

@app.get("/api/nps/schemes")
def nps_schemes(q: Optional[str] = Query(default=None, max_length=100)):
    """Every NPS scheme NPS Trust publishes a NAV for, grouped by pension fund manager, with letter (E / C / G / A),
    tier, variant (standard, GS, Direct, POP) and latest NAV."""
    try:
        rows = nps.list_schemes()
    except nps.NpsSourceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    if q:
        needle = q.strip().lower()
        rows = [r for r in rows if needle in r["name"].lower() or needle in r["pfm"].lower() or needle in r["id"].lower()]
    groups: dict[str, dict] = {}
    for r in rows:
        g = groups.setdefault(r["pfm_id"], {"pfm_id": r["pfm_id"], "pfm": r["pfm"], "schemes": []})
        g["schemes"].append(r)
    return sorted(groups.values(), key=lambda g: g["pfm"].lower())


@app.get("/api/nps/{scheme_id}/nav")
def nps_nav(scheme_id: str, on: Optional[str] = None, conn: sqlite3.Connection = Depends(get_conn)):
    """Latest NAV of one NPS scheme, or the NAV on / just before a date."""
    sid = scheme_id.strip().upper()
    if not nps.is_scheme_id(sid):
        raise HTTPException(status_code=422, detail="NPS scheme ids look like SM007001")
    try:
        on = _iso_date_or_none(on)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    try:
        nps.refresh_scheme(conn, sid)
    except nps.NpsSourceError as e:
        if nps.latest(conn, sid) is None:
            raise HTTPException(status_code=502, detail=str(e)) from e
    result = nps.on_or_before(conn, sid, on) if on else nps.latest(conn, sid)
    if not result:
        raise HTTPException(status_code=404, detail="No NAV available for that date")
    m = nps.meta(conn, sid) or {}
    return {"scheme_id": sid, "date": result[0], "nav": result[1], "requested": on, "name": m.get("name")}


# ----------------------------------------------------------------- funds

_FUND_COLS = "name, kind, scheme_code, symbol, exchange, currency, details, folio_number, locked, lock_in_until, notes"


def _fund_values(body: FundIn, currency: str, exchange: Optional[str]) -> tuple:
    details = json.dumps(body.details) if body.details else None
    return (body.name, body.kind, body.scheme_code, body.symbol, exchange, currency, details, body.folio_number,
            int(body.locked), body.lock_in_until, body.notes)


@app.get("/api/funds")
def list_funds(conn: sqlite3.Connection = Depends(get_conn)):
    rows = conn.execute("SELECT * FROM funds ORDER BY name COLLATE NOCASE").fetchall()
    _auto_refresh(conn, rows)
    return [_fund_payload(conn, r) for r in rows]


@app.post("/api/funds", status_code=201)
def create_fund(body: FundIn, conn: sqlite3.Connection = Depends(get_conn)):
    source_error, currency, exchange = _prepare_source(conn, body)
    with conn:
        cur = conn.execute(
            f"INSERT INTO funds({_FUND_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)", _fund_values(body, currency, exchange)
        )
        fund_id = cur.lastrowid
    payload = _fund_payload(conn, _fund_row(conn, fund_id), detail=True)
    payload["nav_error"] = source_error
    return payload


@app.get("/api/funds/{fund_id}")
def get_fund(
    fund_id: int,
    folio: Optional[str] = Query(default=None, max_length=100, description="Scope to one folio; '(none)' = blank folio"),
    scheme: Optional[str] = Query(default=None, max_length=4, description="NPS: scope to one scheme letter"),
    conn: sqlite3.Connection = Depends(get_conn),
):
    row = _fund_row(conn, fund_id)
    errors = _auto_refresh(conn, [row])
    payload = _fund_payload(conn, row, detail=True, folio=folio, scheme=scheme)
    payload.pop("_flows_base", None)
    payload["nav_errors"] = errors
    return payload


@app.put("/api/funds/{fund_id}")
def update_fund(fund_id: int, body: FundUpdate, conn: sqlite3.Connection = Depends(get_conn)):
    """Change a holding's details (name, AMFI scheme / stock symbol / NPS schemes, default folio, status).
    Transactions are never touched, except that `apply_folio_to_transactions` rewrites the ones carrying the
    old default folio."""
    row = _fund_row(conn, fund_id)
    old_folio = row["folio_number"]
    if body.kind == EPF:  # keep the job-change links whatever the edit form sent
        kept = {k: v for k, v in (_fund_dict(row)["details"] or {}).items() if k.startswith("transferred_")}
        body.details = {**kept, **(body.details or {})} if kept else body.details
    source_error, currency, exchange = _prepare_source(conn, body)
    transactions_updated = 0
    with conn:
        conn.execute(
            "UPDATE funds SET name=?, kind=?, scheme_code=?, symbol=?, exchange=?, currency=?, details=?, folio_number=?, "
            "locked=?, lock_in_until=?, notes=? WHERE id=?",
            (*_fund_values(body, currency, exchange), fund_id),
        )
        if body.apply_folio_to_transactions and body.folio_number != old_folio:
            cur = conn.execute(
                "UPDATE transactions SET folio_number = ? WHERE fund_id = ? AND folio_number = ?",
                (body.folio_number, fund_id, old_folio),
            )
            transactions_updated = cur.rowcount
    payload = _fund_payload(conn, _fund_row(conn, fund_id), detail=True)
    payload.pop("_flows_base", None)
    payload["nav_error"] = source_error
    payload["transactions_updated"] = transactions_updated
    return payload


@app.delete("/api/funds/{fund_id}", status_code=204)
def delete_fund(fund_id: int, conn: sqlite3.Connection = Depends(get_conn)):
    _fund_row(conn, fund_id)
    with conn:
        conn.execute("DELETE FROM funds WHERE id = ?", (fund_id,))
    return None


class EpfTransferIn(BaseModel):
    """A job change: the EPF balance moves to a new account under the same UAN."""

    employer: str = Field(default="", max_length=120)
    name: str = Field(min_length=1, max_length=200)
    date: str
    move_pension: bool = False  # normally the pension (EPS) record stays with the old account
    notes: str = ""

    @field_validator("date")
    @classmethod
    def _v_date(cls, v):
        out = _iso_date_or_none(v)
        if out is None:
            raise ValueError("date is required")
        return out

    @field_validator("employer", "name", "notes")
    @classmethod
    def _strip(cls, v: str):
        return v.strip()


@app.post("/api/funds/{fund_id}/epf-transfer", status_code=201)
def epf_transfer(fund_id: int, body: EpfTransferIn, conn: sqlite3.Connection = Depends(get_conn)):
    """Create the new employer's EPF account (same UAN) and move every employee / employer share entry to it,
    so its history and balance continue unbroken. Pension (EPS) entries stay unless `move_pension`."""
    row = _fund_row(conn, fund_id)
    if row["kind"] != EPF:
        raise HTTPException(status_code=422, detail="Only an EPF account can be moved to a new employer")
    old = _fund_dict(row)
    old_details = old["details"] or {}
    if old_details.get("transferred_to"):
        raise HTTPException(status_code=422, detail=f"This account was already moved to '{old_details.get('transferred_to_name') or old_details['transferred_to']}'")
    schemes = ("EE", "ER", "EPS") if body.move_pension else ("EE", "ER")
    new_details = {"employer": body.employer, "transferred_from": fund_id, "transferred_from_name": old["name"], "transferred_on": body.date}
    with conn:
        cur = conn.execute(
            f"INSERT INTO funds({_FUND_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (body.name, EPF, None, None, None, MF_CURRENCY, json.dumps(new_details), old["folio_number"], 1, None, body.notes),
        )
        new_id = cur.lastrowid
        marks = ",".join("?" * len(schemes))
        moved = conn.execute(f"UPDATE transactions SET fund_id = ? WHERE fund_id = ? AND scheme IN ({marks})", (new_id, fund_id, *schemes)).rowcount
        conn.execute(
            "UPDATE funds SET details = ? WHERE id = ?",
            (json.dumps({**old_details, "transferred_to": new_id, "transferred_to_name": body.name, "transferred_on": body.date}), fund_id),
        )
    payload = _fund_payload(conn, _fund_row(conn, new_id), detail=True)
    payload["moved"] = moved
    payload["old_id"] = fund_id
    return payload


# ----------------------------------------------------------------- transactions

def _check_scheme(row: sqlite3.Row, scheme: str) -> str:
    """NPS transactions must name one of the account's schemes; EPF ones the share (EE / ER / EPS); other kinds carry no scheme."""
    if row["kind"] == EPF:
        if scheme not in EPF_SHARES:
            raise HTTPException(status_code=422, detail="Pick the EPF share this belongs to: EE (employee), ER (employer) or EPS (pension)")
        return scheme
    if row["kind"] != NPS:
        return ""
    schemes = _nps_schemes(row)
    if scheme not in schemes:
        raise HTTPException(status_code=422, detail=f"Pick the NPS scheme this belongs to: {', '.join(schemes) or 'none set up'}")
    return scheme


def _txn_values(body: TxnIn, scheme: str, kind: str = MF) -> tuple:
    amount = body.amount
    if kind == EPF:
        # Rupees are the units: a deposit of 750 is 750 units at 1; interest is 13 free units (zero cost).
        units = body.units if body.type in UNITS_ONLY else amount
        if not units or units <= 0:
            raise HTTPException(status_code=422, detail="Enter the amount")
        return (body.date, body.folio_number.strip(), scheme, body.type, round(amount, 2), 1.0, round(units, 2), body.rate, body.notes.strip())
    if body.type in CASH_ONLY + UNITS_ONLY:
        nav_value, units = body.nav or 0.0, body.units or 0.0
    elif body.type in UNIT_MOVES:
        units = body.units
        nav_value = body.nav if body.nav else amount / units
        amount = amount if amount else units * nav_value
    else:
        units = body.units if body.units else amount / body.nav
        nav_value = body.nav if body.nav else amount / units
    return (
        body.date,
        body.folio_number.strip(),
        scheme,
        body.type,
        round(amount, 2),
        nav_value,
        round(units, 4),
        body.rate,
        body.notes.strip(),
    )


_TXN_INSERT = "INSERT INTO transactions(fund_id, date, folio_number, scheme, type, amount, nav, units, rate, notes) VALUES (?,?,?,?,?,?,?,?,?,?)"


@app.post("/api/funds/{fund_id}/transactions", status_code=201)
def add_txn(fund_id: int, body: TxnIn, conn: sqlite3.Connection = Depends(get_conn)):
    row = _fund_row(conn, fund_id)
    scheme = _check_scheme(row, body.scheme)
    _require_price(body, row["kind"])
    with conn:
        cur = conn.execute(_TXN_INSERT, (fund_id, *_txn_values(body, scheme, row["kind"])))
    return dict(conn.execute("SELECT * FROM transactions WHERE id = ?", (cur.lastrowid,)).fetchone())


class BulkTxnItem(BaseModel):
    date: str
    folio_number: str = ""
    scheme: str = ""
    type: TxnType = "SIP"
    amount: float = Field(default=0, ge=0)
    nav: Optional[float] = Field(default=None, ge=0)
    units: Optional[float] = Field(default=None, ge=0)
    rate: Optional[float] = Field(default=None, ge=0, le=100)
    notes: str = ""

    @field_validator("date")
    @classmethod
    def _v_date(cls, v):
        out = _iso_date_or_none(v)
        if out is None:
            raise ValueError("date is required")
        return out

    @field_validator("scheme")
    @classmethod
    def _v_scheme(cls, v):
        return _clean_scheme(v)

    @model_validator(mode="after")
    def _shape(self):
        _check_txn_shape(self)
        return self


class BulkTxnIn(BaseModel):
    transactions: list[BulkTxnItem] = Field(min_length=1, max_length=5000)


@app.post("/api/funds/{fund_id}/transactions/bulk", status_code=201)
def add_txns_bulk(fund_id: int, body: BulkTxnIn, conn: sqlite3.Connection = Depends(get_conn)):
    """Insert many transactions at once, all or nothing. Rows missing NAV / price and units are completed from history."""
    row = _fund_row(conn, fund_id)
    needs_lookup = any(
        (t.nav is None and t.units is None and t.type not in CASH_ONLY + UNITS_ONLY + UNIT_MOVES)
        or (t.type in UNIT_MOVES and t.nav is None and not t.amount)
        for t in body.transactions
    )
    if needs_lookup:
        _auto_refresh(conn, [row])  # use whatever history is cached if the source is down
    values = []
    problems = []
    for i, t in enumerate(body.transactions):
        scheme = _check_scheme(row, t.scheme)
        nav_value, units, amount = t.nav, t.units, t.amount
        if row["kind"] == EPF:
            nav_value = 1.0
            units = units if t.type in UNITS_ONLY else amount
            if not units or units <= 0:
                problems.append(f"row {i + 1}: no amount")
                continue
            values.append((fund_id, t.date, t.folio_number.strip(), scheme, t.type, round(amount, 2), 1.0, round(units, 2), t.rate, t.notes.strip()))
            continue
        if t.type in CASH_ONLY + UNITS_ONLY:
            nav_value, units = nav_value or 0.0, units or 0.0  # price is informational here
        elif t.type in UNIT_MOVES:
            if nav_value is None and amount:
                nav_value = amount / units
            if nav_value is None:
                found = _price_on_or_before(conn, row, t.date, scheme)
                if not found:
                    problems.append(f"row {i + 1}: no NAV available for {t.date}")
                    continue
                nav_value = found[1]
            if not amount:
                amount = units * nav_value
        else:
            if nav_value is None and units is not None:
                nav_value = amount / units
            if nav_value is None:
                found = _price_on_or_before(conn, row, t.date, scheme)
                if not found:
                    problems.append(f"row {i + 1}: no {'price' if row['kind'] == STOCK else 'NAV'} available for {t.date}")
                    continue
                nav_value = found[1]
            if units is None:
                units = amount / nav_value
        values.append(
            (fund_id, t.date, t.folio_number.strip(), scheme, t.type, round(amount, 2), nav_value, round(units, 4), t.rate, t.notes.strip())
        )
    if problems:
        shown = "; ".join(problems[:5]) + (" …" if len(problems) > 5 else "")
        raise HTTPException(status_code=422, detail=f"Nothing imported. {shown}")
    with conn:
        conn.executemany(_TXN_INSERT, values)
    return {"created": len(values)}


@app.put("/api/transactions/{txn_id}")
def update_txn(txn_id: int, body: TxnIn, conn: sqlite3.Connection = Depends(get_conn)):
    existing = conn.execute("SELECT fund_id FROM transactions WHERE id = ?", (txn_id,)).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Transaction not found")
    fund_row = _fund_row(conn, existing["fund_id"])
    scheme = _check_scheme(fund_row, body.scheme)
    _require_price(body, fund_row["kind"])
    with conn:
        conn.execute(
            "UPDATE transactions SET date=?, folio_number=?, scheme=?, type=?, amount=?, nav=?, units=?, rate=?, notes=? WHERE id=?",
            (*_txn_values(body, scheme, fund_row["kind"]), txn_id),
        )
    return dict(conn.execute("SELECT * FROM transactions WHERE id = ?", (txn_id,)).fetchone())


class NotesIn(BaseModel):
    notes: str = Field(default="", max_length=1000)


@app.patch("/api/transactions/{txn_id}/notes")
def update_txn_notes(txn_id: int, body: NotesIn, conn: sqlite3.Connection = Depends(get_conn)):
    """Change only the comment on a transaction (used by the inline editor in the transaction table)."""
    with conn:
        cur = conn.execute("UPDATE transactions SET notes = ? WHERE id = ?", (body.notes.strip(), txn_id))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return dict(conn.execute("SELECT * FROM transactions WHERE id = ?", (txn_id,)).fetchone())


@app.delete("/api/transactions/{txn_id}", status_code=204)
def delete_txn(txn_id: int, conn: sqlite3.Connection = Depends(get_conn)):
    with conn:
        cur = conn.execute("DELETE FROM transactions WHERE id = ?", (txn_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return None


# ----------------------------------------------------------------- portfolio

@app.get("/api/portfolio")
def portfolio(conn: sqlite3.Connection = Depends(get_conn)):
    """Everything in the base currency: holdings in other currencies are converted at the daily exchange rate
    (each cashflow and chart point at its own date's rate, today's value at the latest rate)."""
    rows = conn.execute("SELECT * FROM funds ORDER BY name COLLATE NOCASE").fetchall()
    errors = _auto_refresh(conn, rows)
    today = dt.date.today()
    funds, histories, flows, rollup, unconverted = [], [], [], [], []
    currencies: dict[str, dict] = {}
    for r in rows:
        f = _fund_payload(conn, r, detail=True)
        txns = f.pop("transactions")
        history = f.pop("history")
        history_base = f.pop("history_base", None)
        flows_base = f.pop("_flows_base", None)
        funds.append(f)
        if not f["needs_fx"]:
            summary = f["summary"]
            histories.append(history)
            flows.extend(calc.cashflows(txns))  # investor cashflows only: NPS switches stay inside the account
        elif f["base"]:
            summary = f["base"]["summary"]
            histories.append(history_base)
            flows.extend(flows_base)
            c = currencies.setdefault(
                f["currency"], {"currency": f["currency"], "rate": f["base"]["rate"], "rate_date": f["base"]["rate_date"],
                                "count": 0, "current_value": 0.0, "current_value_base": 0.0, "invested_base": 0.0},
            )
            c["count"] += 1
            c["current_value"] = round(c["current_value"] + f["summary"]["current_value"], 2)
            c["current_value_base"] = round(c["current_value_base"] + summary["current_value"], 2)
            c["invested_base"] = round(c["invested_base"] + summary["invested"], 2)
        else:
            unconverted.append(f["name"])
            pair = quotes.fx_symbol(f["currency"])
            errors.setdefault(pair, f"No {f['currency']}/{BASE} exchange rate downloaded yet")
            continue
        rollup.append({"summary": summary, "locked": f["locked"], "kind": f["kind"], "closed": f["closed"]})
    totals = calc.portfolio_totals(rollup, flows, today)
    active = [f for f in funds if not f["closed"]]
    totals["fund_count"] = len(active)
    totals["closed_count"] = len(funds) - len(active)
    totals["locked_count"] = sum(1 for f in active if f["locked"])
    totals["currency"] = BASE
    totals["currencies"] = sorted(currencies.values(), key=lambda c: -c["current_value_base"])
    totals["unconverted"] = unconverted
    return {
        "as_of": today.isoformat(),
        "base_currency": BASE,
        "totals": totals,
        "funds": funds,
        "history": calc.combine_histories(histories),
        "nav_errors": errors,
    }


@app.post("/api/nav/refresh")
def refresh_nav(conn: sqlite3.Connection = Depends(get_conn)):
    """Force-refresh every NAV history, stock price history, exchange rate and NPS scheme in use."""
    rows = conn.execute("SELECT * FROM funds").fetchall()
    codes, symbols, nps_ids = _sources(rows)
    requested = len(set(codes)) + len(set(symbols)) + len(set(nps_ids))
    errors = _auto_refresh(conn, rows, force=True)
    return {"requested": requested, "failed": errors}


# ----------------------------------------------------------------- static frontend (must be last)

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
