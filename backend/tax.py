"""Capital gains and the tax on them, under the Indian income-tax rules for an individual, for one financial year.

Every sale (redemption, switch-out, sale of shares) is matched to the units it sold, oldest first, which is how the
Income-tax Act matches them too. Each piece of a sale is then assessed by the holding's tax class and the dates:

  equity   listed shares and equity-oriented funds (more than 65 % in Indian shares, which includes aggressive hybrid,
           arbitrage, balanced advantage and equity-savings funds): long-term after 12 months. Short-term gains are
           taxed under section 111A at 20 % (15 % for sales before 23 July 2024); long-term gains under section 112A at
           12.5 % (10 % before 23 July 2024) on the part above the year's exemption of Rs 1.25 lakh (Rs 1 lakh up to
           FY 2023-24). Units bought before 1 February 2018 take the 31 January 2018 price as their cost when that is
           higher (and not above the sale price): the "grandfathering" of section 112A.
  debt     debt funds (more than 65 % in debt and money-market paper): units bought on or after 1 April 2023 are
           "specified mutual fund" units under section 50AA, so their gains are short-term and taxed at the slab rate
           whatever the holding period. Units bought before that date are long-term after 24 months (36 months for
           sales before 23 July 2024) and taxed under section 112 at 12.5 % without indexation (20 % with indexation
           before 23 July 2024); short-term gains go at the slab rate.
  other    gold and silver funds, international funds, multi-asset and other hybrid funds that are neither equity-
           oriented nor debt-oriented: long-term after 24 months (36 before 23 July 2024), taxed like the pre-2023 debt
           units. Units bought on or after 1 April 2023 and sold before 1 April 2025 fell under section 50AA (slab
           rate), because until then the section caught every fund with less than 35 % in shares.
  sgb      Sovereign Gold Bonds: redeemed through RBI (at maturity, or on an interest date from the fifth year) the
           gain is exempt under section 47(viic); sold on the exchange it is a listed bond, long-term after 12 months
           at 12.5 % (10 % before 23 July 2024), short-term at the slab rate. The interest is income at the slab rate.
  exempt   NPS, EPF, PPF, fixed deposits and insurance policies produce no capital gains: their interest, payouts and
           withdrawals are assessed as income (or exempt income) instead.

Losses are set off the way the Act allows: a short-term loss against any capital gain, a long-term loss only against
long-term gains; what is left can be carried forward for eight years. Dividends (IDCW), interest on gold bonds and
fixed deposits, and a taxable policy payout are income from other sources at the slab rate; the user picks the slab.
Health and education cess of 4 % goes on top of the tax; surcharge and the section 87A rebate are not applied. All of
it is an estimate from the entries in the app, to check against Form 26AS / AIS and the fund houses' capital gains
statements before filing.
"""
from __future__ import annotations

import datetime as dt
import re

from . import calc, fd as fdmod, gold, policy

EQUITY, DEBT, OTHER, SGB, EXEMPT = "equity", "debt", "other", "sgb", "exempt"
CLASSES = (EQUITY, DEBT, OTHER)  # the ones a user can choose for a fund
CLASS_LABELS = {
    EQUITY: "Equity (listed shares, equity-oriented funds)",
    DEBT: "Debt fund",
    OTHER: "Other fund (gold, international, multi-asset, hybrid)",
    SGB: "Sovereign Gold Bond",
    EXEMPT: "No capital gains tax",
}

# ---- the rules, with the dates they took effect
CUTOVER = "2024-07-23"        # Finance (No. 2) Act 2024: new rates and holding periods for transfers on or after this date
SPECIFIED_FROM = "2023-04-01"  # debt-fund units bought on or after: slab rate whatever the holding period (section 50AA)
RELIEF_FROM = "2025-04-01"     # gold, international and other non-equity funds sold on or after: section 50AA no longer applies
GRANDFATHER_DAY = "2018-01-31"  # equity bought before 1 Feb 2018: cost stepped up to this day's price (section 112A)
GRANDFATHER_UNTIL = "2018-02-01"
CESS = 0.04
SLAB_DEFAULT = 30.0
EXEMPTION_OLD, EXEMPTION_NEW = 100000.0, 125000.0  # section 112A, per financial year
EPF_TAXABLE_ABOVE = 250000.0  # employee contributions above this in a year: the interest on the excess is taxable
INS_PREMIUM_CAP = 500000.0    # policies issued from 1 April 2023: aggregate yearly premium above this loses 10(10D)
INS_OLD_POLICY_BEFORE = "2012-04-01"  # policies issued before this may pay up to 20 % of the sum assured a year
DIVIDEND_TDS_NEW, DIVIDEND_TDS_OLD = 10000.0, 5000.0  # TDS on dividends from FY 2025-26 / before
FD_TDS_NEW, FD_TDS_OLD = 50000.0, 40000.0             # TDS on bank interest (non-senior) from FY 2025-26 / before
# Cost inflation index by the financial year's starting year (notified by CBDT); indexation applies only to the
# long-term gains of sales before 23 July 2024, which all fall in years listed here.
CII = {2001: 100, 2002: 105, 2003: 109, 2004: 113, 2005: 117, 2006: 122, 2007: 129, 2008: 137, 2009: 148, 2010: 167,
       2011: 184, 2012: 200, 2013: 220, 2014: 240, 2015: 254, 2016: 264, 2017: 272, 2018: 280, 2019: 289, 2020: 301,
       2021: 317, 2022: 331, 2023: 348, 2024: 363, 2025: 376}
