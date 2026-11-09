# Investment Tracker — User Guide

Investment Tracker is a small app that runs on your own computer and keeps track of your investments:
Indian mutual funds, shares on any stock exchange in the world, your NPS (National Pension System)
account, your EPF (Employees' Provident Fund) and PPF accounts, Sovereign Gold Bonds, bank fixed deposits and life insurance policies (LIC endowment plans and the like). It records which funds, stocks and NPS schemes you hold,
every EPF deposit and the interest credited on it, every purchase, sale, dividend and bonus, what the holdings are worth today, and how well
they have performed. All data stays on your machine in a password-protected file. The only things the
app fetches from the internet are the daily NAVs of your funds, the daily prices of your stocks, the daily NAVs of your NPS schemes and the exchange rates needed to
show everything in rupees.

This guide covers every feature in the app. The last section lists what was added when.

---

## 1. Key terms

| Term | Meaning in this app |
|---|---|
| **Holding** | One thing you own: a mutual fund or a stock. The portfolio page lists all holdings together. |
| **Fund** | One mutual fund scheme you invest in, for example "Parag Parikh Flexi Cap Fund – Direct Plan – Growth". Each fund is linked to an official AMFI scheme code, which is how the app fetches its NAV. |
| **Stock** | Shares of a listed company or an ETF, on any exchange: NSE, BSE, ASX, NASDAQ, NYSE, LSE and so on. Each stock is linked to a ticker **symbol** such as `RELIANCE.NS`, `BHP.AX` or `AAPL`, which is how the app fetches its price. |
| **Currency** | The money a stock is traded in (AUD for an ASX share, USD for a US share). The app keeps each stock in its own currency and converts to **INR** for the portfolio totals. Mutual funds are always INR. |
| **Folio / Account** | For a fund: the folio number the fund house gave you. For a stock: the broker or demat account (optional). One holding can have several; each transaction records which one it belongs to. |
| **Transaction** | A purchase (**SIP** installment, **Lumpsum**, or **Buy** for a stock), a sale (**Redemption** / **Sell**), a **Dividend** received, or **Bonus** (free) units or shares. It has a date, amount, NAV / price, units and an optional comment. |
| **Realised gain** | Profit already taken by selling units: the sale proceeds minus what those units cost. Shown separately from the unrealised profit on units you still hold. |
| **Dividends** | Cash paid out to you by a company or fund (an IDCW payout). Counted in your return but it does not change the units you hold. |
| **NAV / Price** | The price of one unit of a fund (Net Asset Value) or one share of a stock on a given day. The app downloads the full daily history of each holding. |
| **Current value** | Units you hold × latest NAV or price. |
| **Profit / P&L** | Current value − amount invested. |
| **XIRR** | Your annualised return taking the timing of every purchase, sale and dividend into account, the same figure Excel's XIRR gives. |
| **Open / Locked** | Whether a holding can be sold today (open) or is under a lock-in such as the 3-year ELSS lock-in or a vesting period (locked). You set this yourself. |
| **Closed** | A holding you have sold out of completely. It keeps all its transactions, realised gains and dividends, and is listed under the **Closed** tab of the portfolio table instead of among the active holdings. Buying again reopens it. |
| **NPS account** | Your National Pension System account (Tier I or II) with one pension fund manager. It holds several **schemes** at once: **E** (equity), **C** (corporate bonds), **G** (government securities) and sometimes **A** (alternative assets), each with its own NAV and units. |
| **Switch** | Units moved from one NPS scheme to another when the account is rebalanced. No money reaches you, so switches are not contributions or withdrawals; within a scheme they are money leaving or entering that scheme. |
| **Charges** | Units deducted from a holding to pay fees (NPS maintenance charges, for example). Their value is lost, so it counts against your gain. |
| **Gold bond** | A Sovereign Gold Bond (SGB) series you hold: so many grams of gold, bought at the issue price, earning 2.5 % a year on that price paid every six months, redeemed at the gold price after eight years (or from the fifth year). It is valued at the series' NSE traded price, fetched from NSE by its code; a bond without a code is valued at a **gold price per gram** you enter. |
| **PPF account** | Your Public Provident Fund account. Deposits whenever you like, interest credited once a year on 31 March at the declared rate, and maturity 15 financial years after the year of opening. As with EPF, nothing is looked up online: you enter deposits and the interest credited, and the app keeps the balance. |
| **EPF account** | Your Employees' Provident Fund account (one per UAN). It has two **shares** that earn interest, the **employee share** and the **employer share**, and the employer's **pension (EPS) contribution**, which goes to the pension scheme and is tracked separately. Nothing is looked up online: you enter deposits and the interest EPFO credits each year, and the app keeps the balances. |
| **Fixed deposit** | A bank or post-office fixed deposit: a principal placed for a fixed term, with the maturity date and value from the bank's FD advice as its terms. It is valued along the curve from the principal to the maturity value; nothing is looked up online. |
| **Insurance policy** | A life insurance policy with a maturity value, such as an LIC endowment or money-back plan: premiums on a schedule (yearly, half-yearly, quarterly or monthly) and a payout known in advance. The app works out the policy's own rate of return over every premium, paid and still due, and values the premiums paid at that rate. |

---

## 2. Starting the app

### Using the exe

Double-click `InvestmentTracker.exe`. After a few seconds the app opens in its own window, with no
address bar, tabs or console. Use it like any other program; **closing the window quits the app**.
Double-clicking the exe again while it is open simply brings up another window of the same app.

Behind the scenes the window is Microsoft Edge (or Google Chrome) running in "app" mode with its own
private profile, which is why it looks like a plain application window. If neither browser is
installed, the app opens in your default browser instead and a small "Investment Tracker is running"
window appears with a **Quit** button.

The first time Windows may show "Windows protected your PC". Click **More info**, then **Run anyway**.
This happens once because the exe is not signed.

The exe keeps its data in a `data` folder next to itself, so you can copy the exe anywhere and it
will keep working from there. If something goes wrong, `data\app.log` contains the details.

### Running from source

If you have the project folder and Python installed, double-click `run.bat` instead. It opens the
same window, uses the `data` folder inside the project, and leaves no console open. See the README
for setup details.

### First launch: choose a password

The first screen asks you to **protect your data with a password**:

1. Type a password of at least 8 characters, twice. A long phrase you will remember works best.
2. Tick the box confirming you understand there is **no way to recover the data if you forget the
   password**. The password is never stored anywhere, so this is really true.
3. Click **Set password and continue**.

If you used an earlier version of the app that stored data without a password, the screen says so and
your existing funds are encrypted with the new password automatically. The old unprotected file is
removed once the encrypted one has been verified.

### Every launch after that: unlock

You will see **Unlock your portfolio**. Type your password and press Enter or click **Unlock**.
A wrong password shows an error and clears the box; there is a short delay after each wrong attempt.

When a new version of the app needs to change how the data is stored (for example when stocks were
added), the change happens silently during this unlock. Your transactions are never altered by it.

### Locking

- **Lock** (top bar) locks the app immediately. The password is needed to open it again.
- The app locks itself after **30 minutes without any activity**. If you were in the middle of
  something, the unlock screen appears the next time you click; after unlocking, carry on.
- **Password** (top bar) changes your password. You must enter the current password first. The new
  password takes effect immediately for the stored file.

### Light and dark theme

The app follows your Windows light/dark setting. The **Dark / Light** button in the top bar
overrides it, and the choice is remembered in your browser.

---

## 3. The Portfolio page

This is the home page (click **Investment Tracker** or **Portfolio** in the top bar to return to it).
It shows everything you own across all funds and stocks, **in rupees**. Stocks in other currencies are
converted at the daily exchange rate (see section 12 for exactly how).

**Top line:** the date of the latest price used ("Prices as of …"), how many holdings you have, and a
reminder that totals are in INR once you hold a stock.

**Headline figures**

- **Current value** – the big number: what all your holdings are worth today, with the unrealised gain or
  loss on them below it in rupees and percent. A second line shows what you have already **realised**:
  gains from sales plus dividends received.
- **Total investment** – everything you have put in. Once you have sold something it becomes
  **Investment in holdings**: the cost of what you still hold, with the totals bought and sold underneath.
  When dividends have been received, the same line also shows the investment **net of dividends**: how
  much of your money is still at stake after the cash that has come back to you.
- **Total profit / Unrealised profit** – current value minus investment, with the absolute percentage and
  the realised figure (sales and dividends) alongside.
- **XIRR** – annualised return of the whole portfolio, computed from every transaction in every holding.
- **Redeemable now** – the current value of your *open* holdings, with the locked value shown underneath.

**Portfolio value over time** – a chart of your total current value (blue) against the amount invested
(orange, stepped: it jumps on each purchase and drops on each sale). Use the **1M, 3M, 6M, 1Y, 3Y, All**
buttons to change the period; the choice is remembered. Hover anywhere on the chart to see the exact
values on that day and the gain or loss at that point. The value at the right end of each line is labelled.

**Allocation** – a pie chart, drawn as a ring with your total current value in the middle, splitting your
holdings by asset class: mutual funds, stocks, NPS, EPF, PPF, gold bonds, fixed deposits and insurance
policies, each with a fixed colour. The list beside the ring gives, for each class, the number of
holdings, the amount invested, its share of the ring and its current value; hovering a slice shows the
same figures. Each class has a **tick box** in front of it, all ticked to begin with: untick a class to
leave it out of the ring, and the ring, the total in its middle and the shares are redrawn from the
ticked classes only (useful for looking at the investments you can actually move, without the locked-in
ones). An unticked class stays in the list, greyed, with its own figures. The choice is remembered on
this device until you tick the class again. Below the list, one line per foreign currency shows how
much you hold in that currency, the exchange rate used and its date, and the rupee value.

**Locked vs redeemable** – a bar splitting your current value into what you could sell today (open
holdings) and what is under lock-in (locked holdings), with the amounts and what was invested in each part.

**Holdings table** – one row per fund or stock: name with an **MF** / **Stock** chip (once you hold a
stock), its category or its symbol, exchange and currency, the folio or account, status badge, invested,
current value, P&L (rupees and percent, with the realised figure), XIRR, and the latest NAV or
price with its date. As soon as you hold more than one kind, the rows are **grouped by asset class**
(Mutual funds, Stocks, NPS, EPF, PPF, Gold), each group under its own heading and with a subtotal row of invested
amount, current value, P&L and the group's XIRR (the annualised return of those holdings taken together, so a
collapsed group still tells you how that asset class is doing). Click a group heading to **collapse** the group down to its subtotal row and
click it again to expand it; the app remembers which groups you collapsed, separately for the Active and
Closed tabs. For a stock in another currency the invested and current value cells show the
rupee figure with the original currency underneath, and XIRR shows the rupee return with the
own-currency return underneath. The bottom row totals the portfolio.

