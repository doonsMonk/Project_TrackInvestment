"""Gold holdings (Sovereign Gold Bonds): the gold price per gram in INR, entered by hand, and the bond schedule.

RBI redeems a Sovereign Gold Bond at the IBJA 999 gold price, and no free feed carries the listed SGB series
(Yahoo Finance does not know them), so the price is entered by the user - from Google Finance, the exchange or the
day's gold rate - and shared by every gold holding. It lives in the quotes table under one symbol so the usual
history / latest / on-or-before lookups apply, and it carries a date so a stale price stays visible.
"""
import calendar
import datetime as dt
import sqlite3

from . import quotes

SYMBOL = "GOLD:INR"
COUPON = 2.5       # % a year on the issue price, paid every six months
TENOR_YEARS = 8    # a bond matures eight years after its issue date
EXIT_YEARS = 5     # RBI allows early redemption from the fifth year, on an interest date


def set_price(conn: sqlite3.Connection, iso_date: str, price: float) -> None:
    with conn:
        conn.execute("INSERT OR REPLACE INTO quotes(symbol, date, close) VALUES (?, ?, ?)", (SYMBOL, iso_date, float(price)))
        conn.execute(
            "INSERT OR REPLACE INTO quote_meta(symbol, name, exchange, currency, quote_type, last_fetched) VALUES (?, ?, ?, ?, ?, ?)",
            (SYMBOL, "Gold, per gram", None, "INR", "MANUAL", dt.datetime.now().isoformat(timespec="seconds")),
        )


def delete_price(conn: sqlite3.Connection, iso_date: str) -> bool:
    with conn:
        cur = conn.execute("DELETE FROM quotes WHERE symbol = ? AND date = ?", (SYMBOL, iso_date))
    return cur.rowcount > 0


def history(conn: sqlite3.Connection) -> list[tuple[str, float]]:
    return quotes.get_history(conn, SYMBOL)


def latest(conn: sqlite3.Connection) -> tuple[str, float] | None:
    return quotes.latest(conn, SYMBOL)


def on_or_before(conn: sqlite3.Connection, iso_date: str) -> tuple[str, float] | None:
    return quotes.on_or_before(conn, SYMBOL, iso_date)


def add_months(d: dt.date, n: int) -> dt.date:
    y = d.year + (d.month - 1 + n) // 12
    m = (d.month - 1 + n) % 12 + 1
    return dt.date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def schedule(issue_date: str | None, units: float, issue_price: float | None, today: dt.date, coupon: float = COUPON) -> dict:
    """Interest dates, early-redemption date and maturity of a bond issued on `issue_date`; the half-yearly
    interest amount when the issue price is known (interest is paid on the issue price, not on what was paid)."""
    if not issue_date:
        return {"issue_date": None, "maturity": None, "exit_from": None, "next_interest": None, "payments_left": None,
                "interest_per_payment": None, "matured": False, "coupon": coupon}
    d0 = dt.date.fromisoformat(issue_date)
    maturity = add_months(d0, 12 * TENOR_YEARS)
    upcoming = [d for d in (add_months(d0, 6 * k) for k in range(1, 2 * TENOR_YEARS + 1)) if d > today]
    per = round(units * issue_price * coupon / 200.0, 2) if units and issue_price else None
    return {
        "issue_date": d0.isoformat(),
        "maturity": maturity.isoformat(),
        "exit_from": add_months(d0, 12 * EXIT_YEARS).isoformat(),
        "next_interest": upcoming[0].isoformat() if upcoming else None,
        "payments_left": len(upcoming),
        "interest_per_payment": per,
        "matured": today >= maturity,
        "coupon": coupon,
    }