SECTIONS = {
    "111A": "Short-term equity gains (section 111A)",
    "112A": "Long-term equity gains (section 112A)",
    "112": "Long-term gains on other assets (section 112)",
    "slab": "Gains taxed at the slab rate",
    "exempt": "Exempt gains",
}
FY_RE = re.compile(r"^(\d{4})-(\d{2})$")


# ---------------------------------------------------------------- dates

def fy_of(iso_date: str) -> str:
    """Indian financial year of a date: '2011-02-15' -> '2010-11'."""
    y, m = int(iso_date[:4]), int(iso_date[5:7])
    start = y if m >= 4 else y - 1
    return f"{start}-{(start + 1) % 100:02d}"


def fy_start_year(fy: str) -> int:
    m = FY_RE.match(fy or "")
    if not m or (int(m.group(1)) + 1) % 100 != int(m.group(2)):
        raise ValueError("the financial year must look like 2025-26")
    return int(m.group(1))


def fy_bounds(fy: str) -> tuple[str, str]:
    y = fy_start_year(fy)
    return f"{y}-04-01", f"{y + 1}-03-31"


def _add_months(iso: str, n: int) -> str:
    return gold.add_months(dt.date.fromisoformat(iso), n).isoformat()


def _is_long(buy: str, sale: str, months: int) -> bool:
    """Held for more than `months` months: sold after the same day `months` later."""
    return sale > _add_months(buy, months)


def _cii(iso: str) -> int:
    y = fy_start_year(fy_of(iso))
    return CII.get(y) or CII[max(CII)]


# ---------------------------------------------------------------- what kind of asset, for tax

EQUITY_HYBRID_WORDS = ("aggressive", "arbitrage", "equity savings", "balanced advantage", "dynamic asset")
DEBT_WORDS = ("debt", "bond", "gilt", "liquid", "money market", "overnight", "g-sec", "gsec", "sdl", "psu", "credit risk",
              "corporate", "banking", "duration", "floater", "floating", "treasury", "target maturity", "income", "fixed maturity")
METAL_WORDS = ("gold", "silver")
INTL_WORDS = ("international", "global", "overseas", "nasdaq", "s&p", "world", "china", "japan", "europe", "emerging", "us equity", "u.s.")


