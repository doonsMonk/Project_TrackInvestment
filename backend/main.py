"""FastAPI application: JSON API under /api plus the static frontend at /."""
from __future__ import annotations

import base64
import datetime as dt
import json
import os
import shutil
import sqlite3
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .compat import field_validator, list_limits, model_validator  # pydantic v2 on the PC, v1 on Android

from . import calc, cas, cloud, db, fd, gold, nav, nps, policy, quotes, sgb, sip, tax

# In the PyInstaller build the frontend is unpacked under sys._MEIPASS; in a dev checkout it's <project>/frontend.
_BUNDLE_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
FRONTEND_DIR = Path(os.environ["INVESTMENT_TRACKER_FRONTEND"]) if os.environ.get("INVESTMENT_TRACKER_FRONTEND") else _BUNDLE_ROOT / "frontend"  # Android: unpacked assets

MF, STOCK, NPS, EPF, PPF = "MF", "STOCK", "NPS", "EPF", "PPF"
GOLD = "GOLD"  # Sovereign Gold Bonds: grams valued at a gold price per gram entered by the user
FD = "FD"  # fixed deposits: rupees valued along the curve from the principal to the maturity value
INS = "INS"  # life insurance policies: premiums on a schedule, valued at the policy's own rate of return towards the maturity value
TERM_KINDS = (FD, INS)  # rupees as units, priced along a curve to a maturity value known in advance
RUPEE_KINDS = (EPF, PPF)  # no price source: a rupee is a unit, deposits are purchases, interest is zero-cost units
EPF_SHARES = {"EE": "Employee share", "ER": "Employer share", "EPS": "Pension scheme (EPS)"}
BASE = quotes.BASE_CURRENCY
MF_CURRENCY = "INR"  # AMFI and NPS NAVs are always in rupees, whatever the portfolio currency is


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.vault.prepare()
    yield
    db.vault.lock()  # flush and forget the key on shutdown


VERSION = "0.15.0"
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
        detail = str(e) if isinstance(e, db.VaultChangedOnDisk) else "Locked. Enter your password to continue."
        raise HTTPException(status_code=423, detail=detail) from e
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
        "data_dir": str(db.DATA_DIR),
        "vault_path": str(db.VAULT_PATH),
        "configured_data_dir": db.read_settings().get("data_dir"),
        "settings_path": str(db.SETTINGS_PATH),
        "notice": v.last_notice,  # why the vault locked itself (the file on disk was replaced), if it did
    }


# ----------------------------------------------------------------- cloud backup (Google Drive / OneDrive / Dropbox)

class CloudCredentialsIn(BaseModel):
    """The OAuth client the user created in the provider's console."""

    provider: Literal["google", "onedrive", "dropbox"]
    client_id: str = Field(default="", max_length=300)
    client_secret: Optional[str] = Field(default=None, max_length=300)


class CloudProviderIn(BaseModel):
    provider: Literal["google", "onedrive", "dropbox"]


@app.get("/api/cloud/status")
def cloud_status(check: bool = False):
    """Setup, connection and backup state of every provider; `check=true` also looks at the copy in the cloud."""
    return cloud.status(check_remote=check)


@app.put("/api/cloud/credentials")
def cloud_credentials(body: CloudCredentialsIn):
    if body.client_id and cloud.PROVIDERS[body.provider]["needs_secret"] and not (body.client_secret or "").strip():
        raise HTTPException(status_code=422, detail=f"{cloud.PROVIDERS[body.provider]['label']} also needs the client secret")
    try:
        cloud.set_credentials(body.provider, body.client_id, body.client_secret)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not write {db.SETTINGS_PATH}: {e}") from e
    if not body.client_id:
        cloud.disconnect(body.provider)
    return cloud.status()["providers"][body.provider]


@app.post("/api/cloud/connect")
def cloud_connect(body: CloudProviderIn, request: Request):
    """Start the sign-in: returns the provider's consent URL for the browser. The provider sends the user back to
    this app's own address, /api/cloud/callback."""
    host = request.headers.get("host") or f"127.0.0.1:{request.url.port or 8000}"
    port = host.rsplit(":", 1)[1] if ":" in host else "80"
    redirect_uri = f"http://127.0.0.1:{port}/api/cloud/callback"
    try:
        return {"auth_url": cloud.begin_connect(body.provider, redirect_uri), "redirect_uri": redirect_uri}
    except cloud.CloudError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@app.get("/api/cloud/callback", response_class=HTMLResponse)
