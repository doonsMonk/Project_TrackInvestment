"""Mutual fund consolidated account statements (CAS) from CAMS and KFintech, read straight from the PDF.

The detailed CAS lists, folio by folio and scheme by scheme, every transaction of the period: purchases and SIP
instalments, redemptions, switches, dividends, and the small tax lines. This module turns the PDF into the app's
own transaction model so an import can create the holdings it does not have and add the entries it is missing.

Reading the PDF: the statement is a table whose cells pdfminer returns as separate text boxes; boxes that share a
vertical position are joined into one row (tab-separated), and the rows are then matched against a few patterns
(folio line, scheme line, opening / closing balance, one transaction). The approach and the patterns follow the
MIT-licensed `casparser` project's pdfminer path, trimmed to what the app needs and without its ISIN database:
scheme codes are looked up in mfapi.in's scheme list by ISIN, or offered as name matches for the user to confirm.
"""
from __future__ import annotations

import difflib
import io
import re
import threading
import time
from datetime import datetime

from pdfminer.converter import PDFPageAggregator
from pdfminer.layout import LAParams, LTChar, LTContainer, LTTextBox, LTTextBoxHorizontal, LTTextBoxVertical
from pdfminer.pdfdocument import PDFDocument, PDFPasswordIncorrect, PDFSyntaxError
from pdfminer.pdfinterp import PDFPageInterpreter, PDFResourceManager
from pdfminer.pdfpage import PDFPage
from pdfminer.pdfparser import PDFParser

from . import nav


class CasError(Exception):
    """A statement that could not be read; the message is meant for the user."""


# ------------------------------------------------------------------ PDF -> rows of text

def _is_close(a, b, tol):
    return abs(a - b) < tol


def _without_hindi(box: LTContainer) -> LTContainer:
    """CAMS statements carry a Hindi rendering of some labels in a second font; drop those glyphs."""
    box._objs = [o for o in box._objs if not (isinstance(o, LTChar) and "Mangal" in o.fontname)]
    for i, o in enumerate(box._objs):
        if isinstance(o, LTContainer):
            box._objs[i] = _without_hindi(o)
    return box


def _text_boxes(layout: LTContainer) -> list:
    out = []
    for el in layout:
        if isinstance(el, LTTextBox):
            out.append(_without_hindi(el))
        elif isinstance(el, LTContainer):
            out.extend(_text_boxes(el))
    return out


def _rows(pages: list[list]) -> list[str]:
    """Join the text boxes of each page into rows: boxes whose vertical extent overlaps belong to one row, and the
    row's cells are separated by two tabs, left to right."""
    lines: list[str] = []
    for boxes in pages:
        ordered = sorted(boxes, key=lambda b: (-b.y1, b.x0))
        items: list = []
        y0 = y1 = 0.0
        if ordered:
            y0, y1 = ordered[0].y0, ordered[0].y1
        for el in ordered:
            if items and not (_is_close(el.y1, y1, 5) or _is_close(el.y0, y0, 5) or _is_close(el.y1, y0, 2) or _is_close(el.y0, y1, 2)):
                line = "\t\t".join(b.get_text().strip() for b in sorted(items, key=lambda b: b.x0))
                if line.strip():
                    lines.append(line)
                items = []
                y0, y1 = el.y0, el.y1
            items.append(el)
        if items:
            line = "\t\t".join(b.get_text().strip() for b in sorted(items, key=lambda b: b.x0))
            if line.strip():
                lines.append(line)
    return lines


def pdf_rows(data: bytes, password: str) -> tuple[str, list[str]]:
    """(source, rows) for a CAS PDF: source is CAMS, KFINTECH or UNKNOWN."""
    parser = PDFParser(io.BytesIO(data))
    try:
        document = PDFDocument(parser, password=password or "")
    except PDFPasswordIncorrect as e:
        raise CasError("The PDF password is wrong. It is usually your PAN, or what you chose when asking for the statement.") from e
    except PDFSyntaxError as e:
        raise CasError("This file is not a readable PDF.") from e
    except Exception as e:  # noqa: BLE001 - pdfminer raises assorted errors on odd files
        raise CasError(f"The PDF could not be opened: {e}") from e
    source = "UNKNOWN"
    for info in document.info:
        producer = info.get("Producer", b"")
        producer = producer.decode("utf8", "ignore") if isinstance(producer, bytes) else str(producer)
        if "Data Dynamics ActiveReports" in producer:
            source = "KFINTECH"
        elif "Stimulsoft Reports" in producer:
            source = "CAMS"
    line_margin = {"KFINTECH": 0.1, "CAMS": 0.2}.get(source, 0.01)
    manager = PDFResourceManager()
    device = PDFPageAggregator(manager, laparams=LAParams(line_margin=line_margin, detect_vertical=True, all_texts=True))
    interpreter = PDFPageInterpreter(manager, device)
    pages = []
    for page in PDFPage.create_pages(document):
        interpreter.process_page(page)
        boxes = _text_boxes(device.get_result())
        if source == "UNKNOWN":
            for el in boxes:
                if isinstance(el, LTTextBoxVertical):
                    t = el.get_text()
                    if "CAMSCASWS" in t:
                        source = "CAMS"
                    elif "KFINCASWS" in t:
                        source = "KFINTECH"
            for el in boxes:
                t = el.get_text()
                if "NSDL Consolidated Account Statement" in t or "Central Depository Services" in t:
                    raise CasError("This is a depository (NSDL / CDSL) statement. The app reads the mutual fund CAS from CAMS or KFintech.")
        pages.append(boxes)
    return source, _rows(pages)