def classify(fund: dict, category: str | None) -> dict:
    """The tax class of a holding and where it came from: the user's choice on the holding, the AMFI scheme category,
    the kind of holding, or the name."""
    kind = fund.get("kind") or "MF"
    d = fund.get("details") if isinstance(fund.get("details"), dict) else {}
    if kind in ("NPS", "EPF", "PPF", "FD", "INS"):
        return {"class": EXEMPT, "source": "kind", "reason": "no capital gains on this kind of holding"}
    if kind == "GOLD":
        return {"class": SGB, "source": "kind", "reason": "Sovereign Gold Bond"}
    if kind == "STOCK":
        if (fund.get("currency") or "INR").upper() == "INR":
            return {"class": EQUITY, "source": "kind", "reason": "listed share"}
        return {"class": OTHER, "source": "kind", "reason": f"share in {fund.get('currency')}: not listed in India, so long-term after 24 months"}
    chosen = d.get("tax_class")
    if chosen in CLASSES:
        return {"class": chosen, "source": "chosen", "reason": "set on the holding"}
    cat = (category or "").lower()
    name = (fund.get("name") or "").lower()
    by_cat = lambda c: {"class": c, "source": "category", "reason": f"scheme category: {category}"}  # noqa: E731
    if "hybrid" in cat:
        if any(w in cat or w in name for w in EQUITY_HYBRID_WORDS):
            return by_cat(EQUITY)
        if "conservative" in cat:
            return by_cat(DEBT)
        return {"class": OTHER, "source": "category", "reason": f"scheme category: {category}; set Equity on the holding if the fund keeps more than 65 % in shares"}
    if "equity" in cat:
        return by_cat(EQUITY)
    if "debt" in cat or "income" in cat:
        return by_cat(DEBT)
    if "solution" in cat:
        return {"class": OTHER, "source": "category", "reason": f"scheme category: {category}; set Equity or Debt on the holding to match the fund's portfolio"}
    if "overseas" in cat or any(w in name for w in INTL_WORDS):
        return {"class": OTHER, "source": "category" if cat else "name", "reason": "invests abroad"}
    if any(w in name for w in METAL_WORDS):
        return {"class": OTHER, "source": "name", "reason": "gold or silver fund"}
    if cat:  # index funds, ETFs, domestic fund of funds and anything else AMFI files under "Other"
        if any(w in name for w in DEBT_WORDS):
            return {"class": DEBT, "source": "name", "reason": f"scheme category: {category}; the name says it holds debt"}
        return {"class": EQUITY, "source": "category", "reason": f"scheme category: {category}; taken as an equity index or ETF"}
    if any(w in name for w in DEBT_WORDS):
        return {"class": DEBT, "source": "name", "reason": "assumed from the name"}
    return {"class": EQUITY, "source": "name", "reason": "assumed from the name; set the class on the holding if it is a debt or other fund"}


# ---------------------------------------------------------------- lots and the pieces of each sale

def _chronological(txns: list[dict]) -> list[dict]:
    return sorted(txns, key=lambda t: (t["date"], t.get("id") or 0))


def walk_lots(txns: list[dict]) -> tuple[list[dict], dict[str, list[dict]]]:
    """FIFO per scheme, remembering when each lot was bought: the pieces of every sale (one per lot it consumed) and
    the lots still held."""
    lots_by_scheme: dict[str, list[dict]] = {}
    pieces: list[dict] = []
    for t in _chronological(txns):
        key = t.get("scheme") or ""
        lots = lots_by_scheme.setdefault(key, [])
        typ = t["type"]
        if typ in calc.SELLS:
            units = float(t["units"] or 0)
            per_unit = float(t["amount"]) / units if units else 0.0
            remaining = units
            while remaining > 1e-9 and lots:
                lot = lots[0]
                take = min(lot["units"], remaining)
                pieces.append({"sale_id": t.get("id"), "sale_date": t["date"], "sale_type": typ, "scheme": key, "notes": t.get("notes") or "",
                               "buy_date": lot["date"], "buy_type": lot["type"], "units": take, "cost": take * lot["cpu"], "proceeds": take * per_unit})
                lot["units"] -= take
                remaining -= take
                if lot["units"] <= 1e-9:
                    lots.pop(0)
            if remaining > 1e-9:  # more sold than bought: a data problem, shown rather than hidden
                pieces.append({"sale_id": t.get("id"), "sale_date": t["date"], "sale_type": typ, "scheme": key, "notes": t.get("notes") or "",
                               "buy_date": None, "buy_type": None, "units": remaining, "cost": 0.0, "proceeds": remaining * per_unit, "oversold": True})
        elif typ == calc.DIVIDEND:
            continue
        elif typ == calc.BONUS:
            if (t["units"] or 0) > 0:
                lots.append({"units": float(t["units"]), "cpu": 0.0, "date": t["date"], "type": typ})
        elif (t["units"] or 0) > 0:  # SIP, LUMPSUM, SWITCH_IN
            lots.append({"units": float(t["units"]), "cpu": float(t["amount"]) / float(t["units"]), "date": t["date"], "type": typ})
    return pieces, lots_by_scheme


def _term(cls: str, buy: str, sale: str, ctx: dict) -> tuple[str, str]:
    """(section, term) for units bought on `buy` and sold on `sale`."""
    post = sale >= CUTOVER
    if cls == EQUITY:
        return ("112A", "long") if _is_long(buy, sale, 12) else ("111A", "short")
    if cls == DEBT and buy >= SPECIFIED_FROM:
        return "slab", "deemed-short"
    if cls == OTHER and buy >= SPECIFIED_FROM and sale < RELIEF_FROM:
        return "slab", "deemed-short"
    if cls in (DEBT, OTHER):
        return ("112", "long") if _is_long(buy, sale, 24 if post else 36) else ("slab", "short")
    if cls == SGB:
        on_exchange = any(w in (ctx.get("notes") or "").lower() for w in ("exchange", "nse", "bse", "sold on"))
        exit_from = ctx.get("exit_from")
        if not on_exchange and ((exit_from and sale >= exit_from) or (not exit_from and _is_long(buy, sale, 60))):
            return "exempt", "redeemed"
        return ("112", "long") if _is_long(buy, sale, 12) else ("slab", "short")
    return "exempt", "exempt"