def cloud_callback(state: str = "", code: str = "", error: str = "", error_description: str = ""):
    """Where the provider sends the browser after the consent page."""
    page = "<!doctype html><meta charset='utf-8'><title>Investment Tracker</title><body style='font-family:system-ui;padding:40px;max-width:520px'>{}</body>"
    if error:
        return page.format(f"<h2>Sign-in cancelled</h2><p>{error}: {error_description}</p><p>You can close this tab and try again in the app.</p>")
    try:
        result = cloud.finish_connect(state, code)
    except cloud.CloudError as e:
        return page.format(f"<h2>Sign-in failed</h2><p>{e}</p><p>Close this tab and try again in the app.</p>")
    label = cloud.PROVIDERS[result["provider"]]["label"]
    cloud.schedule_backup(1.0)
    return page.format(f"<h2>{label} connected</h2><p>Signed in as <b>{result['account']}</b>. The vault will be backed up there after every change.</p><p>You can close this tab and return to the app.</p>")


@app.post("/api/cloud/backup")
def cloud_backup(body: CloudProviderIn):
    try:
        return cloud.backup(body.provider)
    except cloud.CloudError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.post("/api/cloud/restore")
def cloud_restore(body: CloudProviderIn):
    """Replace this device's vault with the provider's copy (the previous file is kept beside it)."""
    try:
        return cloud.restore(body.provider)
    except cloud.CloudError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not write the vault file: {e}") from e


@app.delete("/api/cloud/{provider}", status_code=204)
def cloud_disconnect(provider: Literal["google", "onedrive", "dropbox"]):
    cloud.disconnect(provider)
    return None


class DataDirIn(BaseModel):
    """Where the vault file should live from the next start on; empty = the default folder."""

    path: Optional[str] = Field(default=None, max_length=1000)
    copy_vault: bool = True


