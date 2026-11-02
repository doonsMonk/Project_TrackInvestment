"""Pure portfolio math: XIRR, per-fund summaries, value-over-time series."""
from __future__ import annotations

from datetime import date


def xirr(cashflows: list[tuple[date, float]]) -> float | None:
    """Annualised internal rate of return for dated cashflows.

    Investments are negative, redemptions / current value positive.
    Returns a fraction (0.12 = 12 %) or None when undefined.
    """
    flows = [(d, a) for d, a in cashflows if a]
    if len(flows) < 2:
        return None
    if not (any(a < 0 for _, a in flows) and any(a > 0 for _, a in flows)):
        return None
    t0 = min(d for d, _ in flows)
    pts = [((d - t0).days / 365.0, a) for d, a in flows]
    if all(t == 0 for t, _ in pts):
        return None
    scale = sum(abs(a) for _, a in pts)

    def npv(r: float) -> float:
        return sum(a / (1.0 + r) ** t for t, a in pts)

    def dnpv(r: float) -> float:
        return sum(-t * a / (1.0 + r) ** (t + 1.0) for t, a in pts)

    # Newton-Raphson from a sensible starting guess
    r = 0.1
    for _ in range(100):
        f = npv(r)
        df = dnpv(r)
        if abs(df) < 1e-14:
            break
        nr = r - f / df
        if nr <= -0.9999:
            nr = (r - 0.9999) / 2.0
        if abs(nr - r) < 1e-10:
            r = nr
            break
        r = nr
    if r > -0.9999 and abs(npv(r)) <= 1e-7 * scale:
        return r

    # Bisection fallback: robust when Newton overshoots
    lo, hi = -0.9999, 10.0
    flo, fhi = npv(lo), npv(hi)
    if flo * fhi > 0:
        return None
    for _ in range(300):
        mid = (lo + hi) / 2.0
        fm = npv(mid)
        if abs(fm) <= 1e-9 * scale:
            return mid
        if flo * fm < 0:
            hi, fhi = mid, fm
        else:
            lo, flo = mid, fm
    return (lo + hi) / 2.0


def summarize(txns: list[dict], latest: tuple[str, float] | None, today: date) -> dict:
    """Totals for one fund given its transactions and the latest cached NAV."""
    invested = sum(t["amount"] for t in txns)
    units = sum(t["units"] for t in txns)
    nav_date, nav = latest if latest else (None, None)
    current = units * nav if nav is not None else 0.0
    profit = current - invested
    flows = [(date.fromisoformat(t["date"]), -t["amount"]) for t in txns]
    if current > 0:
        flows.append((today, current))
    return {
        "invested": round(invested, 2),
        "units": round(units, 4),
        "latest_nav": nav,
        "latest_nav_date": nav_date,
        "current_value": round(current, 2),
        "profit": round(profit, 2),
        "abs_return_pct": (profit / invested * 100.0) if invested else None,
        "xirr": xirr(flows) if txns else None,
        "txn_count": len(txns),
        "first_txn_date": min((t["date"] for t in txns), default=None),
    }


def value_history(txns: list[dict], history: list[tuple[str, float]]) -> list[dict]:
    """Daily [{date, value, invested}] from the first transaction, using NAV history (ascending)."""
    if not txns or not history:
        return []
    tx = sorted(txns, key=lambda t: t["date"])
    first = tx[0]["date"]
    out: list[dict] = []
    i = 0
    units = 0.0
    invested = 0.0
    for d, nav in history:
        if d < first:
            continue
        while i < len(tx) and tx[i]["date"] <= d:
            units += tx[i]["units"]
            invested += tx[i]["amount"]
            i += 1
        out.append({"date": d, "value": round(units * nav, 2), "invested": round(invested, 2)})
    return out


def combine_histories(histories: list[list[dict]]) -> list[dict]:
    """Sum several fund histories day by day, forward-filling each fund across its missing dates."""
    dates = sorted({p["date"] for h in histories for p in h})
    if not dates:
        return []
    ptrs = [0] * len(histories)
    last: list[dict | None] = [None] * len(histories)
    out: list[dict] = []
    for d in dates:
        value = 0.0
        invested = 0.0
        for k, h in enumerate(histories):
            while ptrs[k] < len(h) and h[ptrs[k]]["date"] <= d:
                last[k] = h[ptrs[k]]
                ptrs[k] += 1
            if last[k] is not None:
                value += last[k]["value"]
                invested += last[k]["invested"]
        out.append({"date": d, "value": round(value, 2), "invested": round(invested, 2)})
    return out


def portfolio_totals(funds: list[dict], flows: list[tuple[date, float]], today: date) -> dict:
    """Roll up per-fund summaries plus the combined cashflow XIRR and locked / redeemable split."""
    invested = sum(f["summary"]["invested"] for f in funds)
    current = sum(f["summary"]["current_value"] for f in funds)
    locked_value = sum(f["summary"]["current_value"] for f in funds if f["locked"])
    locked_invested = sum(f["summary"]["invested"] for f in funds if f["locked"])
    profit = current - invested
    all_flows = list(flows)
    if current > 0:
        all_flows.append((today, current))
    return {
        "invested": round(invested, 2),
        "current_value": round(current, 2),
        "profit": round(profit, 2),
        "abs_return_pct": (profit / invested * 100.0) if invested else None,
        "xirr": xirr(all_flows) if flows else None,
        "locked_value": round(locked_value, 2),
        "unlocked_value": round(current - locked_value, 2),
        "locked_invested": round(locked_invested, 2),
        "unlocked_invested": round(invested - locked_invested, 2),
        "fund_count": len(funds),
        "locked_count": sum(1 for f in funds if f["locked"]),
    }