- Click a row (or focus it and press Enter) to open the holding's page.
- Click a group heading (for example **Stocks**) to collapse or expand that group.
- Click **Edit** at the end of a row to change its details without opening it (see section 8).
- Click **+ Add fund / stock** (top bar or in the table header) to add a holding.

**Active / Closed tabs** – once you have sold out of something, two tabs appear above the table. **Active**
is the table described above. **Closed** lists each holding you have exited: its closing date, the total
bought, what it was sold for, the realised gain including dividends, and its final XIRR. Closed holdings
keep every transaction and still count in the realised totals and the XIRR above; open one to see its
history, and adding a purchase moves it back to Active. The address `#/?tab=closed` opens the tab directly.

**Price warning** – if a price service could not be reached, a yellow banner says so and the figures use
the last prices that were downloaded. Nothing is lost; click **Refresh prices** later. If a foreign stock
has no exchange rate yet, a banner names it and it is left out of the rupee totals until the rate arrives.

---

## 4. Adding a mutual fund, a stock, an NPS, EPF or PPF account, a gold bond, a fixed deposit or an insurance policy

Click **+ Add fund / stock**. At the top of the dialog choose **Mutual fund**, **Stock / ETF**, **NPS**, **EPF**, **PPF**, **Gold (SGB)**, **Fixed deposit** or **Insurance policy (LIC)**.

### Mutual fund

1. **Search scheme** – start typing the fund's name (at least 3 letters), for example
   `parag parikh flexi`. Matching schemes from the official AMFI list appear. Pick the exact plan you
   hold: *Direct* or *Regular*, and *Growth* or *IDCW*. Note that some fund houses call the growth
   option **"Cumulative"** (ICICI Prudential does), so if you cannot find "Growth", look for that.
   Selecting a result fills in the **Scheme code (AMFI)** and the **Display name**.
2. **Default folio number** – your folio with this fund house. It is pre-filled on new transactions;
   each transaction can still carry a different folio.

### Stock / ETF

1. **Search stock or ETF** – type the company name or ticker, for example `reliance`, `infosys` or
   `AAPL`. Results come from Yahoo Finance and cover every major exchange; each shows the symbol, the
   company name and the exchange. Indian shares appear twice, as the NSE listing (`RELIANCE.NS`) and the
   BSE listing (`RELIANCE.BO`); pick the one you trade on. Selecting a result fills in the **Symbol** and
   the **Display name**.
2. **Symbol** – you can also type it directly if you know it. As soon as a symbol is in the box the app
   looks it up and shows the company name, exchange, **the currency its prices are in**, and the latest
   price, so you can confirm it is the right one. The currency is taken from the exchange and cannot be
   changed by hand: an ASX share is always in AUD, a NASDAQ share in USD, an NSE share in INR. The
   portfolio converts to rupees for you.
3. **Default account** (optional) – the broker or demat account, for example `Zerodha` or `ESPP`.

### NPS account

1. **Pension fund manager** – pick yours (SBI, ICICI Prudential, HDFC, LIC, UTI, Kotak, Aditya Birla, Axis,
   Tata or DSP). The list comes from NPS Trust, which publishes every scheme's NAV daily.
2. **Tier** – Tier I (the retirement account; the app marks it Locked) or Tier II (voluntary).
3. **Scheme variant** – most accounts use the **Standard** schemes. Newer accounts may be on the GS, Direct or
   POP variants; your eNPS statement names the exact scheme, so match that.
4. **Schemes in this account** – tick the schemes you hold: E (equity), C (corporate bonds), G (government
   securities) and, if you have it, A (alternative assets). Each shows its NPS Trust scheme id and latest NAV.
5. **PRAN** – your Permanent Retirement Account Number, used as the account's folio.

The app downloads the full NAV history of every ticked scheme. Changing the schemes later is done under
**Edit NPS account**; transactions are never touched by that.

### EPF account

1. **Employer** (optional) – the employer this account belongs to; it is used in the suggested name.
2. **UAN** – your Universal Account Number, used as the account's folio.

An EPF account is marked **Locked** because the money is not available until the EPFO withdrawal rules
allow it. Nothing is fetched online for EPF; the next section explains how you enter deposits and interest.

### PPF account

1. **Bank / post office** (optional) and **Account opened on**. The opening date sets the maturity: 15
   financial years after the year of opening, so an account opened in FY 2015-16 matures on 1 April 2031.
   The app fills **Locked until** with that date; leave the date empty to take the first deposit's date
   instead.
2. **Account number** – your PPF account number, used as the account's folio.

A PPF account is marked **Locked** until maturity. Nothing is fetched online for PPF; the next section
explains how you enter deposits and interest, and section 15 the PPF rules the app follows.

### Gold bond (Sovereign Gold Bond)

1. **Pick the series from the exchange list** – every Sovereign Gold Bond series, live ones first, with
   its NSE code, issue date, issue price and latest traded price. The prices come from NSE's own feed and the
   issue details from sgb.vercel.app (Yahoo Finance, which prices your stocks, does not know the bonds).
   Picking a series fills in everything below.
2. **Series** – the name, for example `Sovereign Gold Bonds 2021-22-Series-X`; it becomes the display name.
3. **NSE code** – such as `SGBMAR30X`. With a code the bond is priced from the exchange list and refreshed
   with the other prices. Leave it empty to value the bond at a gold price you enter yourself.
4. **Issue price per gram** – the price interest is paid on, before any online discount (₹5,109 when you
   paid ₹5,059). With it the app shows the amount of each half-yearly interest payment.
5. **Issue date** – it sets the interest dates, the early-redemption date (five years on, filled into
   **Locked until**) and the maturity (eight years on). The exchange list gives it to the month; the exact
   date is in the RBI press release or your allotment advice. Leave it empty to take the first purchase's date.
6. **Default folio** (optional) – the folio or demat account on your allotment.

Section 16 explains how a gold bond is valued and what the bond page shows.

### Fixed deposit

1. **Bank** (optional) – it becomes part of the display name (`FD · SBI`).
2. **Deposit date** and **Principal** – recorded as the deposit transaction as soon as you click Add. Leave
   both empty if you will import the deposit from a sheet instead (section 7).
3. **Maturity date** and **Maturity value** – from the bank's FD advice. They are what the deposit is worth
   at the end, and the app values it along a constant-rate curve between the two dates (section 17). The
   maturity date is filled into **Locked until**. Leave them empty if you do not have the advice yet; the
   deposit then sits at its principal until you enter them with Edit fixed deposit.
4. **Interest rate** (optional) – the rate the bank quoted, for your records. The app shows the effective
   annual rate it works out from the principal and the maturity value beside it.
5. **Interest** – *Cumulative* (interest is paid with the principal at maturity) or *Paid out
   periodically* (you receive the interest along the way and record each credit as a transaction).
6. **FD account number** – the account or receipt number on the advice (optional).

A fixed deposit is marked **Locked** until maturity. Nothing is fetched online for it.

### Insurance policy

1. **Insurer** (LIC is pre-filled) and **Plan** (optional, for example `Jeevan Anand (149)`); together they make
   the display name.
2. **Premium** and how often it is **Paid** (yearly, half-yearly, quarterly or monthly), as you pay it.
3. **First premium** – the policy's start date; every due date follows from it. **Last premium** is optional:
   leave it empty when premiums run until maturity (the last due date before it), set it for a plan whose
   premiums stop earlier.
4. **Maturity date** and **Maturity value** – from the policy document or the insurer's estimate (sum assured
   plus the bonuses you expect). They are what the policy pays at the end, and the app values the policy
   towards them (section 18). The maturity date is filled into **Locked until**.
5. **Sum assured** (optional) – the life cover, for your records.
6. **Record every premium due up to today as paid** – ticked by default: one Premium transaction is recorded
   per due date from the first premium to today, so a policy that has run for years is complete in one go.
   Untick it if you will import the premiums from a sheet instead (section 7).
7. **Policy number** – from the bond or the premium receipts (optional).

A policy is marked **Locked** until maturity. Nothing is fetched online for it.

### Both

3. **Display name** – how the holding appears in the app. Shorten it if you like.
4. **Status** – *Open — can be sold / redeemed*, or *Locked — under lock-in* (ELSS, a vesting period,
   an employee share plan holding period). For locked holdings you can also enter **Locked until**,
   which is shown on the badge.
5. **Notes** – anything you want to remember.
6. Click **Add**. The app downloads the full price history (and the exchange rate history for a foreign
   stock) and opens the holding's page.

If you picked the wrong scheme or symbol, don't delete the holding: see section 8 to re-link it.

---

## 5. The Fund / Stock / NPS / EPF / PPF / Gold bond / Fixed deposit / Insurance policy page

Open a holding from the portfolio table. The page shows:

