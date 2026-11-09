"""SIP schedules: a fixed amount on a fixed day, monthly or quarterly, on a mutual fund or a stock.

A schedule lives in the holding's `details["sips"]`. From it the app knows which instalments have fallen due, and it
checks each one against the purchases actually recorded (same folio when the schedule names one, the amount within
one per cent, the date within a few days, as allotment can land a day or two after the debit). Instalments with no
such purchase are pending: the page offers to record them, at the NAV of the due date, and a later CAS import
replaces such a recorded instalment with the exact figures from the statement.
"""
from __future__ import annotations

from datetime import date, timedelta

from . import calc, gold

EVERY = {"monthly": 1, "quarterly": 3}
MAX_SIPS = 20
WINDOW_DAYS = 5
SCHEDULE_NOTE = "SIP instalment · from the schedule"


def clean(raw) -> list[dict]:
    """Validate a list of schedules from the client; raises ValueError with a message for the user."""
    if raw in (None, ""):
        return []
    if not isinstance(raw, list):
        raise ValueError("sips must be a list")
    if len(raw) > MAX_SIPS:
        raise ValueError(f"at most {MAX_SIPS} SIP schedules per holding")
    out = []
    for i, s in enumerate(raw):
        if not isinstance(s, dict):
            raise ValueError(f"SIP {i + 1}: not an object")
        try:
            amount = float(s.get("amount"))
            day = int(s.get("day"))
        except (TypeError, ValueError) as e:
            raise ValueError(f"SIP {i + 1}: amount and day must be numbers") from e
        if amount <= 0:
            raise ValueError(f"SIP {i + 1}: the amount must be positive")
        if not 1 <= day <= 28:
            raise ValueError(f"SIP {i + 1}: the day must be between 1 and 28")
        every = str(s.get("every") or "monthly")
        if every not in EVERY:
            raise ValueError(f"SIP {i + 1}: every must be monthly or quarterly")
        start, end = s.get("start"), s.get("end") or None
        for key, value in (("start", start), ("end", end)):
            if value:
                try:
                    date.fromisoformat(str(value))
                except ValueError as e:
                    raise ValueError(f"SIP {i + 1}: {key} must be a date (YYYY-MM-DD)") from e
        if not start:
            raise ValueError(f"SIP {i + 1}: a start date is needed")
        if end and str(end) < str(start):
            raise ValueError(f"SIP {i + 1}: the end cannot be before the start")
        out.append({"amount": round(amount, 2), "day": day, "every": every, "start": str(start), "end": str(end) if end else None,
                    "folio": str(s.get("folio") or "").strip()[:100], "paused": bool(s.get("paused"))})
    return out


def due_dates(s: dict, until: date) -> list[str]:
    """The instalments of a schedule up to `until`: the schedule's day of the month, every month or quarter, from the
    first such day on or after the start."""
    start = date.fromisoformat(s["start"])
    end = date.fromisoformat(s["end"]) if s.get("end") else None
    first = start.replace(day=s["day"]) if start.day <= s["day"] else gold.add_months(start.replace(day=1), 1).replace(day=s["day"])
    out = []
    n = 0
    while n < 1200:
        d = gold.add_months(first, n * EVERY[s["every"]])
        if d > until or (end and d > end):
            break
        out.append(d.isoformat())
        n += 1
    return out


def _covered(due: str, purchases: list[dict], s: dict, taken: set) -> dict | None:
    """The recorded purchase that stands for this instalment, if any: same folio (when the schedule names one), the
    amount within one per cent, the date within WINDOW_DAYS, not already claimed by another instalment."""
    d0 = date.fromisoformat(due)
    best = None
    for t in purchases:
        if t["id"] in taken:
            continue
        if s["folio"] and (t.get("folio_number") or "") and t["folio_number"] != s["folio"]:
            continue
        if abs(t["amount"] - s["amount"]) > max(1.0, s["amount"] * 0.01):
            continue
        gap = abs((date.fromisoformat(t["date"]) - d0).days)
        if gap <= WINDOW_DAYS and (best is None or gap < best[0]):
            best = (gap, t)
    return best[1] if best else None


def status(schedules: list[dict], txns: list[dict], today: date) -> dict:
    """What the page shows: each schedule with its next due date and pending instalments, and the totals."""
    purchases = sorted((t for t in txns if t["type"] in calc.PURCHASES), key=lambda t: t["date"])
    taken: set = set()
    out = []
    pending_all = []
    for i, s in enumerate(schedules):
        dues = due_dates(s, today)
        pending = []
        for due in dues:
            hit = _covered(due, purchases, s, taken)
            if hit:
                taken.add(hit["id"])
            elif not s.get("paused"):
                pending.append(due)
        # the next instalment after today
        nxt = None
        if not s.get("paused"):
            later = due_dates(s, today + timedelta(days=400))
            nxt = next((d for d in later if d > today.isoformat()), None)
        entry = {**s, "index": i, "paid": len(dues) - len(pending), "pending": pending, "next_due": nxt}
        out.append(entry)
        pending_all.extend({"date": d, "amount": s["amount"], "folio": s["folio"], "index": i} for d in pending)
    pending_all.sort(key=lambda x: x["date"])
    return {"schedules": out, "pending": pending_all, "pending_total": round(sum(x["amount"] for x in pending_all), 2),
            "next_due": min((e["next_due"] for e in out if e["next_due"]), default=None),
            "monthly": round(sum(s["amount"] / EVERY[s["every"]] for s in schedules if not s.get("paused")), 2)}


def scheduled_match(txns: list[dict], date_iso: str, amount: float) -> dict | None:
    """A purchase recorded from a schedule that a statement line (date, amount) would replace."""
    d0 = date.fromisoformat(date_iso)
    for t in txns:
        if t["type"] in calc.PURCHASES and SCHEDULE_NOTE in (t.get("notes") or "") and abs(t["amount"] - amount) <= max(1.0, amount * 0.01):
            if abs((date.fromisoformat(t["date"]) - d0).days) <= WINDOW_DAYS:
                return t
    return None
