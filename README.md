# Investment Tracker

A local web app for tracking Indian mutual fund investments: funds and folios, SIP / lumpsum
transactions, live NAV, current value, profit, XIRR, value-over-time charts, and how much of the
portfolio is locked versus redeemable.

Everything runs on your machine. Data lives in a SQLite file under `data/`; nothing is sent
anywhere except NAV lookups to the public AMFI-backed API.

## Run as a desktop app (.exe)

Build once with `build_exe.bat` (needs Python 3.10+ installed). It produces
`dist\InvestmentTracker.exe`, a single self-contained file (about 20 MB) that you can copy
anywhere, pin to the taskbar, or put in your Startup folder.

Double-clicking the exe opens a small console window, starts the local server on port 8000
(or the next free port), and opens the app in your default browser. Closing the window stops
the app. The database is kept in a `data` folder next to the exe, so backing up means copying
that folder. If that location isn't writable (for example under Program Files) it falls back to
`%LOCALAPPDATA%\InvestmentTracker\data`.

Environment variables (optional): `INVESTMENT_TRACKER_DATA` overrides the data folder;
`INVESTMENT_TRACKER_NO_BROWSER=1` skips the automatic browser launch.

The exe is unsigned, so Windows SmartScreen may show a "Windows protected your PC" prompt the
first time; choose *More info* then *Run anyway*.

## Run from source (development)

Double-click `run.bat` (or run `.\run.ps1` in PowerShell). It creates a virtual environment on
first run, starts the server with auto-reload and opens http://127.0.0.1:8000.

Manual:

```powershell
py -3 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn backend.main:app --reload
```

Chart.js is bundled under `frontend/vendor`, so the UI itself works offline; only NAV lookups
need internet.

## Features

**Fund page** (`#/fund/<id>`)
- Folio number, display name, AMFI scheme code, fund house and category
- Total investment, current value, total profit (value minus investment), absolute return, XIRR
- Latest NAV with its date and total units held
- Transactions: date, folio (a fund can hold several folios), type (SIP / Lumpsum), amount, NAV, units.
  NAV auto-fills from the NAV history for the chosen date; units default to amount / NAV and can be overridden to match the statement.
- Current value vs invested amount over time, with 1M / 3M / 6M / 1Y / 3Y / All ranges
- Open or Locked status (set by you), with an optional "locked until" date

**Portfolio page** (`#/`)
- Total investment, total current value, total profit, portfolio-wide XIRR
- One row per fund with investment, current value, P&L, XIRR and latest NAV
- Combined value-over-time chart
- Locked value vs redeemable value, by fund status

## How NAV data works

- Source: [mfapi.in](https://www.mfapi.in/), a free JSON API over AMFI's daily published NAVs.
  It replaces the Google Finance code approach: every scheme has an AMFI scheme code, searchable
  by name in the "Add fund" dialog (pick the exact plan: Direct / Regular, Growth / IDCW).
- The full NAV history of each scheme is cached in `data/portfolio.db`. It refreshes automatically
  when older than 6 hours (AMFI publishes NAVs in the evening), or immediately via "Refresh NAV".
  If the API is unreachable the app keeps working with cached values and shows a warning.

## Calculations (`backend/calc.py`)

- Current value = total units x latest NAV
- Profit = current value - total invested
- XIRR = annualised rate solving NPV = 0 over all purchases (negative cashflows on their dates)
  plus the current value as a positive cashflow today. Newton-Raphson with bisection fallback;
  matches Excel's XIRR on its documented example.
- Value over time = units held on each NAV date x that day's NAV; invested is the cumulative
  amount, drawn as a step line. The portfolio chart sums funds day by day, forward-filling a fund
  on days it has no NAV (for example differing holidays).

## Project layout

```
backend/
  main.py   FastAPI routes (JSON API under /api, static frontend at /)
  db.py     SQLite schema and connection
  nav.py    mfapi.in client and NAV cache
  calc.py   XIRR, summaries, value history
frontend/
  index.html, styles.css          shell and theme tokens (light + dark)
  app.js                          hash router, portfolio and fund views, forms
  charts.js                       Chart.js line chart and segmented bar
  api.js, format.js, ui.js        fetch wrapper, INR / date formatting, modal + toast
data/                             portfolio.db (created on first run, git-ignored)
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/portfolio` | Totals, per-fund rows, combined history, locked / redeemable split |
| GET, POST | `/api/funds` | List funds with summaries / create a fund |
| GET, PUT, DELETE | `/api/funds/{id}` | Fund detail with transactions and history / update / delete |
| POST | `/api/funds/{id}/transactions` | Add a SIP or lumpsum purchase |
| PUT, DELETE | `/api/transactions/{id}` | Edit / delete a transaction |
| GET | `/api/schemes/search?q=` | Search AMFI schemes by name |
| GET | `/api/schemes/{code}/nav?on=YYYY-MM-DD` | NAV on (or just before) a date |
| POST | `/api/nav/refresh` | Force-refresh NAV history for all funds |

Interactive docs: http://127.0.0.1:8000/docs

## Ideas for next steps

- Redemption / switch-out transactions (today only purchases are modelled)
- Import a CAMS / KFintech consolidated account statement
- Per-installment lock-in for ELSS (each SIP unlocks three years after its own date)
- Asset allocation, goals, benchmark comparison, CSV export
