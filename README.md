# Investment Tracker

A local web app for tracking Indian mutual funds, stocks on any exchange, NPS accounts and EPF: funds with
folios, stocks with accounts, NPS schemes E / C / G with their own NAVs, EPF deposits and credited interest, purchases / sales / dividends / bonus units, live NAVs and prices, current
value, profit, XIRR, value-over-time charts, currency conversion to INR, and how much of the
portfolio is locked versus redeemable.

Everything runs on your machine. Data lives in one password-encrypted file under `data/`; nothing is
sent anywhere except NAV lookups to the public AMFI-backed API, price / exchange-rate lookups to
Yahoo Finance and NPS NAV lookups to NPS Trust.

**Using the app?** Read the [User Guide](docs/USER_GUIDE.md); it explains every screen and feature.
The rest of this file is about running, building and developing it.

## Password protection

- On first start you choose a password. From then on the app asks for it every time it opens, and
  nothing can be read or added until it is entered. The "Lock" button in the top bar locks it on demand,
  and it locks itself after 30 minutes without use.
- **There is no password recovery.** The password is never stored, and the data file cannot be opened
  without it. If you forget the password, the data is gone; the only way forward is to delete
  `data/portfolio.enc` and start again. Choose something you will remember and consider keeping it in
  a password manager.
- "Password" in the top bar changes the password (the current one is required).
- How it works: the database is held in memory while unlocked and written to disk only as
  `data/portfolio.enc`, encrypted with AES-256-GCM. The key is derived from your password with scrypt,
  and the file is authenticated, so a wrong password or a tampered file is rejected rather than
  producing garbage. Every change is re-encrypted and saved immediately.
- Upgrading from the unencrypted version: when an old `data/portfolio.db` is found, the setup screen
  encrypts it into `portfolio.enc` and removes the plaintext file once the new file has been verified.
- Back up `data/portfolio.enc`. A backup is only useful together with the password.
- `INVESTMENT_TRACKER_IDLE_LOCK_MINUTES` changes the auto-lock delay (0 disables it).

## Software required

**Just using the app (the exe):** nothing to install. You need Windows 10 or 11, any modern browser
(Edge, Chrome, Firefox), and an internet connection for NAV updates. Copy `InvestmentTracker.exe`
anywhere and double-click it.

**Building the exe or running from source** needs the tools below. Run the commands in PowerShell
(press Win, type `powershell`, Enter). `winget` is built into Windows 10/11.

| Tool | Needed for | Install |
|---|---|---|
| Python 3.10 or newer | building the exe, running from source | `winget install Python.Python.3.14` |
| Git | cloning the repository, pushing changes | `winget install Git.Git` |
| Python packages (FastAPI, Uvicorn, cryptography, truststore, PyInstaller, Pillow) | same as Python | installed automatically by `run.bat` / `build_exe.bat` |

Step by step:

1. **Install Python.** Either run `winget install Python.Python.3.14`, or download it from
   https://www.python.org/downloads/ and in the installer tick *Add python.exe to PATH* and keep
   *py launcher* selected. Close and reopen PowerShell afterwards.
2. **Install Git** (only if you want to clone the repo or push changes):
   `winget install Git.Git`, or download from https://git-scm.com/download/win. Reopen PowerShell.
3. **Get the project.** Either `git clone https://github.com/doonsMonk/Project_TrackInvestment.git`
   or download the ZIP from GitHub and extract it.
4. **Build or run.** Double-click `build_exe.bat` to produce the exe, or `run.bat` to run from
   source. On first run either script creates a virtual environment in `.venv` and installs the
   Python packages listed in `requirements.txt` (runtime) and `requirements-build.txt` (build tools).
   This needs internet once and takes a minute.

Check your setup from PowerShell:

```powershell
py --version        # Python 3.10.x or newer
git --version       # git version 2.x (only if you installed Git)
```

Manual package install, if you prefer not to use the bat files:

```powershell
py -3 -m venv .venv
.venv\Scripts\python -m pip install -r requirements-build.txt
```

## Run as a desktop app (.exe)

Build once with `build_exe.bat` (see *Software required* above). It produces
`dist\InvestmentTracker.exe`, a single self-contained file (about 20 MB) that you can copy
anywhere, pin to the taskbar, or put in your Startup folder.

Double-clicking the exe starts the local server (port 8000, or the next free one) and opens the app
in its own window, with no console and no browser tabs. The window is Microsoft Edge (or Chrome) in
"app" mode with a private profile stored under the data folder, so it behaves like a standalone
program: closing the window stops the app. If neither browser is installed, the default browser is
used and a small status window provides a Quit button. Double-clicking the exe again while it is
running just opens another window to the same instance; double-clicking a *newer* exe asks the older
instance to quit (`POST /api/quit`) and takes its place. The launcher clears the window's cache on
every start and the server sends `Cache-Control: no-cache` for static files and `no-store` for the
API, so an upgrade never shows stale scripts. The running version is shown in the top bar and in
`/api/auth/status`.