@app.put("/api/settings/data-dir")
def set_data_dir(body: DataDirIn):
    """Record the data folder in settings.json (next to the exe), optionally copying the current vault file
    there when that folder has none. Takes effect when the app is started again; nothing is moved or deleted."""
    settings = db.read_settings()
    raw = (body.path or "").strip()
    if not raw:
        settings.pop("data_dir", None)
        try:
            db.write_settings(settings)
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"Could not write {db.SETTINGS_PATH}: {e}") from e
        return {"data_dir": None, "restart_required": True, "copied": False, "vault_exists_there": False}
    target = Path(raw).expanduser()
    if not target.is_absolute():
        raise HTTPException(status_code=422, detail="Give the full path of the folder, for example C:\\Users\\you\\OneDrive\\InvestmentTracker")
    try:
        target.mkdir(parents=True, exist_ok=True)
        probe = target / ".write_test"
        probe.touch()
        probe.unlink()
    except OSError as e:
        raise HTTPException(status_code=422, detail=f"That folder cannot be used: {e}") from e
    dest = target / db.VAULT_PATH.name
    same = target.resolve() == db.DATA_DIR.resolve()
    copied = False
    if body.copy_vault and not same and db.VAULT_PATH.exists() and not dest.exists():
        db.vault.lock()  # flush, so the copy is complete; the user unlocks again after the restart anyway
        shutil.copy2(db.VAULT_PATH, dest)
        copied = True
    settings["data_dir"] = str(target)
    try:
        db.write_settings(settings)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not write {db.SETTINGS_PATH}: {e}") from e
    return {"data_dir": str(target), "restart_required": not same, "copied": copied, "vault_exists_there": dest.exists()}


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
        detail = str(e) if isinstance(e, db.VaultChangedOnDisk) else "Locked. Enter your password to continue."
        raise HTTPException(status_code=423, detail=detail) from e
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
    kind: Literal["MF", "STOCK", "NPS", "EPF", "PPF", "GOLD", "FD", "INS"] = MF
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
        elif self.kind == GOLD:
            d = self.details if isinstance(self.details, dict) else {}
            issue_date = d.get("issue_date")
            price = d.get("issue_price")
            try:
                price = float(price) if price not in (None, "") else None
            except (TypeError, ValueError) as e:
                raise ValueError("issue_price must be a number") from e
            if price is not None and price <= 0:
                raise ValueError("issue_price must be positive")
            self.details = {
                "form": "SGB",
                "series": str(d.get("series") or "").strip()[:120],
                "code": str(d.get("code") or "").strip().upper()[:24],
                "issue_date": _iso_date_or_none(str(issue_date)) if issue_date else None,
                "issue_date_from": str(d.get("issue_date_from") or "") or None,  # "sgb" when filled from the exchange list
                "issue_price": price,
                "isin": str(d.get("isin") or "").strip().upper() or None,
            }
            self.scheme_code = None
        elif self.kind == INS:
            d = self.details if isinstance(self.details, dict) else {}
            nums = {}
            for key in ("premium", "maturity_value", "sum_assured"):
                try:
                    nums[key] = float(d[key]) if d.get(key) not in (None, "") else None
                except (TypeError, ValueError) as e:
                    raise ValueError(f"{key} must be a number") from e
                if nums[key] is not None and nums[key] <= 0:
                    raise ValueError(f"{key} must be positive")
            freq = str(d.get("frequency") or "yearly")
            if freq not in policy.FREQUENCIES:
                raise ValueError("frequency must be yearly, half-yearly, quarterly or monthly")
            dates = {}
            for key in ("first_premium", "last_premium", "maturity_date"):
                raw = d.get(key)
                dates[key] = _iso_date_or_none(str(raw)) if raw else None
                if raw and dates[key] is None:
                    raise ValueError(f"{key} must be a date (YYYY-MM-DD)")
            if dates["first_premium"] and dates["maturity_date"] and dates["maturity_date"] <= dates["first_premium"]:
                raise ValueError("the maturity date must be after the first premium")
            if dates["first_premium"] and dates["last_premium"] and dates["last_premium"] < dates["first_premium"]:
                raise ValueError("the last premium cannot be before the first")
            self.details = {
                "insurer": str(d.get("insurer") or "").strip()[:120],
                "plan": str(d.get("plan") or "").strip()[:120],
                "frequency": freq,
                **nums,
                **dates,
            }
            self.scheme_code = None
        elif self.kind == FD:
            d = self.details if isinstance(self.details, dict) else {}
            mv, rate = d.get("maturity_value"), d.get("rate")
            try:
                mv = float(mv) if mv not in (None, "") else None
                rate = float(rate) if rate not in (None, "") else None
            except (TypeError, ValueError) as e:
                raise ValueError("maturity_value and rate must be numbers") from e
            if mv is not None and mv <= 0:
                raise ValueError("maturity_value must be positive")
            if rate is not None and not 0 <= rate <= 100:
                raise ValueError("rate must be a percentage")
            md = d.get("maturity_date")
            payout = str(d.get("payout") or "cumulative")
            if payout not in ("cumulative", "periodic"):
                raise ValueError("payout must be cumulative or periodic")
            self.details = {
                "bank": str(d.get("bank") or "").strip()[:120],
                "maturity_date": _iso_date_or_none(str(md)) if md else None,
                "maturity_value": mv,
                "rate": rate,
                "payout": payout,
            }
            self.scheme_code = None
        elif self.kind == PPF:
            d = self.details if isinstance(self.details, dict) else {}
            opened = d.get("opened")
            self.details = {"bank": str(d.get("bank") or "").strip()[:120], "opened": _iso_date_or_none(str(opened)) if opened else None}
            self.scheme_code = None
        else:
            d = self.details if isinstance(self.details, dict) else {}
            sips = sip.clean(d.get("sips")) if self.kind in (MF, STOCK) else []  # SIP schedules live in the details
            tax_class = d.get("tax_class") if self.kind == MF and d.get("tax_class") in tax.CLASSES else None  # equity / debt / other, when the user says so
            details = {k: v for k, v in (("sips", sips), ("tax_class", tax_class)) if v}
            self.details = details or None
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
    """A single purchase / sale needs a price or units, except for EPF / PPF where a rupee is a unit (and an FD
    deposit, which is rupees too; an FD payout gets its units and factor from the route)."""
    if kind in TERM_KINDS and body.type in calc.PURCHASES:
        return
    if kind not in RUPEE_KINDS and body.type not in CASH_ONLY + UNITS_ONLY + UNIT_MOVES and body.nav is None and body.units is None:
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


def _sources(rows) -> tuple[list[int], list[str], list[str], list[str]]:
    """(AMFI scheme codes, quote symbols incl. FX pairs, NPS scheme ids, SGB codes) needed to value these holdings."""
    codes = [r["scheme_code"] for r in rows if (r["kind"] or MF) == MF and r["scheme_code"]]
    symbols = [r["symbol"] for r in rows if r["kind"] == STOCK and r["symbol"]]
    pairs = [p for p in (quotes.fx_symbol(r["currency"]) for r in rows) if p]
    nps_ids = [sid for r in rows if r["kind"] == NPS for sid in _nps_schemes(r).values()]
    sgb_codes = [c for c in ((_fund_dict(r)["details"] or {}).get("code") for r in rows if r["kind"] == GOLD) if c]
    return codes, symbols + pairs, nps_ids, sgb_codes