# ------------------------------------------------------------------ rows -> folios, schemes, transactions

DATE = r"(\d{2}-[A-Za-z]{3}-\d{4})"
AMT = r"([(-]*\d[\d,.]+)\)*"
PERIOD_RE = re.compile(r"(?P<from>\d{2}-[a-zA-Z]{3}-\d{4})\s+to\s+(?P<to>\d{2}-[a-zA-Z]{3}-\d{4})", re.I)
SUMMARY_RE = re.compile(r"consolidated\s+account\s+summary|as\s+on\s+\d{2}-[a-zA-Z]{3}-\d{4}", re.I)
AMC_RE = re.compile(r"^(.+?\s+(MF|Mutual\s*Fund)|franklin\s+templeton\s+investments)$", re.I)
FOLIO_RE = re.compile(r"^Folio\s+No\s*:\s+([\d/\s]+\d)\s")
FOLIO_KV_RE = re.compile(r"(PAN|KYC)\s*:\s*([A-Z]{5}\d{4}[A-Z]|OK|NOT OK)")
SCHEME_RE = re.compile(r"(?P<code>[\s\w]+-*[gdp]?)-\s*\d*\s*(?P<name>.+?)(?:\t\t|\(\s*Advis|ISIN).*?Registrar\s*:\s*(?P<rta>[^\s]*).*$", re.I | re.S)
SCHEME_KV_RE = re.compile(r"(\w+)\s*:\s*([-\w]+)", re.I)
REGISTRAR_RE = re.compile(r"^\s*Registrar\s*:\s*(.*)\s*$")
OPEN_RE = re.compile(r"Opening\s+Unit\s+Balance.+?([\d,.]+)")
CLOSE_RE = re.compile(r"Closing\s+Unit\s+Balance.+?([\d,.]+)")
VALUATION_RE = re.compile(r"(?:Valuation|Market\s+Value)\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.]+)", re.I)
NAV_RE = re.compile(r"NAV\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.]+)", re.I)
# the date and the description may land in one text box when the columns sit close together
TXN_RES = [re.compile(p, re.I | re.S) for p in (
    rf"{DATE}(?:\t\t|\s+)([^0-9].*)\t\t{AMT}\t\t{AMT}\t\t{AMT}\t\t{AMT}",          # the usual row: amount, units, nav, balance
    rf"{DATE}(?:\t\t|\s+)([^0-9].*)\t\t{AMT}\t\t(?:{AMT})*\t\t{AMT}\t\t{AMT}",     # zero units
    rf"{DATE}(?:\t\t|\s+)([^0-9].*)\t\t{AMT}\t\t{AMT}(?:\t\t{AMT}\t\t{AMT})*",     # segregated portfolio
    rf"{DATE}(?:\t\t|\s+)([^0-9].*)\t\t{AMT}(?:\t\t{AMT}\t\t{AMT}\t\t{AMT})*",     # tax lines: an amount only
)]
TAIL_RE = re.compile(r"(\n.+?)(\t\t|$)")
DIVIDEND_RE = re.compile(r"(?:div\.|dividend|idcw).+?(reinvest)*.*?@\s*Rs\.\s*([\d.]+)(?:\s+per\s+unit)?", re.I | re.S)
ISIN_RE = re.compile(r"\b(INF[0-9A-Z]{8}[0-9])\b")


def _num(s: str | None) -> float | None:
    if s is None:
        return None
    s = s.strip().replace(",", "")
    neg = s.startswith("(") or s.startswith("-")
    s = s.strip("()-")
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def _iso(dmy: str) -> str:
    return datetime.strptime(dmy, "%d-%b-%Y").date().isoformat()


def _scheme_name(raw: str) -> str:
    s = re.sub(r"\((formerly|erstwhile).+?\)", "", raw, flags=re.I | re.S).strip()
    s = re.sub(r"\((Demat|Non-Demat).*", "", s, flags=re.I | re.S).strip()
    s = re.sub(r"\s+", " ", s).strip()
    return re.sub(r"[^a-zA-Z0-9_)]+$", "", s).strip()


