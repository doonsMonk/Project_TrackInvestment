"""Pure portfolio math: XIRR, per-holding summaries, value-over-time series, currency conversion.

Transaction types:
  SIP, LUMPSUM  purchases: money out, units in
  REDEMPTION    sale: money in, units out (consumes purchase lots first-in-first-out, which is how Indian
                capital-gains rules match units)
  DIVIDEND      cash received, holdings unchanged (an IDCW payout for a mutual fund)
  BONUS         free units / shares at zero cost (bonus issue, split, gift); the lot has cost 0, so the
                whole proceeds are gain when it is sold
  SWITCH_OUT    units sold whose proceeds stay inside the holding (an NPS rebalance out of one scheme);
  SWITCH_IN     units bought with money that came from inside the holding (the other leg). Neither is cash
                to or from the investor, so neither is an investor cashflow, but within one scheme they are
                money leaving / entering that scheme.
  CHARGE        units deducted for fees (NPS maintenance charges): a sale whose proceeds are lost.
Amounts and units are stored as non-negative magnitudes; the type gives the direction. So:
  invested      = cost of the units still held (remaining lots)
  realised_gain = proceeds of sales / switches / charges - cost of the units they consumed
  dividends     = cash received as dividends
  charges       = value deducted as charges
  profit        = current value - invested  (unrealised, on current holdings)
  total_gain    = profit + realised_gain + dividends - charges  (= value + money back - money in)
"""
from __future__ import annotations

from bisect import bisect_right
from datetime import date

REDEMPTION = "REDEMPTION"
DIVIDEND = "DIVIDEND"
BONUS = "BONUS"
SWITCH_IN = "SWITCH_IN"
SWITCH_OUT = "SWITCH_OUT"
CHARGE = "CHARGE"
PURCHASES = ("SIP", "LUMPSUM")
SELLS = (REDEMPTION, SWITCH_OUT, CHARGE)  # consume lots FIFO
ALL_TYPES = PURCHASES + (REDEMPTION, DIVIDEND, BONUS, SWITCH_IN, SWITCH_OUT, CHARGE)


class RateSeries:
    """Exchange rates by date, ascending [(iso_date, rate)]. `on(date)` carries the last known rate
    forward over weekends and holidays; dates before the first rate get the first rate."""

    def __init__(self, rows: list[tuple[str, float]]) -> None:
        self.dates = [d for d, _ in rows]
        self.rates = [r for _, r in rows]

    def __bool__(self) -> bool:
        return bool(self.dates)

    def on(self, iso_date: str) -> float:
        i = bisect_right(self.dates, iso_date) - 1
        return self.rates[max(i, 0)]

    @property
    def latest(self) -> tuple[str | None, float | None]:
        return (self.dates[-1], self.rates[-1]) if self.dates else (None, None)


def convert_txns(txns: list[dict], fx: RateSeries) -> list[dict]:
    """Transactions re-expressed in the base currency at the rate of their own date."""
    return [{**t, "amount": t["amount"] * fx.on(t["date"]), "nav": t["nav"] * fx.on(t["date"])} for t in txns]


def convert_history(history: list[tuple[str, float]], fx: RateSeries) -> list[tuple[str, float]]:
    return [(d, p * fx.on(d)) for d, p in history]


def convert_latest(latest: tuple[str, float] | None, fx: RateSeries) -> tuple[str, float] | None:
    """Latest price in the base currency at today's (latest) rate."""
    return (latest[0], latest[1] * fx.latest[1]) if latest else None