def _auto_refresh(conn: sqlite3.Connection, rows, force: bool = False) -> dict[str, str]:
    """Refresh stale NAV / price / FX / NPS caches; never fail the request because a source is down."""
    codes, symbols, nps_ids, sgb_codes = _sources(rows)
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
    try:
        errors.update(sgb.refresh_many(conn, sgb_codes, force))
    except Exception as e:  # noqa: BLE001
        errors["*sgb"] = str(e)
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
                detail=f"Could not look up {body.symbol}: {error}. Check the symbol (for example RELIANCE.NS, BHP.AX, AAPL).",
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
    if body.kind in RUPEE_KINDS:
        return None, MF_CURRENCY, None  # no price source: an EPF / PPF balance is deposits plus the interest you enter
    if body.kind in TERM_KINDS:
        return None, MF_CURRENCY, None  # valued along a curve to the maturity value; nothing to fetch
    if body.kind == GOLD:
        # With an NSE code the series is priced from sgb.vercel.app and its issue details fill any empty fields;
        # without one (or offline) the bond is valued at the gold price per gram the user enters.
        d = body.details or {}
        code = d.get("code")
        if not code:
            return None, MF_CURRENCY, None
        try:
            info = sgb.issue_info(code)
        except sgb.SgbSourceError as e:
            return f"{code}: {e}", MF_CURRENCY, None
        if info is None:
            raise HTTPException(
                status_code=422,
                detail=f"{code} is not in the Sovereign Gold Bond lists at NSE or sgb.vercel.app. Check the NSE symbol (for example SGBMAR30X), "
                       "or leave the code empty and enter the gold price yourself.",
            )
        d["series"] = d.get("series") or info["name"]
        if not d.get("issue_date") and info.get("issue_date"):
            d["issue_date"], d["issue_date_from"] = info["issue_date"], "sgb"
        d["issue_price"] = d.get("issue_price") or info.get("face_value")
        d["isin"] = info.get("isin") or d.get("isin")
        try:
            sgb.refresh_code(conn, code)
        except sgb.SgbSourceError as e:
            return str(e), MF_CURRENCY, None
        return None, MF_CURRENCY, None
    try:
        nav.refresh_scheme(conn, body.scheme_code)
        return None, MF_CURRENCY, None
    except nav.NavSourceError as e:
        return str(e), MF_CURRENCY, None


def _price_source(conn: sqlite3.Connection, fund: dict, with_history: bool):
    """(history, latest) for a fund or stock from its own price table; gold holdings share the entered gold price."""
    if fund["kind"] == FD:
        t = fd.terms(fund["details"], _txns(conn, fund["id"]))
        today = dt.date.today().isoformat()
        return (fd.series(t, dt.date.today()) if with_history else []), (today, fd.factor(t, today))
    if fund["kind"] == INS:
        t = policy.terms(fund["details"], _txns(conn, fund["id"]))
        now = dt.date.today()
        r = policy.rate(t, now)
        return (policy.series(t, r, now) if with_history else []), (now.isoformat(), policy.factor(t, r, now.isoformat()))
    if fund["kind"] == GOLD:
        code = (fund["details"] or {}).get("code")
        if code and sgb.latest(conn, code):
            return (sgb.get_history(conn, code) if with_history else []), sgb.latest(conn, code)
        return (gold.history(conn) if with_history else []), gold.latest(conn)
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
    if row["kind"] in RUPEE_KINDS:
        return (iso_date, 1.0)  # rupees in, rupees out: one unit is one rupee
    if row["kind"] == FD:
        return (iso_date, fd.factor(fd.terms(_fund_dict(row)["details"], _txns(conn, row["id"])), iso_date))
    if row["kind"] == INS:
        t = policy.terms(_fund_dict(row)["details"], _txns(conn, row["id"]))
        return (iso_date, policy.factor(t, policy.rate(t, dt.date.today()), iso_date))
    if row["kind"] == GOLD:
        code = (_fund_dict(row)["details"] or {}).get("code")
        return (sgb.on_or_before(conn, code, iso_date) if code else None) or gold.on_or_before(conn, iso_date)
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


def _ppf_years(all_txns: list[dict], today: dt.date) -> tuple[list[dict], Optional[str]]:
    """PPF: one row per financial year (deposits, interest, withdrawals, rate, closing balance) plus the latest
    year with deposits whose interest has not been entered yet, if any."""
    years: dict[str, dict] = {}
    for t in all_txns:
        y = years.setdefault(fy_of(t["date"]), {"fy": fy_of(t["date"]), "deposit": 0.0, "interest": 0.0, "withdrawn": 0.0, "rate": None})
        if t["type"] in calc.PURCHASES:
            y["deposit"] += t["amount"]
        elif t["type"] == calc.BONUS:
            y["interest"] += t["units"]
        elif t["type"] == calc.REDEMPTION:
            y["withdrawn"] += t["amount"]
        if t.get("rate") is not None:
            y["rate"] = t["rate"]
    rows = sorted(years.values(), key=lambda y: y["fy"])
    closing = 0.0
    for y in rows:
        closing += y["deposit"] + y["interest"] - y["withdrawn"]
        y["closing"] = round(closing, 2)
        for k in ("deposit", "interest", "withdrawn"):
            y[k] = round(y[k], 2)
    with_deposits = [y["fy"] for y in rows if y["deposit"]]
    with_interest = [y["fy"] for y in rows if y["interest"]]
    pending = None
    if with_deposits:
        last_dep = max(with_deposits)
        if not with_interest or max(with_interest) < last_dep:
            pending = last_dep
    return rows, pending