def _rate(section: str, term: str, sale: str, cls: str) -> float | None:
    post = sale >= CUTOVER
    if section == "111A":
        return 0.20 if post else 0.15
    if section == "112A":
        return 0.125 if post else 0.10
    if section == "112":
        if cls == SGB:
            return 0.125 if post else 0.10  # listed bonds: the 10 % rate without indexation before the change
        return 0.125 if post else 0.20       # 20 % with indexation before the change
    return None  # slab rate, or exempt


def assess(piece: dict, cls: str, ctx: dict) -> dict:
    """One piece of a sale with its term, section, rate and taxable gain (after grandfathering or indexation)."""
    p = dict(piece)
    gain = p["proceeds"] - p["cost"]
    p["gain"] = gain
    p["class"] = cls
    if p.get("oversold") or not p["buy_date"]:
        p.update({"section": "slab", "term": "unknown", "rate": None, "taxable_gain": gain, "months": None,
                  "note": "sold more than the entries show as bought: the cost of these units is unknown, so the whole amount counts as gain"})
        return p
    section, term = _term(cls, p["buy_date"], p["sale_date"], {**ctx, "notes": p.get("notes")})
    rate = _rate(section, term, p["sale_date"], cls)
    taxable = gain
    note = ""
    if section == "112A" and p["buy_date"] < GRANDFATHER_UNTIL and ctx.get("fmv2018"):
        stepped = max(p["cost"], min(ctx["fmv2018"] * p["units"], p["proceeds"]))
        if stepped > p["cost"] + 0.005:
            taxable = p["proceeds"] - stepped
            note = f"cost taken as the 31 Jan 2018 price ({ctx['fmv2018']:.4f} a unit) under the grandfathering rule"
    elif section == "112" and cls != SGB and p["sale_date"] < CUTOVER:
        indexed = p["cost"] * _cii(p["sale_date"]) / _cii(p["buy_date"])
        taxable = p["proceeds"] - indexed
        note = f"20 % on the gain over the indexed cost (CII {_cii(p['buy_date'])} → {_cii(p['sale_date'])})"
    elif section == "exempt" and cls == SGB:
        note = "redeemed through RBI: exempt under section 47(viic). If it was sold on the exchange instead, put the word 'exchange' in the entry's comment and the gain is taxed as a listed bond"
    elif term == "deemed-short":
        note = "bought on or after 1 April 2023: short-term at the slab rate whatever the holding period (section 50AA)"
    d0, d1 = dt.date.fromisoformat(p["buy_date"]), dt.date.fromisoformat(p["sale_date"])
    p.update({"section": section, "term": term, "rate": rate, "taxable_gain": taxable, "note": note,
              "months": (d1.year - d0.year) * 12 + d1.month - d0.month - (1 if d1.day < d0.day else 0), "days": (d1 - d0).days})
    return p


# ---------------------------------------------------------------- buckets, set-off, exemption, tax

def exemption_limit(fy: str) -> float:
    return EXEMPTION_NEW if fy_start_year(fy) >= 2024 else EXEMPTION_OLD


