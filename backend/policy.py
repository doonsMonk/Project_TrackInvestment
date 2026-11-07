"""Life insurance policies (an LIC endowment or money-back plan, for example): premiums on a schedule and a maturity
value known in advance.

A policy is one holding. Each premium paid is rupees as units at a factor of 1; the policy's terms give the premium,
how often it falls due, when the premiums start and stop, and the maturity date and value. The policy's own rate of
return is the internal rate of return of the whole plan: every premium (the ones paid, as recorded, and the ones still
due, from the schedule), any survival benefit already received, and the maturity value. Between premiums the policy
is worth what the premiums paid so far have accrued to at that rate, so the value per rupee paid is that accrued
value divided by the rupees paid, and the holding's own XIRR comes out as the policy's rate. The maturity payout (or a
surrender) is a sale of all the units at the amount received.
"""
from __future__ import annotations

from datetime import date, timedelta

from . import calc, gold

FREQUENCIES = {"yearly": 12, "half-yearly": 6, "quarterly": 3, "monthly": 1}
DAY = 365.0  # calc.xirr's year, so the holding's XIRR matches the policy rate exactly


def _num(v) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def terms(details: dict | None, txns: list[dict]) -> dict:
    """The plan from the details, the premiums paid and the benefits received from the entries."""
    d = details or {}
    paid = sorted((t for t in txns if t["type"] in calc.PURCHASES), key=lambda t: (t["date"], t["id"] if "id" in t else 0))
    benefits = sorted((t for t in txns if t["type"] == calc.DIVIDEND), key=lambda t: t["date"])
    premium = _num(d.get("premium"))
    if not premium and paid:
        amounts = [round(t["amount"], 2) for t in paid]
        premium = max(set(amounts), key=amounts.count)  # the usual premium: the most common amount paid
    mv = _num(d.get("maturity_value"))
    sa = _num(d.get("sum_assured"))
    return {
        "insurer": d.get("insurer") or "",
        "plan": d.get("plan") or "",
        "premium": premium if premium and premium > 0 else None,
        "frequency": d.get("frequency") if d.get("frequency") in FREQUENCIES else "yearly",
        "first_premium": d.get("first_premium") or (paid[0]["date"] if paid else None),
        "last_premium": d.get("last_premium") or None,
        "maturity_date": d.get("maturity_date") or None,
        "maturity_value": mv if mv and mv > 0 else None,
        "sum_assured": sa if sa and sa > 0 else None,
        "paid": [(t["date"], float(t["amount"])) for t in paid],
        "benefits": [(t["date"], float(t["amount"])) for t in benefits],
    }


def due_dates(t: dict) -> list[str]:
    """Every premium due date: from the first premium, every period, up to the last premium date or, without one,
    the last due date on or before maturity."""
    if not t["first_premium"] or not t["premium"]:
        return []
    end = t["last_premium"] or t["maturity_date"]
    if not end:
        return []
    start = date.fromisoformat(t["first_premium"])
    months = FREQUENCIES[t["frequency"]]
    out = []
    n = 0
    while n < 2400:
        d = gold.add_months(start, n * months).isoformat()
        if d > end:
            break
        out.append(d)
        n += 1
    return out


def pending(t: dict, today: date) -> list[str]:
    """Due dates not covered by a premium paid: the ones still to come, and any that fell due without being recorded."""
    return due_dates(t)[len(t["paid"]):]


def rate(t: dict, today: date) -> float | None:
    """The policy's own annual rate of return over all its premiums, benefits received and the maturity value."""
    if not t["maturity_value"] or not t["maturity_date"]:
        return None
    flows = [(date.fromisoformat(d), -a) for d, a in t["paid"]]
    flows += [(date.fromisoformat(d), -t["premium"]) for d in pending(t, today)]
    flows += [(date.fromisoformat(d), a) for d, a in t["benefits"]]
    flows.append((date.fromisoformat(t["maturity_date"]), t["maturity_value"]))
    if not any(a < 0 for _, a in flows):
        return None
    return calc.xirr(flows)


def value(t: dict, r: float | None, iso_date: str) -> tuple[float, float]:
    """(rupees paid, accrued value) on a date: each premium paid by then grown at the policy rate from its date,
    less each benefit received grown the same way; flat from the maturity date on."""
    paid = [(d, a) for d, a in t["paid"] if d <= iso_date]
    units = sum(a for _, a in paid)
    benefits = [(d, a) for d, a in t["benefits"] if d <= iso_date]
    if t["maturity_date"] and iso_date > t["maturity_date"]:
        iso_date = t["maturity_date"]
    if r is None:
        return units, max(units - sum(a for _, a in benefits), 0.0)
    at = date.fromisoformat(iso_date)
    g = 1.0 + r
    grow = lambda d, a: a * g ** ((at - date.fromisoformat(d)).days / DAY)  # noqa: E731
    v = sum(grow(d, a) for d, a in paid) - sum(grow(d, a) for d, a in benefits)
    return units, max(v, 0.0)


def factor(t: dict, r: float | None, iso_date: str) -> float:
    """Value per rupee paid on that date (1 before the first premium)."""
    units, v = value(t, r, iso_date)
    return v / units if units > 0 else 1.0


def series(t: dict, r: float | None, today: date) -> list[tuple[str, float]]:
    """One point per day from the first premium to today, for the value chart."""
    if not t["paid"]:
        return []
    d = date.fromisoformat(t["paid"][0][0])
    end = max(today, d)
    out = []
    step = timedelta(days=1)
    while d <= end:
        out.append((d.isoformat(), factor(t, r, d.isoformat())))
        d += step
    return out


def info(t: dict, r: float | None, today: date, current_value: float | None, units: float | None) -> dict:
    """What the policy page shows: the schedule, what is paid and what is still due, the policy rate, status."""
    dues = due_dates(t)
    todo = pending(t, today)
    iso = today.isoformat()
    paid_total = round(sum(a for _, a in t["paid"]), 2)
    pending_total = round(len(todo) * (t["premium"] or 0.0), 2)
    matured = bool(t["maturity_date"] and iso >= t["maturity_date"])
    open_units = (units or 0) > 0
    has_terms = bool(t["maturity_value"] and t["maturity_date"])
    return {
        **{k: v for k, v in t.items() if k not in ("paid", "benefits")},
        "last_premium": t["last_premium"] or (dues[-1] if dues else None),
        "premiums_paid": len(t["paid"]),
        "paid_total": paid_total,
        "premiums_total": len(dues) if dues else None,
        "premiums_left": len(todo) if dues else None,
        "pending_total": pending_total if dues else None,
        "total_outlay": round(paid_total + pending_total, 2) if dues else None,
        "next_due": todo[0] if todo else None,
        "overdue": sum(1 for d in todo if d <= iso),
        "benefits_received": round(sum(a for _, a in t["benefits"]), 2),
        "policy_rate": r,
        "maturity_gain": round(t["maturity_value"] - paid_total - pending_total, 2) if has_terms and dues else None,
        "accrued": round((current_value or 0) - paid_total, 2) if open_units and paid_total else None,
        "days_left": max(0, (date.fromisoformat(t["maturity_date"]) - today).days) if t["maturity_date"] else None,
        "matured": matured,
        "awaiting_payout": matured and open_units,
        "has_terms": has_terms,
    }