def classify(description: str, units: float | None) -> str:
    """The app's transaction type for a CAS line, or a reason to skip it (TAX, REVERSAL, SEGREGATION, OTHER)."""
    d = description.lower()
    if DIVIDEND_RE.search(d):
        return "LUMPSUM" if DIVIDEND_RE.search(d).group(1) else "DIVIDEND"  # reinvested dividends buy units
    if units is None:
        return "TAX" if ("stt" in d or "stamp" in d or "tds" in d) else "OTHER"
    if units > 0:
        if "switch" in d:
            return "SWITCH_IN"
        if "segregat" in d:
            return "SEGREGATION"
        if "sip" in d or "systematic" in d or re.search(r"instal+ment", d) or re.search(r"sys.+?invest", d, re.S):
            return "SIP"
        return "LUMPSUM"
    if units < 0:
        if re.search(r"reversal|rejection|dishonou?red|mismatch|insufficient\s+balance|payment\s+not\s+received", d):
            return "REVERSAL"
        if "switch" in d:
            return "SWITCH_OUT"
        return "REDEMPTION"
    return "OTHER"


def _parse_txn(line: str):
    for rx in TXN_RES:
        m = rx.search(line)
        if not m:
            continue
        g = m.groups()
        date = desc = amount = units = navv = balance = None
        none = g.count(None)
        if none == 3:
            date, desc, amount, *_ = g
        elif none == 2:
            date, desc, units, balance, *_ = g
        elif none == 1:
            date, desc, amount, units, navv, balance = g
            units = "0.000"
        elif none == 0:
            date, desc, amount, units, navv, balance = g
        if date is None:
            continue
        if desc and re.match(r"\s*\*\*\*", desc):  # ``*** Stamp Duty ***`` lines carry an amount only
            if amount is None and units is not None:
                amount = units
            units = None
            balance = None
        return date, desc, amount, units, navv, balance
    return None


def parse_rows(rows: list[str]) -> dict:
    """The statement as {period, folios: [{folio, amc, schemes: [{name, rta, rta_code, isin, open, close, nav, value,
    valuation_date, transactions: [...]}]}]}. Each transaction: {date, description, amount, units, nav, balance, type}."""
    head = "\n".join(rows[:40])
    m = PERIOD_RE.search(head)
    if not m:
        if SUMMARY_RE.search(head):
            raise CasError("This is the summary CAS, which lists holdings without transactions. Ask CAMS or KFintech for the detailed statement.")
        raise CasError("The statement period was not found. Is this a CAMS or KFintech consolidated account statement?")
    period = {"from": _iso(m.group("from")), "to": _iso(m.group("to"))}
    folios: dict[str, dict] = {}
    current_folio = None
    current_amc = None
    scheme: dict | None = None

    def close_scheme():
        nonlocal scheme
        if scheme and current_folio:
            folios[current_folio]["schemes"].append(scheme)
        scheme = None

    for idx, line in enumerate(rows):
        nxt = rows[idx + 1].strip() if idx + 1 < len(rows) else ""
        # a scheme name long enough to push the registrar cell onto the next visual row, and the other way round
        if REGISTRAR_RE.search(line) and idx + 1 < len(rows):
            line = "\t\t".join([rows[idx + 1], line])
        elif re.search(r"Registrar\s*:\s*$", line) and nxt:
            two = re.match(r"^([-\w]+)\)\s*\t+\s*(\S+)\s*$", nxt)
            if two and re.search(r"\(Advisor\s*:\s*\t", line):
                line = re.sub(r"(\(Advisor\s*:\s*)", r"\g<1>" + two.group(1) + ")", line, count=1) + two.group(2)
            else:
                line = line + nxt
        elif re.search(r"\(Advisor\s*:\s*(?:\t|$)", line) and re.match(r"^[-\w]+\)\s*$", nxt):
            line = re.sub(r"(\(Advisor\s*:\s*)", r"\g<1>" + nxt.rstrip(")") + ")", line, count=1)
        elif re.search(r"Registrar\s*:\s*\w+\s*$", line) and re.search(r"^[-\w]+-", line) and re.search(r"ISIN\s*:|\(Advisor\s*:", nxt):
            line = line + " " + nxt

        if AMC_RE.search(line):
            current_amc = AMC_RE.search(line).group(0).strip()
            continue
        fm = FOLIO_RE.search(line)
        if fm:
            folio = fm.group(1).strip()
            if folio != current_folio:
                close_scheme()
                current_folio = folio
                if folio not in folios:
                    pan = ""
                    for k, v in FOLIO_KV_RE.findall(line):
                        if k == "PAN" and len(v) == 10:
                            pan = v
                    folios[folio] = {"folio": folio, "amc": current_amc or "", "pan": pan, "schemes": []}
            continue
        sm = SCHEME_RE.search(line)
        if sm:
            if current_folio is None:
                raise CasError("The statement's layout was not understood: a scheme appears before any folio.")
            name = _scheme_name(sm.group("name"))
            if scheme is None or scheme["name"] != name:
                close_scheme()
                meta = {k.strip().lower(): v.strip() for k, v in SCHEME_KV_RE.findall(line)}
                isin = meta.get("isin")
                if not isin:
                    im = ISIN_RE.search(line)
                    isin = im.group(1) if im else None
                scheme = {"name": name, "rta": sm.group("rta").strip(), "rta_code": sm.group("code").strip(), "isin": isin,
                          "advisor": meta.get("advisor"), "open": 0.0, "close": None, "nav": None, "value": None, "valuation_date": None,
                          "transactions": []}
            continue
        if scheme is None:
            continue
        om = OPEN_RE.search(line)
        if om:
            scheme["open"] = _num(om.group(1)) or 0.0
            continue
        cm = CLOSE_RE.search(line)
        if cm:
            scheme["close"] = _num(cm.group(1))
        vm = VALUATION_RE.search(line)
        if vm:
            scheme["valuation_date"] = _iso(vm.group(1))
            scheme["value"] = _num(vm.group(2))
        nm = NAV_RE.search(line)
        if nm:
            scheme["valuation_date"] = _iso(nm.group(1))
            scheme["nav"] = _num(nm.group(2))
            continue
        tail = ""
        tm = TAIL_RE.search(line)
        if tm:
            tail = tm.group(1).strip()
            line = line.replace(tm.group(1), "")
        parsed = _parse_txn(line)
        if not parsed:
            continue
        date, desc, amount, units, navv, balance = parsed
        desc = " ".join(x for x in [desc.strip(), tail] if x)
        units_v = _num(units)
        kind = classify(desc, units_v)
        scheme["transactions"].append({
            "date": _iso(date), "description": re.sub(r"\s+", " ", desc), "amount": _num(amount), "units": units_v,
            "nav": _num(navv), "balance": _num(balance), "type": kind,
        })
    close_scheme()
    if not folios:
        raise CasError("No folios were found in the statement. The app reads the detailed CAS from CAMS or KFintech.")
    return {"period": period, "folios": list(folios.values())}