The encrypted database is kept in a `data` folder next to the exe, so backing up means copying that
folder. If that location isn't writable (for example under Program Files) it falls back to
`%LOCALAPPDATA%\InvestmentTracker\data`. Because there is no console, messages go to
`data\app.log`.

Environment variables (optional): `INVESTMENT_TRACKER_DATA` overrides the data folder;
`INVESTMENT_TRACKER_NO_BROWSER=1` runs the server without opening a window (useful for tests);
`INVESTMENT_TRACKER_BASE_CURRENCY` changes the currency portfolio totals are shown in (default `INR`).

The exe is unsigned, so Windows SmartScreen may show a "Windows protected your PC" prompt the
first time; choose *More info* then *Run anyway*.

## Run from source (development)

Double-click `run.bat` (or run `.\run.ps1` in PowerShell). It creates a virtual environment on
first run, then starts the app in its own window exactly like the exe does, leaving no console open.
Logs go to `data\app.log`.

Manual (keeps a console, handy for watching requests):

```powershell
py -3 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn backend.main:app --reload
```

Chart.js is bundled under `frontend/vendor`, so the UI itself works offline; only NAV lookups
need internet.

## Features

**Holdings** are mutual funds (linked to an AMFI scheme code), stocks / ETFs (linked to a Yahoo
Finance symbol such as `RELIANCE.NS`, `ALL.AX`, `AAPL`, `VOD.L`) or NPS accounts (a pension fund manager
and tier, with one NPS Trust scheme id per asset class: `SM007001` = ICICI Scheme E Tier I, and so on).
An NPS account is valued scheme by scheme; its `summary` adds the schemes up (`units` and `latest_nav`
are null there), `schemes[]` carries one summary per scheme, and `?scheme=E` scopes the detail to one.
An EPF account (`kind: EPF`) has no price source at all: a rupee is a unit (nav 1), deposits are purchases
of the employee (`scheme: EE`) or employer (`ER`) share, interest credited is BONUS units (zero cost), the
pension contribution is `EPS` and only summed, and `rate` records the year's interest rate. The payload adds
`epf.years` (one row per financial year with closing balances) and `epf.pending_interest_fy`. A stock is tracked in its exchange's
currency; the portfolio converts to INR at daily exchange rates (each cashflow at its own date's rate,
today's value at the latest rate), so the INR return includes the currency movement and the holding's
page shows the return in both currencies.

**Fund / stock page** (`#/fund/<id>`)
- Folio number, display name, AMFI scheme code, fund house and category; for a stock the symbol,
  exchange, currency, company name and account
- Total investment, current value, total profit (value minus investment), absolute return, XIRR
  (and the INR equivalents for a foreign stock)
- Latest NAV / price with its date and total units / shares held
- Transactions: date, folio or account, type, amount, NAV / price, units. Types: SIP and Lumpsum / Buy
  (purchases), Redemption / Sell, Dividend (cash received, holdings unchanged), Bonus (free units at
  zero cost), Switch in / out (value moved between NPS schemes, no investor cash) and Charges (units
  deducted for fees, valued at that day's NAV). Price auto-fills from history for the chosen date; units
  default to amount / price and can be overridden to match the statement. NPS transactions carry a
  `scheme` letter.
- Exit: records a sale of everything held (units pre-filled, amount = units x latest price, editable).
  Any sale that brings the units to zero marks the holding `closed`: it keeps all its data, is listed
  under a Closed tab on the portfolio page, and reopens on the next purchase.
- Dividends are realised income: shown with the gains from sales, never in the unrealised profit; the
  investment figure is also shown net of dividends (`net_invested`), while the cost basis stays untouched.
- Fixing a wrongly chosen holding: "Edit" (on its page, or Edit on a portfolio row) changes the name,
  the linked AMFI scheme or stock symbol, the default folio / account, status and notes. Transactions
  are never touched by this: if the holding was linked to a similarly named scheme (IDCW instead of
  Growth, Regular instead of Direct) or the wrong listing, pick the correct one and the existing
  transactions are simply revalued with its price history. Optionally, a corrected default folio can
  also be applied to the transactions that still carry the old one.
- Comments: every SIP or lumpsum transaction can carry a free-text comment (for example "bonus money",
  "top-up on dip"). Add it in the transaction form, or click the Comment cell in the table to edit it
  inline (Enter saves, Escape cancels). The import dialog can map a comment column from the data or apply
  one comment to the whole batch, and comments can be edited per row afterwards.
- Folios: a fund can hold transactions from several folios. The fund page lists every folio with its own
  invested amount, units, current value, P&L and XIRR, and a folio filter scopes the figures, the chart and
  the transaction list to one folio (the URL carries the filter, so it can be bookmarked).
- Import: paste a whole table from Excel, Google Sheets, a CSV or broker contract notes (or pick a file).
  Columns are detected from the header row (folio / account, name / symbol, type, date, amount,
  units / qty / shares, NAV / price in any order) and can be re-mapped in the preview. Dates like
  `11-Mar-2019`, `11/03/2019` or `2019-03-11` are accepted; negative amounts count as purchases; sales
  are recognised from negative units, Sell / Redemption / `S` type words, or positive amounts in a file
  whose purchases are negative; dividends from Dividend / Payout words or money with 0 units; bonus units
  from Bonus / Free / Split words or units with 0 money. Missing price or units are filled from history,
  and rows already recorded are skipped.
- Current value vs invested amount over time, with 1M / 3M / 6M / 1Y / 3Y / All ranges
- Open or Locked status (set by you), with an optional "locked until" date

**Portfolio page** (`#/`), everything in INR
- Total investment, total current value, total profit, realised gains and dividends, portfolio-wide XIRR
- One row per holding with investment, current value, P&L, XIRR and latest NAV / price (foreign stocks
  show the INR figure with the native amount underneath)
- Combined value-over-time chart
- Allocation ring (pie) by asset class, driven by `totals.by_kind` so new classes appear automatically,
  with counts, invested amounts and shares, plus one line per foreign currency (amount held, rate used
  and its date)
- Locked value vs redeemable value, by holding status
- EPF page: by-financial-year table plus a stacked column chart of employee deposits, employer deposits and
  interest credited per year
- Active / Closed tabs on the holdings table, rows grouped by asset class with subtotals (groups collapse on click); closed holdings
  show bought, sold-for, realised (incl. dividends) and final XIRR

## How price data works

- NPS scheme NAVs: NPS Trust (`https://npstrust.org.in/nav-report-excel`, a tab-separated daily file of every
  scheme with its id, and `https://npstrust.org.in/nav-graphs-details?lnavdata=PFM007&yearval=all&subcat=SM007001`,
  the chart endpoint that returns a scheme's full daily history). The site omits an intermediate certificate,
  so `backend/__init__.py` makes Python verify HTTPS through the Windows certificate store (`truststore`).
- Mutual fund NAVs: [mfapi.in](https://www.mfapi.in/), a free JSON API over AMFI's daily published
  NAVs. Every scheme has an AMFI scheme code, searchable by name in the "Add" dialog (pick the exact
  plan: Direct / Regular, Growth / IDCW).
- Stock prices and exchange rates: Yahoo Finance's public chart and search endpoints
  (`query1.finance.yahoo.com/v8/finance/chart/<symbol>`, `query2.finance.yahoo.com/v1/finance/search`).
  Daily closes for any symbol; exchange rates are the same kind of series under symbols like `AUDINR=X`.
  No API key. Prices reported in minor units (LSE pence) are converted to the major unit. The request
  uses an explicit period range rather than `range=max`, which quietly returns monthly bars.
- The full history of each scheme, symbol and currency pair is cached inside the encrypted database
  (`nav_history` / `quotes`). It refreshes automatically when older than 6 hours, or immediately via
  "Refresh prices". If a source is unreachable the app keeps working with cached values and shows a
  warning; a failed source is not retried for 10 minutes, and the remembered error keeps being reported.

## Calculations (`backend/calc.py`)

- EPF needs no new maths: with one rupee per unit, `summarize` on each share gives deposits (invested),
  balance (value), interest (bonus units) and XIRR; `calc.aggregate` adds the shares up, and the return on own
  contributions is `xirr` over employee deposits plus today's balance. Interest is entered, never computed.
- Transaction types: SIP, LUMPSUM (purchases), REDEMPTION (sale), DIVIDEND (cash in, holdings
  unchanged), BONUS (free units, a zero-cost lot), SWITCH_OUT / SWITCH_IN (a sale and a purchase funded
  inside the holding, as in an NPS rebalance) and CHARGE (a sale whose proceeds are lost). Amounts and
  units are stored as non-negative magnitudes and the type gives the direction. Sales, switches out and
  charges consume lots FIFO. Investor cashflows (`calc.cashflows`) are purchases, redemptions and dividends
  only; `internal=True` adds switches, which is how one NPS scheme's own XIRR is computed, while the account
  XIRR (`calc.aggregate`) uses the investor flows. `total_gain = profit + realised + dividends - charges`.
- Invested = FIFO cost of the units still held; realised gain = sale proceeds - cost of sold units;
  dividends summed separately; total gain = unrealised profit + realised gain + dividends
- Current value = units held x latest NAV / price; profit (unrealised) = current value - invested
- XIRR = annualised rate solving NPV = 0 over purchases (negative cashflows), sales and dividends
  (positive) and the current value as a positive cashflow today. Newton-Raphson with bisection fallback;
  matches Excel's XIRR on its documented example.
- Currency: a holding in another currency gets a second summary in the base currency, computed by
  converting every transaction at its own date's rate (`RateSeries`, forward-filled over weekends) and
  the latest price at the latest rate. Portfolio totals, the combined chart and the portfolio XIRR use
  the converted figures; a holding whose rate is not cached yet is reported and left out.
- Value over time = units held on each price date x that day's price; invested is the FIFO cost of the
  units held that day, drawn as a step line. The portfolio chart sums holdings day by day, forward-filling
  each on days it has no price (different exchange holidays).

## Project layout

```
backend/
  main.py   FastAPI routes (JSON API under /api, static frontend at /)
  db.py     encrypted vault: in-memory SQLite, AES-GCM file on disk, password handling
  nav.py    mfapi.in client and NAV cache (mutual funds)
  quotes.py Yahoo Finance client and price / exchange-rate cache (stocks), base currency
  nps.py    NPS Trust client (scheme list, per-scheme NAV history) cached in the quotes table
  calc.py   XIRR, FIFO lots, summaries, value history, currency conversion
frontend/
  index.html, styles.css          shell and theme tokens (light + dark)
  app.js                          hash router, portfolio and holding views, forms (kind-aware wording)
  import.js, parse.js             paste-a-table import dialog and its (DOM-free) parsing helpers
  charts.js                       Chart.js line chart and segmented bar (currency-aware)
  api.js, format.js, ui.js        fetch wrapper, multi-currency / date formatting, modal + toast
data/                             portfolio.enc (encrypted database, created on first run, git-ignored)
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auth/status` | `setup`, `locked` or `unlocked` |
| POST | `/api/auth/setup`, `/unlock`, `/lock`, `/change-password` | Password lifecycle. Every other endpoint answers 409 before setup and 423 while locked |
| GET | `/api/portfolio` | Totals in the base currency, per-holding rows, combined history, kind split, per-currency lines, locked / redeemable split |
| GET, POST | `/api/funds` | List holdings with summaries / create one. Body: `kind` (`MF` with `scheme_code`, or `STOCK` with `symbol`), `name`, `folio_number`, `locked`, `lock_in_until`, `notes` |
| GET, PUT, DELETE | `/api/funds/{id}` | Holding detail with transactions, history (and `base` / `history_base` in the base currency for a foreign stock) and per-folio summaries / update / delete. `?folio=` scopes the detail to one folio |
| POST | `/api/funds/{id}/transactions` | Add a transaction (`SIP`, `LUMPSUM`, `REDEMPTION`, `DIVIDEND`, `BONUS`, `SWITCH_IN`, `SWITCH_OUT`, `CHARGE`; `scheme` for NPS / EPF; `rate` for EPF) |
| POST | `/api/funds/{id}/epf-transfer` | EPF job change: creates the new employer's account (same UAN) and moves the EE / ER entries to it; EPS stays unless `move_pension`. Both accounts get `details.transferred_*` links |
| POST | `/api/funds/{id}/transactions/bulk` | Add many at once (all or nothing; fills price / units from history) |
| PUT, DELETE | `/api/transactions/{id}` | Edit / delete a transaction |
| PATCH | `/api/transactions/{id}/notes` | Change only the comment on a transaction |
| GET | `/api/schemes/search?q=` | Search AMFI schemes by name |
| GET | `/api/schemes/{code}/nav?on=YYYY-MM-DD` | NAV on (or just before) a date |
| GET | `/api/stocks/search?q=` | Search stock / ETF symbols by name or ticker, any exchange |
| GET | `/api/stocks/{symbol}/quote?on=YYYY-MM-DD` | Closing price on (or just before) a date, plus name, exchange and currency |
| GET | `/api/nps/schemes?q=` | Every NPS scheme NPS Trust publishes, grouped by pension fund manager, with letter / tier / variant and latest NAV |
| GET | `/api/nps/{scheme_id}/nav?on=YYYY-MM-DD` | An NPS scheme's NAV on (or just before) a date |
| POST | `/api/nav/refresh` | Force-refresh every NAV history, price history and exchange rate in use |

Interactive docs: http://127.0.0.1:8000/docs

## Ideas for next steps

- Import a CAMS / KFintech consolidated account statement or a broker holdings statement
- Stock splits as an adjustment (today a split is recorded as bonus shares)
- Per-installment lock-in for ELSS (each SIP unlocks three years after its own date)
- Asset allocation, goals, benchmark comparison, CSV export