def buckets(lines: list[dict], fy: str, slab_pct: float) -> dict:
    """Net each section, set losses off the way the Act allows, apply the 112A exemption, work the tax out."""
    out = {}
    for key in ("111A", "112A", "112", "slab", "exempt"):
        rows = [ln for ln in lines if ln["section"] == key]
        gains = sum(ln["taxable_gain"] for ln in rows if ln["taxable_gain"] > 0)
        losses = sum(ln["taxable_gain"] for ln in rows if ln["taxable_gain"] < 0)
        weight = sum(abs(ln["taxable_gain"]) for ln in rows if ln["rate"] is not None)
        rate = (sum(abs(ln["taxable_gain"]) * ln["rate"] for ln in rows if ln["rate"] is not None) / weight) if weight else None
        if key == "slab":
            rate = slab_pct / 100.0
        out[key] = {"section": key, "label": SECTIONS[key], "count": len(rows), "gains": gains, "losses": losses, "net": gains + losses,
                    "rate": rate, "set_off": 0.0, "after_set_off": max(0.0, gains + losses), "exemption": 0.0, "taxable": 0.0, "tax": 0.0}
    # losses: short-term ones against anything, long-term ones against long-term gains only
    lt_loss = -min(0.0, out["112A"]["net"]) - min(0.0, out["112"]["net"])
    st_loss = -min(0.0, out["111A"]["net"]) - min(0.0, out["slab"]["net"])
    for loss_kind, order in (("long", ("112", "112A")), ("short", ("slab", "111A", "112", "112A"))):
        left = lt_loss if loss_kind == "long" else st_loss
        for key in order:
            if left <= 0:
                break
            room = out[key]["after_set_off"]
            take = min(room, left)
            out[key]["after_set_off"] -= take
            out[key]["set_off"] += take
            left -= take
        if loss_kind == "long":
            lt_carry = left
        else:
            st_carry = left
    limit = exemption_limit(fy)
    b = out["112A"]
    b["exemption"] = min(limit, b["after_set_off"])
    b["taxable"] = b["after_set_off"] - b["exemption"]
    for key in ("111A", "112", "slab"):
        out[key]["taxable"] = out[key]["after_set_off"]
    for key in ("111A", "112A", "112", "slab"):
        out[key]["tax"] = out[key]["taxable"] * (out[key]["rate"] or 0.0)
    out["exempt"]["taxable"] = 0.0
    return {"buckets": out, "exemption_limit": limit, "carry_forward": {"short_term": st_carry, "long_term": lt_carry}}


# ---------------------------------------------------------------- income other than capital gains

def _in(fy_from: str, fy_to: str):
    return lambda t: fy_from <= t["date"] <= fy_to


