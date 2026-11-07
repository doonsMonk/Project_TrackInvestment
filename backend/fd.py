"""Fixed deposits: the value of a deposit between its start and its maturity.

An FD is one holding: the deposit is the principal (rupees as units at a factor of 1), the bank's maturity advice
gives the maturity date and value, and in between the deposit is valued along a constant-rate growth curve from
the principal to the maturity value (the factor is the value per rupee deposited). The effective annual rate is
implied by those two figures. Interest paid out on a non-cumulative FD is recorded as cash received, and the
maturity payout (or a premature closure) as a sale of all the units at the amount received.
"""
from __future__ import annotations

from datetime import date, timedelta

from . import calc


def terms(details: dict | None, txns: list[dict]) -> dict:
    """Principal and deposit date from the entries, maturity date / value and the quoted rate from the details."""
    d = details or {}
    deposits = [t for t in txns if t["type"] in calc.PURCHASES]
    principal = round(sum(t["amount"] for t in deposits), 2)
    deposit_date = min((t["date"] for t in deposits), default=None)
    maturity_value = d.get("maturity_value")
    try:
        maturity_value = float(maturity_value) if maturity_value not in (None, "") else None
    except (TypeError, ValueError):
        maturity_value = None
    return {
        "principal": principal,
        "deposit_date": deposit_date,
        "maturity_date": d.get("maturity_date") or None,
        "maturity_value": maturity_value if maturity_value and maturity_value > 0 else None,
        "quoted_rate": d.get("rate"),
        "payout": d.get("payout") or "cumulative",
    }


def _ratio(t: dict) -> float | None:
    """Maturity value per rupee deposited, when both ends are known."""
    if t["principal"] > 0 and t["maturity_value"] and t["deposit_date"] and t["maturity_date"] and t["maturity_date"] > t["deposit_date"]:
        return t["maturity_value"] / t["principal"]
    return None


def factor(t: dict, iso_date: str) -> float:
    """Value per rupee deposited on `iso_date`: 1 at the start, the maturity ratio at maturity and after, and a
    constant-rate curve in between."""
    ratio = _ratio(t)
    if ratio is None or iso_date <= t["deposit_date"]:
        return 1.0
    if iso_date >= t["maturity_date"]:
        return ratio
    d0, d1, d = date.fromisoformat(t["deposit_date"]), date.fromisoformat(t["maturity_date"]), date.fromisoformat(iso_date)
    return ratio ** ((d - d0).days / (d1 - d0).days)


def series(t: dict, today: date) -> list[tuple[str, float]]:
    """One point per day from the deposit to today (flat after maturity), for the value chart."""
    if not t["deposit_date"]:
        return []
    start = date.fromisoformat(t["deposit_date"])
    end = max(today, start)
    out = []
    d = start
    step = timedelta(days=1)
    while d <= end:
        out.append((d.isoformat(), factor(t, d.isoformat())))
        d += step
    return out


def info(t: dict, today: date, current_value: float | None, units: float | None) -> dict:
    """What the FD page shows: effective rate, interest, days, status."""
    ratio = _ratio(t)
    eff = None
    days_total = days_left = days_elapsed = None
    if ratio is not None:
        d0, d1 = date.fromisoformat(t["deposit_date"]), date.fromisoformat(t["maturity_date"])
        days_total = (d1 - d0).days
        days_elapsed = max(0, min(days_total, (today - d0).days))
        days_left = max(0, (d1 - today).days)
        eff = ratio ** (365.25 / days_total) - 1
    matured = bool(t["maturity_date"] and today.isoformat() >= t["maturity_date"])
    open_units = (units or 0) > 0
    return {
        **t,
        "effective_rate": eff,
        "interest_at_maturity": round(t["maturity_value"] - t["principal"], 2) if ratio is not None else None,
        "accrued": round((current_value or 0) - t["principal"], 2) if open_units and t["principal"] else None,
        "days_total": days_total,
        "days_elapsed": days_elapsed,
        "days_left": days_left,
        "matured": matured,
        "awaiting_payout": matured and open_units,
        "has_terms": ratio is not None,
    }