**Header** – the name with its Open/Locked badge and an MF / Stock chip, then a line with its folio(s),
AMFI scheme code, fund house and category (fund) or its symbol, exchange, price currency, company name
and account(s) (stock). **Exit**, **Edit** and **Delete** are on the right. Exit appears only while you
hold units and records the sale of all of them (section 6). Delete removes the holding and all its
transactions after a confirmation; it cannot be undone. A holding you have sold out of shows a grey
**Closed** badge with the date instead of Open / Locked, and its current value is zero.

**Folio / account chips** – appear when the transactions span more than one folio or account: **All**
plus one chip per folio. Click a chip to show only that folio everywhere on the page: the headline
figures, the chart and the transaction list. The filter is part of the page address, so you can bookmark
a folio view, and the browser's back button returns to the full holding.

**Headline figures** – current value with gain or loss, total investment, total profit, XIRR, and the
latest NAV or price with its date and the number of units or shares you hold. Once a holding has sales
the tiles change to **Investment in holdings** (what the units you still hold cost you, with the totals
bought and sold underneath) and **Unrealised profit** (on those holdings), with the **realised** gain
from the sales and any **dividends** shown alongside. Bonus units are noted under the investment tile.
A yellow warning appears if the sales recorded exceed the units bought.

For a stock in another currency every figure on this page is in that currency (for example `A$7,354`),
and the rupee equivalent appears underneath: the current value with the exchange rate and its date, the
investment, the profit, and the XIRR in rupees next to the XIRR in the stock's currency. The two XIRRs
differ by the currency movement.

**NPS accounts** show the same page with three differences. Instead of folio chips there are **scheme chips**:
**Whole account**, **Scheme E**, **Scheme C**, **Scheme G** (and A). The headline figures for the whole
account add the schemes together: investment, current value, profit, charges deducted, and an **XIRR
computed only on your own contributions and withdrawals** (money that actually left or reached your bank).
Pick a scheme chip to see that scheme alone: its units, NAV, value and its **own XIRR**, which also counts
money switched into or out of it during rebalancing. The **Latest NAVs** tile lists every scheme's NAV. A
**By scheme** table gives, for each scheme, its transactions, invested amount, units, NAV, current value,
P&L with charges, and XIRR, with the whole account in the bottom row. The transaction list has a **Scheme**
column and chips for **Contribution**, **Withdrawal**, **Switch in**, **Switch out** and **Charges**; its totals
line separates money contributed, switched and deducted. **Exit** appears when a single scheme is selected.

**EPF accounts** show **share chips** instead of folio chips: **Whole account**, **Employee share** and
**Employer share**. The headline tiles are **Deposits** (employee plus employer, split underneath), **Interest
credited** (with the last year credited and its rate), **XIRR** (on all deposits, with the return on your own
contributions alone next to it, where the employer's share counts as gain) and the **Pension scheme (EPS)**
total paid in so far, which is not part of the balance. A **By financial year** table lists, for each year
April to March, the employee and employer deposits, the pension contribution, the interest rate, the interest
credited on each share, any withdrawals and the closing balances, all worked out by the app from what you
entered. Below it, **Deposits and interest by year** draws one column per financial year, stacked in three
colours: employee deposits (blue), employer deposits (orange) and the interest credited for that year (green).
Hover a column to read the three figures and the year total; a year whose interest is not entered yet shows
"pending". The **Employee share** and **Employer share** chips narrow the chart to that share. The second chart
is **Balance over time**. The entries table shows **one row per month**: the date, the type
(deposit, interest credited, transfer in or withdrawal), the **Employee**, **Employer** and **Pension (EPS)**
amounts side by side, the interest rate and a comment. **Edit** on a row opens the whole month in one
dialog; **Delete** removes all of that row's entries. The
buttons are **Import a year**, **Year interest**, **+ Add month** and **+ Add entry** (section 6), and
**Moved jobs** for a change of employer (section 14). A yellow banner reminds you when the latest year's
interest has not been entered yet.

**PPF accounts** have no shares. The tiles are **Deposits** (with this financial year's deposits and any
withdrawals), **Interest credited** (the last year credited and its rate, or the year still pending),
**XIRR** and **Matures on** (15 financial years after the year of opening, with the time left; once matured,
the tile shows the end of the current five-year extension instead). The **By financial year** table lists
deposits, the interest rate, the interest credited, withdrawals and the closing balance for each year;
**Deposits and interest by year** stacks deposits (blue) and interest (green) per year; and **Balance over
time** follows. The entries table has one row per entry: the date, the type, the amount, the interest rate and
a comment. The buttons are **Import a year**, **Year interest** and **+ Add entry** (section 6).

**Gold bonds** look like a stock page with grams instead of shares and a **Price per gram** instead of a
share price: the tiles are **Total investment**, **Unrealised profit** (with the interest received so far as
the realised part), **XIRR** and **Latest price per gram** with its date and where it came from (the NSE
traded price, or a price you entered). A **Gold price** button sits in the header for bonds without an NSE
code: enter today's price per gram and the date, and every such bond is revalued; the dialog also lists the
prices you entered before, so a stale one can be removed. A banner reminds you when a bond has no price yet.
The **Bond details** card lists the series, the code (as a Google Finance link), the issue date and price, the
interest terms with the amount of each payment and the next due date, the interest received so far, the
early-redemption date, the maturity with the time left, the price with its source, and the **IBJA gold
price** (the rate RBI redeems at) with how far the market price sits from it. Transactions are purchases
(grams at a price per gram), **Interest** receipts and redemptions or sales.

**Fixed deposits** have the tiles **Principal** (with the deposit date), **Maturity value** (with the date,
the interest it includes and the time left; after the payout this tile becomes **Paid out**), **Interest
rate** (the effective annual rate implied by the two figures, with the quoted rate beside it) and **XIRR**.
The **Deposit details** card lists the bank, the account number, the deposit, whether the interest is
cumulative or paid out, the maturity date and value, the rate, the value today with the interest accrued so
far, the interest paid out and, once closed, the payout. A **Matured / paid out** button in the header
records the money the bank paid (section 6); there is no Exit button. A banner reminds you when the
maturity has passed and the payout is still to be recorded, or when the maturity date and value have not
been entered yet. Transactions are the deposit, **Interest paid out** credits and the **Payout**, shown with
their date, type, amount and comment.

**Insurance policies** have the tiles **Premiums paid** (how many of the schedule, the premium and when the
next falls due), **Maturity value** (with the date, the time left and what is still to be paid; **Paid out**
once the policy has ended), **Policy return** (the rate at which every premium, paid and still due, grows to
the maturity value) and **XIRR** (on the premiums paid and today's accrued value, which comes to the same
rate while the schedule is kept). The **Policy details** card lists the insurer, plan and policy number, the
premium and its frequency, the premiums paid and still to come with the total outlay, the first, last and
next due dates, the maturity date and value with the gain over all the premiums, the sum assured, the policy
return, the value today with the amount accrued, the benefits received and, once closed, the payout. Two
buttons sit in the header: **Premium paid** (the next premium from the schedule, pre-filled) and **Matured /
paid out**; there is no Exit button. Banners warn when a premium fell due without being recorded, when the
maturity has passed and the payout is still to be recorded, and when the maturity date and value are not set.

**By folio / By account** – shown when there is more than one. One row per folio with its transaction
count, invested amount, units, current value, P&L and XIRR, plus a totals row. Clicking a row applies the
filter.

**Value over time** – the same chart as the portfolio page, for this holding only (or the selected
folio), in the holding's own currency.

**Transactions** – every transaction, newest first: date, folio or account, type (SIP, Lumpsum,
Redemption for a fund; Buy, Sell, SIP for a stock; Dividend and Bonus for both), amount, NAV or price,
units (shown with a minus sign for sales and a plus sign for bonus units; a dash where it does not
apply), comment, and **Edit / Delete** links. The bottom row totals the amounts bought, sold and
received as dividends, and the units held. Buttons: **Import** (section 7) and **+ Add transaction**
(section 6).

---

## 6. Adding or editing a single transaction

Click **+ Add transaction** on the holding's page, or **Edit** on a row.

- **Date** – defaults to today; cannot be in the future.
- **Type** – for a fund: SIP (purchase), Lumpsum (purchase), Redemption (sell), Dividend / IDCW payout,
  Bonus units. For a stock: Buy, Sell, SIP (buy), Dividend received, Bonus / free shares. For an NPS account:
  Contribution, Lumpsum contribution, Withdrawal, Switch in, Switch out and Charges, plus a **Scheme** box
  (E / C / G / A) saying which scheme the transaction belongs to. Every kind also offers **Charges**.
  - For a **switch**, enter the value moved and the NAV; it is not money you paid or received.
  - For **charges**, enter the units deducted; the value follows from the NAV of that day (editable).
  - For a **sale**, enter the amount you received and the units sold; the app reduces your holding and
    works out the realised gain.
  - For a **dividend**, enter the cash received. The units box is switched off: a dividend does not
    change what you hold. The price box is optional, for your records.
  - For **bonus / free shares** (a bonus issue, a split, a gift, vested free shares), enter the number
    received. The amount box is switched off: nothing was paid, and the shares are added at zero cost.
- **Folio number / Account** – pre-filled with the holding's default (or the folio you are currently
  filtering on). Change it if this transaction belongs to a different one. If one purchase was spread
  over several folios, type them all separated by `/` (for example `1234567890/2345678901`); the
  form detects this and offers to create one transaction per folio with the amount and units divided
  equally, each carrying a comment that records the split.
- **Amount** – in the holding's currency (shown in the label): what you paid, or received.
- **NAV / Price** – filled in automatically from the holding's price history for the chosen date as soon
  as you pick the date (for a stock, the closing price). If the date was a weekend or holiday, the
  previous trading day's figure is used and the hint tells you so. You can type the exact figure from
  your statement or contract note instead.