def income_lines(fund: dict, txns: list[dict], cls: str, category: str | None, fy: str, today: dt.date) -> tuple[list[dict], list[dict]]:
    """(income lines, deduction lines) of one holding in the year: dividends and interest at the slab rate, exempt
    interest and payouts, things that need a look, and the payments that qualify for a deduction."""
    fy_from, fy_to = fy_bounds(fy)
    inside = _in(fy_from, fy_to)
    kind = fund.get("kind") or "MF"
    name = fund["name"]
    fid = fund["id"]
    new_tds = fy_start_year(fy) >= 2025
    income: list[dict] = []
    deductions: list[dict] = []
    line = lambda what, amount, treatment, note="", date=None: {"fund_id": fid, "name": name, "kind": kind, "what": what, "amount": round(amount, 2), "treatment": treatment, "note": note, "date": date}  # noqa: E731
    year_txns = [t for t in txns if inside(t)]
    if kind in ("MF", "STOCK"):
        divs = sum(t["amount"] for t in year_txns if t["type"] == calc.DIVIDEND)
        if divs:
            income.append(line("Dividend / IDCW", divs, "slab", f"income from other sources; the payer deducts 10 % TDS once the year's dividends from it pass Rs {int(DIVIDEND_TDS_NEW if new_tds else DIVIDEND_TDS_OLD):,}"))
        if kind == "MF" and "elss" in (category or "").lower():
            bought = sum(t["amount"] for t in year_txns if t["type"] in calc.PURCHASES)
            if bought:
                deductions.append(line("ELSS fund purchases", bought, "80C", "section 80C, within the Rs 1.5 lakh limit; old tax regime only; locked for three years"))
    elif kind == "GOLD":
        interest = sum(t["amount"] for t in year_txns if t["type"] == calc.DIVIDEND)
        if interest:
            income.append(line("Gold bond interest", interest, "slab", "2.5 % a year on the issue price: income from other sources, no TDS"))
    elif kind == "FD":
        terms = fdmod.terms(fund.get("details"), txns)
        payouts = sorted((t for t in txns if t["type"] == calc.REDEMPTION), key=lambda t: t["date"])
        payout_date = payouts[0]["date"] if payouts else None
        payout_amount = sum(t["amount"] for t in payouts)

        def value_at(iso: str) -> float:
            if not terms["deposit_date"] or iso < terms["deposit_date"]:
                return 0.0
            if payout_date and iso >= payout_date:
                return payout_amount
            return terms["principal"] * fdmod.factor(terms, iso)

        day_before = (dt.date.fromisoformat(fy_from) - dt.timedelta(days=1)).isoformat()
        deposited = sum(t["amount"] for t in year_txns if t["type"] in calc.PURCHASES)
        accrued = value_at(fy_to) - value_at(day_before) - deposited
        paid_out = sum(t["amount"] for t in year_txns if t["type"] == calc.DIVIDEND)
        if abs(accrued) >= 0.5:
            how = "paid out at maturity" if payout_date and inside({"date": payout_date}) else "accrued this year on the cumulative deposit"
            income.append(line("Fixed deposit interest", accrued, "slab", f"{how}; income from other sources, taxed on accrual each year. The bank deducts 10 % TDS once its interest to you passes Rs {int(FD_TDS_NEW if new_tds else FD_TDS_OLD):,} in a year (double for a senior citizen); the bank's interest certificate and Form 26AS / AIS are the authority"))
        if paid_out:
            income.append(line("Fixed deposit interest paid out", paid_out, "slab", "income from other sources; TDS as above"))
    elif kind == "INS":
        terms = policy.terms(fund.get("details"), txns)
        premiums = sum(t["amount"] for t in year_txns if t["type"] in calc.PURCHASES)
        if premiums:
            deductions.append(line("Life insurance premiums", premiums, "80C", "section 80C, within the Rs 1.5 lakh limit, for premiums up to 10 % of the sum assured (20 % for policies issued before 1 April 2012); old tax regime only"))
        payout = sum(t["amount"] for t in year_txns if t["type"] == calc.REDEMPTION)
        benefits = sum(t["amount"] for t in year_txns if t["type"] == calc.DIVIDEND)
        if payout or benefits:
            first = terms["first_premium"] or ""
            cap = 0.20 if first and first < INS_OLD_POLICY_BEFORE else 0.10
            premium, sa = terms["premium"], terms["sum_assured"]
            yearly = premium * {"yearly": 1, "half-yearly": 2, "quarterly": 4, "monthly": 12}.get(terms["frequency"], 1) if premium else None
            over_cap = bool(first and first >= "2023-04-01" and yearly and yearly > INS_PREMIUM_CAP)
            if sa and yearly is not None:
                exempt = yearly <= cap * sa + 0.005 and not over_cap
            else:
                exempt = None if not over_cap else False
            all_paid = sum(a for _, a in terms["paid"])
            all_got = sum(a for _, a in terms["benefits"]) + sum(t["amount"] for t in txns if t["type"] == calc.REDEMPTION)
            amount = payout + benefits
            if exempt:
                income.append(line("Policy payout", amount, "exempt", f"exempt under section 10(10D): the yearly premium is within {int(cap * 100)} % of the sum assured"))
            elif exempt is None:
                so_far = f"Rs {all_got - all_paid:,.0f} over the policy's life so far" if all_got > all_paid else "nothing so far, as what you received is still less than the premiums paid"
                income.append(line("Policy payout", amount, "attention", f"exempt under section 10(10D) if the yearly premium never exceeded {int(cap * 100)} % of the sum assured; add the sum assured to the policy to let the app check. Otherwise the gain (what you received less the premiums paid: {so_far}) is income at the slab rate"))
            else:
                taxable = max(0.0, all_got - all_paid)
                income.append(line("Policy payout, taxable part", min(taxable, amount), "slab", f"section 10(10D) does not apply ({'premium above Rs 5 lakh a year on a policy issued from April 2023' if over_cap else f'premium above {int(cap * 100)} % of the sum assured'}): what you received less the premiums paid is income from other sources"))
    elif kind == "EPF":
        interest = sum(t["units"] for t in year_txns if t["type"] == calc.BONUS and t.get("scheme") in ("EE", "ER"))
        own = sum(t["amount"] for t in year_txns if t["type"] in calc.PURCHASES and t.get("scheme") == "EE")
        if interest:
            if own > EPF_TAXABLE_ABOVE:
                income.append(line("EPF interest credited", interest, "attention", f"your own contributions this year came to Rs {own:,.0f}: the interest on the part above Rs 2.5 lakh is taxable (the EPFO keeps it in a separate account and reports it); the rest is exempt"))
            else:
                income.append(line("EPF interest credited", interest, "exempt", "exempt: your contributions stayed within Rs 2.5 lakh this year"))
        if own:
            deductions.append(line("EPF employee contributions", own, "80C", "section 80C, within the Rs 1.5 lakh limit; old tax regime only"))
        withdrawn = sum(t["amount"] for t in year_txns if t["type"] == calc.REDEMPTION)
        if withdrawn:
            first = min((t["date"] for t in txns if t["type"] in calc.PURCHASES), default=None)
            early = bool(first and any(t["date"] < _add_months(first, 60) for t in year_txns if t["type"] == calc.REDEMPTION))
            income.append(line("EPF withdrawal", withdrawn, "attention" if early else "exempt",
                               "withdrawn within five years of the first contribution: taxable unless the service was continuous for five years across employers, or ended for reasons beyond your control; the EPFO deducts 10 % TDS above Rs 50,000" if early else "exempt: after five years of service"))
    elif kind == "PPF":
        interest = sum(t["units"] for t in year_txns if t["type"] == calc.BONUS)
        if interest:
            income.append(line("PPF interest credited", interest, "exempt", "exempt under section 10(11); report it as exempt income in the return"))
        deposits = sum(t["amount"] for t in year_txns if t["type"] == "SIP")
        if deposits:
            deductions.append(line("PPF deposits", deposits, "80C", "section 80C, within the Rs 1.5 lakh limit; old tax regime only"))
        withdrawn = sum(t["amount"] for t in year_txns if t["type"] == calc.REDEMPTION)
        if withdrawn:
            income.append(line("PPF withdrawal", withdrawn, "exempt", "exempt"))
    elif kind == "NPS":
        contributed = sum(t["amount"] for t in year_txns if t["type"] in calc.PURCHASES)
        if contributed:
            deductions.append(line("NPS contributions", contributed, "80CCD", "your own Tier I contributions: section 80CCD(1) within 80C's Rs 1.5 lakh and a further Rs 50,000 under 80CCD(1B), old regime only; an employer's contribution is deductible under 80CCD(2) in both regimes (up to 14 % of basic salary in the new regime)"))
        withdrawn = sum(t["amount"] for t in year_txns if t["type"] == calc.REDEMPTION)
        if withdrawn:
            income.append(line("NPS withdrawal", withdrawn, "attention", "at exit 60 % of the corpus is exempt and the rest must buy an annuity whose payments are taxed at the slab rate; a partial withdrawal of up to 25 % of your own contributions is exempt; withdrawals from Tier II are taxed at the slab rate"))
    return income, deductions