def _ppf_maturity(fund: dict, all_txns: list[dict], today: dt.date) -> dict:
    """A PPF account matures 15 financial years after the year it was opened (opened in FY 2015-16 -> 1 April
    2031); after that it is treated as extended in five-year blocks. The opening date comes from the account's
    details or, failing that, its first entry."""
    d = fund.get("details") or {}
    opened = d.get("opened") or (min(t["date"] for t in all_txns) if all_txns else None)
    if not opened:
        return {"opened_on": None, "opened_fy": None, "matures_on": None, "extended_till": None}
    fy_start = int(fy_of(opened)[:4])
    matures = dt.date(fy_start + 16, 4, 1)
    extended = None
    if matures <= today:
        extended = matures
        while extended <= today:
            extended = extended.replace(year=extended.year + 5)
    return {"opened_on": opened, "opened_fy": fy_of(opened), "matures_on": matures.isoformat(),
            "extended_till": extended.isoformat() if extended else None}


def _ppf_payload(fund: dict, all_txns: list[dict], txns: list[dict], today: dt.date, detail: bool,
                 folio: Optional[str]) -> dict:
    """PPF: one share valued at one rupee per unit, so `summarize` gives the balance, deposits, interest (bonus
    units) and XIRR without any interest arithmetic."""
    one = (today.isoformat(), 1.0)
    with_interest = lambda s: {**s, "interest": round(s["bonus_units"], 2)}  # noqa: E731
    full = with_interest(calc.summarize(all_txns, one, today))
    fund["summary"] = full if folio is None else with_interest(calc.summarize(txns, one, today))
    fund["closed"], fund["closed_on"] = full["closed"], full["closed_on"]
    years, pending = _ppf_years(all_txns, today)
    fund["ppf"] = {"years": years, "pending_interest_fy": pending, "current_fy": fy_of(today.isoformat()),
                   **_ppf_maturity(fund, all_txns, today)}
    if detail:
        fund["transactions"] = txns
        if folio is not None:
            fund["all_transactions"] = all_txns
        dates = sorted({t["date"] for t in txns} | {today.isoformat()})
        fund["history"] = calc.value_history(txns, [(d, 1.0) for d in dates])
        fund["folios"] = [
            {"folio": k or NO_FOLIO, "label": k or "No account number",
             "summary": with_interest(calc.summarize([t for t in all_txns if t["folio_number"] == k], one, today))}
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
    if detail:  # each sale carries its own realised gain, for statements and the income section of a report
        gains = calc.sale_gains(all_txns)
        for t in all_txns:
            t["gain"] = gains.get(t["id"])
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
    if fund["kind"] == PPF:
        return _ppf_payload(fund, all_txns, txns, today, detail, folio)

    history, latest = _price_source(conn, fund, detail)
    fx = _fx(conn, fund["currency"])
    fund["summary"] = calc.summarize(txns, latest, today)
    full = fund["summary"] if folio is None else calc.summarize(all_txns, latest, today)
    fund["closed"] = full["closed"]  # sold out entirely (judged on every transaction, not the folio in view)
    fund["closed_on"] = full["closed_on"]
    fund["scheme"] = nav.scheme_meta(conn, fund["scheme_code"]) if fund["kind"] == MF else None
    fund["quote"] = quotes.meta(conn, fund["symbol"]) if fund["kind"] == STOCK else None
    if fund["kind"] in (MF, STOCK):
        fund["sips"] = sip.status((fund["details"] or {}).get("sips") or [], all_txns, today)
    if fund["kind"] == FD:
        fund["fd"] = fd.info(fd.terms(fund["details"], all_txns), today, full["current_value"], full["units"])
    if fund["kind"] == INS:
        t = policy.terms(fund["details"], all_txns)
        fund["policy"] = policy.info(t, policy.rate(t, today), today, full["current_value"], full["units"])
    if fund["kind"] == GOLD:
        d = fund["details"] or {}
        issue = d.get("issue_date") or min((t["date"] for t in all_txns if t["type"] in calc.PURCHASES), default=None)
        ib = sgb.ibja(conn)
        fund["gold"] = {
            **gold.schedule(issue, full["units"] or 0.0, d.get("issue_price"), today),
            "issue_date_assumed": not d.get("issue_date"),
            "interest_received": full["dividends"],
            "interest_payments": sum(1 for t in all_txns if t["type"] == calc.DIVIDEND),
            "price_date": latest[0] if latest else None,
            "price": latest[1] if latest else None,
            "price_source": "sgb" if (d.get("code") and sgb.latest(conn, d["code"])) else ("manual" if latest else None),
            "ibja_price": ib[1] if ib else None,
            "ibja_date": ib[0] if ib else None,
            "exchange_name": (sgb.meta(conn, d["code"]) or {}).get("name") if d.get("code") else None,
            "price_feed": "nse" if (sgb.meta(conn, d["code"]) or {}).get("exchange") == sgb.FEED_NSE else "page" if d.get("code") and sgb.latest(conn, d["code"]) else None,
        }
        # The price paid or received on a transaction day is a gold price for that day too: it gives the chart
        # points before the first entered price (the entered prices still decide today's value).
        known = {d for d, _ in history}
        implied = {(t["date"], float(t["nav"])) for t in all_txns
                   if t["nav"] and t["nav"] > 0 and (t["type"] in calc.PURCHASES or t["type"] == calc.REDEMPTION) and t["date"] not in known}
        history = sorted(history + list(implied))
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

# ---------------------------------------------------------------- CAS import (CAMS / KFintech statement PDFs)
class CasIn(BaseModel):
    pdf_base64: str = Field(description="The statement PDF, base64")
    password: str = Field(default="", max_length=200, description="The PDF password (usually the PAN)")


def _cas_match(conn: sqlite3.Connection, scheme: dict, folio: str, listing: dict | None, funds: list) -> dict:
    """Which holding a CAS scheme belongs to: by AMFI code (through the ISIN), else by folio + similar name; and the
    mfapi.in schemes it could be, for the user to confirm when nothing matched."""
    code = None
    code_name = None
    isin = (scheme.get("isin") or "").upper()
    if listing and isin and isin in listing["by_isin"]:
        code, code_name = listing["by_isin"][isin]
    match = None
    by = None
    if code:
        match = next((f for f in funds if f["kind"] == MF and f["scheme_code"] == code), None)
        by = "code" if match else None
    if match is None:
        words = cas._words(scheme["name"])
        for f in funds:
            if f["kind"] != MF:
                continue
            same_folio = folio and f["folio_number"] and folio.replace(" ", "") == str(f["folio_number"]).replace(" ", "")
            have = cas._words(f["name"]) | cas._words((f.get("scheme") or {}).get("scheme_name") or "")
            if same_folio and words and len(words & have) >= max(1, len(words) // 2):
                match, by = f, "folio"
                break
    candidates = cas.suggest_codes(scheme["name"], listing) if listing and not code else []
    return {"fund_id": match["id"] if match else None, "fund_name": match["name"] if match else None, "by": by,
            "scheme_code": code, "scheme_code_name": code_name, "candidates": candidates}


def _cas_txn(t: dict) -> dict | None:
    """A CAS line as the app's transaction, or None for the lines that are not transactions (taxes, reversals…)."""
    kind = t["type"]
    if kind in ("TAX", "OTHER", "SEGREGATION", "REVERSAL"):
        return None
    amount = abs(t["amount"] or 0.0)
    units = abs(t["units"] or 0.0)
    navv = t["nav"] or (round(amount / units, 4) if units and amount else None)
    if kind == "DIVIDEND":
        return {"type": "DIVIDEND", "date": t["date"], "amount": round(amount, 2), "units": 0.0, "nav": navv, "notes": t["description"]}
    if kind in ("SIP", "LUMPSUM", "SWITCH_IN"):
        if not units:
            return None
        return {"type": "LUMPSUM" if kind == "SWITCH_IN" else kind, "date": t["date"], "amount": round(amount, 2), "units": round(units, 4), "nav": navv,
                "notes": t["description"] if kind == "SWITCH_IN" else ""}
    if kind in ("REDEMPTION", "SWITCH_OUT"):
        if not units:
            return None
        return {"type": "REDEMPTION", "date": t["date"], "amount": round(amount, 2), "units": round(units, 4), "nav": navv,
                "notes": t["description"] if kind == "SWITCH_OUT" else ""}
    return None


@app.post("/api/import/cas")
def import_cas(body: CasIn, conn: sqlite3.Connection = Depends(get_conn)):
    """Read a CAMS / KFintech detailed CAS PDF. Nothing is written: the answer is the statement, scheme by scheme, with
    each transaction in the app's terms, which holding it matched (or the schemes it could be), and which entries the
    holding already has. The page imports from it with the usual routes."""
    try:
        data = base64.b64decode(body.pdf_base64, validate=False)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail="The file could not be decoded") from e
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="The PDF is larger than 25 MB")
    try:
        statement = cas.read_pdf(data, body.password)
    except cas.CasError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    listing = None
    listing_error = None
    try:
        listing = cas.scheme_list()
    except Exception as e:  # noqa: BLE001 - offline: schemes are matched by folio and name only
        listing_error = str(e)
    funds = [_fund_dict(r) for r in conn.execute("SELECT * FROM funds").fetchall()]
    for f in funds:
        f["scheme"] = nav.scheme_meta(conn, f["scheme_code"]) if f["kind"] == MF and f["scheme_code"] else None
    existing_by_fund: dict[int, list[dict]] = {}
    out_folios = []
    for folio in statement["folios"]:
        schemes = []
        for sc in folio["schemes"]:
            match = _cas_match(conn, sc, folio["folio"], listing, funds)
            txns = []
            skipped = []
            if match["fund_id"] and match["fund_id"] not in existing_by_fund:
                existing_by_fund[match["fund_id"]] = _txns(conn, match["fund_id"])
            have = existing_by_fund.get(match["fund_id"], []) if match["fund_id"] else []
            for t in sc["transactions"]:
                row = _cas_txn(t)
                if row is None:
                    skipped.append({"date": t["date"], "description": t["description"], "amount": t["amount"], "why": t["type"].lower()})
                    continue
                dup = next((h for h in have if h["date"] == row["date"] and abs(h["amount"] - row["amount"]) < 0.01
                            and (row["units"] == 0 or abs(h["units"] - row["units"]) < 0.001)), None)
                row["existing_id"] = dup["id"] if dup else None
                # an instalment recorded from a SIP schedule is replaced by the statement's exact figures
                sched = sip.scheduled_match(have, row["date"], row["amount"]) if not dup and row["type"] in ("SIP", "LUMPSUM") else None
                row["replace_id"] = sched["id"] if sched else None
                txns.append(row)
            schemes.append({**{k: v for k, v in sc.items() if k != "transactions"}, "match": match, "transactions": txns, "skipped": skipped})
        out_folios.append({"folio": folio["folio"], "amc": folio["amc"], "schemes": schemes})
    return {"source": statement["source"], "period": statement["period"], "folios": out_folios, "scheme_list_error": listing_error}


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

