"""FastAPI application: JSON API under /api plus the static frontend at /."""
from __future__ import annotations

import datetime as dt
import sqlite3
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import calc, db, nav

# In the PyInstaller build the frontend is unpacked under sys._MEIPASS; in a dev checkout it's <project>/frontend.
_BUNDLE_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
FRONTEND_DIR = _BUNDLE_ROOT / "frontend"


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="Investment Tracker", version="0.1.0", lifespan=lifespan)


def get_conn():
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


# ----------------------------------------------------------------- schemas

def _iso_date_or_none(v: Optional[str]) -> Optional[str]:
    if v in (None, ""):
        return None
    try:
        return dt.date.fromisoformat(v).isoformat()
    except ValueError as e:
        raise ValueError("date must be in YYYY-MM-DD format") from e


class FundIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    scheme_code: int = Field(gt=0)
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


class TxnIn(BaseModel):
    date: str
    folio_number: str = ""
    type: Literal["SIP", "LUMPSUM"]
    amount: float = Field(gt=0)
    nav: float = Field(gt=0)
    units: Optional[float] = Field(default=None, gt=0, description="Defaults to amount / nav")
    notes: str = ""

    @field_validator("date")
    @classmethod
    def _v_date(cls, v):
        out = _iso_date_or_none(v)
        if out is None:
            raise ValueError("date is required")
        return out


# ----------------------------------------------------------------- helpers

def _fund_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["locked"] = bool(d["locked"])
    return d


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


def _auto_refresh(conn: sqlite3.Connection, codes) -> dict[str, str]:
    """Refresh stale NAV caches; never fail the request because the NAV source is down."""
    try:
        return {str(k): v for k, v in nav.refresh_many(conn, codes).items()}
    except Exception as e:  # noqa: BLE001
        return {"*": str(e)}


def _fund_payload(conn: sqlite3.Connection, row: sqlite3.Row, detail: bool = False) -> dict:
    fund = _fund_dict(row)
    txns = _txns(conn, fund["id"])
    code = fund["scheme_code"]
    fund["summary"] = calc.summarize(txns, nav.latest_nav(conn, code), dt.date.today())
    fund["scheme"] = nav.scheme_meta(conn, code)
    if detail:
        fund["transactions"] = txns
        fund["history"] = calc.value_history(txns, nav.get_history(conn, code))
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


# ----------------------------------------------------------------- funds

@app.get("/api/funds")
def list_funds(conn: sqlite3.Connection = Depends(get_conn)):
    rows = conn.execute("SELECT * FROM funds ORDER BY name COLLATE NOCASE").fetchall()
    _auto_refresh(conn, [r["scheme_code"] for r in rows])
    return [_fund_payload(conn, r) for r in rows]


@app.post("/api/funds", status_code=201)
def create_fund(body: FundIn, conn: sqlite3.Connection = Depends(get_conn)):
    with conn:
        cur = conn.execute(
            "INSERT INTO funds(name, scheme_code, folio_number, locked, lock_in_until, notes) VALUES (?,?,?,?,?,?)",
            (body.name, body.scheme_code, body.folio_number, int(body.locked), body.lock_in_until, body.notes),
        )
        fund_id = cur.lastrowid
    nav_error = None
    try:
        nav.refresh_scheme(conn, body.scheme_code)
    except nav.NavSourceError as e:
        nav_error = str(e)
    payload = _fund_payload(conn, _fund_row(conn, fund_id), detail=True)
    payload["nav_error"] = nav_error
    return payload


@app.get("/api/funds/{fund_id}")
def get_fund(fund_id: int, conn: sqlite3.Connection = Depends(get_conn)):
    row = _fund_row(conn, fund_id)
    errors = _auto_refresh(conn, [row["scheme_code"]])
    payload = _fund_payload(conn, row, detail=True)
    payload["nav_errors"] = errors
    return payload


@app.put("/api/funds/{fund_id}")
def update_fund(fund_id: int, body: FundIn, conn: sqlite3.Connection = Depends(get_conn)):
    _fund_row(conn, fund_id)
    with conn:
        conn.execute(
            "UPDATE funds SET name=?, scheme_code=?, folio_number=?, locked=?, lock_in_until=?, notes=? WHERE id=?",
            (body.name, body.scheme_code, body.folio_number, int(body.locked), body.lock_in_until, body.notes, fund_id),
        )
    nav_error = None
    try:
        nav.refresh_scheme(conn, body.scheme_code)
    except nav.NavSourceError as e:
        nav_error = str(e)
    payload = _fund_payload(conn, _fund_row(conn, fund_id), detail=True)
    payload["nav_error"] = nav_error
    return payload


@app.delete("/api/funds/{fund_id}", status_code=204)
def delete_fund(fund_id: int, conn: sqlite3.Connection = Depends(get_conn)):
    _fund_row(conn, fund_id)
    with conn:
        conn.execute("DELETE FROM funds WHERE id = ?", (fund_id,))
    return None


# ----------------------------------------------------------------- transactions

def _txn_values(body: TxnIn) -> tuple:
    units = body.units if body.units is not None else body.amount / body.nav
    return (
        body.date,
        body.folio_number.strip(),
        body.type,
        round(body.amount, 2),
        body.nav,
        round(units, 4),
        body.notes.strip(),
    )


@app.post("/api/funds/{fund_id}/transactions", status_code=201)
def add_txn(fund_id: int, body: TxnIn, conn: sqlite3.Connection = Depends(get_conn)):
    _fund_row(conn, fund_id)
    with conn:
        cur = conn.execute(
            "INSERT INTO transactions(fund_id, date, folio_number, type, amount, nav, units, notes) VALUES (?,?,?,?,?,?,?,?)",
            (fund_id, *_txn_values(body)),
        )
    return dict(conn.execute("SELECT * FROM transactions WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.put("/api/transactions/{txn_id}")
def update_txn(txn_id: int, body: TxnIn, conn: sqlite3.Connection = Depends(get_conn)):
    if not conn.execute("SELECT 1 FROM transactions WHERE id = ?", (txn_id,)).fetchone():
        raise HTTPException(status_code=404, detail="Transaction not found")
    with conn:
        conn.execute(
            "UPDATE transactions SET date=?, folio_number=?, type=?, amount=?, nav=?, units=?, notes=? WHERE id=?",
            (*_txn_values(body), txn_id),
        )
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
    rows = conn.execute("SELECT * FROM funds ORDER BY name COLLATE NOCASE").fetchall()
    nav_errors = _auto_refresh(conn, [r["scheme_code"] for r in rows])
    today = dt.date.today()
    funds, histories, flows = [], [], []
    for r in rows:
        f = _fund_payload(conn, r, detail=True)
        txns = f.pop("transactions")
        histories.append(f.pop("history"))
        flows.extend((dt.date.fromisoformat(t["date"]), -t["amount"]) for t in txns)
        funds.append(f)
    return {
        "as_of": today.isoformat(),
        "totals": calc.portfolio_totals(funds, flows, today),
        "funds": funds,
        "history": calc.combine_histories(histories),
        "nav_errors": nav_errors,
    }


@app.post("/api/nav/refresh")
def refresh_nav(conn: sqlite3.Connection = Depends(get_conn)):
    codes = [r["scheme_code"] for r in conn.execute("SELECT DISTINCT scheme_code FROM funds")]
    errors = nav.refresh_many(conn, codes, force=True)
    return {"requested": len(codes), "failed": {str(k): v for k, v in errors.items()}}


# ----------------------------------------------------------------- static frontend (must be last)

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