# ---------------------------------------------------------------- what a sale today would be

def unrealised(fund: dict, lots_by_scheme: dict[str, list[dict]], cls: str, latest: tuple[str, float] | None, today: dt.date, ctx: dict) -> dict | None:
    """Units still held split into what would be short-term and long-term if sold today, with the gain of each part
    at the latest price, and the day the oldest short-term lot turns long-term."""
    if cls not in (EQUITY, DEBT, OTHER, SGB) or not latest:
        return None
    price = latest[1]
    iso = today.isoformat()
    st = {"units": 0.0, "cost": 0.0}
    lt = {"units": 0.0, "cost": 0.0}
    turns = []
    for lots in lots_by_scheme.values():
        for lot in lots:
            if lot["units"] <= 1e-9:
                continue
            section, term = _term(cls, lot["date"], iso, {**ctx, "notes": ""})
            if cls == SGB and section == "exempt":
                term = "long"
            if term == "long":
                lt["units"] += lot["units"]
                lt["cost"] += lot["units"] * lot["cpu"]
            else:
                st["units"] += lot["units"]
                st["cost"] += lot["units"] * lot["cpu"]
                if term == "short":
                    months = 12 if cls in (EQUITY, SGB) else 24
                    turns.append((dt.date.fromisoformat(_add_months(lot["date"], months)) + dt.timedelta(days=1)).isoformat())
    if st["units"] + lt["units"] <= 1e-9:
        return None
    return {
        "fund_id": fund["id"], "name": fund["name"], "kind": fund.get("kind") or "MF", "class": cls,
        "price_date": latest[0],
        "short": {"units": st["units"], "value": st["units"] * price, "gain": st["units"] * price - st["cost"]},
        "long": {"units": lt["units"], "value": lt["units"] * price, "gain": lt["units"] * price - lt["cost"]},
        "next_long_term": min(turns) if turns else None,
        "slab_only": cls == DEBT and all(lot["date"] >= SPECIFIED_FROM for lots in lots_by_scheme.values() for lot in lots if lot["units"] > 1e-9),
    }


# ---------------------------------------------------------------- the report

def years_with_activity(holdings: list[dict], today: dt.date) -> list[str]:
    ys = {fy_of(today.isoformat())}
    for h in holdings:
        ys.update(fy_of(t["date"]) for t in h["txns"])
    return sorted(ys, reverse=True)