class GoldPriceIn(BaseModel):
    """The gold price per gram (INR) on a date; it values every gold holding."""

    date: str
    price: float = Field(gt=0, le=10_000_000)

    @field_validator("date")
    @classmethod
    def _v_date(cls, v):
        d = _iso_date_or_none(v)
        if d is None:
            raise ValueError("date is required")
        return d


@app.get("/api/sgb/issues")
def sgb_issues(q: Optional[str] = Query(default=None, max_length=60)):
    """Every Sovereign Gold Bond series known (NSE symbol, name, issue date and price, latest traded price from NSE,
    interest dates, maturity), live ones first."""
    try:
        rows = sgb.list_issues()
    except sgb.SgbSourceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    if q:
        needle = q.strip().upper()
        rows = [r for r in rows if needle in r["symbol"] or needle in r["name"].upper()]
    return rows


@app.get("/api/gold/price")
def gold_price(on: Optional[str] = None, conn: sqlite3.Connection = Depends(get_conn)):
    """The latest gold price per gram (or the one on / just before a date) and the recent entries."""
    try:
        on = _iso_date_or_none(on)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    hit = gold.on_or_before(conn, on) if on else gold.latest(conn)
    if on and hit is None:
        raise HTTPException(status_code=404, detail="No gold price entered on or before that date")
    hist = gold.history(conn)
    return {
        "date": hit[0] if hit else None,
        "price": hit[1] if hit else None,
        "currency": MF_CURRENCY,
        "history": [{"date": d, "price": p} for d, p in hist[-120:]],
    }