def xirr(cashflows: list[tuple[date, float]]) -> float | None:
    """Annualised internal rate of return for dated cashflows.

    Money out (purchases) negative, money in (redemptions, dividends, current value) positive.
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


class Lots:
    """FIFO purchase lots: [units_remaining, cost_per_unit]."""

    def __init__(self) -> None:
        self.lots: list[list[float]] = []
        self.oversold = 0.0  # units sold beyond what was held (data problem, surfaced to the UI)

    def buy(self, units: float, amount: float) -> None:
        if units > 0:
            self.lots.append([units, amount / units])

    def sell(self, units: float) -> float:
        """Consume `units` oldest-first; returns the cost basis of what was consumed."""
        cost = 0.0
        remaining = units
        while remaining > 1e-9 and self.lots:
            lot = self.lots[0]
            take = min(lot[0], remaining)
            cost += take * lot[1]
            lot[0] -= take
            remaining -= take
            if lot[0] <= 1e-9:
                self.lots.pop(0)
        if remaining > 1e-9:
            self.oversold += remaining
        return cost

    @property
    def units(self) -> float:
        return sum(l[0] for l in self.lots) - self.oversold

    @property
    def cost(self) -> float:
        return sum(l[0] * l[1] for l in self.lots)


def _chronological(txns: list[dict]) -> list[dict]:
    return sorted(txns, key=lambda t: (t["date"], t.get("id") or 0))


def _apply(lots: Lots, t: dict) -> float:
    """Apply one transaction to the lots; returns the realised gain it produced (0 unless units were sold)."""
    kind = t["type"]
    if kind in SELLS:
        return t["amount"] - lots.sell(t["units"])
    if kind == DIVIDEND:
        return 0.0  # cash only; holdings and cost basis unchanged
    if kind == BONUS:
        lots.buy(t["units"], 0.0)  # free units: a zero-cost lot
        return 0.0
    lots.buy(t["units"], t["amount"])  # SIP, LUMPSUM, SWITCH_IN
    return 0.0


def cashflows(txns: list[dict], internal: bool = False) -> list[tuple[date, float]]:
    """Dated cashflows for XIRR: purchases negative; redemptions and dividends positive; bonus units nothing.
    Switches are internal to the holding and count only when `internal` is set (one scheme's own return);
    charges never count (nothing came back)."""
    out = []
    for t in txns:
        kind = t["type"]
        if kind in PURCHASES or (internal and kind == SWITCH_IN):
            out.append((date.fromisoformat(t["date"]), -t["amount"]))
        elif kind in (REDEMPTION, DIVIDEND) or (internal and kind == SWITCH_OUT):
            out.append((date.fromisoformat(t["date"]), t["amount"]))
    return out


def summarize(txns: list[dict], latest: tuple[str, float] | None, today: date, internal_flows: bool = False) -> dict:
    """Totals for one holding (or one folio / scheme) given its transactions and the latest cached NAV / price."""
    tx = _chronological(txns)
    lots = Lots()
    purchased = redeemed = realised = dividends = bonus_units = switched_in = switched_out = charges = 0.0
    for t in tx:
        kind = t["type"]
        if kind == REDEMPTION:
            redeemed += t["amount"]
            realised += _apply(lots, t)
        elif kind == SWITCH_OUT:
            switched_out += t["amount"]
            realised += _apply(lots, t)
        elif kind == CHARGE:
            charges += t["amount"]
            realised += _apply(lots, t)
        elif kind == DIVIDEND:
            dividends += t["amount"]
        elif kind == BONUS:
            bonus_units += t["units"]
            _apply(lots, t)
        elif kind == SWITCH_IN:
            switched_in += t["amount"]
            _apply(lots, t)
        else:
            purchased += t["amount"]
            _apply(lots, t)
    units = lots.units
    invested = lots.cost
    nav_date, nav = latest if latest else (None, None)
    current = units * nav if nav is not None else 0.0
    profit = current - invested
    flows = cashflows(tx, internal_flows)
    if current > 0:
        flows.append((today, current))
    # Sold out completely: the holding is closed (kept with all its data, listed separately in the UI).
    closed = bool(tx) and (redeemed > 0 or switched_out > 0) and units <= 1e-6
    closed_on = max((t["date"] for t in tx if t["type"] in (REDEMPTION, SWITCH_OUT)), default=None) if closed else None
    return {
        "invested": round(invested, 2),
        "net_invested": round(invested - dividends, 2),  # cost of holdings less the cash dividends have returned
        "purchased": round(purchased, 2),
        "redeemed": round(redeemed, 2),
        "switched_in": round(switched_in, 2),
        "switched_out": round(switched_out, 2),
        "charges": round(charges, 2),
        "realised_gain": round(realised, 2),
        "dividends": round(dividends, 2),
        "realised_total": round(realised + dividends, 2),  # everything already received: sale gains + dividends
        "closed": closed,
        "closed_on": closed_on,
        "bonus_units": round(bonus_units, 4),
        "units": round(units, 4),
        "oversold_units": round(lots.oversold, 4),
        "latest_nav": nav,
        "latest_nav_date": nav_date,
        "current_value": round(current, 2),
        "profit": round(profit, 2),
        "total_gain": round(profit + realised + dividends - charges, 2),
        "abs_return_pct": (profit / invested * 100.0) if invested else None,
        "xirr": xirr(flows) if tx else None,
        "txn_count": len(tx),
        "first_txn_date": tx[0]["date"] if tx else None,
    }


def aggregate(parts: list[dict], flows: list[tuple[date, float]], today: date) -> dict:
    """One summary for several sub-holdings with different NAVs (an NPS account's E / C / G schemes):
    money figures add up, units and NAV do not apply, and the XIRR comes from the investor's own cashflows."""
    s = lambda key: sum(p[key] for p in parts)  # noqa: E731
    invested, current = s("invested"), s("current_value")
    profit = current - invested
    realised, dividends, charges = s("realised_gain"), s("dividends"), s("charges")
    all_flows = list(flows)
    if current > 0:
        all_flows.append((today, current))
    has_tx = any(p["txn_count"] for p in parts)
    closed = has_tx and all(p["closed"] or p["txn_count"] == 0 for p in parts)
    return {
        "invested": round(invested, 2),
        "net_invested": round(invested - dividends, 2),
        "purchased": round(s("purchased"), 2),
        "redeemed": round(s("redeemed"), 2),
        "switched_in": round(s("switched_in"), 2),
        "switched_out": round(s("switched_out"), 2),
        "charges": round(charges, 2),
        "realised_gain": round(realised, 2),
        "dividends": round(dividends, 2),
        "realised_total": round(realised + dividends, 2),
        "closed": closed,
        "closed_on": max((p["closed_on"] for p in parts if p["closed_on"]), default=None) if closed else None,
        "bonus_units": round(s("bonus_units"), 4),
        "units": None,
        "oversold_units": round(s("oversold_units"), 4),
        "latest_nav": None,
        "latest_nav_date": max((p["latest_nav_date"] for p in parts if p["latest_nav_date"]), default=None),
        "current_value": round(current, 2),
        "profit": round(profit, 2),
        "total_gain": round(profit + realised + dividends - charges, 2),
        "abs_return_pct": (profit / invested * 100.0) if invested else None,
        "xirr": xirr(all_flows) if has_tx else None,
        "txn_count": sum(p["txn_count"] for p in parts),
        "first_txn_date": min((p["first_txn_date"] for p in parts if p["first_txn_date"]), default=None),
    }


def value_history(txns: list[dict], history: list[tuple[str, float]]) -> list[dict]:
    """Daily [{date, value, invested}] from the first transaction, using NAV / price history (ascending).
    `invested` is the FIFO cost of the units held on that day."""
    if not txns or not history:
        return []
    tx = _chronological(txns)
    first = tx[0]["date"]
    lots = Lots()
    out: list[dict] = []
    i = 0
    for d, nav in history:
        if d < first:
            continue
        while i < len(tx) and tx[i]["date"] <= d:
            _apply(lots, tx[i])
            i += 1
        out.append({"date": d, "value": round(lots.units * nav, 2), "invested": round(lots.cost, 2)})
    return out


def combine_histories(histories: list[list[dict]]) -> list[dict]:
    """Sum several holding histories day by day, forward-filling each one across its missing dates."""
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
    """Roll up per-holding summaries plus the combined cashflow XIRR, locked / redeemable split and kind split."""
    s = lambda key, pred=lambda f: True: sum(f["summary"].get(key, 0.0) for f in funds if pred(f))  # noqa: E731
    invested = s("invested")
    current = s("current_value")
    locked_value = s("current_value", lambda f: f["locked"])
    locked_invested = s("invested", lambda f: f["locked"])
    profit = current - invested
    realised = s("realised_gain")
    dividends = s("dividends")
    charges = s("charges")
    all_flows = list(flows)
    if current > 0:
        all_flows.append((today, current))
    active = [f for f in funds if not f.get("closed")]
    by_kind: dict[str, dict] = {}
    for f in funds:
        k = by_kind.setdefault(f.get("kind") or "MF", {"count": 0, "closed": 0, "invested": 0.0, "current_value": 0.0, "realised_gain": 0.0, "dividends": 0.0, "charges": 0.0})
        k["closed" if f.get("closed") else "count"] += 1  # count = active holdings
        for key in ("invested", "current_value", "realised_gain", "dividends", "charges"):
            k[key] = round(k[key] + f["summary"].get(key, 0.0), 2)
    for k in by_kind.values():
        k["profit"] = round(k["current_value"] - k["invested"], 2)
    return {
        "by_kind": by_kind,
        "invested": round(invested, 2),
        "net_invested": round(invested - dividends, 2),
        "purchased": round(s("purchased"), 2),
        "redeemed": round(s("redeemed"), 2),
        "realised_gain": round(realised, 2),
        "dividends": round(dividends, 2),
        "charges": round(charges, 2),
        "realised_total": round(realised + dividends, 2),
        "current_value": round(current, 2),
        "profit": round(profit, 2),
        "total_gain": round(profit + realised + dividends - charges, 2),
        "abs_return_pct": (profit / invested * 100.0) if invested else None,
        "xirr": xirr(all_flows) if flows else None,
        "locked_value": round(locked_value, 2),
        "unlocked_value": round(current - locked_value, 2),
        "locked_invested": round(locked_invested, 2),
        "unlocked_invested": round(invested - locked_invested, 2),
        "fund_count": len(active),
        "closed_count": len(funds) - len(active),
        "locked_count": sum(1 for f in active if f["locked"]),
    }