- **Units / Shares** – calculated as amount ÷ price. Type the figure from your statement if it differs
  (stamp duty or brokerage makes it slightly different). Clearing the box turns automatic calculation
  back on.
- **Comment** – optional free text, for example "bonus money", "ESPP purchase" or "vested RSUs".

Click **Add transaction** (or **Save changes**). All figures and charts update immediately.

### EPF and PPF entries

EPF has its own forms, because one month means several entries; PPF uses the same forms with a single amount:

- **+ Add month** – one dialog for the whole month: the date (the 15th is pre-filled), the type, the
  employee deposit, the employer deposit (the EPF part only), the pension (EPS) contribution and the interest
  rate for that year. Leave a box empty for a share that had nothing that month.
- **Year interest** – pick the financial year and enter the interest EPFO credited on the employee share and
  on the employer share. It is dated 31 March of that year. The app never calculates interest; it only
  records what EPFO credited. A year whose interest is already recorded is marked in the list.
- **+ Add entry** – the same dialog with the type free to choose: a deposit, a transfer in or opening balance
  (for example a balance that was already in the account before you started using the app), interest
  credited, or a withdrawal (advance), again with employee, employer and pension boxes. **Edit** on a row of
  the table opens this dialog with the month filled in; clearing an amount removes that share's entry.