@app.post("/api/gold/price", status_code=201)
def gold_price_set(body: GoldPriceIn, conn: sqlite3.Connection = Depends(get_conn)):
    gold.set_price(conn, body.date, body.price)
    return {"date": body.date, "price": body.price}


@app.delete("/api/gold/price/{iso_date}", status_code=204)
def gold_price_delete(iso_date: str, conn: sqlite3.Connection = Depends(get_conn)):
    try:
        iso_date = _iso_date_or_none(iso_date)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if not iso_date or not gold.delete_price(conn, iso_date):
        raise HTTPException(status_code=404, detail="No gold price on that date")
    return None


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


def _fd_payout(conn: sqlite3.Connection, fund_id: int, body: TxnIn, exclude_id: Optional[int] = None) -> None:
    """An FD or policy payout (maturity, premature closure, surrender) takes every unit still held at the amount received."""
    if body.type != calc.REDEMPTION or body.units:
        return
    held = calc.summarize([t for t in _txns(conn, fund_id) if t["id"] != exclude_id], None, dt.date.today())["units"] or 0.0
    if held <= 0:
        raise HTTPException(status_code=422, detail="There is no deposit left to pay out")
    if not body.amount or body.amount <= 0:
        raise HTTPException(status_code=422, detail="Enter the amount received")
    body.units = round(held, 2)
    body.nav = body.amount / held