def report(holdings: list[dict], fy: str, slab_pct: float, today: dt.date) -> dict:
    """Everything the Tax page shows for one financial year. Each holding: {"fund", "txns", "category", "latest",
    "fmv2018", "exit_from", "unconverted"}; amounts are expected in the base currency already."""
    fy_from, fy_to = fy_bounds(fy)
    lines: list[dict] = []
    income: list[dict] = []
    deductions: list[dict] = []
    open_positions: list[dict] = []
    classes: list[dict] = []
    warnings: list[str] = []
    for h in holdings:
        fund, txns = h["fund"], h["txns"]
        info = classify(fund, h.get("category"))
        cls = info["class"]
        classes.append({"fund_id": fund["id"], "name": fund["name"], "kind": fund.get("kind") or "MF", **info})
        if h.get("unconverted"):
            warnings.append(f"{fund['name']}: no exchange rate for {fund.get('currency')}, so its figures are in {fund.get('currency')}, not rupees")
        ctx = {"fmv2018": h.get("fmv2018"), "exit_from": h.get("exit_from")}
        if cls != EXEMPT:
            pieces, lots = walk_lots(txns)
            for p in pieces:
                if fy_from <= p["sale_date"] <= fy_to and p["sale_type"] != calc.CHARGE:
                    a = assess(p, cls, ctx)
                    a.update({"fund_id": fund["id"], "name": fund["name"], "kind": fund.get("kind") or "MF"})
                    lines.append(a)
            u = unrealised(fund, lots, cls, h.get("latest"), today, ctx)
            if u:
                open_positions.append(u)
        inc, ded = income_lines(fund, txns, cls, h.get("category"), fy, today)
        income.extend(inc)
        deductions.extend(ded)
    lines.sort(key=lambda ln: (ln["sale_date"], ln["name"], ln["buy_date"] or ""))
    b = buckets(lines, fy, slab_pct)
    slab_income = sum(x["amount"] for x in income if x["treatment"] == "slab")
    exempt_income = sum(x["amount"] for x in income if x["treatment"] == "exempt")
    attention = sum(x["amount"] for x in income if x["treatment"] == "attention")
    bk = b["buckets"]
    tax_gains = sum(bk[k]["tax"] for k in ("111A", "112A", "112", "slab"))
    tax_income = slab_income * slab_pct / 100.0
    subtotal = tax_gains + tax_income
    cess = subtotal * CESS
    r2 = lambda v: round(v, 2)  # noqa: E731
    for ln in lines:
        for k in ("units", "cost", "proceeds", "gain", "taxable_gain"):
            ln[k] = r2(ln[k])
    for key in bk:
        for k in ("gains", "losses", "net", "set_off", "after_set_off", "exemption", "taxable", "tax"):
            bk[key][k] = r2(bk[key][k])
    for u in open_positions:
        for part in ("short", "long"):
            for k in ("units", "value", "gain"):
                u[part][k] = r2(u[part][k])
    exemption_used = bk["112A"]["exemption"]
    return {
        "fy": fy, "from": fy_from, "to": fy_to, "years": years_with_activity(holdings, today), "slab": slab_pct, "today": today.isoformat(),
        "lines": lines,
        "buckets": bk,
        "exemption": {"limit": b["exemption_limit"], "used": exemption_used, "left": r2(b["exemption_limit"] - exemption_used)},
        "carry_forward": {k: r2(v) for k, v in b["carry_forward"].items()},
        "income": income, "deductions": deductions,
        "totals": {
            "proceeds": r2(sum(ln["proceeds"] for ln in lines)), "cost": r2(sum(ln["cost"] for ln in lines)), "gain": r2(sum(ln["gain"] for ln in lines)),
            "slab_income": r2(slab_income), "exempt_income": r2(exempt_income), "attention_income": r2(attention),
            "deductions_80c": r2(sum(x["amount"] for x in deductions if x["treatment"] == "80C")),
            "deductions_nps": r2(sum(x["amount"] for x in deductions if x["treatment"] == "80CCD")),
        },
        "estimate": {"tax_on_gains": r2(tax_gains), "tax_on_income": r2(tax_income), "subtotal": r2(subtotal), "cess": r2(cess), "total": r2(subtotal + cess),
                     "per_bucket": {k: bk[k]["tax"] for k in ("111A", "112A", "112", "slab")}},
        "open_positions": sorted(open_positions, key=lambda u: -(u["short"]["value"] + u["long"]["value"])),
        "classes": classes,
        "warnings": warnings,
        "rules": {"cutover": CUTOVER, "specified_from": SPECIFIED_FROM, "relief_from": RELIEF_FROM, "grandfather_day": GRANDFATHER_DAY, "cess": CESS,
                  "exemption_limit": b["exemption_limit"], "classes": CLASS_LABELS, "sections": SECTIONS},
    }