- **PPF** – **+ Add entry** opens the same dialog with one amount box: a deposit (dated the day you paid;
  deposits made by the 5th earn that month's interest), a transfer in or opening balance, interest credited,
  or a withdrawal. **Year interest** records the interest credited for a financial year, dated 31 March.

### Fixed deposit entries

A fixed deposit has a short form of its own: date, type and amount.

- **Deposit** – the principal placed with the bank. The dialog that adds the holding records it for you;
  use this for a further deposit, or when you added the holding without one.
- **Interest paid out** – interest credited to your bank account from a non-cumulative deposit. It is cash
  received, like a dividend: counted in the XIRR and the realised figure, the deposit itself unchanged.
- **Payout (maturity or premature closure)** – the money the bank paid when the deposit ended. The whole
  deposit leaves the holding, the holding is marked **Closed**, and the amount above the principal is the
  realised gain (the interest earned). **Matured / paid out** in the page header opens this form with the
  maturity value pre-filled once the maturity date has passed, or today's value before it; change it to the
  amount actually credited (after any tax deducted at source). A renewal is a new deposit: record the payout
  here and add the renewed deposit as a new holding.

### Insurance policy entries

The same short form (date, type, amount) serves a policy:

- **Premium** – a premium paid, as paid. **Premium paid** in the page header opens the form with the next due
  date from the schedule (or the first one that was missed) and the premium pre-filled; change the date to the
  day you actually paid. **Single premium / top-up** is a one-off payment outside the schedule.
- **Benefit received** – a survival benefit (money-back plans) or a bonus paid out while the policy runs on.
  It is cash received, like a dividend; the policy's rate of return takes it into account.
- **Payout (maturity or surrender)** – the money the insurer paid when the policy ended, at maturity or on
  surrender. The whole policy leaves the holding, it is marked **Closed**, and the amount above the premiums
  paid is the realised gain. **Matured / paid out** opens this form with the maturity value pre-filled once
  the maturity date has passed, or today's value before it.

### Exiting a holding

Click **Exit** on the holding's page to sell everything you hold in one go. The dialog opens as a sale
with the units pre-filled (all of them, or all in the folio you are filtering on), today's date, the
latest price, and the amount worked out as units × price. Change the date and type the amount you
actually received, from your contract note or statement, then click **Record exit**. As soon as the
units held reach zero the holding is marked **Closed** and moves to the Closed tab of the portfolio;
nothing is deleted. The same happens when an ordinary sale brings the units to zero. For a holding
spread over several folios, filter to a folio first if you want to exit one folio at a time.

---

## 7. Importing many transactions at once

If you have your transactions in a spreadsheet, a statement export or broker contract notes, you do not
need to type them one by one. On the holding's page click **Import**. The same dialog works for funds
and stocks.

**Where the data can come from**

- Copy rows in Excel or Google Sheets and paste them into the **Paste rows** box, or
- click **…or choose a file** and pick a `.csv`, `.tsv` or `.txt` file.

A header row is optional. If present, the columns are recognised from their names: folio / account /
demat, name / symbol / scrip, type / buy-sell / action, date, amount / value / consideration, units /
quantity / qty / shares, NAV / price / rate, comment / remarks, in any order. Without a header the app
assumes this order: Folio or account, Name, Type, Date, Amount, Units or shares, NAV or price. Tabs,
commas, semicolons and `|` are all accepted as separators.

**What the app understands**

- Dates like `11-Mar-2019`, `11 March 2019`, `11/03/2019`, `2019-03-11` or `Mar 11, 2019`.
- Amounts with commas and currency symbols, such as `-10,000.00` or `₹ 5,000`. Statements show
  purchases as negative cash flow, so the sign is ignored. Amounts are taken to be in the holding's
  currency (AUD for an ASX stock, and so on).
- Type words such as `SIP`, `Systematic Investment`, `Purchase`, `Lumpsum`, `Buy`, `Sell`, or just
  `B` / `S` as broker files often use. If the data has no type column, the **Type when the data has
  none** setting is used (SIP for a fund, Buy for a stock).
- **Sales** are recognised in three ways: negative units (the usual statement format, for example
  `196,000.00` with `-508` units, even if the type column says SIP); words like `Sell`, `Redemption`,
  `Switch out`, `SWP` or `Withdrawal` in the type column; or a positive amount in a file where purchases
  are shown as negative. The preview labels such rows "Sell · 508 shares sold" (or "Redemption …").
- **Dividends** are recognised from the words `Dividend`, `Payout` or `IDCW`, or from the pattern alone:
  money in the amount column and an explicit **0** in the units column. `Dividend reinvestment` rows are
  purchases, because they buy units with the payout.
- **Bonus / free shares** are recognised from the words `Bonus`, `Free` or `Split` (then the amount column
  may be 0 or empty), or from the pattern alone: units in the units column and an explicit **0** in the
  amount column. A row with units but an empty amount and no type word is reported as an error rather
  than guessed.
- **NPS statements** have one row per contribution with units and NAV for each scheme, in columns such as
  `Quantity Purchased E / C / G` and `Purchased at NAV E / C / G` (without a header the order is PRAN, Scheme
  name, Type, Date, Amount, Units E, Units C, Units G, NAV E, NAV C, NAV G). Each row becomes one transaction
  per scheme. A row with money and units everywhere is a **contribution**: the amount is shared out by each
  scheme's value (units × NAV), and the preview notes how much of it went in charges before allotment. A row
  with `0.00` and units going down in every scheme is **charges** deducted (the usual "restructure /
  maintenance" line). A row with `0.00` and units going down in one scheme and up in another is a
  **rebalance**: a switch out of the first scheme and into the second. Money coming in with units going down
  everywhere is a **withdrawal**. Paste the statement on the NPS account's page.
- **EPF sheets** are imported one financial year at a time with **Import a year** on the EPF page. Paste the
  year as it is in your sheet: the `Balance` line on top (deposits to date, the year such as `2021-2022`, and
  the balances brought forward), the `Month` header line, one line per month with the employee deposit,
  employer deposit, pension contribution, `IR%`, interest on each share and the running balances, and the
  `Year Total` / `Overall Total` lines. The totals and the balance columns are ignored (the app works the
  balances out itself), the year is read from the Balance line or typed in, deposits are dated the 15th of
  each month and the year's interest 31 March. If the Balance line brings in balances from years that are not
  in the app yet, a tick box offers to record them as of 1 April (deposits as a transfer in, the interest to
  date as interest). Months already recorded are skipped, so a year can be pasted again after adding months.
- **PPF sheets** are imported one financial year at a time with **Import a year** on the PPF page. Paste the
  year as it is in your sheet: the `Balance` line on top (the opening balance and the starting year, such as
  `2021`), the `Month` header line, one line per month with the deposit, `Before 5th` or `After 5th`, the
  interest rate, the month's interest and the running balance, and the totals line. A deposit marked Before
  5th is dated the 1st of its month and one marked After 5th the 15th; the monthly interest figures are added
  up into one interest entry dated 31 March; the balance column and the totals are ignored (the app works the
  balance out itself, and warns if the sheet's interest total does not match the months). If the Balance line
  brings in a balance from years that are not in the app yet, a tick box offers to record it as a transfer in
  dated 1 April. Deposits already recorded are skipped.
- **Gold bond sheets** use the mutual fund layout (folio, name, type, date, amount, grams, price per gram),
  with `LUMP SUM` purchases as negative amounts and the half-yearly interest as `dividend` rows (positive
  amount, 0 grams), which import as **Interest**. A closing `Current Value` line (its date, value, grams and
  price per gram) is not a transaction: the preview marks it as a summary line, and for a bond priced by
  hand a tick box offers to record its price per gram as the **gold price** for that date. For a bond priced
  from the exchange, and for any other kind of holding, such a line is simply skipped.
- **Fixed deposit sheets** need only an account number, a type, a date and an amount, with or without a
  header (`Folio Number/AccountNumber | Type of Investment | Date of purchase | Amount Invested`). The row
  typed `lumpsum` with a negative amount is the deposit. A row whose type says **Final Value at maturity**
  is not a transaction: the preview marks it as a maturity line and a tick box offers to record its date and
  amount as the deposit's maturity date and value (replacing what the holding has). Rows typed `interest`
  with a positive amount import as **Interest paid out**; a positive amount typed `closure`, `matured` or
  `redemption` imports as the **Payout** and closes the deposit. An empty first cell (the maturity line has
  no account number) is kept in place, so rows copied straight from Excel line up.
- **Insurance policy sheets** use the same columns (policy number, name, type, date, amount) and usually list
  the whole premium schedule: every row with a negative amount is a premium. Rows dated up to today import as
  premiums paid; rows dated after today are the premiums still to come, shown as **Future premium · due …**
  and not imported. A row whose type says **Value at maturity** gives the maturity date and value. A tick box
  offers to record the policy's terms from all of this: the maturity, the premium (the most common amount),
  how often it is paid (from the gaps between the dates), the first premium and, when future rows are
  present, the last one. Rows typed `survival benefit`, `money back` or `dividend` with a positive amount
  import as **Benefit received**; `surrender`, `matured` or `payout` rows as the **Payout**.
- Rows dated after today are never imported, for any kind of holding; the preview says so.
- If a purchase or sale row has units but no price, or a price but no units, the missing one is
  calculated. If it has neither, the price for that date is looked up from history.
- A comment column is imported as the transaction's comment. **Comment for imported rows** applies one
  comment to every row that has none, for example "Imported from CAS statement, Nov 2026".
- **Purchases spread over several folios.** Statements sometimes show one SIP against two folios, such as
  `1234567890/2345678901` with ₹5,000 and 47.948 units. With **Split rows that list several folios**
  ticked (the default), such a row becomes one transaction per folio, each with half the amount and half
  the units at the same NAV, and a comment noting the split. Folios like `1234567/89`, where the part
  after the slash is only a short suffix, are treated as a single folio. Untick the option to keep such
  rows as one transaction.

**The preview**

As soon as you paste, a preview appears. Above each column is a dropdown showing what the app thinks the
column is; change it if a column was misread (choose **— ignore —** for columns you don't want). The
first column shows each row's status:

- **Ready** – will be imported as a purchase.
- **Sell · 4 shares sold**, **Dividend · 36 AUD received**, **Bonus · 10 free shares** – will be imported
  as that type. Check these labels: they are the app's reading of the row.
- **Split 1/2: ₹2,500, 23.974 units** – this source row is spread over several folios and will become
  several transactions (one preview line per folio).
- **Skipped · already recorded** – a transaction of the same type with the same date, amount and units
  (and folio) already exists in this holding. Untick **Skip rows already recorded** if you really want it
  imported.
- **Unrecognised date / amount …** – the row has a problem and will be left out; fix the data or
  ignore it.

A summary line counts the rows, and warnings appear if the pasted name does not look like the holding
you are on, or if the rows mention several different names. The import always goes into the holding
whose page you are on, so paste one fund or stock at a time.

Click **Import N transactions**. Everything is saved in one go; if any row cannot be completed (for
example a date before the holding existed, with no price available), nothing is imported and the reason
is shown. Afterwards you can edit or comment on individual rows as usual.

---

## 8. Fixing a holding linked to the wrong scheme or symbol, or other details

Many schemes have near-identical names (Direct vs Regular, Growth vs IDCW), and a company can be listed
on several exchanges. If you added transactions to a holding that is linked to the wrong scheme or
symbol, you do not need to re-enter anything.

Open **Edit fund** / **Edit stock** (on the holding's page, or **Edit** on the portfolio row):

- For a fund, the **Linked AMFI scheme** box shows the scheme currently used. Click **Change scheme**,
  search for the correct one and pick it. For a stock, the **Linked stock** box shows the symbol,
  exchange and currency; click **Change symbol** and pick or type the correct one. A notice confirms what
  the holding will be re-linked from and to, and warns you if the currency changes. Your transactions keep
  their dates, amounts, units, prices and comments exactly as recorded; only the price history used to
  value them changes, and all figures are recalculated on save.
- **Use the scheme name** / **Use the company name** copies the official name into the display name.
- Change the **Default folio number** / **Default account** if it was wrong. If existing transactions
  carry the old value, a checkbox offers to update them too, with the count shown. It is unticked by
  default, so transactions are left alone unless you choose otherwise.
- Status, Locked until and Notes can be changed at any time. The kind (fund or stock) cannot be changed
  once created; delete and re-add instead.

Click **Save changes**.

---

## 9. Comments on transactions

Every transaction can carry a short note.

- In the transaction table, click **+ Add comment** (or an existing comment) to edit it right in the
  row. Press **Enter** or click elsewhere to save, **Escape** to cancel.
- The Add / Edit transaction dialog has a **Comment** field.
- Imports can bring in a comment column or apply one comment to the whole batch (section 7).

---

## 10. Keeping prices up to date

- Mutual fund NAVs come from the public AMFI data (via mfapi.in). AMFI publishes each day's NAV in the
  evening.
- Stock prices and exchange rates come from Yahoo Finance: the daily closing price of each symbol, and
  for each foreign currency the daily rate against the rupee (for example AUD/INR). During market hours
  the latest point is the current price.
- NPS scheme NAVs come from NPS Trust (npstrust.org.in): the daily NAV of every scheme of every pension
  fund manager, and each scheme's full history since 2009.
- The app refreshes a holding's history automatically when the stored data is more than 6 hours old,
  whenever you open a page that needs it.
- **Refresh prices** in the top bar forces an immediate refresh of every NAV, price and exchange rate.
- With no internet connection the app keeps working with the prices it already has, and shows a banner
  so you know the figures may be a day or two old. If a source keeps failing, the banner repeats the
  reason and the app waits ten minutes before trying that source again.

**Gold bonds** take the day's traded price of each series from NSE's own feed (the data behind NSE's
sovereign gold bond market page), and the rest from sgb.vercel.app: a short daily price history, the face
value and issue date, the interest dates and the IBJA gold price RBI redeems at. If NSE cannot be reached the
page's price is used, and the Bond details card says so. One fetch each covers every series, refreshed like
the other sources and forced by *Refresh prices*; the app keeps working on the last fetched prices when both
are unreachable. Yahoo Finance does not carry the bond series. A bond without an NSE code is valued instead at
the gold price per gram you enter with **Gold price** on its page (or by importing a sheet that ends with a
Current Value line); one entered price, with its date, serves every such bond.

---

## 11. How the numbers are calculated

- **Units held** = units bought + bonus units − units sold (per holding, or per folio when filtered).
- **Investment** = what the units you still hold cost you. Without sales that is simply everything you
  paid (bonus units cost nothing, so they do not add to it). With sales, sold units are matched against
  purchases **first-in, first-out** (the oldest units are treated as sold first, the same rule Indian
  capital-gains tax uses), so the investment figure is the cost of the remaining, more recent units.
  Bonus units are a lot of their own, at zero cost, dated when they were received.
- **Current value** = units held × latest NAV or price.
- **Profit (unrealised)** = current value − investment. The percentage next to it is the simple
  (absolute) return on the current holdings, not annualised.
- **Realised gain** = sale proceeds − the FIFO cost of the units sold. When bonus units are sold the
  whole proceeds are gain. Shown separately, so profit on what you still hold and profit you have already
  taken are never mixed up.
- **Switches** (NPS rebalancing) move value between schemes. The scheme switched out of sells units at that
  day's NAV (first-in, first-out, so it realises the gain on those units) and the scheme switched into buys
  units at its NAV. Nothing is counted as a contribution or withdrawal, so the account's XIRR ignores
  switches; each scheme's own XIRR counts them as money leaving or entering that scheme.
- **Charges** = units deducted for fees, valued at that day's NAV. The units leave your holding like a sale
  whose proceeds you never receive, so the charge is subtracted from the overall gain. The money that goes in
  charges before an NPS contribution is allotted (the gap between the amount you paid and units × NAV) is
  simply part of what that contribution cost you.
- **EPF balance** of each share = deposits + interest credited − withdrawals. The investment is the deposits
  (employee and employer), the gain is the interest, and the **account XIRR** treats every deposit as money
  out and today's balance as money back. The **return on your own contributions** does the same with the
  employee deposits only, so the employer's share counts as part of the gain. Pension (EPS) contributions are
  outside all of this. No interest is ever calculated by the app.
- **PPF balance** = deposits + interest credited − withdrawals, exactly like one EPF share; the XIRR treats
  every deposit as money out and today's balance as money back. Interest is entered, never calculated.
- **Gold bond value** = grams held × the gold price per gram you entered (the latest entry; the chart uses
  each entry from its date on). Interest payments are treated exactly like dividends: realised, part of the
  XIRR, and shown as "interest" rather than "dividends". A redemption or sale is a sale of grams at that
  day's price, with the FIFO gain as for any holding.
- **Fixed deposit value** grows from the principal on the deposit date to the maturity value on the
  maturity date at a constant rate: on any day in between it is principal × (maturity value ÷
  principal)^(days elapsed ÷ days in the term), and from the maturity date on it is the maturity value.
  The **effective annual rate** is (maturity value ÷ principal)^(365.25 ÷ days in the term) − 1; a
  quarterly-compounded quoted rate gives a slightly higher effective rate. Interest paid out is treated
  like a dividend. The payout is a sale of the whole deposit at the amount received, so the realised gain
  is the interest earned. Without a maturity date and value the deposit is simply worth its principal.
- **Insurance policy value.** The policy's **rate of return** is the annual rate at which every premium
  (the ones paid, as recorded, and the ones still due, from the schedule), less any benefit already
  received, grows to exactly the maturity value on the maturity date: the XIRR of the whole plan. On any
  day the policy is worth the premiums paid so far, each grown at that rate from the day it was paid, less
  the benefits received grown the same way; it reaches the maturity value on the maturity date once every
  premium has been paid, and stays there. The value per rupee paid is that accrued value divided by the
  rupees paid, so the holding's own XIRR equals the policy rate as long as the schedule is kept. The payout is
  a sale of the whole policy at the amount received, with the gain over the premiums paid as the realised
  gain. Without a maturity date and value the policy is worth the premiums paid.
- **Dividends** = cash received as dividends or IDCW payouts. They are **realised**: the money is already
  in your bank account, so they are shown together with the gains from sales as the realised figure, and
  never inside the unrealised profit. They do not reduce the cost of your holding (that figure is what
  FIFO and the tax rules use), but the investment tile also shows the investment **net of dividends**,
  which is what you still have at stake.
- **XIRR** treats every purchase as money going out on its date, every sale and dividend as money coming
  in on its date, and today's current value as money coming back, and finds the annual rate that
  balances them. It is the standard way to measure SIP returns and matches Excel's XIRR function. For
  investments only a few weeks old the XIRR can look extreme (a small gain over a few days annualises to
  a huge percentage); it settles down with time.
- **Value over time** multiplies the units you held on each day by that day's NAV or price, so the value
  line drops when units are sold and rises when bonus units arrive. The invested line is the FIFO cost of
  the units held on that day: it rises with each purchase and falls when units are sold. The portfolio
  chart adds all holdings together day by day, carrying each one forward over days it has no price (stock
  exchanges and AMFI have different holidays).
- **Locked / redeemable** simply splits current value by each holding's Open/Locked status.

---

## 12. Stocks in other currencies

A stock is tracked in the currency its exchange uses, and that is what you enter in transactions: an
ASX purchase in Australian dollars, a NASDAQ purchase in US dollars. The holding's page shows everything
in that currency. The portfolio page, and the rupee equivalents on the holding's page, convert like this:

- Each purchase, sale and dividend is converted at the exchange rate **of its own date**. So a share
  bought for A$40 when a dollar was ₹55 is recorded as a ₹2,200 investment, whatever the rate is today.
- Today's value is converted at the **latest** rate.
- The rupee profit therefore includes the currency movement, which is your real rupee return. The
  holding's own-currency figures show the return without it. Both XIRRs are shown on the holding's page.
- The chart on the holding's page is in the stock's currency; the portfolio chart is in rupees, using
  each day's rate.
- Shares quoted in pence on the London Stock Exchange are converted to pounds automatically.
- If the exchange rate has not been downloaded yet (first time offline), the stock is shown in its own
  currency only and is left out of the rupee totals until **Refresh prices** succeeds.
- Rupees are the portfolio currency because the app is built for an Indian investor. If you ever need
  the totals in another currency, start the app with the environment variable
  `INVESTMENT_TRACKER_BASE_CURRENCY` set to that currency's code (for example `USD`); mutual funds
  are then converted too. Everything else stays the same.

---

## 13. NPS accounts: schemes, charges and rebalancing

An NPS account is one holding that contains several schemes, each a separate fund with its own NAV: E for
equity, C for corporate bonds, G for government securities and, on some accounts, A for alternative assets.
Every contribution you make is split between them in the proportion you chose, which is why one line on your
statement carries units and a NAV for each scheme.

- **What you enter.** Import the statement (section 7) or add transactions one at a time with the scheme
  chosen in the form. A contribution is shared out between the schemes by the value each received; the
  small gap between what you paid and that value is the charge taken before allotment, and it stays inside
  your cost so that the account's return is measured on the money you really paid.
- **Charges deducted as units.** The regular "restructure / maintenance charges" line (amount 0, units
  slightly negative in every scheme) is recorded as Charges per scheme. The units disappear from your
  holding and their value is shown as charges deducted on the account and in each scheme's P&L.
- **Rebalancing.** When units move from one scheme to another (amount 0, units down in one scheme, up in
  another) the app records a Switch out and a Switch in. No money is counted as leaving or entering the
  account.
- **Two kinds of XIRR.** The **account XIRR** uses only your own contributions and withdrawals plus today's
  value, so it is the return on the money you actually paid in, after all charges. Each **scheme's XIRR** is
  the return of that scheme on its own, counting switches into or out of it as money entering or leaving.
- **Exit.** Select a scheme chip and click **Exit scheme** to record selling everything in that scheme. When
  every scheme has been sold out the account is marked Closed.
- **NAVs** come from NPS Trust for the exact scheme you picked when adding the account, so make sure the
  tier and variant match your statement; if the NAVs look wrong, use **Edit NPS account** to change them.
  The NAV recorded on each of your transactions always stays the one from your statement.

---

## 14. EPF accounts: shares, interest and the pension scheme

Every month your employer deposits your own 12 % and its matching share into your EPF account, and part of
the employer's share goes to the Employees' Pension Scheme (EPS) instead. Once a year EPFO credits interest on
the employee and employer balances at the rate declared for that year. The app mirrors exactly that:

- **Three shares.** Each entry belongs to the employee share, the employer share or the pension scheme. The
  two EPF shares have balances and earn interest; the pension contributions are only added up and shown as
  "paid in so far", because that money buys a pension later rather than sitting in your balance.
- **Deposits and interest are data, not calculations.** You enter deposits (a year at a time from your sheet,
  or month by month) and, when EPFO credits it, the interest for the year on each share. The app adds them up
  per share and per financial year, so the balance always matches what you entered; the running balances on
  your sheet are ignored, which also means a slip in a sheet formula cannot creep in.
- **Until the year's interest is in**, the balance shows deposits only for that year and a banner says so.
- **Two returns.** The account XIRR is the return on all deposits, yours and your employer's; the return on
  your own contributions treats the employer's share as gain.
- **Changing jobs.** Click **Moved jobs** on the old account. Give the new employer's name, the display
  name of the new account and the date of the change. The app creates the new EPF account under the same
  UAN and moves every employee and employer share entry, deposits and interest alike, into it, so the new
  account shows the full history, the by-year table and the returns without a break. The pension (EPS)
  record stays with the old account (tick the box if yours moved too), which is then listed under Closed
  with a note of where its balance went; both accounts link to each other. From then on enter the new
  employer's months on the new account, including its pension contributions.
- **Transfers and withdrawals.** A balance that was already in another account before you started using
  the app is a transfer in (an entry of type Transfer in / opening balance, or the opening-balance tick box
  when importing a year); an advance is a withdrawal of the share it came from.

---

## 15. PPF accounts: deposits, interest and maturity

A Public Provident Fund account takes deposits whenever you like (at least ₹500 and at most ₹1.5 lakh in a
financial year), earns interest at the rate the government declares each quarter, and credits that interest
once a year on 31 March. A month's interest is paid on the lowest balance between the 5th and the end of the
month, which is why a deposit made by the 5th matters. The app records all of this as data:

- **Deposits** are dated the day you paid. When a year is imported, a deposit marked *Before 5th* is dated
  the 1st of the month and one marked *After 5th* the 15th.
- **Interest is entered, not calculated.** Import a year to add the monthly interest figures from your sheet
  up into one entry dated 31 March, or enter the year's interest with **Year interest** once the bank or post
  office credits it. Until then the balance shows deposits only for that year and a banner says so.
- **Maturity.** A PPF account matures 15 financial years after the year it was opened (opened in FY 2015-16,
  matures on 1 April 2031). The account page shows the date and the time left, and **Locked until** is filled
  with it when you set the opening date. After maturity the account is shown as extended in five-year blocks.
- **Withdrawals** (a partial withdrawal from the seventh year, or the balance at maturity) are entries of type
  Withdrawal. Withdrawing everything closes the account.

---

## 16. Sovereign Gold Bonds: gold price, interest and maturity

A Sovereign Gold Bond is a government bond denominated in grams of gold. You buy it at the issue price per
gram (online buyers get a ₹50 discount), RBI pays 2.5 % a year on the issue price in two half-yearly
instalments, and at maturity after eight years the bond is redeemed at the then gold price (the IBJA 999
rate), free of capital gains tax. RBI also buys it back from the fifth year on an interest date, and a bond
held in demat form can be sold on the exchange at any time. The app records this as:

- **Grams and a price per gram.** A purchase is so many grams at the price you paid; the holding is worth
  grams × its price per gram. With an NSE code that is the series' last traded price from NSE's feed,
  fetched with the other prices (sgb.vercel.app adds the history and the IBJA gold price, shown for
  comparison because RBI redeems at it). Without a code it is the **gold price per gram** you enter with **Gold price** (one price for
  all such bonds, dated, with the earlier entries kept for the chart).
- **Interest** is a transaction of type Interest (money received, no change in grams), like a dividend. The
  **Bond details** card shows the amount of each payment when the issue price is known, the next due date,
  and how many payments are left.
- **Dates.** From the issue date the app works out the half-yearly interest dates, the early-redemption date
  (five years on, which is also put into **Locked until**) and the maturity (eight years on, with the time
  left). Without an issue date the first purchase's date is used; set the real one with Edit gold bond.
- **Redemption or sale** is a sale of grams at that day's price; selling everything closes the bond.

---

## 17. Fixed deposits: maturity value, interest and payout

A bank fixed deposit is money placed for a fixed term at a fixed rate. The bank's FD advice states the
principal, the deposit date, the maturity date and the maturity value (or, for a deposit whose interest is
paid out, the rate and the payout frequency). The app keeps it simple:

- **One holding per deposit.** The deposit is the principal; the maturity date and value are the holding's
  terms, entered in the add / edit dialog or taken from a sheet's *Final Value at maturity* line.
- **Valued along the curve.** Between the two dates the deposit is worth what it has accrued so far at the
  rate implied by the two figures, so the value chart rises smoothly and the XIRR equals the effective rate.
  Without the terms the deposit is worth its principal.
- **Interest paid out** (non-cumulative deposits) is recorded as cash received. For such a deposit the
  maturity value is usually the principal itself.
- **Payout.** When the deposit matures (or is closed early), record what the bank paid with **Matured /
  paid out**; the holding closes with the interest earned as its realised gain. The payout is pre-filled with
  the maturity value, which you change to the amount actually credited if tax was deducted at source. A
  renewal is a new deposit holding.
- **Tax.** FD interest is taxable as income; the app does not work the tax out, it only records what you
  received.

---

## 18. Insurance policies: premiums, the policy's return and the payout

A traditional life insurance policy (an LIC endowment or money-back plan, for example) takes a fixed premium
on fixed dates for a fixed number of years and pays a sum assured plus bonuses at maturity. The policy
document gives the premium and its due dates; the maturity value is the sum assured plus the bonuses you
expect (the insurer's benefit illustration, or your own estimate), and you can change it whenever a bonus
is declared. The app records this as:

- **One holding per policy**, with the premium, how often it is paid, the first and last premium dates and
  the maturity date and value as its terms. The due dates follow from the first premium and the frequency,
  up to the last premium or, without one, the last due date before maturity.
- **Premiums** are the transactions: one per due date, recorded as paid. The add dialog can record every
  premium due so far in one go, a sheet can import them, and **Premium paid** records the next one when it
  falls due. A premium that fell due without being recorded is pointed out on the page and the portfolio
  row; the schedule still counts it as due.
- **The policy's return** is the rate that takes every premium of the schedule, paid and still to come, to
  the maturity value (section 11). It is the honest return of the plan as a whole, and it is what the
  policy is valued at: the premiums paid so far, grown at that rate. Compare it with what the same money
  would earn elsewhere.
- **Benefits received** along the way (survival benefits, bonuses paid out) are cash received; they lower
  what remains in the policy and enter the rate.
- **Payout.** At maturity, or on surrender, record what the insurer paid with **Matured / paid out**; the
  holding closes with the gain over the premiums paid as its realised gain.
- The **sum assured** (the life cover) is kept for your records; it plays no part in the valuation.

---

## 19. Your data: where it is, backups and safety

- Everything is stored in a single file named **`portfolio.enc`**, inside the `data` folder next to the
  exe (or inside the project's `data` folder when running from source). If the folder next to the exe is
  not writable, the file goes to `%LOCALAPPDATA%\InvestmentTracker\data` instead; `data\app.log`
  records the exact path when the app starts.
- The file is encrypted (AES-256) with a key derived from your password. Without the password it is
  unreadable, including to anyone who copies the file.
- **Back up** by copying `portfolio.enc` somewhere safe. Restore by copying it back. A backup is only
  useful together with the password.
- **Moving to another computer:** copy the exe and the `data` folder.
- **Forgotten password:** there is no reset. The only way forward is to delete `portfolio.enc` and start
  again from your statements. Consider keeping the password in a password manager.

### Cloud backup to Google Drive, OneDrive or Dropbox

Click **Cloud** in the top bar (or **Cloud backup…** under the lock screen). The dialog lists the three
providers. Each needs a one-time **Set up…** where you paste an OAuth client ID that you create in the provider's
own console under your personal account; the dialog explains the exact steps for each and links to the console
(for Google also a client secret; for Dropbox the return address `http://127.0.0.1:8000/api/cloud/callback` must be
registered on the app you create). Then click **Connect**: the provider's normal sign-in page opens in your
browser, you allow the app access to its own folder, and the browser hands you back to the app. From then on,
every change is uploaded a few seconds later, and the dialog shows the account, the last backup and what the
cloud holds. The file is encrypted before it leaves the device, so the cloud only ever holds ciphertext, and the
app can see only the folder it created (`Investment Tracker` in Google Drive, `Apps/<your app name>` in OneDrive
and Dropbox), never your other files.

To use the same data on another device, connect the same provider there and click **Restore from …**: the
device's vault file is replaced by the cloud copy (the previous file is kept beside it as
`portfolio.before-restore-<date>.enc`) and you unlock with that file's password. When a device's lock screen
finds that another device saved a newer copy, it says so and offers the restore right there. Several providers
can be connected at once; **Back up now** uploads immediately; **Disconnect** stops the backups and leaves the
copy in the cloud as it is. The client IDs stay in `settings.json`, the sign-in tokens in `cloud_tokens.json` in
the data folder; delete that file or disconnect to revoke this device.

### Keeping the vault in a cloud folder, and using it on another device

The vault is one file, `portfolio.enc`, encrypted with your password before it is written, so a folder that
OneDrive, Google Drive or Dropbox syncs only ever holds ciphertext. To move it there, click **Change folder…**
under the lock screen (or the first-run screen), give the folder's full path, and leave **Copy the current vault
file there** ticked; the choice is kept in `settings.json` next to the exe and takes effect when you open the app
again. Leave the folder empty to go back to the default. The folder can also be set with the
`INVESTMENT_TRACKER_DATA` environment variable, which wins over the setting.

Keep only one device open at a time. The app keeps the whole database in memory while unlocked and writes the
file after every change, so if the file on disk is replaced underneath it (a sync client bringing another
device's copy, or a file you copied in by hand) it does not overwrite that copy: it locks itself, the lock screen
explains why, and unlocking loads the new copy. If this app had changes of its own that were not yet in the file,
they are kept in a side file named `portfolio.conflict-<date>.enc` in the same folder, which opens with the same
password: the app never silently loses either side. A sync client re-downloading an identical file is not
treated as a change.

---

## 20. The Android app

The same app runs on an Android phone: the backend runs inside the app, the pages are the ones you know, and the
data is the same encrypted file, `portfolio.enc`, kept in the app's private storage. It is installed from the
APK file built from this project (`android\app\build\outputs\apk\debug\app-debug.apk`): copy it to the phone and
open it, allowing the file manager to install unknown apps when asked. The first start unpacks the app and takes
a few seconds; after that it opens like any other app and asks for the vault password.

- **The same data on the phone and the PC.** Long-press anywhere on a page to open the menu. **Save vault as…**
  writes the phone's vault file to a place you pick: Google Drive, OneDrive, Dropbox and the Downloads folder all
  appear in the picker. **Open vault file…** replaces the phone's vault with a file you pick (it asks first, and
  the app locks so the file's own password is needed). On the PC, the vault is in the data folder (section 19),
  which can itself be a cloud-synced folder. Copy the file in one direction at a time, and keep only one device
  open while you make changes: both apps refuse to overwrite a file that another device changed.
- **Prices** are fetched by the phone the same way: mutual funds, stocks, NPS and gold bonds refresh when
  older than six hours or with Refresh prices; EPF and PPF need no prices.
- **Links** such as the Google Finance quote open in the phone's browser.
- **Reload** in the menu reloads the page; **About** shows the version, which matches the PC build it came from.
- The phone keeps your theme, the collapsed groups and the active tab, just like the PC.

---

## 21. Tips and shortcuts

- **Enter** on a highlighted holding or folio row opens it; **Escape** closes any dialog.
- Bookmark a holding's page, or a folio view of it, in your browser; the address includes both.
- The chart period and the theme you choose are remembered on this computer.
- Hover over a truncated comment or name to see the full text.
- Use the folio filter before clicking **+ Add transaction** or **Import** to have that folio pre-filled.
- Broker contract notes usually list Buy/Sell, quantity and price: paste them straight into Import.

---

## 22. Troubleshooting

| Problem | What to do |
|---|---|
| No window appeared | Wait a few seconds; the first start unpacks the app. If nothing happens, open `http://127.0.0.1:8000` in a browser and check `data\app.log`. |
| Port 8000 is used by something else | The app picks the next free port automatically; the window opens on it, and `data\app.log` records the address. |
| "Windows protected your PC" | Click *More info*, then *Run anyway*. One-time only. |
| "Price refresh failed" banner | No internet or the price service is down. Figures use the last downloaded prices; click *Refresh prices* later. |
| A fund shows a strange value or NAV | It is probably linked to the wrong plan (IDCW vs Growth, Regular vs Direct). Use *Edit fund → Change scheme* (section 8). |
| A stock's price looks wrong by a factor of 100 | London shares are quoted in pence; the app converts them to pounds, so enter your transactions in pounds too. |
| "Could not look up SYMBOL" when adding a stock | The symbol is not known to Yahoo Finance, or you are offline. Try the search, or add the exchange suffix (`.NS`, `.BO`, `.AX`, `.L`). |
| A foreign stock is missing from the rupee totals | Its exchange rate has not been downloaded yet. Click *Refresh prices* while online. |
| "No NAV / price available for that date" | The holding did not exist on that date, or history is not downloaded yet. Enter the figure from your statement. |
| "Could not fetch NAVs for SM0070xx" when adding an NPS account | NPS Trust could not be reached, or that scheme is not in its NAV file. Try again online; if a scheme is missing, untick it. |
| An NPS row imports with the wrong types | Check the preview labels: 0 amount with units down everywhere is charges; units down in one scheme and up in another is a rebalance; money with units everywhere is a contribution. Fix the data (for example a missing minus sign) and paste again. |
| An EPF year shows "pending" interest | EPFO's interest for that year has not been entered. Click *Year interest* on the account page once it is credited. |
| A PPF year shows "pending" interest | The interest for that year has not been entered. Import the year's sheet, or click *Year interest* once the bank or post office credits it. |
| A gold bond shows no current value | It has no price yet. With an NSE code, click *Refresh prices* while online and check the code under *Edit gold bond*; without one, click *Gold price* and enter today's price per gram. |
| "SGBMAR30X is not in the Sovereign Gold Bond lists" when adding a bond | The code is not an NSE symbol either source knows. Pick the series from the list in the dialog instead, or leave the code empty and enter the gold price yourself. |
| Bond details says the price came from sgb.vercel.app | NSE's feed could not be reached at the last refresh, so the page's (possibly older) price was used. Click *Refresh prices* when online. |
| My EPF sheet's balances differ from the app | The app adds deposits and credited interest itself. Check the deposits and interest you entered for the year; the sheet's own balance columns are not used. |
| Forgot the password | Not recoverable. Delete `portfolio.enc` to start over. |
| App locked while I was working | It auto-locks after 30 idle minutes. Unlock and continue; nothing is lost. |
| I installed a new version but see the old screens | Check the version shown next to the app name in the top bar. Since version 0.4.0 the app clears its window cache on every start and a newer exe shuts down an older instance that is still running, so simply close the window and start the exe again. On older versions press **F5** in the window once, and make sure no `InvestmentTracker.exe` is left in Task Manager. |

---

## 23. Feature history

| Date | Added |
|---|---|
| 2 Nov 2026 | First version: funds with folio, AMFI scheme and Open/Locked status; SIP and lumpsum transactions with NAV auto-fill; current value, profit and XIRR per fund and for the portfolio; value-over-time charts; locked vs redeemable split; light and dark theme. |
| 2 Nov 2026 | Packaged as a single `InvestmentTracker.exe`. |
| 2 Nov 2026 | Bulk import of transactions by pasting a table or choosing a file, with column detection, duplicate skipping and preview. |
| 2 Nov 2026 | Folio-wise view: folio filter chips and a By-folio breakdown on the fund page. |
| 2 Nov 2026 | Comments on transactions, editable inline, with import support. |
| 2 Nov 2026 | Password protection: encrypted data file, unlock on every start, Lock button, auto-lock, change password. No recovery by design. |
| 3 Nov 2026 | Edit fund rework: re-link a fund to the correct AMFI scheme with transactions untouched; optional folio correction on existing transactions; Edit action on portfolio rows. |
| 3 Nov 2026 | Fix: vaults migrated from the unencrypted version could not be unlocked (WAL header). |
| 3 Nov 2026 | Purchases spread over several folios (e.g. `1234567890/2345678901`) are split into one transaction per folio with the amount and units divided equally, both in the import and in the Add transaction form. |
| 3 Nov 2026 | Standalone app window: the exe (and `run.bat`) now open the app in its own window with no console or browser tabs; closing the window quits. Messages go to `data\app.log`. |
| 3 Nov 2026 | Redemptions: a third transaction type for sales. Units held fall, sale proceeds count in XIRR, realised gains are tracked with FIFO matching, and the investment figure becomes the cost of the units still held. The import recognises sales from negative units, type words, or positive amounts in a file whose purchases are negative. |
| 3 Nov 2026 | Stocks: shares and ETFs on any exchange, in any currency, alongside mutual funds. Symbol search and daily prices from Yahoo Finance; each stock tracked in its own currency with rupee equivalents; portfolio totals, chart and XIRR in rupees using daily exchange rates; Mutual funds vs stocks split and per-currency lines on the portfolio page; Buy / Sell wording, accounts instead of folios, and broker-style columns (Symbol, Qty, Price, B/S) in the import. |
| 3 Nov 2026 | Dividends and bonus / free units: two more transaction types, for funds and stocks. A dividend is cash received (counted in XIRR and overall gain, holdings unchanged); bonus units are added at zero cost. Recognised in the import from type words or from the pattern (money with 0 units, units with 0 money). |
| 3 Nov 2026 | Allocation pie on the portfolio page: current value split by asset class (mutual funds, stocks; ready for more classes such as gold), with the total in the middle and a list of counts, invested amounts, shares and values. Replaces the Mutual funds vs stocks bar. |
| 4 Nov 2026 | Dividends are shown as realised, together with gains from sales, never inside the unrealised profit; the investment figure is also shown net of dividends received. |
| 4 Nov 2026 | Exit and closed holdings: an Exit button records the sale of everything held; any sale that brings the units to zero marks the holding Closed and lists it under a Closed tab on the portfolio page, keeping all its data. |
| 4 Nov 2026 | Version 0.4.0: the version is shown in the top bar; upgrades can no longer show stale screens (the window cache is cleared on start and the server forbids caching), and starting a newer exe replaces an older instance that is still running. |
| 9 Nov 2026 | Version 0.12.2: first run on a real phone (Motorola Edge 30, Android 14) and the layout fixes it showed up: the holdings table keeps Holding, Current value, P&L and XIRR on a narrow screen (Status, Invested, Latest and Edit are left to the holding's page), the detail cards wrap their text instead of running off the edge, the kind chooser in the Add dialog wraps onto two lines, the lock screen says "phone" on a phone and its vault path wraps inside the card. Reinstalling the same version of the Android app now refreshes its copy of the pages. |
| 7 Nov 2026 | Version 0.12.1: tick boxes in the allocation list. Untick a class to leave it out of the ring; the ring, its centre total and the shares are redrawn from the ticked classes, and the choice is remembered. |
| 7 Nov 2026 | Version 0.12.0: life insurance policies (LIC endowment and money-back plans). A policy holds its premium, frequency, first / last premium dates and maturity value as terms; its return is the rate that takes every premium, paid and still due, to the maturity value, and the premiums paid are valued at that rate. The add dialog records every premium due so far in one go, a Premium paid button records the next, overdue premiums are flagged, benefits received and the payout / surrender are recorded like FD interest and payouts. A premium sheet imports directly: paid rows become premiums, future rows and the Value at maturity line set the terms. Rows dated after today are no longer imported for any kind of holding. Insurance gets its own slice of the allocation ring. |
| 7 Nov 2026 | Version 0.11.0: fixed deposits. A deposit is one holding with the principal and the bank's maturity date and value as its terms; it is valued along a constant-rate curve between the two dates (effective rate shown), interest paid out is recorded as cash, and Matured / paid out records the payout and closes it. The add dialog records the deposit in one go; a sheet with an account number, type, date and amount imports directly and its Final Value at maturity line sets the terms. Fixed deposits get their own slice of the allocation ring. Pasted rows now keep an empty first cell, and long account numbers are no longer mistaken for amounts. |
| 6 Nov 2026 | Version 0.10.0: cloud backup. Connect Google Drive, OneDrive or Dropbox through the provider's own sign-in (one-time client ID setup); every change is uploaded a few seconds later, any device can restore the latest copy, and the lock screen points out a newer copy saved elsewhere. |
| 6 Nov 2026 | Android app: the backend and frontend packaged for a phone (an APK built from the android folder), with the vault opened from and saved to any file or cloud folder from a long-press menu. |
| 6 Nov 2026 | Version 0.9.0: a Data folder setting (Change folder… on the lock screen; kept in settings.json next to the exe) so the vault can live in a cloud-synced folder, and a guard that locks the app instead of overwriting a vault file another device or a sync client replaced, keeping its own unsaved changes in a side file. The lock screen shows where the vault file is. Request models now run on pydantic v1 as well as v2, for the Android build. |
| 6 Nov 2026 | Version 0.8.2: gold bond prices now come from NSE's own feed (today's traded price of every live series), with sgb.vercel.app supplying the history, issue details and IBJA rate and standing in when NSE is unreachable; the Bond details card names the feed. |
| 6 Nov 2026 | Version 0.8.1: gold bonds priced automatically. A bond with an NSE code takes the series' last traded price (and a short history) from sgb.vercel.app, refreshed with the other prices; the add dialog lists every series with its issue date and price; the Bond details card shows the price source and the IBJA gold price RBI redeems at. The entered gold price remains for bonds without a code. |
| 6 Nov 2026 | Version 0.8.0: Sovereign Gold Bonds. A gold bond holds grams bought at a price per gram, is valued at a gold price per gram you enter (shared by every bond, with its date and history), records half-yearly interest like dividends, and shows its issue terms, interest schedule, early-redemption date and maturity; sheets in the mutual fund layout import directly, and their Current Value line can set the gold price. Kind chips now show whenever more than one kind is held. |
| 6 Nov 2026 | Version 0.7.1: the subtotal row of each holding group shows the group's XIRR (active holdings on the Active tab, closed ones on the Closed tab). |
| 5 Nov 2026 | Version 0.7.0: PPF accounts. Deposits entry by entry or a financial year at a time from your sheet (Before / After 5th decides the date), the year's interest entered as data (the sheet's monthly figures added up, dated 31 March), a by-year table, the deposits-and-interest chart, maturity 15 financial years after opening with the time left, and a PPF slice in the allocation ring. |
| 5 Nov 2026 | Fixed a rare freeze: when two requests overlapped (for example a page opening while prices refreshed) the app could stop answering until restarted. |
| 5 Nov 2026 | Version 0.6.2: EPF page gains a Deposits and interest by year chart, one stacked column per financial year in three colours (employee deposits, employer deposits, interest credited). |
| 5 Nov 2026 | Version 0.6.1: holding groups on the portfolio can be collapsed and expanded by clicking the group heading; the choice is remembered. |
| 5 Nov 2026 | EPF entries shown one row per month (employee, employer and pension side by side) and edited as a month; portfolio holdings grouped by asset class with subtotals. |
| 5 Nov 2026 | EPF job change: "Moved jobs" creates the new employer's account under the same UAN and moves the employee and employer share history to it; the pension record stays with the old account, which closes. |
| 5 Nov 2026 | Version 0.6.0: EPF accounts. Employee and employer shares with deposits month by month or a financial year at a time from your sheet, the pension (EPS) contribution tracked separately, interest entered per year as EPFO credits it (never calculated), a by-financial-year table with closing balances, the account XIRR and the return on your own contributions, and a reminder when a year's interest is still pending. |
| 5 Nov 2026 | Version 0.5.0: NPS accounts. One holding with schemes E / C / G (/ A), NAVs from NPS Trust, scheme chips and a By-scheme table with each scheme's own XIRR and the account XIRR on your own contributions; the eNPS statement format imports directly (units and NAV per scheme), with charges deducted as units and rebalancing recorded as switches. Two new transaction types for every kind: Switch in / out and Charges. |

This guide is updated whenever a feature is added or changed.