def _txn_values(body: TxnIn, scheme: str, kind: str = MF) -> tuple:
    amount = body.amount
    if kind in RUPEE_KINDS or (kind in TERM_KINDS and body.type in calc.PURCHASES):
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
    if row["kind"] in TERM_KINDS:
        _fd_payout(conn, fund_id, body)
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
    transactions: list[BulkTxnItem] = Field(**list_limits(1, 5000))


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
    fd_held = None
    for i, t in enumerate(body.transactions):
        scheme = _check_scheme(row, t.scheme)
        nav_value, units, amount = t.nav, t.units, t.amount
        if row["kind"] in TERM_KINDS and t.type == calc.REDEMPTION and not units:
            if fd_held is None:
                fd_held = calc.summarize(_txns(conn, fund_id), None, dt.date.today())["units"] or 0.0  # already recorded
            held = fd_held + sum(v[7] for v in values if v[4] in calc.PURCHASES) - sum(v[7] for v in values if v[4] == calc.REDEMPTION)
            if held <= 0 or not amount:
                problems.append(f"row {i + 1}: nothing left to pay out, or no amount")
                continue
            nav_value, units = amount / held, round(held, 2)
        if row["kind"] in RUPEE_KINDS or (row["kind"] in TERM_KINDS and t.type in calc.PURCHASES):
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
    if fund_row["kind"] in TERM_KINDS:
        _fd_payout(conn, existing["fund_id"], body, exclude_id=txn_id)
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

@app.get("/api/tax")
def tax_report(fy: Optional[str] = None, slab: float = tax.SLAB_DEFAULT, conn: sqlite3.Connection = Depends(get_conn)):
    """Capital gains, other income, deductions and the estimated tax of one financial year (default: the current
    one), from every entry in the vault; `slab` is the user's marginal rate for the items taxed at the slab rate."""
    today = dt.date.today()
    fy = fy or tax.fy_of(today.isoformat())
    try:
        tax.fy_start_year(fy)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if not 0 <= slab <= 60:
        raise HTTPException(status_code=422, detail="the slab rate must be between 0 and 60 per cent")
    rows = conn.execute("SELECT * FROM funds ORDER BY name COLLATE NOCASE").fetchall()
    holdings = []
    for r in rows:
        fund = _fund_dict(r)
        txns = _txns(conn, fund["id"])
        latest = None
        unconverted = False
        if fund["kind"] in (MF, STOCK, GOLD):
            _, latest = _price_source(conn, fund, False)
        if fund["currency"] != BASE:
            fx = _fx(conn, fund["currency"])
            if fx:
                txns = calc.convert_txns(txns, fx)
                latest = calc.convert_latest(latest, fx)
            else:
                unconverted = True
        category = (nav.scheme_meta(conn, fund["scheme_code"]) or {}).get("scheme_category") if fund["kind"] == MF and fund["scheme_code"] else None
        fmv = None
        if fund["kind"] in (MF, STOCK) and any(t["type"] in calc.PURCHASES and t["date"] < tax.GRANDFATHER_UNTIL for t in txns):
            p = _price_on_or_before(conn, r, tax.GRANDFATHER_DAY)
            fmv = p[1] if p else None
        exit_from = None
        if fund["kind"] == GOLD:
            d = fund["details"] or {}
            issue = d.get("issue_date") or min((t["date"] for t in txns if t["type"] in calc.PURCHASES), default=None)
            exit_from = gold.schedule(issue, 0.0, None, today)["exit_from"]
        holdings.append({"fund": fund, "txns": txns, "category": category, "latest": latest, "fmv2018": fmv, "exit_from": exit_from, "unconverted": unconverted})
    return tax.report(holdings, fy, slab, today)


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
            fund_flows = calc.cashflows(txns)  # investor cashflows only: NPS switches stay inside the account
            flows.extend(fund_flows)
        elif f["base"]:
            summary = f["base"]["summary"]
            histories.append(history_base)
            fund_flows = flows_base
            flows.extend(fund_flows)
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
        rollup.append({"summary": summary, "locked": f["locked"], "kind": f["kind"], "closed": f["closed"], "flows": fund_flows})
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
    """Force-refresh every NAV history, stock price history, exchange rate, NPS scheme and gold bond series in use."""
    rows = conn.execute("SELECT * FROM funds").fetchall()
    codes, symbols, nps_ids, sgb_codes = _sources(rows)
    requested = len(set(codes)) + len(set(symbols)) + len(set(nps_ids)) + len(set(sgb_codes))
    errors = _auto_refresh(conn, rows, force=True)
    return {"requested": requested, "failed": errors}


# ----------------------------------------------------------------- static frontend (must be last)

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