def read_pdf(data: bytes, password: str) -> dict:
    source, rows = pdf_rows(data, password)
    out = parse_rows(rows)
    out["source"] = source
    return out


# ------------------------------------------------------------------ scheme codes from mfapi.in

_list_lock = threading.Lock()
_list_cache: dict = {"at": 0.0, "by_isin": {}, "names": []}
LIST_TTL = 24 * 3600


def scheme_list() -> dict:
    """mfapi.in's scheme list, as {isin: (code, name)} and a names list for fuzzy matching; cached for a day."""
    with _list_lock:
        if time.time() - _list_cache["at"] < LIST_TTL and _list_cache["by_isin"]:
            return _list_cache
        data = nav._get_json(f"{nav.MFAPI_BASE}/mf")
        if not isinstance(data, list):
            raise CasError("mfapi.in's scheme list could not be fetched; the statement can still be read, but schemes must be matched by hand.")
        by_isin: dict[str, tuple[int, str]] = {}
        names: list[tuple[str, int, str]] = []
        for item in data:
            try:
                code, name = int(item["schemeCode"]), str(item["schemeName"])
            except (KeyError, ValueError, TypeError):
                continue
            names.append((name.lower(), code, name))
            for key in ("isinGrowth", "isinDivReinvestment"):
                isin = item.get(key)
                if isin:
                    by_isin[str(isin).strip().upper()] = (code, name)
        _list_cache.update({"at": time.time(), "by_isin": by_isin, "names": names})
        return _list_cache


_NOISE = {"fund", "plan", "growth", "direct", "regular", "option", "the", "and", "of", "scheme", "mutual", "mf"}


def _words(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in _NOISE and len(w) > 1}


def suggest_codes(name: str, listing: dict, limit: int = 6) -> list[dict]:
    """Likely mfapi.in schemes for a CAS scheme name: shared significant words first, then string similarity."""
    want = _words(name)
    if not want:
        return []
    scored = []
    for low, code, full in listing["names"]:
        have = _words(low)
        shared = len(want & have)
        if shared < max(1, len(want) // 2):
            continue
        ratio = difflib.SequenceMatcher(None, name.lower(), low).ratio()
        direct = ("direct" in low) == ("direct" in name.lower())
        growth = ("growth" in low) == ("growth" in name.lower() or "idcw" not in name.lower())
        scored.append((shared + ratio + (0.5 if direct else 0) + (0.3 if growth else 0), code, full))
    scored.sort(key=lambda x: -x[0])
    return [{"scheme_code": c, "scheme_name": n} for _, c, n in scored[:limit]]
