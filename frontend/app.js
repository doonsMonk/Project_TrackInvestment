// Investment Tracker frontend: hash-routed single page app, no build step.
//   #/            portfolio overview (everything in the base currency, INR)
//   #/fund/<id>   one holding (mutual fund or stock) with its transactions, in its own currency

import { api } from './api.js';
import { valueChart, updateValueChart, segmentedBar, donutChart, stackedColumns, seriesColors, themeTokens } from './charts.js';
import { fmtMoney, fmtINR, fmtPct, fmtNum, fmtDate, esc, todayISO, isNum } from './format.js';
import { openModal, closeModal, toast, confirmDialog } from './ui.js';
import { openImportModal } from './import.js';
import { splitFolios, distribute, fyLabel } from './parse.js';

const app = document.getElementById('app');
const RANGES = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '3Y': 36, All: null };

// Kind-specific vocabulary: a mutual fund has folios, NAVs and units; a stock has accounts, prices and shares.
const MOVE_TYPES = { SWITCH_IN: 'Switch in', SWITCH_OUT: 'Switch out', CHARGE: 'Charges' };
const KINDS = {
  MF: { key: 'MF', label: 'Mutual fund', lower: 'mutual fund', plural: 'Mutual funds', price: 'NAV', folio: 'Folio', folioPlural: 'folios', unit: 'units', priceDecimals: 4,
        types: { SIP: 'SIP', LUMPSUM: 'Lumpsum', REDEMPTION: 'Redemption', DIVIDEND: 'Dividend', BONUS: 'Bonus units', ...MOVE_TYPES }, sold: 'redeemed' },
  STOCK: { key: 'STOCK', label: 'Stock', lower: 'stock', plural: 'Stocks', price: 'Price', folio: 'Account', folioPlural: 'accounts', unit: 'shares', priceDecimals: 2,
           types: { SIP: 'SIP', LUMPSUM: 'Buy', REDEMPTION: 'Sell', DIVIDEND: 'Dividend', BONUS: 'Bonus shares', ...MOVE_TYPES }, sold: 'sold' },
  NPS: { key: 'NPS', label: 'NPS account', lower: 'NPS account', plural: 'NPS accounts', price: 'NAV', realisedWhat: 'on units switched or deducted', folio: 'PRAN', folioPlural: 'PRANs', unit: 'units', priceDecimals: 4,
         types: { SIP: 'Contribution', LUMPSUM: 'Lumpsum contribution', REDEMPTION: 'Withdrawal', DIVIDEND: 'Dividend', BONUS: 'Bonus units', ...MOVE_TYPES }, sold: 'withdrawn' },
  EPF: { key: 'EPF', label: 'EPF account', lower: 'EPF account', plural: 'EPF accounts', price: 'NAV', realisedWhat: 'on withdrawals', folio: 'UAN', folioPlural: 'UANs', unit: 'rupees', priceDecimals: 2,
         types: { SIP: 'Deposit', LUMPSUM: 'Transfer in', REDEMPTION: 'Withdrawal', DIVIDEND: 'Dividend', BONUS: 'Interest credited', ...MOVE_TYPES }, sold: 'withdrawn' },
  PPF: { key: 'PPF', label: 'PPF account', lower: 'PPF account', plural: 'PPF accounts', price: 'NAV', realisedWhat: 'on withdrawals', folio: 'Account number', folioPlural: 'account numbers', unit: 'rupees', priceDecimals: 2,
         types: { SIP: 'Deposit', LUMPSUM: 'Transfer in', REDEMPTION: 'Withdrawal', DIVIDEND: 'Dividend', BONUS: 'Interest credited', ...MOVE_TYPES }, sold: 'withdrawn' },
  GOLD: { key: 'GOLD', label: 'Sovereign Gold Bond', lower: 'gold bond', plural: 'Gold', price: 'Price per gram', realisedWhat: 'from sales', dividendWord: 'interest', folio: 'Folio', folioPlural: 'folios', unit: 'grams', priceDecimals: 2,
          types: { SIP: 'SIP', LUMPSUM: 'Purchase', REDEMPTION: 'Redemption / sale', DIVIDEND: 'Interest', BONUS: 'Bonus units', ...MOVE_TYPES }, sold: 'sold' },
  FD: { key: 'FD', label: 'Fixed deposit', lower: 'fixed deposit', plural: 'Fixed deposits', price: 'Value per rupee', realisedWhat: 'at payout', dividendWord: 'interest', folio: 'Account number', folioPlural: 'account numbers', unit: 'rupees', priceDecimals: 4,
        types: { SIP: 'Deposit', LUMPSUM: 'Deposit', REDEMPTION: 'Payout', DIVIDEND: 'Interest paid out', BONUS: 'Bonus', ...MOVE_TYPES }, sold: 'paid out' },
  INS: { key: 'INS', label: 'Insurance policy', lower: 'policy', plural: 'Insurance policies', price: 'Value per rupee', realisedWhat: 'at payout', dividendWord: 'benefits', folio: 'Policy number', folioPlural: 'policy numbers', unit: 'rupees', priceDecimals: 4,
         types: { SIP: 'Premium', LUMPSUM: 'Single premium / top-up', REDEMPTION: 'Payout', DIVIDEND: 'Benefit received', BONUS: 'Bonus', ...MOVE_TYPES }, sold: 'paid out' },
};
const EPF_SHARES = { EE: 'Employee share', ER: 'Employer share', EPS: 'Pension (EPS)' };
/** Indian financial year of an ISO date: '2011-02-15' -> '2010-11'. */
const fyOfDate = (iso) => { const y = Number(iso.slice(0, 4)); const start = Number(iso.slice(5, 7)) >= 4 ? y : y - 1; return `${start}-${String((start + 1) % 100).padStart(2, '0')}`; };
/** PPF maturity: 1 April, 15 financial years after the year the account was opened. */
const ppfMaturityDate = (iso) => { const y = Number(iso.slice(0, 4)); const start = Number(iso.slice(5, 7)) >= 4 ? y : y - 1; return `${start + 16}-04-01`; };
/** ISO date n years later (29 February becomes 1 March in a common year, as HTML date inputs reject it). */
const addYears = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setFullYear(d.getFullYear() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const goldMaturityText = (g) => (!g?.maturity ? '' : g.matured ? `matured ${fmtDate(g.maturity)}` : `matures ${fmtDate(g.maturity)}`);
const ppfMaturityText = (p) => (!p?.matures_on ? '' : p.extended_till ? `matured ${fmtDate(p.matures_on)} · extended till ${fmtDate(p.extended_till)}` : `matures ${fmtDate(p.matures_on)}`);
const fdMaturityText = (x) => (!x?.maturity_date ? '' : x.awaiting_payout ? `matured ${fmtDate(x.maturity_date)} · awaiting payout` : x.matured ? `matured ${fmtDate(x.maturity_date)}` : `matures ${fmtDate(x.maturity_date)}`);
/** ISO date n months later, the day clamped to the month's end (14 Feb + 12 -> 14 Feb; 31 Jan + 1 -> 28/29 Feb). */
const addMonths = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(y, m - 1 + n, 1); const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate(); t.setDate(Math.min(d, last)); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const FREQ_MONTHS = { yearly: 12, 'half-yearly': 6, quarterly: 3, monthly: 1 };
const CHIP_CLASS = { REDEMPTION: ' redemption', DIVIDEND: ' dividend', BONUS: ' bonus', SWITCH_IN: ' switch', SWITCH_OUT: ' switch', CHARGE: ' charge' };
const kindOf = (f) => KINDS[f?.kind] || KINDS.MF;
const SCHEME_NAMES = { E: 'Equity', C: 'Corporate bonds', G: 'Government securities', A: 'Alternative assets' };
// Asset classes for the allocation ring, in a fixed order so each keeps its colour as classes are added.
const ASSET_CLASSES = [
  { kind: 'MF', label: 'Mutual funds', one: 'fund', many: 'funds' },
  { kind: 'STOCK', label: 'Stocks', one: 'stock', many: 'stocks' },
  { kind: 'NPS', label: 'NPS', one: 'account', many: 'accounts' },
  { kind: 'EPF', label: 'EPF', one: 'account', many: 'accounts' },
  { kind: 'PPF', label: 'PPF', one: 'account', many: 'accounts' },
  { kind: 'GOLD', label: 'Gold', one: 'holding', many: 'holdings' },
  { kind: 'FD', label: 'Fixed deposits', one: 'deposit', many: 'deposits' },
  { kind: 'INS', label: 'Insurance', one: 'policy', many: 'policies' },
];
let BASE = 'INR'; // portfolio currency, confirmed by the server on boot

function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

const state = {
  chart: null,
  donut: null,
  holdingsTab: 'active', // portfolio table: 'active' or 'closed'
  history: [],
  range: load('range', '1Y'),
  theme: load('theme', 'auto'),
};
if (!(state.range in RANGES)) state.range = '1Y';

// Optional ?theme=light|dark|auto in the URL seeds (and remembers) the theme.
const urlTheme = new URLSearchParams(location.search).get('theme');
if (['light', 'dark', 'auto'].includes(urlTheme)) {
  state.theme = urlTheme;
  save('theme', urlTheme);
}

// ---------------------------------------------------------------- theme
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const effectiveTheme = () => (state.theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : state.theme);

function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = state.theme;
  const btn = document.getElementById('btn-theme');
  if (btn) {
    const dark = effectiveTheme() === 'dark';
    btn.textContent = dark ? '☀ Light' : '☾ Dark';
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
}

// ---------------------------------------------------------------- view helpers
const pct = (frac) => (isNum(frac) ? frac * 100 : null);

const LOCK_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const UNLOCK_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';

function statusBadge(f) {
  if (f.closed) return `<span class="badge closed" title="Sold out completely; kept with all its transactions">Closed${f.closed_on ? ` · ${fmtDate(f.closed_on)}` : ''}</span>`;
  if (!f.locked) return `<span class="badge open">${UNLOCK_ICON} Open</span>`;
  const till = f.lock_in_until ? ` till ${fmtDate(f.lock_in_until)}` : '';
  return `<span class="badge locked" title="Under lock-in${till}">${LOCK_ICON} Locked${till}</span>`;
}

/** "realised ₹1,277 (₹1,200 from sales · ₹77 dividends)", or '' when nothing has been realised. */
function realisedText(s, M, what = 'from sales', divWord = 'dividends') {
  const r = s.realised_gain || 0;
  const d = s.dividends || 0;
  if (!r && !d) return '';
  if (r && d) return `realised ${M(r + d)} (${M(r)} ${what} · ${M(d)} ${divWord})`;
  return `realised ${M(r + d)} ${d ? `in ${divWord}` : what}`;
}

/** Investment less the dividends already received, shown under the investment figure. */
function netOfDividends(s, M, divWord = 'dividends') {
  if (!s.dividends || !s.invested) return '';
  return s.net_invested > 0 ? `${M(s.net_invested)} net of ${divWord} received` : `${divWord} received exceed the cost`;
}

function kindChip(f) {
  const short = { STOCK: 'Stock', NPS: 'NPS', EPF: 'EPF', PPF: 'PPF', GOLD: 'Gold', FD: 'FD', INS: 'Policy' }[f.kind] || 'MF';
  return `<span class="chip kind${f.kind === 'MF' || !f.kind ? '' : ` ${f.kind.toLowerCase()}`}">${short}</span>`;
}

function hero({ label, value, profit, absPct, realised = 0, dividends = 0, currency = BASE, approx = '', realisedWhat = 'from sales', dividendWord = 'dividends' }) {
  const M = (v) => fmtMoney(v, currency);
  const has = isNum(profit);
  const up = has && profit >= 0;
  const taken = realisedText({ realised_gain: realised, dividends }, M, realisedWhat, dividendWord);
  let sub;
  if (has) {
    sub = `<div class="delta ${up ? 'up' : 'down'}"><span aria-hidden="true">${up ? '▲' : '▼'}</span> ${M(Math.abs(profit))}
             <span class="muted">(${fmtPct(absPct)}) ${taken ? 'unrealised ' : ''}${up ? 'gain' : 'loss'}${taken ? ' on current holdings' : ''}</span></div>${taken ? `<div class="muted small">${taken}</div>` : ''}`;
  } else if (realised || dividends) {
    sub = `<div class="delta ${realised + dividends >= 0 ? 'up' : 'down'}">${taken} <span class="muted">· nothing held now</span></div>`;
  } else {
    sub = '<div class="muted small">Add transactions to see returns</div>';
  }
  return `
    <section class="card hero">
      <div class="tile-label">${label}</div>
      <div class="hero-value">${M(value)}</div>
      ${sub}
      ${approx ? `<div class="approx">${approx}</div>` : ''}
    </section>`;
}

function tile(label, valueHtml, sub = '') {
  return `<div class="card tile"><div class="tile-label">${label}</div><div class="tile-value">${valueHtml}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ''}</div>`;
}

function deltaValue(profit, currency = BASE) {
  if (!isNum(profit)) return '–';
  const up = profit >= 0;
  return `<span class="delta ${up ? 'up' : 'down'}"><span aria-hidden="true">${up ? '▲' : '▼'}</span> ${fmtMoney(Math.abs(profit), currency)}</span>`;
}

function rangeButtons() {
  return `<div class="range-filter" role="group" aria-label="Time range">${Object.keys(RANGES)
    .map((k) => `<button type="button" class="range-btn${k === state.range ? ' active' : ''}" data-range="${k}">${k}</button>`)
    .join('')}</div>`;
}

function navErrorBanner(errors) {
  const msgs = Object.values(errors || {});
  if (!msgs.length) return '';
  return `<div class="banner warn" role="status">⚠ Price refresh failed for ${msgs.length} source${msgs.length > 1 ? 's' : ''}; showing last cached values. <span class="small">${esc(msgs[0])}</span></div>`;
}

const loading = () => '<section class="card"><p class="empty">Loading…</p></section>';

function errorCard(err) {
  return `<section class="card error-card"><h2>Something went wrong</h2><p class="muted">${esc(err?.message || err)}</p><button type="button" class="btn ghost small" data-action="reload">Reload</button></section>`;
}

// ---------------------------------------------------------------- chart mounting
function filterHistory(history, rangeKey) {
  const months = RANGES[rangeKey];
  if (!months || history.length < 2) return history;
  const last = new Date(history[history.length - 1].date);
  last.setMonth(last.getMonth() - months);
  const cutoff = last.toISOString().slice(0, 10);
  const filtered = history.filter((p) => p.date >= cutoff);
  return filtered.length > 1 ? filtered : history;
}

function destroyChart() {
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
  if (state.donut) {
    state.donut.destroy();
    state.donut = null;
  }
  if (state.yearChart) {
    state.yearChart.destroy();
    state.yearChart = null;
  }
}

function mountChart(history, currency = BASE) {
  state.history = history;
  const canvas = document.getElementById('value-chart');
  if (!canvas) return;
  const wrap = canvas.closest('.chart-wrap');
  if (!history.length) {
    wrap.innerHTML = '<p class="empty">Add transactions to see the value graph.</p>';
    return;
  }
  if (!window.Chart) {
    wrap.innerHTML = '<p class="empty">Chart library did not load (offline?). Figures above are still current.</p>';
    return;
  }
  let shown = filterHistory(history, state.range);
  if (!shown.some((p) => p.value || p.invested)) shown = history; // closed before the range began: show its whole life instead of a flat zero
  state.chart = valueChart(canvas, shown, { currency });
}

function wireRange(root) {
  root.querySelector('.range-filter')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    state.range = btn.dataset.range;
    save('range', state.range);
    root.querySelectorAll('.range-btn').forEach((b) => b.classList.toggle('active', b.dataset.range === state.range));
    if (state.chart) updateValueChart(state.chart, filterHistory(state.history, state.range));
  });
}

// ---------------------------------------------------------------- portfolio view
/** Current value by asset class, in the fixed ASSET_CLASSES order (unknown classes follow, alphabetically). */
function allocationParts(t) {
  const bk = t.by_kind || {};
  const colors = seriesColors();
  const known = ASSET_CLASSES.map((c) => c.kind);
  const extra = Object.keys(bk).filter((k) => !known.includes(k)).sort();
  const classes = [...ASSET_CLASSES, ...extra.map((k) => ({ kind: k, label: k[0] + k.slice(1).toLowerCase(), one: 'holding', many: 'holdings' }))];
  const parts = classes
    .map((c, i) => ({ ...c, color: colors[i % colors.length], ...(bk[c.kind] || { count: 0, invested: 0, current_value: 0 }) }))
    .filter((p) => p.count > 0);
  const total = parts.reduce((s, p) => s + Math.max(0, p.current_value), 0);
  parts.forEach((p) => { p.share = total ? (Math.max(0, p.current_value) / total) * 100 : 0; });
  return { parts, total };
}

function allocationSection(t, alloc) {
  const rows = alloc.parts
    .map(
      (p) => `<div class="kv-row"><i class="swatch" style="background:${p.color}"></i><span>${esc(p.label)}</span><span class="muted small">${p.count} ${p.count === 1 ? p.one : p.many} · invested ${fmtINR(p.invested)} · ${p.share.toFixed(1)}%</span><b>${fmtINR(p.current_value)}</b></div>`,
    )
    .join('');
  const currencyRows = (t.currencies || [])
    .map(
      (c) => `<div class="kv-row currency-row"><span>${esc(c.currency)} holdings</span><span class="muted small">${c.count} stock${c.count === 1 ? '' : 's'} · ${fmtMoney(c.current_value, c.currency)} · 1 ${esc(c.currency)} = ${fmtINR(c.rate, 2)} on ${fmtDate(c.rate_date)}</span><b>${fmtINR(c.current_value_base)}</b></div>`,
    )
    .join('');
  const summary = alloc.parts.map((p) => `${p.label} ${fmtINR(p.current_value)} (${p.share.toFixed(1)}%)`).join(', ');
  return `
    <section class="card">
      <div class="card-head"><h2>Allocation</h2><span class="muted small">current value by asset class, in ${esc(BASE)}</span></div>
      <div class="alloc-grid">
        <div class="donut-wrap"><canvas id="alloc-chart" role="img" aria-label="Allocation: ${esc(summary)}"></canvas></div>
        <div class="kv-list alloc-list">${rows}${currencyRows}</div>
      </div>
    </section>`;
}

function mountDonut(alloc) {
  const canvas = document.getElementById('alloc-chart');
  if (!canvas) return;
  const wrap = canvas.closest('.donut-wrap');
  if (!alloc.total) {
    wrap.innerHTML = '<p class="empty small">Nothing valued yet.</p>';
    return;
  }
  if (!window.Chart) {
    wrap.innerHTML = '<p class="empty small">Chart library did not load; the list on the right has the figures.</p>';
    return;
  }
  state.donut = donutChart(canvas, alloc.parts.map((p) => ({ label: p.label, value: p.current_value, color: p.color })), { currency: BASE, centreLabel: 'current value' });
}

async function renderPortfolio() {
  app.innerHTML = loading();
  const data = await api.get('/api/portfolio');
  const t = data.totals;
  BASE = data.base_currency || BASE;

  if (!data.funds.length) {
    app.innerHTML = `
      <div class="page-head"><h1>Portfolio</h1></div>
      <section class="card empty-card">
        <h2>Nothing here yet</h2>
        <p>Add a mutual fund or a stock, then record your purchases and sales. NAVs come from AMFI data; stock prices and exchange rates from Yahoo Finance.</p>
        <button type="button" class="btn primary" id="btn-add-fund-inline">+ Add your first holding</button>
      </section>`;
    return;
  }

  const asOf = data.funds.map((f) => f.summary.latest_nav_date).filter(Boolean).sort().pop();
  const tokens = themeTokens();
  const anyStock = data.funds.some((f) => f.kind && f.kind !== 'MF'); // kind chips once there is more than one kind
  const activeFunds = data.funds.filter((f) => !f.closed);
  const closedFunds = data.funds.filter((f) => f.closed);
  const rowBits = (f) => {
    const k = kindOf(f);
    const s = f.summary;
    const cur = f.currency || BASE;
    const foreign = Boolean(f.needs_fx);
    const bs = foreign ? f.base?.summary : s; // figures in the base currency (undefined when no exchange rate yet)
    const folioText = f.folio_count > 1 ? `${f.folio_count} ${k.folioPlural}` : f.folio_number ? `${k.folio} ${f.folio_number}` : '';
    const what = f.kind === 'STOCK'
      ? [f.symbol, f.exchange, cur].filter(Boolean).join(' · ')
      : f.kind === 'NPS'
        ? ['NPS', f.details?.pfm, f.details?.tier ? `Tier ${f.details.tier}` : '', f.schemes?.length ? `Schemes ${f.schemes.map((p) => p.scheme).join(' / ')}` : ''].filter(Boolean).join(' · ')
        : f.kind === 'EPF'
          ? ['EPF', f.details?.employer, f.epf?.pending_interest_fy ? `interest for FY ${f.epf.pending_interest_fy} pending` : ''].filter(Boolean).join(' · ')
          : f.kind === 'GOLD'
            ? ['Sovereign Gold Bond', f.details?.code, goldMaturityText(f.gold), f.gold?.price ? '' : 'no gold price entered'].filter(Boolean).join(' · ')
          : f.kind === 'FD'
            ? ['Fixed deposit', f.details?.bank, fdMaturityText(f.fd), f.fd?.has_terms || f.closed ? '' : 'maturity not set'].filter(Boolean).join(' · ')
          : f.kind === 'INS'
            ? ['Insurance policy', f.details?.insurer, f.details?.plan, fdMaturityText(f.policy), f.closed ? '' : f.policy?.overdue ? `${f.policy.overdue} premium${f.policy.overdue === 1 ? '' : 's'} due` : f.policy?.next_due ? `next premium ${fmtDate(f.policy.next_due)}` : '', f.policy?.has_terms || f.closed ? '' : 'maturity not set'].filter(Boolean).join(' · ')
          : f.kind === 'PPF'
            ? ['PPF', f.details?.bank, ppfMaturityText(f.ppf), f.ppf?.pending_interest_fy ? `interest for FY ${f.ppf.pending_interest_fy} pending` : ''].filter(Boolean).join(' · ')
            : f.scheme?.scheme_category;
    const sub = [what, folioText].filter(Boolean).join(' · ');
    const native = (v) => (foreign ? `<div class="sub-amount">${fmtMoney(v, cur)}</div>` : '');
    const nameCell = `<td><div class="fund-name">${anyStock ? kindChip(f) : ''}${esc(f.name)}</div><div class="muted small">${esc(sub)}</div></td>`;
    const xirrCell = `<td class="num">${fmtPct(pct(bs?.xirr))}${foreign && bs ? `<div class="sub-amount">${fmtPct(pct(s.xirr))} in ${esc(cur)}</div>` : ''}</td>`;
    const editCell = `<td class="row-actions"><button type="button" class="link-btn" data-edit-fund="${f.id}" title="Edit name, scheme or symbol, folio or status">Edit</button></td>`;
    return { k, s, cur, foreign, bs, native, nameCell, xirrCell, editCell };
  };
  const kindsOf = (list) => {
    const present = [...new Set(list.map((f) => f.kind || 'MF'))];
    const order = ASSET_CLASSES.map((c) => c.kind);
    return present.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  };
  const classOf = (kind) => ASSET_CLASSES.find((c) => c.kind === kind) || { kind, label: kind, one: 'holding', many: 'holdings' };
  const inrOf = (f) => (f.needs_fx ? f.base?.summary : f.summary) || null;
  /** Groups the user has collapsed, as "tab:KIND" keys, remembered between visits. */
  const collapsed = (() => {
    try { return new Set(JSON.parse(load('holdingsCollapsed', '[]'))); } catch { return new Set(); }
  })();
  /**
   * Rows grouped under one header per asset class, each group with a subtotal, when more than one class is
   * present. The header is a toggle: a collapsed group hides its holdings and keeps only the subtotal row.
   */
  const grouped = (list, rowHtml, subtotalHtml, span, tab) => {
    const kinds = kindsOf(list);
    if (kinds.length < 2) return list.map(rowHtml).join('');
    return kinds
      .map((kind) => {
        const group = list.filter((f) => (f.kind || 'MF') === kind);
        const c = classOf(kind);
        const key = `${tab}:${kind}`;
        const shut = collapsed.has(key);
        const head = `<tr class="group-row${shut ? ' collapsed' : ''}"><td colspan="${span}">
            <button type="button" class="group-toggle" data-group-toggle="${key}" data-kind="${kind}" aria-expanded="${!shut}" title="${shut ? 'Show' : 'Hide'} the holdings in this group">
              <span class="chev" aria-hidden="true"></span>${kindChip({ kind })}<span>${esc(c.label)}</span><span class="muted small">${group.length} ${group.length === 1 ? c.one : c.many}</span>
            </button></td></tr>`;
        const body = group.map((f) => rowHtml(f).replace('<tr', `<tr data-group="${kind}"${shut ? ' hidden' : ''}`)).join('');
        return head + body + subtotalHtml(c, group);
      })
      .join('');
  };
  const activeSubtotal = (c, group) => {
    const sums = group.map(inrOf).filter(Boolean);
    const invested = sums.reduce((s, x) => s + x.invested, 0);
    const value = sums.reduce((s, x) => s + x.current_value, 0);
    const x = t.by_kind?.[c.kind]?.active_xirr;
    return `<tr class="group-total"><td colspan="2">${esc(c.label)}</td><td class="num">${fmtINR(invested)}</td><td class="num">${fmtINR(value)}</td><td class="num">${deltaValue(invested ? value - invested : null)}</td><td class="num" title="Annualised return of these holdings together, in ${esc(BASE)}">${fmtPct(pct(x))}</td><td colspan="2"></td></tr>`;
  };
  const closedSubtotal = (c, group) => {
    const sums = group.map(inrOf).filter(Boolean);
    const bought = sums.reduce((s, x) => s + x.purchased, 0);
    const sold = sums.reduce((s, x) => s + x.redeemed, 0);
    const realised = sums.reduce((s, x) => s + x.realised_total, 0);
    const x = t.by_kind?.[c.kind]?.closed_xirr;
    return `<tr class="group-total"><td colspan="2">${esc(c.label)}</td><td class="num">${fmtINR(bought)}</td><td class="num">${fmtINR(sold)}</td><td class="num">${deltaValue(realised)}</td><td class="num" title="Annualised return of these closed holdings together, in ${esc(BASE)}">${fmtPct(pct(x))}</td><td></td></tr>`;
  };
  const activeRow = (f) => {
      const { k, s, cur, bs, native, nameCell, xirrCell, editCell } = rowBits(f);
      const taken = bs ? realisedText(bs, fmtINR, k.realisedWhat || 'from sales', k.dividendWord) : '';
      return `
        <tr class="row-link" data-href="#/fund/${f.id}" tabindex="0">
          ${nameCell}
          <td>${statusBadge(f)}</td>
          <td class="num">${bs ? fmtINR(bs.invested) : '–'}${native(s.invested)}</td>
          <td class="num">${bs ? fmtINR(bs.current_value) : '–'}${native(s.current_value)}</td>
          <td class="num">${bs ? deltaValue(bs.invested ? bs.profit : null) : '–'}<div class="muted small">${bs ? fmtPct(bs.abs_return_pct) : ''}${taken ? ` · ${taken}` : ''}</div></td>
          ${xirrCell}
          <td class="num muted small">${isNum(s.latest_nav) ? `${fmtMoney(s.latest_nav, cur, k.priceDecimals)}<br>${fmtDate(s.latest_nav_date)}` : f.kind === 'NPS' && f.schemes?.length ? f.schemes.map((p) => `${esc(p.scheme)} ${isNum(p.summary.latest_nav) ? fmtNum(p.summary.latest_nav, 2) : '–'}`).join('<br>') : f.kind === 'EPF' || f.kind === 'PPF' ? `${fmtINR(s.interest)}<br>interest` : '–'}</td>
          ${editCell}
        </tr>`;
    };
  const rows = grouped(activeFunds, activeRow, activeSubtotal, 8, 'active');
  const closedRow = (f) => {
      const { s, bs, native, nameCell, xirrCell, editCell } = rowBits(f);
      return `
        <tr class="row-link" data-href="#/fund/${f.id}" tabindex="0">
          ${nameCell}
          <td>${statusBadge(f)}</td>
          <td class="num">${bs ? fmtINR(bs.purchased) : '–'}${native(s.purchased)}</td>
          <td class="num">${bs ? fmtINR(bs.redeemed) : '–'}${native(s.redeemed)}</td>
          <td class="num">${bs ? deltaValue(bs.realised_total) : '–'}<div class="muted small">${bs?.dividends ? `incl. ${fmtINR(bs.dividends)} ${k.dividendWord || 'dividends'}` : ''}</div></td>
          ${xirrCell}
          ${editCell}
        </tr>`;
    };
  const closedRows = grouped(closedFunds, closedRow, closedSubtotal, 7, 'closed');
  const tab = closedFunds.length && state.holdingsTab === 'closed' ? 'closed' : 'active';
  const tabs = closedFunds.length
    ? `<div class="range-filter" role="tablist" aria-label="Holdings">
        <button type="button" class="range-btn${tab === 'active' ? ' active' : ''}" data-tab="active" role="tab">Active (${activeFunds.length})</button>
        <button type="button" class="range-btn${tab === 'closed' ? ' active' : ''}" data-tab="closed" role="tab">Closed (${closedFunds.length})</button>
      </div>`
    : '';

  const unconverted = t.unconverted || [];
  const alloc = allocationParts(t);
  app.innerHTML = `
    ${navErrorBanner(data.nav_errors)}
    ${unconverted.length ? `<div class="banner warn">No exchange rate yet for ${esc(unconverted.join(', '))}, so ${unconverted.length === 1 ? 'it is' : 'they are'} left out of the totals below. Click <b>Refresh prices</b> when you are online.</div>` : ''}
    <div class="page-head">
      <h1>Portfolio</h1>
      <div class="muted small">${asOf ? `Prices as of ${fmtDate(asOf)} · ` : ''}${t.fund_count} holding${t.fund_count === 1 ? '' : 's'}${t.closed_count ? ` · ${t.closed_count} closed` : ''}${anyStock ? ` · totals in ${esc(BASE)}` : ''}</div>
    </div>
    <section class="summary-grid">
      ${hero({ label: 'Current value', value: t.current_value, profit: t.invested ? t.profit : null, absPct: t.abs_return_pct, realised: t.realised_gain, dividends: t.dividends })}
      <div class="tiles">
        ${tile(t.redeemed ? 'Investment in holdings' : 'Total investment', fmtINR(t.invested), [t.redeemed ? `${fmtINR(t.purchased)} bought · ${fmtINR(t.redeemed)} sold` : '', netOfDividends(t, fmtINR)].filter(Boolean).join(' · '))}
        ${tile(t.redeemed || t.dividends ? 'Unrealised profit' : 'Total profit', deltaValue(t.invested ? t.profit : null), [isNum(t.abs_return_pct) ? `${fmtPct(t.abs_return_pct)} absolute` : '', realisedText(t, fmtINR)].filter(Boolean).join(' · '))}
        ${tile('XIRR', fmtPct(pct(t.xirr)), `annualised, all holdings${anyStock ? `, in ${esc(BASE)}` : ''}`)}
        ${tile('Redeemable now', fmtINR(t.unlocked_value), `${fmtINR(t.locked_value)} locked`)}
      </div>
    </section>
    <section class="card chart-card">
      <div class="card-head"><h2>Portfolio value over time</h2>${rangeButtons()}</div>
      <div class="chart-wrap"><canvas id="value-chart" role="img" aria-label="Portfolio current value and invested amount over time"></canvas></div>
    </section>
    ${allocationSection(t, alloc)}
    <section class="card">
      <div class="card-head"><h2>Locked vs redeemable</h2><span class="muted small">by current value</span></div>
      ${segmentedBar(
        [
          { label: 'Redeemable (open)', value: t.unlocked_value, color: tokens.series1 },
          { label: 'Locked (lock-in)', value: t.locked_value, color: tokens.muted },
        ],
        { ariaLabel: `Redeemable ${fmtINR(t.unlocked_value)}, locked ${fmtINR(t.locked_value)}` },
      )}
      <div class="kv-list">
        <div class="kv-row"><span>Redeemable now</span><span class="muted small">${t.fund_count - t.locked_count} open · invested ${fmtINR(t.unlocked_invested)}</span><b>${fmtINR(t.unlocked_value)}</b></div>
        <div class="kv-row"><span>Locked</span><span class="muted small">${t.locked_count} locked · invested ${fmtINR(t.locked_invested)}</span><b>${fmtINR(t.locked_value)}</b></div>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><div class="filter-bar"><h2>Holdings</h2>${tabs}</div><button type="button" class="btn primary small" id="btn-add-fund-inline">+ Add fund / stock</button></div>
      <div class="table-wrap" id="holdings-active" ${tab === 'active' ? '' : 'hidden'}>
        ${activeFunds.length ? `
        <table class="data">
          <thead><tr><th>Holding</th><th>Status</th><th class="num">Invested</th><th class="num">Current value</th><th class="num">P&amp;L</th><th class="num">XIRR</th><th class="num">Latest ${anyStock ? 'NAV / price' : 'NAV'}</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td colspan="2">Total${anyStock ? ` (${esc(BASE)})` : ''}</td><td class="num">${fmtINR(t.invested)}</td><td class="num">${fmtINR(t.current_value)}</td><td class="num">${deltaValue(t.invested ? t.profit : null)}</td><td class="num">${fmtPct(pct(t.xirr))}</td><td colspan="2"></td></tr></tfoot>
        </table>` : '<p class="empty">Nothing held at the moment. Everything you had is under Closed.</p>'}
      </div>
      ${closedFunds.length ? `
      <div class="table-wrap" id="holdings-closed" ${tab === 'closed' ? '' : 'hidden'}>
        <table class="data">
          <thead><tr><th>Holding</th><th>Status</th><th class="num">Bought</th><th class="num">Sold for</th><th class="num">Realised</th><th class="num">XIRR</th><th></th></tr></thead>
          <tbody>${closedRows}</tbody>
        </table>
        <p class="muted small" style="margin-top:8px">Closed holdings were sold out completely. Their transactions, realised gains and dividends are kept and still count in the totals above; adding a purchase reopens one.</p>
      </div>` : ''}
    </section>`;

  mountChart(data.history, BASE);
  mountDonut(alloc);
  wireRange(app);
  app.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      state.holdingsTab = b.dataset.tab;
      app.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
      document.getElementById('holdings-active').hidden = state.holdingsTab !== 'active';
      const closedWrap = document.getElementById('holdings-closed');
      if (closedWrap) closedWrap.hidden = state.holdingsTab !== 'closed';
    }),
  );
  app.querySelectorAll('[data-group-toggle]').forEach((b) =>
    b.addEventListener('click', () => {
      const key = b.dataset.groupToggle;
      const open = b.getAttribute('aria-expanded') !== 'true';
      if (open) collapsed.delete(key); else collapsed.add(key);
      save('holdingsCollapsed', JSON.stringify([...collapsed]));
      b.setAttribute('aria-expanded', String(open));
      b.title = `${open ? 'Hide' : 'Show'} the holdings in this group`;
      const head = b.closest('tr');
      head.classList.toggle('collapsed', !open);
      head.closest('tbody').querySelectorAll(`tr[data-group="${b.dataset.kind}"]`).forEach((r) => { r.hidden = !open; });
    }),
  );
  app.querySelectorAll('tr.row-link').forEach((tr) => {
    const go = () => { location.hash = tr.dataset.href; };
    tr.addEventListener('click', (e) => { if (!e.target.closest('[data-edit-fund]')) go(); });
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });
  app.querySelectorAll('[data-edit-fund]').forEach((b) =>
    b.addEventListener('click', () => openFundModal({ id: Number(b.dataset.editFund) })),
  );
}

// ---------------------------------------------------------------- fund view
function commentCell(notes) {
  return notes
    ? `<button type="button" class="comment-text" title="${esc(notes)} (click to edit)">${esc(notes)}</button>`
    : '<button type="button" class="link-btn comment-add">+ Add comment</button>';
}

/** Turn a comment cell into an inline editor; Enter or blur saves, Escape cancels. */
function startCommentEdit(td, tx, others = []) {
  if (td.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'comment-input';
  input.maxLength = 500;
  input.placeholder = 'Comment…';
  input.value = tx.notes || '';
  td.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (!save || value === (tx.notes || '')) { td.innerHTML = commentCell(tx.notes); return; }
    try {
      const updated = await api.patch(`/api/transactions/${tx.id}/notes`, { notes: value });
      tx.notes = updated.notes;
      await Promise.all(others.map(async (o) => { o.notes = (await api.patch(`/api/transactions/${o.id}/notes`, { notes: value })).notes; }));
      td.innerHTML = commentCell(tx.notes);
      toast(value ? 'Comment saved' : 'Comment removed');
    } catch (e) {
      td.innerHTML = commentCell(tx.notes);
      toast(`Could not save comment: ${e.message}`, 'error');
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/** EPF entries grouped into one row per month: the employee, employer and pension entries of the same date and
 * type side by side. Each row carries the ids of its entries so Edit / Delete act on the whole month. */
function epfGroups(txns) {
  const rows = [];
  const index = new Map();
  for (const t of txns) { // newest first, as served
    const base = `${t.date}|${t.type}|${t.folio_number || ''}`;
    let list = index.get(base);
    if (!list) { list = []; index.set(base, list); }
    let g = list.find((x) => !x.shares[t.scheme]);
    if (!g) { g = { date: t.date, type: t.type, folio: t.folio_number || '', shares: {}, entries: [] }; list.push(g); rows.push(g); }
    g.shares[t.scheme] = t;
    g.entries.push(t);
  }
  return rows;
}

/** EPF / PPF entries, one row per date and type: EPF shows the employee, employer and pension amounts side by
 * side, PPF a single amount. */
function epfTxnTable(txns, cur, kind = 'EPF') {
  const ppf = kind === 'PPF';
  const shares = ppf ? [['', `Amount (${esc(cur)})`]] : [['EE', 'Employee'], ['ER', 'Employer'], ['EPS', 'Pension (EPS)']];
  const types = (KINDS[kind] || KINDS.EPF).types;
  const M = (v, d = 2) => fmtMoney(v, cur, d);
  const amountOf = (t) => (t.type === 'BONUS' ? t.units : t.amount);
  const sum = (pred) => txns.filter(pred).reduce((s, t) => s + amountOf(t), 0);
  const deposits = sum((t) => (t.type === 'SIP' || t.type === 'LUMPSUM') && t.scheme !== 'EPS');
  const pension = ppf ? 0 : sum((t) => (t.type === 'SIP' || t.type === 'LUMPSUM') && t.scheme === 'EPS');
  const interest = sum((t) => t.type === 'BONUS');
  const withdrawn = sum((t) => t.type === 'REDEMPTION');
  const cell = (t) => (t ? `${t.type === 'REDEMPTION' ? '−' : ''}${M(amountOf(t))}` : '<span class="muted">–</span>');
  const body = epfGroups(txns)
    .map((g) => {
      const rate = g.entries.find((t) => isNum(t.rate))?.rate;
      const note = g.entries.find((t) => t.notes)?.notes || '';
      return `
      <tr data-ids="${g.entries.map((t) => t.id).join(',')}">
        <td>${fmtDate(g.date)}</td>
        <td><span class="chip${CHIP_CLASS[g.type] || ''}">${types[g.type] || g.type}</span></td>
        ${shares.map(([key]) => `<td class="num">${cell(g.shares[key])}</td>`).join('')}
        <td class="num">${isNum(rate) ? `${rate}%` : '–'}</td>
        <td class="comment-cell">${commentCell(note)}</td>
        <td class="row-actions"><button type="button" class="link-btn" data-edit>Edit</button><button type="button" class="link-btn danger-text" data-del>Delete</button></td>
      </tr>`;
    })
    .join('');
  const line = (v, label) => (v ? `${M(v)}<div class="muted small">${label}</div>` : '');
  return `
    <div class="table-wrap">
      <table class="data txn-table">
        <thead><tr><th>Date</th><th>Type</th>${shares.map(([, label]) => `<th class="num">${label}</th>`).join('')}<th class="num">IR%</th><th>Comment</th><th></th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td colspan="2">Total (${txns.length} entr${txns.length === 1 ? 'y' : 'ies'})</td><td class="num"${ppf ? '' : ' colspan="2"'}>${line(deposits, ppf ? 'deposits' : 'deposits (employee + employer)')}${line(interest, 'interest')}${line(withdrawn, 'withdrawn')}</td>${ppf ? '' : `<td class="num">${line(pension, 'pension (EPS)')}</td>`}<td colspan="3"></td></tr></tfoot>
      </table>
    </div>`;
}

function txnTable(txns, k, cur, { showScheme = false, epf = false } = {}) {
  if (epf) return epfTxnTable(txns, cur, k.key);
  const is = (t, ...types) => types.includes(t.type);
  const M = (v, d = 0) => fmtMoney(v, cur, d);
  const sum = (...types) => txns.filter((t) => is(t, ...types)).reduce((s, t) => s + t.amount, 0);
  const totalAmount = sum('SIP', 'LUMPSUM');
  const soldAmount = sum('REDEMPTION');
  const divAmount = sum('DIVIDEND');
  const switchedIn = sum('SWITCH_IN');
  const switchedOut = sum('SWITCH_OUT');
  const charges = sum('CHARGE');
  const totalUnits = txns.reduce((s, t) => s + (is(t, 'REDEMPTION', 'SWITCH_OUT', 'CHARGE') ? -t.units : is(t, 'DIVIDEND') ? 0 : t.units), 0);
  const body = txns
    .map((tx) => {
      const out = is(tx, 'REDEMPTION', 'SWITCH_OUT', 'CHARGE');
      const plus = is(tx, 'BONUS', 'SWITCH_IN');
      return `
      <tr data-id="${tx.id}">
        <td>${fmtDate(tx.date)}</td>
        ${showScheme ? `<td><span class="chip">${esc(tx.scheme) || '–'}</span></td>` : `<td>${esc(tx.folio_number) || '–'}</td>`}
        <td><span class="chip${CHIP_CLASS[tx.type] || ''}">${k.types[tx.type] || tx.type}</span></td>
        <td class="num">${is(tx, 'BONUS') ? '–' : M(tx.amount, 2)}</td>
        <td class="num">${tx.nav > 0 ? fmtNum(tx.nav, k.priceDecimals) : '–'}</td>
        <td class="num">${is(tx, 'DIVIDEND') ? '–' : `${out ? '−' : plus ? '+' : ''}${fmtNum(tx.units, 4)}`}</td>
        <td class="comment-cell">${commentCell(tx.notes)}</td>
        <td class="row-actions"><button type="button" class="link-btn" data-edit>Edit</button><button type="button" class="link-btn danger-text" data-del>Delete</button></td>
      </tr>`;
    })
    .join('');
  const unitHead = k.unit[0].toUpperCase() + k.unit.slice(1);
  const line = (v, label) => (v ? `${M(v, 2)}<div class="muted small">${label}</div>` : '');
  return `
    <div class="table-wrap">
      <table class="data txn-table">
        <thead><tr><th>Date</th><th>${showScheme ? 'Scheme' : k.folio}</th><th>Type</th><th class="num">Amount (${esc(cur)})</th><th class="num">${k.price}</th><th class="num">${unitHead}</th><th>Comment</th><th></th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td colspan="3">Total (${txns.length} transaction${txns.length === 1 ? '' : 's'})</td><td class="num">${line(totalAmount, showScheme ? 'contributed' : 'bought')}${line(soldAmount, k.sold)}${line(divAmount, k.dividendWord || 'dividends')}${line(switchedIn, 'switched in')}${line(switchedOut, 'switched out')}${line(charges, 'charges')}</td><td></td><td class="num">${fmtNum(totalUnits, 4)}<div class="muted small">held</div></td><td colspan="2"></td></tr></tfoot>
      </table>
    </div>`;
}

const NO_FOLIO = '(none)'; // server-side key for transactions with a blank folio

function fundHash(id, folioKey, schemeKey) {
  const p = new URLSearchParams();
  if (folioKey) p.set('folio', folioKey);
  if (schemeKey) p.set('scheme', schemeKey);
  const qs = p.toString();
  return qs ? `#/fund/${id}?${qs}` : `#/fund/${id}`;
}

/** NPS / EPF: chips to scope the page to one scheme (E / C / G ...) or share (employee / employer), or the whole account. */
function schemeFilter(f, activeKey, labelOf = (p) => `Scheme ${esc(p.scheme)}`, title = 'Scheme') {
  if (!f.schemes || f.schemes.length < 2) return '';
  const btn = (key, label) =>
    `<button type="button" class="range-btn${(activeKey || '') === key ? ' active' : ''}" data-scheme="${esc(key)}">${label}</button>`;
  return `<div class="filter-bar"><span class="muted small">${title}</span>
    <div class="range-filter folio-filter" role="group" aria-label="${title}">${btn('', 'Whole account')}${f.schemes.map((p) => btn(p.scheme, labelOf(p))).join('')}</div></div>`;
}

/** "2 years 5 months left", "3 months left", or '' once the date has passed. */
function timeLeft(iso) {
  const now = new Date();
  const to = new Date(`${iso}T00:00:00`);
  const months = (to.getFullYear() - now.getFullYear()) * 12 + (to.getMonth() - now.getMonth()) - (to.getDate() < now.getDate() ? 1 : 0);
  if (months <= 0) return '';
  const y = Math.floor(months / 12);
  const m = months % 12;
  return `${[y ? `${y} year${y === 1 ? '' : 's'}` : '', m ? `${m} month${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ')} left`;
}

/** PPF: the four headline tiles. */
function ppfTiles(s, M, f) {
  const p = f.ppf || {};
  const years = p.years || [];
  const lastInterest = [...years].reverse().find((y) => y.interest);
  const thisFy = years.find((y) => y.fy === p.current_fy);
  const interest = isNum(s.interest) ? s.interest : s.bonus_units || 0;
  const maturity = p.extended_till
    ? tile('Extended till', fmtDate(p.extended_till), `matured ${fmtDate(p.matures_on)} · extended in 5-year blocks`)
    : p.matures_on
      ? tile('Matures on', fmtDate(p.matures_on), [timeLeft(p.matures_on), p.opened_fy ? `opened in FY ${esc(p.opened_fy)}` : ''].filter(Boolean).join(' · '))
      : tile('Matures on', '–', 'set the opening date with Edit PPF account');
  return [
    tile('Deposits', M(s.purchased), [thisFy?.deposit ? `${M(thisFy.deposit)} in FY ${esc(thisFy.fy)}` : 'nothing yet this financial year', s.redeemed ? `${M(s.redeemed)} withdrawn` : ''].filter(Boolean).join(' · ')),
    tile('Interest credited', M(interest), [lastInterest ? `up to FY ${esc(lastInterest.fy)}${isNum(lastInterest.rate) ? ` at ${lastInterest.rate}%` : ''}` : 'none entered yet', p.pending_interest_fy ? `FY ${esc(p.pending_interest_fy)} pending` : ''].filter(Boolean).join(' · ')),
    tile('XIRR', fmtPct(pct(s.xirr)), 'annualised · PPF interest is tax-free'),
    maturity,
  ].join('');
}

/** EPF: the four headline tiles (whole account or one share). */
function epfTiles(s, activeScheme, M, f) {
  const years = f.epf?.years || [];
  const lastInterest = [...years].reverse().find((y) => y.interest_ee || y.interest_er);
  const pending = f.epf?.pending_interest_fy;
  const interest = isNum(s.interest) ? s.interest : s.bonus_units || 0;
  if (activeScheme) {
    return [
      tile('Deposits', M(s.invested), `${activeScheme.name.toLowerCase()} only`),
      tile('Interest credited', M(interest), lastInterest ? `up to FY ${lastInterest.fy}` : 'none entered yet'),
      tile('XIRR', fmtPct(pct(s.xirr)), 'annualised, this share on its own'),
      tile('Balance', M(s.current_value), `${M(s.invested)} deposited · ${M(interest)} interest`),
    ].join('');
  }
  return [
    tile('Deposits', M(s.invested), `employee ${M(s.deposits_employee)} · employer ${M(s.deposits_employer)}`),
    tile('Interest credited', M(interest), [lastInterest ? `up to FY ${lastInterest.fy}${isNum(lastInterest.rate) ? ` at ${lastInterest.rate}%` : ''}` : 'none entered yet', pending ? `FY ${pending} pending` : ''].filter(Boolean).join(' · ')),
    tile('XIRR', fmtPct(pct(s.xirr)), `on all deposits · ${fmtPct(pct(s.own_xirr))} on your own contributions`),
    tile('Pension scheme (EPS)', M(s.pension_paid), 'paid in so far · not part of the balance'),
  ].join('');
}

/** EPF: one row per financial year, balances worked out from deposits and the interest entered. */
/**
 * EPF / PPF: one stacked column per financial year. EPF: employee deposits, employer deposits and the interest
 * credited, following the Share filter (share = 'EE' | 'ER' | undefined for the whole account); PPF: deposits
 * and the interest credited.
 */
function mountYearChart(f, share, currency) {
  const canvas = document.getElementById('year-chart');
  const acct = f.epf || f.ppf;
  const years = acct?.years || [];
  if (!canvas || !years.length) return;
  const t = themeTokens();
  const pending = acct.pending_interest_fy;
  const placeholder = (i) => (years[i].fy === pending ? 'pending' : null);
  const series = f.ppf
    ? [
        { label: 'Deposits', data: years.map((y) => y.deposit), color: t.series1 },
        { label: 'Interest credited', data: years.map((y) => y.interest), color: t.series3, placeholder },
      ]
    : [
        share !== 'ER' ? { label: 'Employee deposits', data: years.map((y) => y.deposit_ee), color: t.series1 } : null,
        share !== 'EE' ? { label: 'Employer deposits', data: years.map((y) => y.deposit_er), color: t.series2 } : null,
        { label: 'Interest credited', data: years.map((y) => (share === 'ER' ? 0 : y.interest_ee) + (share === 'EE' ? 0 : y.interest_er)), color: t.series3, placeholder },
      ].filter(Boolean);
  state.yearChart = stackedColumns(canvas, years.map((y) => `FY ${y.fy}`), series, { currency, totalLabel: 'Year total' });
}

/** Fixed deposit: the four headline tiles. */
function fdTiles(s, M, f) {
  const x = f.fd || {};
  const paidOut = f.closed || !(s.units > 0);
  const rate = isNum(x.effective_rate) ? `${(x.effective_rate * 100).toFixed(2)}%` : isNum(x.quoted_rate) ? `${x.quoted_rate}%` : '–';
  return [
    tile('Principal', M(x.principal || s.purchased || 0), [x.deposit_date ? `deposited ${fmtDate(x.deposit_date)}` : 'no deposit recorded yet', isNum(x.quoted_rate) ? `quoted ${x.quoted_rate}% a year` : ''].filter(Boolean).join(' · ')),
    paidOut
      ? tile('Paid out', M(s.redeemed || 0), [f.closed_on ? `on ${fmtDate(f.closed_on)}` : '', isNum(s.realised_gain) ? `${M(s.realised_gain)} interest earned` : '', s.dividends ? `${M(s.dividends)} paid out before` : ''].filter(Boolean).join(' · '))
      : x.has_terms
        ? tile('Maturity value', M(x.maturity_value), [`on ${fmtDate(x.maturity_date)}`, isNum(x.interest_at_maturity) ? `${M(x.interest_at_maturity)} interest` : '', x.matured ? 'matured · record the payout' : timeLeft(x.maturity_date) || `${x.days_left} days left`].filter(Boolean).join(' · '))
        : tile('Maturity value', '–', 'set the maturity date and value with Edit fixed deposit'),
    tile('Interest rate', rate, isNum(x.effective_rate) ? `a year, worked out from the principal and the maturity value${isNum(x.quoted_rate) ? ` · ${x.quoted_rate}% quoted` : ''}` : isNum(x.quoted_rate) ? 'quoted by the bank' : 'set the maturity value to see the rate'),
    tile('XIRR', fmtPct(pct(s.xirr)), paidOut ? 'annualised, on the money paid out' : x.has_terms ? 'annualised, on today\'s accrued value · FD interest is taxable' : 'annualised'),
  ].join('');
}

/** Insurance policy: the four headline tiles. */
function insTiles(s, M, f) {
  const x = f.policy || {};
  const paidOut = f.closed || !(s.units > 0);
  const freq = x.frequency ? ` ${x.frequency}` : '';
  return [
    tile('Premiums paid', M(x.paid_total || s.purchased || 0), [isNum(x.premiums_total) ? `${x.premiums_paid} of ${x.premiums_total}` : `${x.premiums_paid || 0} so far`, x.premium ? `${M(x.premium)}${freq}` : '', !paidOut && x.next_due ? (x.overdue ? `${x.overdue} due, not recorded` : `next ${fmtDate(x.next_due)}`) : ''].filter(Boolean).join(' · ')),
    paidOut
      ? tile('Paid out', M(s.redeemed || 0), [f.closed_on ? `on ${fmtDate(f.closed_on)}` : '', isNum(s.realised_gain) ? `${M(s.realised_gain)} over the premiums` : '', s.dividends ? `${M(s.dividends)} received before` : ''].filter(Boolean).join(' · '))
      : x.has_terms
        ? tile('Maturity value', M(x.maturity_value), [`on ${fmtDate(x.maturity_date)}`, x.matured ? 'matured · record the payout' : timeLeft(x.maturity_date) || `${x.days_left} days left`, x.pending_total ? `${M(x.pending_total)} still to pay` : ''].filter(Boolean).join(' · '))
        : tile('Maturity value', '–', 'set the maturity date and value with Edit policy'),
    tile('Policy return', isNum(x.policy_rate) ? fmtPct(x.policy_rate * 100) : '–', isNum(x.policy_rate) ? `a year, over every premium${isNum(x.premiums_total) ? ` (all ${x.premiums_total})` : ''}${x.benefits_received ? ', the benefits received' : ''} and the maturity value` : 'set the maturity value to see it'),
    tile('XIRR', fmtPct(pct(s.xirr)), paidOut ? 'annualised, on the money paid out' : x.has_terms ? 'annualised, on the premiums paid and today\'s accrued value' : 'annualised'),
  ].join('');
}

/** Insurance policy: the plan, the premium schedule and what has happened so far. */
function insCard(f, cur) {
  const x = f.policy || {};
  const d = f.details || {};
  const s = f.summary || {};
  const M = (v, dec = 0) => fmtMoney(v, cur, dec);
  const row = (label, value, sub = '') => (value ? `<tr><td class="nowrap"><b>${label}</b></td><td>${value}${sub ? `<div class="muted small">${sub}</div>` : ''}</td></tr>` : '');
  const open = s.units > 0 && !f.closed;
  const rows = [
    row('Insurer', d.insurer ? esc(d.insurer) : ''),
    row('Plan', d.plan ? esc(d.plan) : ''),
    row('Policy number', f.folio_number ? esc(f.folio_number) : ''),
    row('Premium', x.premium ? `${M(x.premium)} ${esc(x.frequency || 'yearly')}` : '<span class="muted">not set</span>', x.premium ? '' : 'set it with Edit policy, or import the premium rows'),
    row('Premiums', `${x.premiums_paid || 0} paid${isNum(x.premiums_total) ? ` of ${x.premiums_total}` : ''} · ${M(x.paid_total || 0)}`, [isNum(x.premiums_left) && x.premiums_left ? `${x.premiums_left} still to come · ${M(x.pending_total)}` : '', isNum(x.total_outlay) ? `${M(x.total_outlay)} over the whole term` : ''].filter(Boolean).join(' · ')),
    row('First premium', x.first_premium ? fmtDate(x.first_premium) : ''),
    row('Last premium', x.last_premium ? fmtDate(x.last_premium) : '', d.last_premium ? '' : 'the last due date before maturity; set it with Edit policy if premiums stop earlier'),
    row('Next due', open && x.next_due ? fmtDate(x.next_due) : '', open && x.overdue ? `${x.overdue} premium${x.overdue === 1 ? '' : 's'} fell due without being recorded · record them with Premium paid` : ''),
    row('Matures', x.maturity_date ? fmtDate(x.maturity_date) : '<span class="muted">not set</span>', x.maturity_date ? (x.matured ? (open ? 'matured · record the payout with Matured / paid out' : 'matured') : timeLeft(x.maturity_date) || `${x.days_left} days left`) : 'from the policy document; set it with Edit policy'),
    row('Maturity value', isNum(x.maturity_value) ? M(x.maturity_value) : '<span class="muted">not set</span>', isNum(x.maturity_gain) ? `${M(x.maturity_gain)} more than all the premiums` : 'sum assured plus the bonuses you expect, from the policy document or the insurer\'s estimate'),
    row('Sum assured', isNum(x.sum_assured) ? M(x.sum_assured) : '', 'the life cover; not part of the valuation'),
    row('Policy return', isNum(x.policy_rate) ? `${fmtPct(x.policy_rate * 100)} a year` : '', 'the rate at which every premium (paid and still due) grows to the maturity value; the policy is valued at it'),
    row('Value today', open && isNum(s.current_value) ? M(s.current_value) : '', open && isNum(x.accrued) ? `${M(x.accrued)} accrued on the premiums paid` : ''),
    row('Benefits received', s.dividends ? M(s.dividends) : '', 'survival benefits or bonuses paid out so far'),
    row('Paid out', !open && s.redeemed ? `${M(s.redeemed)}${f.closed_on ? ` on ${fmtDate(f.closed_on)}` : ''}` : '', isNum(s.realised_gain) ? `${M(s.realised_gain)} more than the premiums paid` : ''),
  ].join('');
  return `
    <section class="card">
      <div class="card-head"><h2>Policy details</h2><span class="muted small">from the policy document: premiums on a schedule, a maturity value known in advance</span></div>
      <div class="table-wrap"><table class="data"><tbody>${rows}</tbody></table></div>
    </section>`;
}

/** Fixed deposit: the terms from the bank's advice and what has happened so far. */
function fdCard(f, cur) {
  const x = f.fd || {};
  const d = f.details || {};
  const s = f.summary || {};
  const M = (v, dec = 0) => fmtMoney(v, cur, dec);
  const row = (label, value, sub = '') => (value ? `<tr><td class="nowrap"><b>${label}</b></td><td>${value}${sub ? `<div class="muted small">${sub}</div>` : ''}</td></tr>` : '');
  const open = s.units > 0 && !f.closed;
  const rows = [
    row('Bank', d.bank ? esc(d.bank) : ''),
    row('Account number', f.folio_number ? esc(f.folio_number) : ''),
    row('Deposited', x.deposit_date ? `${M(x.principal)} on ${fmtDate(x.deposit_date)}` : '<span class="muted">no deposit recorded yet</span>', 'the principal; a further deposit is another Deposit transaction'),
    row('Interest', d.payout === 'periodic' ? 'Paid out periodically' : 'Cumulative', d.payout === 'periodic' ? 'record each credit as Interest paid out; the maturity value is then usually the principal' : 'added to the deposit and paid with the principal at maturity'),
    row('Matures', x.maturity_date ? fmtDate(x.maturity_date) : '<span class="muted">not set</span>', x.maturity_date ? (x.matured ? (open ? 'matured · record the payout with Matured / paid out' : 'matured') : `${timeLeft(x.maturity_date) || `${x.days_left} days left`}${isNum(x.days_total) ? ` · ${x.days_total} days in all` : ''}`) : 'from the bank\'s FD advice; set it with Edit fixed deposit'),
    row('Maturity value', isNum(x.maturity_value) ? M(x.maturity_value) : '<span class="muted">not set</span>', isNum(x.interest_at_maturity) ? `${M(x.interest_at_maturity)} interest over the term` : 'the amount the bank will pay at maturity'),
    row('Rate', isNum(x.effective_rate) ? `${(x.effective_rate * 100).toFixed(2)}% a year` : isNum(x.quoted_rate) ? `${x.quoted_rate}% a year (quoted)` : '', isNum(x.effective_rate) ? `effective annual rate implied by the principal and the maturity value${isNum(x.quoted_rate) ? ` · ${x.quoted_rate}% quoted by the bank (quarterly compounding makes the effective rate a little higher)` : ''}` : ''),
    row('Value today', open && isNum(s.current_value) ? M(s.current_value) : '', open && isNum(x.accrued) ? `${M(x.accrued)} accrued so far, along the curve from the principal to the maturity value` : ''),
    row('Interest paid out', s.dividends ? M(s.dividends) : '', 'received so far, outside the deposit'),
    row('Paid out', !open && s.redeemed ? `${M(s.redeemed)}${f.closed_on ? ` on ${fmtDate(f.closed_on)}` : ''}` : '', isNum(s.realised_gain) ? `${M(s.realised_gain)} more than the principal` : ''),
  ].join('');
  return `
    <section class="card">
      <div class="card-head"><h2>Deposit details</h2><span class="muted small">from the bank's FD advice: the deposit grows from the principal to the maturity value at a constant rate</span></div>
      <div class="table-wrap"><table class="data"><tbody>${rows}</tbody></table></div>
    </section>`;
}

/** Fixed deposit: date, type, amount and comment; the rupees-as-units bookkeeping stays out of sight. */
function fdTxnTable(txns, k, cur) {
  const M = (v, d = 0) => fmtMoney(v, cur, d);
  const sum = (...types) => txns.filter((t) => types.includes(t.type)).reduce((s, t) => s + t.amount, 0);
  const body = txns
    .map((tx) => `
      <tr data-id="${tx.id}">
        <td>${fmtDate(tx.date)}</td>
        <td><span class="chip${CHIP_CLASS[tx.type] || ''}">${k.types[tx.type] || tx.type}</span></td>
        <td class="num">${M(tx.amount, 2)}</td>
        <td class="comment-cell">${commentCell(tx.notes)}</td>
        <td class="row-actions"><button type="button" class="link-btn" data-edit>Edit</button><button type="button" class="link-btn danger-text" data-del>Delete</button></td>
      </tr>`)
    .join('');
  const line = (v, label) => (v ? `${M(v, 2)}<div class="muted small">${label}</div>` : '');
  return `
    <div class="table-wrap">
      <table class="data txn-table">
        <thead><tr><th>Date</th><th>Type</th><th class="num">Amount (${esc(cur)})</th><th>Comment</th><th></th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td colspan="2">Total (${txns.length} transaction${txns.length === 1 ? '' : 's'})</td><td class="num">${line(sum('SIP', 'LUMPSUM'), 'deposited')}${line(sum('REDEMPTION'), 'paid out')}${line(sum('DIVIDEND'), 'interest paid out')}</td><td colspan="2"></td></tr></tfoot>
      </table>
    </div>`;
}

/** Sovereign Gold Bond: the bond's terms, the interest schedule and what has been received. */
function goldCard(f, cur) {
  const g = f.gold || {};
  const d = f.details || {};
  const M = (v, dec = 2) => fmtMoney(v, cur, dec);
  const row = (label, value, sub = '') => (value ? `<tr><td class="nowrap"><b>${label}</b></td><td>${value}${sub ? `<div class="muted small">${sub}</div>` : ''}</td></tr>` : '');
  const units = f.summary?.units || 0;
  const rows = [
    row('Series', d.series ? esc(d.series) : ''),
    row('Code', d.code ? `<a href="https://www.google.com/finance/quote/${encodeURIComponent(d.code)}:NSE" target="_blank" rel="noopener">${esc(d.code)}</a>` : '', 'opens the Google Finance quote, where the current price is'),
    row('Issue date', g.issue_date ? fmtDate(g.issue_date) : '', g.issue_date_assumed ? 'taken from the first purchase; set the real issue date with Edit gold bond if it differs' : d.issue_date_from === 'sgb' ? 'from the exchange list, accurate to the month; set the exact date from your allotment advice for precise interest dates' : ''),
    row('Issue price', isNum(d.issue_price) ? `${M(d.issue_price)} per gram` : '<span class="muted">not set</span>', 'interest is paid on this price, not on what you paid after any discount'),
    row('Interest', `${g.coupon ?? 2.5}% a year`, [isNum(g.interest_per_payment) ? `${M(g.interest_per_payment)} every six months on ${fmtNum(units, 3)} grams` : 'enter the issue price to see the amount of each payment', g.next_interest ? `next due ${fmtDate(g.next_interest)}` : ''].filter(Boolean).join(' · ')),
    row('Interest received', M(g.interest_received || 0), `${g.interest_payments || 0} payment${g.interest_payments === 1 ? '' : 's'} so far${isNum(g.payments_left) ? ` · ${g.payments_left} to go` : ''}`),
    row('Early redemption', g.exit_from ? `from ${fmtDate(g.exit_from)}` : '', 'RBI buys back from the fifth year, on an interest date, at the gold price; the bond can also be sold on the exchange at any time'),
    row('Maturity', g.maturity ? fmtDate(g.maturity) : '', g.matured ? 'matured · redeemed at the gold price' : `${timeLeft(g.maturity) || 'due'} · redeemed at the gold price, free of capital gains tax`),
    row('Price', g.price_source === 'sgb' ? `${M(g.price)} per gram · NSE last traded price` : g.price_source === 'manual' ? `${M(g.price)} per gram · entered by you` : '<span class="muted">none yet</span>',
      g.price_source === 'sgb' ? `from ${g.price_feed === 'nse' ? 'NSE (nseindia.com)' : 'sgb.vercel.app, as NSE was unreachable'} as of ${fmtDate(g.price_date)}${g.exchange_name && g.exchange_name !== d.code ? ` · listed as ${esc(g.exchange_name)}` : ''} · refreshed with Refresh prices` : g.price_source === 'manual' ? `as of ${fmtDate(g.price_date)} · set the NSE code to price it from the exchange instead` : 'set the NSE code, or enter a gold price'),
    row('IBJA gold price', isNum(g.ibja_price) ? `${M(g.ibja_price)} per gram` : '', [`RBI's redemption and early-exit rate${g.ibja_date ? ` · as of ${fmtDate(g.ibja_date)}` : ''}`, isNum(g.ibja_price) && isNum(g.price) ? `market price ${fmtPct((g.price / g.ibja_price - 1) * 100)} vs IBJA` : ''].filter(Boolean).join(' · ')),
  ].join('');
  return `
    <section class="card">
      <div class="card-head"><h2>Bond details</h2><span class="muted small">Sovereign Gold Bond terms: 2.5% interest a year on the issue price, eight-year tenor, early redemption from the fifth year</span></div>
      <div class="table-wrap"><table class="data"><tbody>${rows}</tbody></table></div>
    </section>`;
}

/** The gold price per gram (INR) that values every gold bond: enter today's, see and remove earlier entries. */
async function openGoldPriceModal() {
  let data;
  try {
    data = await api.get('/api/gold/price');
  } catch (e) {
    toast(`Could not load the gold price: ${e.message}`, 'error');
    return;
  }
  const today = todayISO();
  const list = (rows) => (rows.length
    ? `<table class="data"><thead><tr><th>Date</th><th class="num">Price per gram</th><th></th></tr></thead><tbody>${rows.slice().reverse().slice(0, 12).map((r) => `<tr><td>${fmtDate(r.date)}</td><td class="num">${fmtINR(r.price, 2)}</td><td class="row-actions"><button type="button" class="link-btn danger-text" data-del-date="${r.date}">Delete</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="empty small">No gold price entered yet.</p>');
  const modal = openModal('Gold price', `
  <form id="txn-form" class="form" novalidate>
    <p class="muted small">One price per gram, in rupees, shared by every gold bond. Take it from Google Finance (the bond's code), your broker, or the day's 24-carat gold rate; RBI redeems bonds at the IBJA 999 price.</p>
    <div class="form-row">
      <label class="field">Date
        <input type="date" name="date" required value="${today}" max="${today}">
      </label>
      <label class="field">Price per gram (₹)
        <input type="number" name="price" min="0.01" step="0.01" required placeholder="e.g. 8499" value="${isNum(data.price) ? data.price : ''}">
      </label>
    </div>
    <div class="form-error" id="txn-form-error" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">Save price</button>
    </div>
    <div id="gold-price-list">${list(data.history || [])}</div>
  </form>`);
  const form = modal.querySelector('#txn-form');
  form.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-date]');
    if (!b) return;
    try {
      await api.del(`/api/gold/price/${b.dataset.delDate}`);
      const fresh = await api.get('/api/gold/price');
      modal.querySelector('#gold-price-list').innerHTML = list(fresh.history || []);
      toast('Price removed');
      render();
    } catch (err) {
      toast(`Delete failed: ${err.message}`, 'error');
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = modal.querySelector('#txn-form-error');
    err.hidden = true;
    const body = { date: form.elements.date.value, price: parseFloat(form.elements.price.value) };
    if (!body.date || !(body.price > 0)) { err.textContent = 'Enter the date and the price per gram.'; err.hidden = false; return; }
    try {
      await api.post('/api/gold/price', body);
      closeModal();
      toast(`Gold price ${fmtINR(body.price, 2)} per gram recorded for ${fmtDate(body.date)}`);
      render();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  });
  form.elements.price.focus();
}

/** PPF: one row per financial year, the balance worked out from deposits and the interest entered. */
function ppfYearTable(f, cur) {
  const years = f.ppf?.years || [];
  if (!years.length) return '';
  const M = (v) => fmtMoney(v, cur);
  const pending = f.ppf?.pending_interest_fy;
  const rows = years
    .map(
      (y) => `
      <tr>
        <td class="nowrap"><b>${esc(y.fy)}</b></td>
        <td class="num">${M(y.deposit)}</td>
        <td class="num">${isNum(y.rate) ? `${y.rate}%` : '–'}</td>
        <td class="num">${y.interest ? M(y.interest) : pending === y.fy ? '<span class="muted">pending</span>' : '–'}</td>
        <td class="num">${y.withdrawn ? M(y.withdrawn) : '–'}</td>
        <td class="num"><b>${M(y.closing)}</b></td>
      </tr>`,
    )
    .join('');
  return `
    <section class="card">
      <div class="card-head"><h2>By financial year</h2><span class="muted small">the balance is worked out from the deposits and the interest you enter; interest is credited on 31 March</span></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>FY</th><th class="num">Deposits</th><th class="num">IR%</th><th class="num">Interest</th><th class="num">Withdrawn</th><th class="num">Closing balance</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

function epfYearTable(f, cur) {
  const years = f.epf?.years || [];
  if (!years.length) return '';
  const M = (v) => fmtMoney(v, cur);
  const pending = f.epf?.pending_interest_fy;
  const rows = years
    .map(
      (y) => `
      <tr>
        <td class="nowrap"><b>${esc(y.fy)}</b></td>
        <td class="num">${M(y.deposit_ee)}</td>
        <td class="num">${M(y.deposit_er)}</td>
        <td class="num">${M(y.pension)}</td>
        <td class="num">${isNum(y.rate) ? `${y.rate}%` : '–'}</td>
        <td class="num">${y.interest_ee || y.interest_er ? `${M(y.interest_ee)} / ${M(y.interest_er)}` : pending === y.fy ? '<span class="muted">pending</span>' : '–'}</td>
        <td class="num">${y.withdrawn_ee || y.withdrawn_er ? M(y.withdrawn_ee + y.withdrawn_er) : '–'}</td>
        <td class="num">${M(y.closing_ee)}</td>
        <td class="num">${M(y.closing_er)}</td>
        <td class="num"><b>${M(y.closing_ee + y.closing_er)}</b></td>
      </tr>`,
    )
    .join('');
  return `
    <section class="card">
      <div class="card-head"><h2>By financial year</h2><span class="muted small">balances are worked out from the deposits and the interest you enter; interest is credited at the end of each year</span></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>FY</th><th class="num">Employee deposits</th><th class="num">Employer deposits</th><th class="num">Pension (EPS)</th><th class="num">IR%</th><th class="num">Interest (employee / employer)</th><th class="num">Withdrawn</th><th class="num">Closing employee</th><th class="num">Closing employer</th><th class="num">Closing balance</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

/** NPS: one row per scheme, each valued at its own NAV, with the whole account in the footer. */
function schemeTable(f, activeKey, cur) {
  if (!f.schemes || !f.schemes.length) return '';
  const M = (v) => fmtMoney(v, cur);
  const rows = f.schemes
    .map((p) => {
      const s = p.summary;
      return `
      <tr class="row-link${activeKey === p.scheme ? ' active-row' : ''}" data-scheme="${esc(p.scheme)}" tabindex="0">
        <td><div class="fund-name"><span class="chip">${esc(p.scheme)}</span> ${esc(SCHEME_NAMES[p.scheme] || `Scheme ${p.scheme}`)}</div><div class="muted small">${esc(p.name)}${p.id ? ` · ${esc(p.id)}` : ''}</div></td>
        <td class="num">${s.txn_count}</td>
        <td class="num">${M(s.invested)}</td>
        <td class="num">${fmtNum(s.units, 4)}</td>
        <td class="num">${isNum(s.latest_nav) ? fmtNum(s.latest_nav, 4) : '–'}</td>
        <td class="num">${M(s.current_value)}</td>
        <td class="num">${deltaValue(s.invested ? s.profit : null, cur)}<div class="muted small">${fmtPct(s.abs_return_pct)}${s.charges ? ` · ${M(s.charges)} charges` : ''}</div></td>
        <td class="num">${fmtPct(pct(s.xirr))}</td>
      </tr>`;
    })
    .join('');
  const t = f.schemes_total;
  return `
    <section class="card">
      <div class="card-head"><h2>By scheme</h2><span class="muted small">click a scheme to filter the page · a scheme's XIRR counts money switched in or out of it; the account XIRR only your own contributions and withdrawals</span></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Scheme</th><th class="num">Transactions</th><th class="num">Invested</th><th class="num">Units</th><th class="num">NAV</th><th class="num">Current value</th><th class="num">P&amp;L</th><th class="num">XIRR</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td>Whole account</td><td class="num">${t.txn_count}</td><td class="num">${M(t.invested)}</td><td class="num">–</td><td class="num">–</td><td class="num">${M(t.current_value)}</td><td class="num">${deltaValue(t.invested ? t.profit : null, cur)}${t.charges ? `<div class="muted small">${M(t.charges)} charges</div>` : ''}</td><td class="num">${fmtPct(pct(t.xirr))}</td></tr></tfoot>
        </table>
      </div>
    </section>`;
}

function folioFilter(f, activeKey, k) {
  if (!f.folios || f.folios.length < 2) return '';
  const btn = (key, label) =>
    `<button type="button" class="range-btn${(activeKey || '') === key ? ' active' : ''}" data-folio="${esc(key)}">${label}</button>`;
  return `<div class="filter-bar"><span class="muted small">${k.folio}</span>
    <div class="range-filter folio-filter" role="group" aria-label="${k.folio}">${btn('', `All ${k.folioPlural}`)}${f.folios.map((x) => btn(x.folio, esc(x.label))).join('')}</div></div>`;
}

function folioTable(f, activeKey, k, cur) {
  if (!f.folios || f.folios.length < 2) return '';
  const M = (v) => fmtMoney(v, cur);
  const rows = f.folios
    .map((x) => {
      const s = x.summary;
      return `
      <tr class="row-link${activeKey === x.folio ? ' active-row' : ''}" data-folio="${esc(x.folio)}" tabindex="0">
        <td><div class="fund-name">${esc(x.label)}</div></td>
        <td class="num">${s.txn_count}</td>
        <td class="num">${M(s.invested)}</td>
        <td class="num">${fmtNum(s.units, 3)}</td>
        <td class="num">${M(s.current_value)}</td>
        <td class="num">${deltaValue(s.invested ? s.profit : null, cur)}<div class="muted small">${fmtPct(s.abs_return_pct)}</div></td>
        <td class="num">${fmtPct(pct(s.xirr))}</td>
      </tr>`;
    })
    .join('');
  const t = f.folios_total;
  const unitHead = k.unit[0].toUpperCase() + k.unit.slice(1);
  return `
    <section class="card">
      <div class="card-head"><h2>By ${k.folio.toLowerCase()}</h2><span class="muted small">click a${k.key === 'STOCK' ? 'n' : ''} ${k.folio.toLowerCase()} to filter the page</span></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>${k.folio}</th><th class="num">Transactions</th><th class="num">Invested</th><th class="num">${unitHead}</th><th class="num">Current value</th><th class="num">P&amp;L</th><th class="num">XIRR</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td>All ${k.folioPlural}</td><td class="num">${t.txn_count}</td><td class="num">${M(t.invested)}</td><td class="num">${fmtNum(t.units, 3)}</td><td class="num">${M(t.current_value)}</td><td class="num">${deltaValue(t.invested ? t.profit : null, cur)}</td><td class="num">${fmtPct(pct(t.xirr))}</td></tr></tfoot>
        </table>
      </div>
    </section>`;
}

async function renderFund(id, folioKey, schemeKey) {
  app.innerHTML = loading();
  const params = new URLSearchParams();
  if (folioKey) params.set('folio', folioKey);
  if (schemeKey) params.set('scheme', schemeKey);
  const f = await api.get(`/api/funds/${id}${params.toString() ? `?${params}` : ''}`);
  BASE = f.base_currency || BASE;
  const k = kindOf(f);
  const stock = k.key === 'STOCK';
  const nps = k.key === 'NPS';
  const epf = k.key === 'EPF';
  const ppf = k.key === 'PPF';
  const gold = k.key === 'GOLD';
  const fdk = k.key === 'FD'; // fixed deposit: rupees valued along the curve from the principal to the maturity value
  const ins = k.key === 'INS'; // insurance policy: premiums valued at the policy's own rate towards the maturity value
  const rupee = epf || ppf; // EPF and PPF: a rupee is a unit, interest is entered rather than priced
  const plain = rupee || fdk || ins; // no price tiles: these kinds have their own
  const cur = f.currency || BASE;
  const foreign = Boolean(f.needs_fx);
  const b = foreign ? f.base : null; // converted figures, when an exchange rate is available
  const bs = b?.summary;
  const M = (v, d = 0) => fmtMoney(v, cur, d);
  const folios = f.folios || [];
  const schemes = f.schemes || [];
  const active = folioKey ? folios.find((x) => x.folio === folioKey) : null;
  if (folioKey && !active) { location.hash = fundHash(id); return; } // stale filter (folio no longer exists)
  const activeScheme = (nps || epf) && schemeKey ? schemes.find((p) => p.scheme === schemeKey) : null;
  if (schemeKey && !activeScheme) { location.hash = fundHash(id, folioKey); return; }
  const scope = `${active ? ` · ${k.folio} ${esc(active.label)}` : ''}${activeScheme ? ` · ${epf ? esc(activeScheme.name) : `Scheme ${esc(activeScheme.scheme)}`}` : ''}`;
  const s = f.summary;
  const d = f.details || {};
  const folioText = folios.length > 1
    ? `${folios.length} ${k.folioPlural} <b>${folios.map((x) => esc(x.label)).join(', ')}</b>`
    : folios.length === 1
      ? `${k.folio} <b>${esc(folios[0].label)}</b>`
      : f.folio_number ? `${k.folio} <b>${esc(f.folio_number)}</b>` : '';
  const meta = (ins
    ? [
        f.folio_number ? `Policy number <b>${esc(f.folio_number)}</b>` : folioText,
        d.insurer ? esc(d.insurer) : '',
        d.plan ? esc(d.plan) : '',
        f.policy?.premium ? `${M(f.policy.premium)} ${esc(f.policy.frequency || 'yearly')}` : '',
        fdMaturityText(f.policy),
      ]
    : fdk
    ? [
        f.folio_number ? `Account number <b>${esc(f.folio_number)}</b>` : folioText,
        d.bank ? esc(d.bank) : '',
        f.fd?.deposit_date ? `deposited ${fmtDate(f.fd.deposit_date)}` : '',
        fdMaturityText(f.fd),
      ]
    : gold
    ? [
        folioText,
        d.code ? `Code <b>${esc(d.code)}</b> · <a href="https://www.google.com/finance/quote/${encodeURIComponent(d.code)}:NSE" target="_blank" rel="noopener">Google Finance</a>` : '',
        d.series ? esc(d.series) : '',
        f.gold?.issue_date ? `issued ${fmtDate(f.gold.issue_date)}` : '',
        goldMaturityText(f.gold),
      ]
    : ppf
    ? [
        f.folio_number ? `Account number <b>${esc(f.folio_number)}</b>` : folioText,
        d.bank ? esc(d.bank) : '',
        f.ppf?.opened_on ? `opened ${fmtDate(f.ppf.opened_on)}` : '',
        ppfMaturityText(f.ppf),
      ]
    : epf
    ? [
        f.folio_number ? `UAN <b>${esc(f.folio_number)}</b>` : folioText,
        d.employer ? esc(d.employer) : '',
        isNum(f.summary?.balance_employee) && !d.transferred_to ? `employee ${M(f.summary.balance_employee)} · employer ${M(f.summary.balance_employer)}` : '',
        d.transferred_from ? `continued from <a href="#/fund/${Number(d.transferred_from)}">${esc(d.transferred_from_name || 'the previous account')}</a>${d.transferred_on ? ` on ${fmtDate(d.transferred_on)}` : ''}` : '',
        d.transferred_to ? `balance moved to <a href="#/fund/${Number(d.transferred_to)}">${esc(d.transferred_to_name || 'the new account')}</a>${d.transferred_on ? ` on ${fmtDate(d.transferred_on)}` : ''}` : '',
      ]
    : nps
    ? [
        f.folio_number ? `PRAN <b>${esc(f.folio_number)}</b>` : folioText,
        d.pfm ? esc(d.pfm) : '',
        d.tier ? `Tier ${esc(d.tier)}` : '',
        d.variant ? esc(d.variant) : '',
        schemes.length ? `Schemes <b>${schemes.map((p) => esc(p.scheme)).join(' · ')}</b>` : '',
      ]
    : stock
      ? [
          `Symbol <b>${esc(f.symbol)}</b>`,
          f.exchange ? esc(f.exchange) : '',
          `prices in <b>${esc(cur)}</b>`,
          f.quote?.name && f.quote.name !== f.name ? esc(f.quote.name) : '',
          folioText,
        ]
      : [
          folioText,
          `Scheme code <b>${f.scheme_code}</b>`,
          f.scheme?.fund_house ? esc(f.scheme.fund_house) : '',
          f.scheme?.scheme_category ? esc(f.scheme.scheme_category) : '',
        ]).filter(Boolean).join(' · ');
  // Forms default to the folio / scheme being viewed; duplicate checks always see every transaction.
  const fundForForms = {
    ...f,
    folio_number: active ? (active.folio === NO_FOLIO ? '' : active.folio) : f.folio_number,
    scheme: activeScheme?.scheme || '',
    transactions: f.all_transactions || f.transactions,
  };
  const inBase = (v) => (b ? `≈ ${fmtINR(v)}` : '');

  app.innerHTML = `
    ${navErrorBanner(f.nav_errors)}
    ${foreign && !b ? `<div class="banner warn">No ${esc(cur)} → ${esc(BASE)} exchange rate has been downloaded yet, so ${esc(BASE)} equivalents are not shown and this holding is left out of the portfolio totals. Click <b>Refresh prices</b> when you are online.</div>` : ''}
    ${s.oversold_units > 0 ? `<div class="banner warn">${rupee ? 'Withdrawals exceed the balance' : `Sales exceed the ${k.unit} bought`} by ${rupee ? M(s.oversold_units, 2) : fmtNum(s.oversold_units, 4)}. Check the transactions${active ? ` in this ${k.folio.toLowerCase()}` : ''}: a ${rupee ? 'withdrawal' : 'sale'} may be recorded before its ${rupee ? 'deposit' : 'purchase'}, or against the wrong ${k.lower}.</div>` : ''}
    ${epf && f.epf?.pending_interest_fy ? `<div class="banner warn">Interest for FY ${esc(f.epf.pending_interest_fy)} has not been entered yet, so the balance shows deposits only for that year. Add it with <b>Year interest</b> once EPFO credits it.</div>` : ''}
    ${epf && d.transferred_to ? `<div class="banner">You changed jobs${d.transferred_on ? ` on ${fmtDate(d.transferred_on)}` : ''}: the employee and employer shares, with their whole history, now live in <a href="#/fund/${Number(d.transferred_to)}">${esc(d.transferred_to_name || 'the new account')}</a>. Only the pension (EPS) record stays here.</div>` : ''}
    ${ppf && f.ppf?.pending_interest_fy ? `<div class="banner warn">Interest for FY ${esc(f.ppf.pending_interest_fy)} has not been entered yet, so the balance shows deposits only for that year. Add it with <b>Year interest</b> once it is credited on 31 March.</div>` : ''}
    ${gold && !isNum(s.latest_nav) ? `<div class="banner warn">This bond has no price yet, so it has no current value. ${d.code ? `Its code <b>${esc(d.code)}</b> could not be priced from the exchange list yet (offline, or the code is not listed): click <b>Refresh prices</b> when online, check the code under Edit gold bond, or ` : 'Set its NSE code under <b>Edit gold bond</b> to price it automatically, or '}click <b>Gold price</b> and enter today's price per gram.</div>` : ''}
    ${gold && f.gold?.price_source === 'manual' && s.latest_nav_date && (Date.now() - new Date(`${s.latest_nav_date}T00:00:00`)) / 864e5 > 30 ? `<div class="banner">The gold price you entered is from ${fmtDate(s.latest_nav_date)}. Update it with <b>Gold price</b>, or set the bond's NSE code so it is priced from the exchange.</div>` : ''}
    ${ppf && f.ppf?.extended_till ? `<div class="banner">This account matured on ${fmtDate(f.ppf.matures_on)}. It is shown as extended in five-year blocks, currently till ${fmtDate(f.ppf.extended_till)}; deposits and interest carry on as before.</div>` : ''}
    ${fdk && f.fd?.awaiting_payout ? `<div class="banner warn">This deposit matured on ${fmtDate(f.fd.maturity_date)}. Once the bank pays it out, record the payout with <b>Matured / paid out</b> (a renewal is a new deposit); until then it is shown at its maturity value.</div>` : ''}
    ${fdk && !f.closed && s.units > 0 && !f.fd?.has_terms ? `<div class="banner">The maturity date and value are not set, so the deposit is shown at its principal with no growth. Enter them from the bank's FD advice with <b>Edit fixed deposit</b>, or import the sheet's <i>Final Value at maturity</i> line.</div>` : ''}
    ${ins && !f.closed && f.policy?.overdue ? `<div class="banner warn">${f.policy.overdue === 1 ? `A premium of ${M(f.policy.premium)} fell due on ${fmtDate(f.policy.next_due)}` : `${f.policy.overdue} premiums (${M(f.policy.premium)} ${esc(f.policy.frequency)}, the first due ${fmtDate(f.policy.next_due)}) fell due`} and ${f.policy.overdue === 1 ? 'has' : 'have'} not been recorded. Record ${f.policy.overdue === 1 ? 'it' : 'them'} with <b>Premium paid</b>, or import the receipts; until then the policy's schedule still counts ${f.policy.overdue === 1 ? 'it' : 'them'} as still to come.</div>` : ''}
    ${ins && f.policy?.awaiting_payout ? `<div class="banner warn">This policy matured on ${fmtDate(f.policy.maturity_date)}. Once the insurer pays it out, record the payout with <b>Matured / paid out</b>; until then it is shown at its maturity value.</div>` : ''}
    ${ins && !f.closed && s.units > 0 && !f.policy?.has_terms ? `<div class="banner">The maturity date and value are not set, so the policy is shown at the premiums paid with no growth and no schedule. Enter them from the policy document with <b>Edit policy</b>, or import the sheet's <i>Value at maturity</i> line.</div>` : ''}
    <a class="back-link" href="#/">← Portfolio</a>
    <div class="page-head">
      <div>
        <h1>${esc(f.name)} ${statusBadge(f)}</h1>
        <div class="meta muted small">${kindChip(f)}${meta}</div>
        ${f.notes ? `<div class="notes">${esc(f.notes)}</div>` : ''}
      </div>
      <div class="head-actions">
        ${!plain && !f.closed && s.units > 0 ? `<button type="button" class="btn ghost small" id="btn-exit" title="Sell everything you hold${active ? ` in this ${k.folio.toLowerCase()}` : ''}${activeScheme ? ` in scheme ${esc(activeScheme.scheme)}` : ''} and close the position">Exit${activeScheme ? ` scheme ${esc(activeScheme.scheme)}` : ''}</button>` : ''}
        ${epf && !d.transferred_to && f.transactions.length ? '<button type="button" class="btn ghost small" id="btn-epf-transfer" title="Changed jobs? Move the balance and its history to a new account under the same UAN">Moved jobs</button>' : ''}
        ${gold ? '<button type="button" class="btn ghost small" id="btn-gold-price" title="Enter today\'s gold price per gram; it values every gold bond">Gold price</button>' : ''}
        ${ins && !f.closed && (f.policy?.premium || f.policy?.next_due) ? '<button type="button" class="btn ghost small" id="btn-ins-premium" title="Record the premium that fell due (date and amount pre-filled from the schedule)">Premium paid</button>' : ''}
        ${(fdk || ins) && !f.closed && s.units > 0 ? `<button type="button" class="btn ghost small" id="btn-fd-payout" title="Record the maturity payout or ${ins ? 'a surrender' : 'a premature closure'}; the ${k.lower} then moves to Closed">Matured / paid out</button>` : ''}
        <button type="button" class="btn ghost small" id="btn-edit-fund">Edit ${k.lower}</button>
        <button type="button" class="btn ghost small danger-text" id="btn-delete-fund">Delete</button>
      </div>
    </div>
    ${nps ? schemeFilter(f, schemeKey) : epf ? schemeFilter(f, schemeKey, (p) => esc(p.name), 'Share') : folioFilter(f, folioKey, k)}
    <section class="summary-grid">
      ${hero({
        label: `${rupee ? 'Current balance' : 'Current value'}${scope}`, value: s.current_value, profit: s.invested ? s.profit : null, absPct: s.abs_return_pct,
        realised: rupee ? 0 : s.realised_gain, dividends: s.dividends, currency: cur, realisedWhat: k.realisedWhat || 'from sales', dividendWord: k.dividendWord || 'dividends',
        approx: b ? `≈ ${fmtINR(bs.current_value)} · 1 ${esc(cur)} = ${fmtINR(b.rate, 2)} on ${fmtDate(b.rate_date)}` : '',
      })}
      <div class="tiles">${epf ? epfTiles(s, activeScheme, M, f) : ppf ? ppfTiles(s, M, f) : fdk ? fdTiles(s, M, f) : ins ? insTiles(s, M, f) : ''}
        ${plain ? '' : tile(s.redeemed ? 'Investment in holdings' : 'Total investment', M(s.invested), [s.redeemed ? `${M(s.purchased)} ${nps ? 'contributed' : 'bought'} · ${M(s.redeemed)} ${k.sold}` : '', s.charges ? `${M(s.charges)} deducted as charges` : '', netOfDividends(s, M, k.dividendWord), s.bonus_units ? `${fmtNum(s.bonus_units, 4)} bonus ${k.unit} at no cost` : '', inBase(bs?.invested)].filter(Boolean).join(' · '))}
        ${plain ? '' : tile(s.redeemed || s.dividends ? 'Unrealised profit' : 'Total profit', deltaValue(s.invested ? s.profit : null, cur), [isNum(s.abs_return_pct) ? `${fmtPct(s.abs_return_pct)} absolute` : '', realisedText(s, M, k.realisedWhat || 'from sales', k.dividendWord), b && s.invested ? `${inBase(bs.profit)} in ${esc(BASE)}` : ''].filter(Boolean).join(' · '))}
        ${plain ? '' : tile('XIRR', fmtPct(pct(s.xirr)), b ? `annualised in ${esc(cur)} · ${fmtPct(pct(bs.xirr))} in ${esc(BASE)}` : nps ? (activeScheme ? `annualised, scheme ${esc(activeScheme.scheme)} on its own` : 'annualised, whole account, on your own contributions') : 'annualised')}
        ${plain ? '' : nps && !activeScheme
          ? tile('Latest NAVs', schemes.map((p) => `<span class="scheme-nav"><span class="chip">${esc(p.scheme)}</span>${isNum(p.summary.latest_nav) ? fmtNum(p.summary.latest_nav, 2) : '–'}</span>`).join(''), s.latest_nav_date ? `as of ${fmtDate(s.latest_nav_date)} · ${schemes.length} scheme${schemes.length === 1 ? '' : 's'}` : 'NAVs not fetched yet')
          : tile(`Latest ${k.price}`, isNum(s.latest_nav) ? M(s.latest_nav, k.priceDecimals) : '–', s.latest_nav_date ? `as of ${fmtDate(s.latest_nav_date)}${gold ? (f.gold?.price_source === 'sgb' ? ' · NSE traded price' : ' · entered by you') : ''} · ${fmtNum(s.units, 3)} ${k.unit} held` : gold ? 'no price yet' : `${k.price} not fetched yet`)}
      </div>
    </section>
    ${nps ? schemeTable(f, schemeKey, cur) : epf ? epfYearTable(f, cur) : ppf ? ppfYearTable(f, cur) : folioTable(f, folioKey, k, cur)}
    ${gold ? goldCard(f, cur) : fdk ? fdCard(f, cur) : ins ? insCard(f, cur) : ''}
    ${(epf && f.epf?.years?.length) || (ppf && f.ppf?.years?.length) ? `<section class="card chart-card">
      <div class="card-head"><h2>Deposits and interest by year${scope}</h2><span class="muted small">one column per financial year: ${epf ? 'employee deposits, employer deposits' : 'deposits'} and the interest credited for that year</span></div>
      <div class="chart-wrap short"><canvas id="year-chart" role="img" aria-label="${epf ? 'Employee deposits, employer deposits' : 'Deposits'} and interest credited per financial year for ${esc(f.name)}${activeScheme ? `, ${esc(activeScheme.name)}` : ''}"></canvas></div>
    </section>` : ''}
    <section class="card chart-card">
      <div class="card-head"><h2>${rupee ? 'Balance over time' : 'Value over time'}${scope}${foreign ? ` <span class="muted small">in ${esc(cur)}</span>` : ''}</h2>${rangeButtons()}</div>
      <div class="chart-wrap"><canvas id="value-chart" role="img" aria-label="Current value and invested amount of ${esc(f.name)}${active ? ` ${k.folio.toLowerCase()} ${esc(active.label)}` : ''} over time"></canvas></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Transactions${scope}</h2>
        <div class="head-actions">
          <button type="button" class="btn ghost small" id="btn-import-txn">${rupee ? 'Import a year' : 'Import'}</button>
          ${epf ? '<button type="button" class="btn ghost small" id="btn-epf-interest">Year interest</button><button type="button" class="btn ghost small" id="btn-epf-month">+ Add month</button>' : ppf ? '<button type="button" class="btn ghost small" id="btn-epf-interest">Year interest</button>' : ''}
          <button type="button" class="btn primary small" id="btn-add-txn">${rupee ? '+ Add entry' : '+ Add transaction'}</button>
        </div>
      </div>
      ${f.transactions.length
        ? (fdk || ins ? fdTxnTable(f.transactions, k, cur) : txnTable(f.transactions, k, cur, { showScheme: nps, epf: rupee }))
        : active || activeScheme
          ? `<p class="empty">No ${rupee ? 'entries' : 'transactions'} in this ${activeScheme ? (epf ? 'share' : 'scheme') : k.folio.toLowerCase()}.</p>`
          : `<p class="empty">No ${rupee ? 'entries' : 'transactions'} yet. ${epf ? 'Paste a financial year from your sheet with Import a year, or add months one at a time; enter each year\'s interest when EPFO credits it' : ppf ? 'Paste a financial year from your sheet with Import a year, or add deposits one at a time; enter each year\'s interest when it is credited' : fdk ? 'Record the deposit with + Add transaction, or paste the bank sheet (the deposit row and the Final Value at maturity line) with Import' : ins ? 'Record the premiums paid with Premium paid, or paste the premium sheet (paid and future premiums, and the Value at maturity line) with Import' : nps ? 'Add contributions one at a time, or paste your eNPS transaction statement with Import (one row per contribution, with units and NAV per scheme)' : stock ? 'Add purchases and sales one at a time, or use Import to paste a whole table' : 'Add SIP installments, lumpsum purchases or redemptions one at a time, or use Import to paste a whole table'}.</p>`}
    </section>`;

  mountChart(f.history, cur);
  if (rupee) mountYearChart(f, activeScheme?.scheme, cur);
  wireRange(app);

  app.querySelectorAll('[data-folio]').forEach((el) => {
    const go = () => { location.hash = fundHash(f.id, el.dataset.folio, schemeKey); };
    el.addEventListener('click', go);
    if (el.tagName === 'TR') el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  app.querySelectorAll('[data-scheme]').forEach((el) => {
    const go = () => { location.hash = fundHash(f.id, folioKey, el.dataset.scheme); };
    el.addEventListener('click', go);
    if (el.tagName === 'TR') el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });

  document.getElementById('btn-add-txn').addEventListener('click', () => openTxnModal(fundForForms, null));
  document.getElementById('btn-epf-month')?.addEventListener('click', () => { const n = new Date(); openEpfGroupModal(fundForForms, { type: 'SIP', date: `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-15` }); });
  document.getElementById('btn-epf-interest')?.addEventListener('click', () => openEpfInterestModal(fundForForms));
  document.getElementById('btn-epf-transfer')?.addEventListener('click', () => openEpfTransferModal(f));
  document.getElementById('btn-gold-price')?.addEventListener('click', () => openGoldPriceModal());
  document.getElementById('btn-fd-payout')?.addEventListener('click', () => {
    const x = f.fd || f.policy || {};
    openFdTxnModal(fundForForms, null, {
      type: 'REDEMPTION', payout: true,
      date: x.matured && x.maturity_date <= todayISO() ? x.maturity_date : todayISO(),
      amount: x.matured && isNum(x.maturity_value) ? x.maturity_value : s.current_value,
    });
  });
  document.getElementById('btn-ins-premium')?.addEventListener('click', () => openFdTxnModal(fundForForms, null, {
    type: 'SIP', premium: true,
    date: f.policy?.next_due && f.policy.next_due <= todayISO() ? f.policy.next_due : todayISO(),
    amount: f.policy?.premium || null,
  }));
  document.getElementById('btn-exit')?.addEventListener('click', () => openTxnModal(fundForForms, null, { exitUnits: s.units, folios: folios.length, scoped: Boolean(active), scheme: activeScheme?.scheme || '' }));
  document.getElementById('btn-import-txn').addEventListener('click', () => openImportModal(fundForForms, render));
  document.getElementById('btn-edit-fund').addEventListener('click', () => openFundModal(f));
  document.getElementById('btn-delete-fund').addEventListener('click', async () => {
    const ok = await confirmDialog(`Delete ${k.lower}?`, `This removes <b>${esc(f.name)}</b> and all ${f.transactions.length} of its transactions. This cannot be undone.`);
    if (!ok) return;
    try {
      await api.del(`/api/funds/${f.id}`);
      toast(`${k.label} deleted`);
      location.hash = '#/';
    } catch (e) {
      toast(`Delete failed: ${e.message}`, 'error');
    }
  });

  app.querySelector('.txn-table tbody')?.addEventListener('click', async (e) => {
    const grp = e.target.closest('tr[data-ids]');
    if (grp) {
      const entries = grp.dataset.ids.split(',').map(Number).map((id) => f.transactions.find((t) => t.id === id)).filter(Boolean);
      if (!entries.length) return;
      if (e.target.closest('.comment-text, .comment-add')) { startCommentEdit(e.target.closest('td'), entries[0], entries.slice(1)); return; }
      if (e.target.closest('[data-edit]')) openEpfGroupModal(fundForForms, { entries });
      if (e.target.closest('[data-del]')) {
        const ok = await confirmDialog('Delete this row?', `${k.types[entries[0].type] || entries[0].type} of ${fmtDate(entries[0].date)} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}) will be removed.`);
        if (!ok) return;
        try {
          await Promise.all(entries.map((t) => api.del(`/api/transactions/${t.id}`)));
          toast('Row deleted');
          render();
        } catch (err) {
          toast(`Delete failed: ${err.message}`, 'error');
        }
      }
      return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const tx = f.transactions.find((t) => t.id === Number(tr.dataset.id));
    if (!tx) return;
    if (e.target.closest('.comment-text, .comment-add')) { startCommentEdit(e.target.closest('td'), tx); return; }
    if (e.target.closest('[data-edit]')) openTxnModal(f, tx);
    if (e.target.closest('[data-del]')) {
      const what = tx.type === 'BONUS' ? (rupee ? `${k.types.BONUS} of ${M(tx.units, 2)}` : `${k.types.BONUS}: ${fmtNum(tx.units, 4)} ${k.unit}`) : `${k.types[tx.type] || tx.type} of ${M(tx.amount, 2)}`;
      const ok = await confirmDialog('Delete transaction?', `${what} on ${fmtDate(tx.date)} will be removed.`);
      if (!ok) return;
      try {
        await api.del(`/api/transactions/${tx.id}`);
        toast('Transaction deleted');
        render();
      } catch (err) {
        toast(`Delete failed: ${err.message}`, 'error');
      }
    }
  });
}

// ---------------------------------------------------------------- fund add / edit modal
function fundFormHtml(f) {
  const editing = Boolean(f.id);
  const k = kindOf(f);
  const stock = k.key === 'STOCK';
  const nps = k.key === 'NPS';
  const epf = k.key === 'EPF';
  const ppf = k.key === 'PPF';
  const gold = k.key === 'GOLD';
  const fdKind = k.key === 'FD';
  const insKind = k.key === 'INS';
  const d = f.details || {};
  const txnCount = f.summary?.txn_count ?? 0;
  const schemeName = f.scheme?.scheme_name || (f.scheme_code ? `Scheme code ${f.scheme_code}` : '');
  const schemeMeta = [f.scheme?.fund_house, f.scheme?.scheme_category].filter(Boolean).join(' · ');
  const quoteName = f.quote?.name || '';
  const quoteMeta = [f.symbol, f.exchange, f.currency ? `prices in ${f.currency}` : ''].filter(Boolean).join(' · ');
  return `
  <form id="fund-form" class="form" novalidate>
    ${editing ? '' : `
    <div class="field">What are you adding?
      <div class="kind-toggle" role="radiogroup" aria-label="Kind of holding">
        <label><input type="radio" name="kind" value="MF" checked> Mutual fund</label>
        <label><input type="radio" name="kind" value="STOCK"> Stock / ETF</label>
        <label><input type="radio" name="kind" value="NPS"> NPS</label>
        <label><input type="radio" name="kind" value="EPF"> EPF</label>
        <label><input type="radio" name="kind" value="PPF"> PPF</label>
        <label><input type="radio" name="kind" value="GOLD"> Gold (SGB)</label>
        <label><input type="radio" name="kind" value="FD"> Fixed deposit</label>
        <label><input type="radio" name="kind" value="INS"> Insurance policy (LIC)</label>
      </div>
    </div>`}
    <div id="mf-fields" ${k.key !== 'MF' ? 'hidden' : ''}>
      ${editing ? `
      <div class="field">Linked AMFI scheme
        <div class="scheme-box">
          <div class="scheme-info">
            <div class="scheme-name" id="scheme-name">${esc(schemeName)}</div>
            <div class="muted small" id="scheme-meta">${esc(schemeMeta)}${f.scheme_code ? `${schemeMeta ? ' · ' : ''}code ${f.scheme_code}` : ''}</div>
          </div>
          <button type="button" class="btn ghost small" id="btn-change-scheme">Change scheme</button>
        </div>
        <div class="banner warn small" id="scheme-change-note" hidden></div>
      </div>` : ''}
      <div id="scheme-search" ${editing ? 'hidden' : ''}>
        <label class="field">${editing ? 'Search for the correct scheme' : 'Search scheme'}
          <input name="q" placeholder="Type a fund name, e.g. Parag Parikh Flexi Cap Direct Growth" autocomplete="off">
          <span class="hint">Searches the AMFI scheme list. Pick the exact plan: Direct / Regular, Growth / IDCW. Some fund houses label Growth as "Cumulative".</span>
        </label>
        <div id="scheme-results" class="search-results" hidden></div>
      </div>
      <label class="field">Scheme code (AMFI)
        <input name="scheme_code" inputmode="numeric" pattern="[0-9]+" value="${f.scheme_code ?? ''}" placeholder="e.g. 122639">
      </label>
    </div>
    <div id="stock-fields" ${stock ? '' : 'hidden'}>
      ${editing ? `
      <div class="field">Linked stock
        <div class="scheme-box">
          <div class="scheme-info">
            <div class="scheme-name" id="stock-name">${esc(quoteName || f.symbol || '')}</div>
            <div class="muted small" id="stock-meta">${esc(quoteMeta)}</div>
          </div>
          <button type="button" class="btn ghost small" id="btn-change-symbol">Change symbol</button>
        </div>
        <div class="banner warn small" id="symbol-change-note" hidden></div>
      </div>` : ''}
      <div id="stock-search" ${editing ? 'hidden' : ''}>
        <label class="field">${editing ? 'Search for the correct stock' : 'Search stock or ETF'}
          <input name="q_stock" placeholder="Company name or ticker, e.g. Reliance, Infosys, AAPL" autocomplete="off">
          <span class="hint">Any exchange, any currency. Indian shares appear as NSE (.NS) and BSE (.BO) listings; pick the one you hold. Prices are tracked in the exchange's currency and the portfolio converts them to ${esc(BASE)} daily.</span>
        </label>
        <div id="stock-results" class="search-results" hidden></div>
      </div>
      <label class="field">Symbol
        <input name="symbol" value="${esc(f.symbol ?? '')}" placeholder="e.g. RELIANCE.NS, BHP.AX, AAPL" autocapitalize="characters" autocomplete="off">
        <span class="hint" id="symbol-hint">${quoteName ? esc(`${quoteName} · ${quoteMeta}`) : 'Pick a search result, or type the symbol used by Yahoo Finance'}</span>
      </label>
    </div>
    <div id="nps-fields" ${nps ? '' : 'hidden'}>
      <div class="form-row">
        <label class="field">Pension fund manager
          <select name="nps_pfm"><option value="">Loading…</option></select>
        </label>
        <label class="field">Tier
          <select name="nps_tier">
            <option value="I" ${d.tier !== 'II' ? 'selected' : ''}>Tier I (retirement account)</option>
            <option value="II" ${d.tier === 'II' ? 'selected' : ''}>Tier II (voluntary)</option>
          </select>
        </label>
      </div>
      <label class="field">Scheme variant
        <select name="nps_variant"><option value="">Standard</option></select>
        <span class="hint">Most accounts use the standard schemes. GS, Direct and POP variants exist for newer accounts; pick what your eNPS statement shows.</span>
      </label>
      <div class="field">Schemes in this account
        <div id="nps-schemes" class="radio-row"></div>
        <span class="hint" id="nps-status">NAVs come from NPS Trust, one series per scheme. Untick a scheme you do not invest in.</span>
      </div>
    </div>
    <div id="epf-fields" ${epf ? '' : 'hidden'}>
      <label class="field">Employer (optional)
        <input name="epf_employer" value="${esc(d.employer ?? '')}" placeholder="e.g. Acme Ltd">
        <span class="hint">Your EPF balance is deposits plus the interest EPFO credits each year. You enter both (a financial year at a time from your sheet, or month by month); nothing is looked up online. The employer's pension-scheme (EPS) share is tracked separately and is not part of the balance.</span>
      </label>
    </div>
    <div id="gold-fields" ${gold ? '' : 'hidden'}>
      <label class="field">Pick the series from the exchange list
        <select name="gold_pick"><option value="">Loading the Sovereign Gold Bond list…</option></select>
        <span class="hint" id="gold-status">Prices come from NSE's own feed, issue dates and issue prices from sgb.vercel.app, and both refresh with the other prices. Picking a series fills in the fields below; you can still edit them.</span>
      </label>
      <label class="field">Series
        <input name="gold_series" value="${esc(d.series ?? '')}" placeholder="e.g. Sovereign Gold Bonds 2021-22-Series-X">
        <span class="hint">A bond is worth your grams × its price per gram: the series' NSE traded price when it has a code, otherwise the gold price you enter with <b>Gold price</b> on the bond's page. Interest of 2.5% a year on the issue price arrives every six months: record each payment as an Interest transaction.</span>
      </label>
      <div class="form-row">
        <label class="field">NSE code
          <input name="gold_code" value="${esc(d.code ?? '')}" placeholder="e.g. SGBMAR30X" autocapitalize="characters">
          <span class="hint">Prices the bond from the exchange list. Leave empty to value it at a gold price you enter.</span>
        </label>
        <label class="field">Issue price per gram (₹, optional)
          <input type="number" name="gold_issue_price" min="0" step="0.01" value="${d.issue_price ?? ''}" placeholder="e.g. 5109">
          <span class="hint">The price interest is paid on (before any online discount).</span>
        </label>
      </div>
      <label class="field">Issue date
        <input type="date" name="gold_issue_date" value="${esc(d.issue_date ?? '')}">
        <span class="hint">From the RBI press release or your allotment advice. It sets the interest dates, early redemption from the fifth year (filled into Locked until) and maturity after eight years. Leave empty to take the first purchase's date.</span>
      </label>
    </div>
    <div id="ins-fields" ${insKind ? '' : 'hidden'}>
      <div class="form-row">
        <label class="field">Insurer
          <input name="ins_insurer" value="${esc(d.insurer ?? (editing ? '' : 'LIC'))}" placeholder="e.g. LIC">
          <span class="hint">A life insurance policy with a maturity value (an endowment or money-back plan): premiums on a schedule, a payout known in advance. Nothing is looked up online.</span>
        </label>
        <label class="field">Plan (optional)
          <input name="ins_plan" value="${esc(d.plan ?? '')}" placeholder="e.g. Jeevan Anand (149)">
        </label>
      </div>
      <div class="form-row">
        <label class="field">Premium (₹)
          <input type="number" name="ins_premium" min="0" step="0.01" value="${d.premium ?? ''}" placeholder="e.g. 10000">
          <span class="hint">The amount of each premium, as paid (with any GST).</span>
        </label>
        <label class="field">Paid
          <select name="ins_frequency">${['yearly', 'half-yearly', 'quarterly', 'monthly'].map((v) => `<option value="${v}" ${(d.frequency || 'yearly') === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select>
        </label>
      </div>
      <div class="form-row">
        <label class="field">First premium
          <input type="date" name="ins_first_premium" value="${esc(d.first_premium ?? '')}">
          <span class="hint">The policy's start date; every due date follows from it. Leave empty to take the first premium recorded.</span>
        </label>
        <label class="field">Last premium (optional)
          <input type="date" name="ins_last_premium" value="${esc(d.last_premium ?? '')}">
          <span class="hint">Leave empty when premiums run until maturity (the last due date before it).</span>
        </label>
      </div>
      <div class="form-row">
        <label class="field">Maturity date
          <input type="date" name="ins_maturity_date" value="${esc(d.maturity_date ?? '')}">
          <span class="hint">Filled into Locked until.</span>
        </label>
        <label class="field">Maturity value (₹)
          <input type="number" name="ins_maturity_value" min="0" step="0.01" value="${d.maturity_value ?? ''}" placeholder="e.g. 400000">
          <span class="hint">Sum assured plus the bonuses you expect, from the policy document or the insurer's estimate. The policy is valued along the curve from the premiums to it.</span>
        </label>
      </div>
      <label class="field">Sum assured (₹, optional)
        <input type="number" name="ins_sum_assured" min="0" step="0.01" value="${d.sum_assured ?? ''}" placeholder="e.g. 250000">
        <span class="hint">The life cover, for your records.</span>
      </label>
      ${editing ? '' : `
      <label class="check"><input type="checkbox" name="ins_backfill" checked> <span>Record every premium due up to today as paid (one Premium per due date from the first premium). Untick to import them from a sheet instead.</span></label>`}
    </div>
    <div id="fd-fields" ${fdKind ? '' : 'hidden'}>
      <label class="field">Bank (optional)
        <input name="fd_bank" value="${esc(d.bank ?? '')}" placeholder="e.g. SBI, HDFC Bank, Post Office">
        <span class="hint">A fixed deposit is one holding: the principal, and the maturity date and value from the bank's FD advice. Between the two dates it is valued along a constant-rate curve from the principal to the maturity value; nothing is looked up online.</span>
      </label>
      ${editing ? '' : `
      <div class="form-row">
        <label class="field">Deposit date
          <input type="date" name="fd_deposit_date">
        </label>
        <label class="field">Principal (₹)
          <input type="number" name="fd_principal" min="0" step="0.01" placeholder="e.g. 100000">
          <span class="hint">Recorded as the deposit transaction. Leave both empty to import the deposit from a sheet instead.</span>
        </label>
      </div>`}
      <div class="form-row">
        <label class="field">Maturity date
          <input type="date" name="fd_maturity_date" value="${esc(d.maturity_date ?? '')}">
          <span class="hint">From the FD advice; filled into Locked until.</span>
        </label>
        <label class="field">Maturity value (₹)
          <input type="number" name="fd_maturity_value" min="0" step="0.01" value="${d.maturity_value ?? ''}" placeholder="e.g. 107250">
          <span class="hint">What the bank will pay at maturity. For a deposit whose interest is paid out, usually the principal.</span>
        </label>
      </div>
      <div class="form-row">
        <label class="field">Interest rate % (optional)
          <input type="number" name="fd_rate" min="0" max="100" step="0.01" value="${d.rate ?? ''}" placeholder="e.g. 7.25">
          <span class="hint">The quoted rate, for your records; the effective rate is worked out from the two values.</span>
        </label>
        <label class="field">Interest
          <select name="fd_payout"><option value="cumulative" ${d.payout === 'periodic' ? '' : 'selected'}>Cumulative (paid with the principal at maturity)</option><option value="periodic" ${d.payout === 'periodic' ? 'selected' : ''}>Paid out periodically</option></select>
        </label>
      </div>
    </div>
    <div id="ppf-fields" ${ppf ? '' : 'hidden'}>
      <div class="form-row">
        <label class="field">Bank / post office (optional)
          <input name="ppf_bank" value="${esc(d.bank ?? '')}" placeholder="e.g. SBI, Post Office">
          <span class="hint">A PPF balance is deposits plus the interest credited each year; you enter both (a financial year at a time from your sheet, or entry by entry). Nothing is looked up online.</span>
        </label>
        <label class="field">Account opened on
          <input type="date" name="ppf_opened" value="${esc(d.opened ?? '')}">
          <span class="hint">Sets the maturity: 15 financial years after the year of opening (opened in FY 2015-16, matures 1 April 2031). Leave empty to take the first deposit's date.</span>
        </label>
      </div>
    </div>
    <div class="form-row">
      <label class="field"><span id="folio-label">${insKind ? 'Policy number' : fdKind ? 'FD account number' : gold ? 'Default folio (optional)' : ppf ? 'Account number' : epf ? 'UAN' : nps ? 'PRAN' : stock ? 'Default account (optional)' : 'Default folio number'}</span>
        <input name="folio_number" value="${esc(f.folio_number ?? '')}" placeholder="${insKind ? 'e.g. 123456789' : fdKind ? 'e.g. 50012345678' : gold ? 'e.g. 87654321' : ppf ? 'e.g. 12345678901' : epf ? 'e.g. 100123456789' : nps ? 'e.g. 110012345678' : stock ? 'e.g. Zerodha, ESPP, demat no.' : 'e.g. 1234567/89'}">
        <span class="hint" id="folio-hint">${insKind ? 'The policy number on the bond or the premium receipts (optional).' : fdKind ? 'The FD account or receipt number on the bank\'s advice (optional).' : gold ? 'The folio or demat account on your allotment advice; each purchase can carry its own.' : ppf ? 'Your PPF account number (optional).' : epf ? 'Your Universal Account Number (optional).' : nps ? 'Your Permanent Retirement Account Number (optional).' : stock ? 'Broker or demat account; each transaction can carry its own.' : 'Pre-filled on new transactions; each transaction can still carry its own folio.'}</span>
      </label>
      <label class="field">Display name
        <input name="name" required value="${esc(f.name ?? '')}" placeholder="Shown in your portfolio">
        ${editing ? `<span class="hint"><button type="button" class="link-btn" id="btn-use-scheme-name">Use the ${stock ? 'company' : 'scheme'} name</button></span>` : ''}
      </label>
    </div>
    <label class="check" id="apply-folio-wrap" hidden>
      <input type="checkbox" name="apply_folio">
      <span>Also change the ${stock ? 'account' : 'folio'} on the <b id="apply-folio-count">0</b> existing transaction(s) that use the old one</span>
    </label>
    <fieldset class="field">
      <legend>Status</legend>
      <div class="radio-row">
        <label><input type="radio" name="locked" value="0" ${f.locked ? '' : 'checked'}> Open — can be sold / redeemed</label>
        <label><input type="radio" name="locked" value="1" ${f.locked ? 'checked' : ''}> Locked — under lock-in (e.g. ELSS, vesting, ESPP holding period)</label>
      </div>
    </fieldset>
    <label class="field" id="lock-until-field" ${f.locked ? '' : 'hidden'}>Locked until (optional)
      <input type="date" name="lock_in_until" value="${f.lock_in_until ?? ''}">
    </label>
    <label class="field">Notes
      <input name="notes" value="${esc(f.notes ?? '')}" placeholder="Optional">
    </label>
    ${editing && txnCount ? `<p class="muted small">Your ${txnCount} transaction${txnCount === 1 ? '' : 's'} stay exactly as recorded. Changing the ${stock ? 'symbol' : 'scheme'} only changes which price history is used to value them.</p>` : ''}
    <div class="form-error" id="fund-form-error" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">${editing ? 'Save changes' : 'Add'}</button>
    </div>
  </form>`;
}

async function openFundModal(existing) {
  // From the portfolio page we only have the summary row; fetch the full fund so the dialog knows its source and transactions.
  if (existing?.id && !existing.transactions) {
    try {
      existing = await api.get(`/api/funds/${existing.id}`);
    } catch (e) {
      toast(`Could not load: ${e.message}`, 'error');
      return;
    }
  }
  const editing = Boolean(existing?.id);
  let kind = KINDS[existing?.kind] ? existing.kind : 'MF';
  const modal = openModal(editing ? `Edit ${KINDS[kind].lower}` : 'Add a holding', fundFormHtml(existing || {}));
  const form = modal.querySelector('#fund-form');
  const nameInput = form.elements.name;
  const folioInput = form.elements.folio_number;
  const codeInput = form.elements.scheme_code;
  const symbolInput = form.elements.symbol;
  const original = {
    code: existing?.scheme_code ?? null,
    symbol: existing?.symbol ?? '',
    folio: existing?.folio_number ?? '',
    schemeName: existing?.scheme?.scheme_name || '',
    stockName: existing?.quote?.name || '',
  };
  const allTx = editing ? existing.all_transactions || existing.transactions || [] : [];
  const oldFolioTxns = allTx.filter((t) => (t.folio_number || '') === original.folio).length;
  let selected = { code: original.code, name: original.schemeName }; // AMFI scheme picked from the search
  let stockInfo = original.symbol ? { symbol: original.symbol, name: original.stockName, currency: existing?.currency, exchange: existing?.exchange } : null;
  let nameEdited = editing;
  const err = modal.querySelector('#fund-form-error');

  // ---- NPS: pension fund manager, tier, variant and the schemes (E / C / G / A) with their NPS Trust ids
  const existingDetails = existing?.details || null;
  const pfmSel = form.elements.nps_pfm;
  const tierSel = form.elements.nps_tier;
  const variantSel = form.elements.nps_variant;
  const schemesBox = modal.querySelector('#nps-schemes');
  const npsStatus = modal.querySelector('#nps-status');
  let npsGroups = null;
  const VARIANT_LABEL = { '': 'Standard', GS: 'GS (government sector)', DIRECT: 'Direct', POP: 'POP' };
  const npsCandidates = () => {
    const g = npsGroups?.find((x) => x.pfm_id === pfmSel.value);
    return g ? g.schemes.filter((x) => ['E', 'C', 'G', 'A'].includes(x.letter) && x.tier === tierSel.value) : [];
  };
  const suggestedNpsName = () => {
    const pfm = pfmSel.selectedOptions[0]?.textContent || 'NPS';
    return `NPS Tier ${tierSel.value} · ${pfm.replace(/\s*(pension|fund|management|managers|private|pvt|limited|ltd|solutions|sunlife|mahindra)[\s.]*/gi, ' ').replace(/\s+/g, ' ').trim()}`;
  };
  const renderNpsOptions = () => {
    const cands = npsCandidates();
    const variants = [...new Set(cands.map((x) => x.variant))].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    const wanted = variantSel.dataset.chosen ?? existingDetails?.variant ?? '';
    variantSel.innerHTML = (variants.length ? variants : ['']).map((v) => `<option value="${esc(v)}" ${v === wanted ? 'selected' : ''}>${esc(VARIANT_LABEL[v] || v)}</option>`).join('');
    const chosen = existingDetails?.schemes || {};
    schemesBox.innerHTML = ['E', 'C', 'G', 'A']
      .map((L) => {
        const sch = cands.find((x) => x.letter === L && x.variant === variantSel.value);
        const checked = sch && (existingDetails ? Boolean(chosen[L]) : L !== 'A');
        return `<label class="check"><input type="checkbox" name="nps_scheme" value="${L}" data-id="${sch ? esc(sch.id) : ''}" ${sch ? '' : 'disabled'} ${checked ? 'checked' : ''}> <span><b>Scheme ${L}</b> · ${SCHEME_NAMES[L]}${sch ? ` · ${esc(sch.id)} · NAV ${sch.nav} (${fmtDate(sch.date)})` : ' · not offered here'}</span></label>`;
      })
      .join('');
    if (!editing && !nameEdited) nameInput.value = suggestedNpsName();
  };
  const loadNps = async () => {
    if (npsGroups) return;
    npsStatus.textContent = 'Loading the NPS scheme list from NPS Trust…';
    try {
      npsGroups = await api.get('/api/nps/schemes');
    } catch (e) {
      npsStatus.textContent = `Could not load the NPS scheme list: ${e.message}`;
      return;
    }
    pfmSel.innerHTML = npsGroups.map((g) => `<option value="${esc(g.pfm_id)}" ${existingDetails?.pfm_id === g.pfm_id ? 'selected' : ''}>${esc(g.pfm)}</option>`).join('');
    if (existingDetails?.tier) tierSel.value = existingDetails.tier;
    npsStatus.textContent = 'NAVs come from NPS Trust, one series per scheme. Untick a scheme you do not invest in.';
    renderNpsOptions();
  };
  pfmSel.addEventListener('change', renderNpsOptions);
  tierSel.addEventListener('change', () => {
    renderNpsOptions();
    if (!editing) { form.elements.locked.value = tierSel.value === 'I' ? '1' : '0'; modal.querySelector('#lock-until-field').hidden = tierSel.value !== 'I'; }
  });
  variantSel.addEventListener('change', () => { variantSel.dataset.chosen = variantSel.value; renderNpsOptions(); });

  // ---- kind switch (add only)
  const setKind = (next) => {
    kind = next;
    const stock = kind === 'STOCK';
    const npsKind = kind === 'NPS';
    const epfKind = kind === 'EPF';
    const ppfKind = kind === 'PPF';
    const goldKind = kind === 'GOLD';
    const fdK = kind === 'FD';
    const insK = kind === 'INS';
    modal.querySelector('#mf-fields').hidden = kind !== 'MF';
    modal.querySelector('#fd-fields').hidden = !fdK;
    modal.querySelector('#ins-fields').hidden = !insK;
    modal.querySelector('#ppf-fields').hidden = !ppfKind;
    modal.querySelector('#gold-fields').hidden = !goldKind;
    modal.querySelector('#stock-fields').hidden = !stock;
    modal.querySelector('#nps-fields').hidden = !npsKind;
    modal.querySelector('#epf-fields').hidden = !epfKind;
    modal.querySelector('#folio-label').textContent = insK ? 'Policy number' : fdK ? 'FD account number' : goldKind ? 'Default folio (optional)' : ppfKind ? 'Account number' : epfKind ? 'UAN' : npsKind ? 'PRAN' : stock ? 'Default account (optional)' : 'Default folio number';
    modal.querySelector('#folio-hint').textContent = insK ? 'The policy number on the bond or the premium receipts (optional).' : fdK ? 'The FD account or receipt number on the bank\'s advice (optional).' : goldKind ? 'The folio or demat account on your allotment advice; each purchase can carry its own.' : ppfKind ? 'Your PPF account number (optional).' : epfKind ? 'Your Universal Account Number (optional).' : npsKind ? 'Your Permanent Retirement Account Number (optional).' : stock ? 'Broker or demat account; each transaction can carry its own.' : 'Pre-filled on new transactions; each transaction can still carry its own folio.';
    folioInput.placeholder = insK ? 'e.g. 123456789' : fdK ? 'e.g. 50012345678' : goldKind ? 'e.g. 87654321' : ppfKind ? 'e.g. 12345678901' : epfKind ? 'e.g. 100123456789' : npsKind ? 'e.g. 110012345678' : stock ? 'e.g. Zerodha, ESPP, demat no.' : 'e.g. 1234567/89';
    if (npsKind) {
      loadNps();
      if (!editing) { form.elements.locked.value = tierSel.value === 'I' ? '1' : '0'; modal.querySelector('#lock-until-field').hidden = tierSel.value !== 'I'; }
    } else if (epfKind) {
      if (!editing) { form.elements.locked.value = '1'; modal.querySelector('#lock-until-field').hidden = false; if (!nameEdited) nameInput.value = 'EPF'; }
      form.elements.epf_employer.focus();
    } else if (goldKind) {
      if (!editing) { form.elements.locked.value = '1'; modal.querySelector('#lock-until-field').hidden = false; if (!nameEdited) nameInput.value = 'Sovereign Gold Bond'; }
      loadSgb();
      form.elements.gold_pick.focus();
    } else if (fdK) {
      if (!editing) { form.elements.locked.value = '1'; modal.querySelector('#lock-until-field').hidden = false; if (!nameEdited) nameInput.value = 'Fixed deposit'; }
      form.elements.fd_bank.focus();
    } else if (insK) {
      if (!editing) { form.elements.locked.value = '1'; modal.querySelector('#lock-until-field').hidden = false; if (!nameEdited) nameInput.value = insName(); }
      form.elements.ins_plan.focus();
    } else if (ppfKind) {
      if (!editing) { form.elements.locked.value = '1'; modal.querySelector('#lock-until-field').hidden = false; if (!nameEdited) nameInput.value = 'PPF'; }
      form.elements.ppf_bank.focus();
    } else (stock ? form.elements.q_stock : form.elements.q).focus();
  };
  form.elements.epf_employer.addEventListener('input', () => { if (kind === 'EPF' && !editing && !nameEdited) nameInput.value = `EPF${form.elements.epf_employer.value.trim() ? ` · ${form.elements.epf_employer.value.trim()}` : ''}`; });
  form.elements.ppf_bank.addEventListener('input', () => { if (kind === 'PPF' && !editing && !nameEdited) nameInput.value = `PPF${form.elements.ppf_bank.value.trim() ? ` · ${form.elements.ppf_bank.value.trim()}` : ''}`; });
  form.elements.fd_bank.addEventListener('input', () => { if (kind === 'FD' && !editing && !nameEdited) nameInput.value = `FD${form.elements.fd_bank.value.trim() ? ` · ${form.elements.fd_bank.value.trim()}` : ''}`; });
  const insName = () => { const i = form.elements.ins_insurer.value.trim(); const p = form.elements.ins_plan.value.trim(); return `${i || 'Policy'}${p ? ` · ${p}` : i ? ' policy' : ''}`; };
  ['ins_insurer', 'ins_plan'].forEach((n) => form.elements[n].addEventListener('input', () => { if (kind === 'INS' && !editing && !nameEdited) nameInput.value = insName(); }));
  // PPF: the opening date fills "Locked until" with the maturity, unless a date was typed by hand
  let lockAuto = !form.elements.lock_in_until.value;
  form.elements.lock_in_until.addEventListener('input', () => { lockAuto = !form.elements.lock_in_until.value; });
  form.elements.ppf_opened.addEventListener('change', () => { if (kind === 'PPF' && lockAuto && form.elements.ppf_opened.value) form.elements.lock_in_until.value = ppfMaturityDate(form.elements.ppf_opened.value); });
  // Fixed deposit: the maturity date is the lock-in, unless a date was typed by hand
  form.elements.fd_maturity_date.addEventListener('change', () => { if (kind === 'FD' && lockAuto && form.elements.fd_maturity_date.value) form.elements.lock_in_until.value = form.elements.fd_maturity_date.value; });
  form.elements.ins_maturity_date.addEventListener('change', () => { if (kind === 'INS' && lockAuto && form.elements.ins_maturity_date.value) form.elements.lock_in_until.value = form.elements.ins_maturity_date.value; });
  form.elements.gold_series.addEventListener('input', () => { if (kind === 'GOLD' && !editing && !nameEdited) nameInput.value = form.elements.gold_series.value.trim() || 'Sovereign Gold Bond'; });
  // ---- gold bond: the series list from the exchange (sgb.vercel.app)
  const goldPick = form.elements.gold_pick;
  const goldStatus = modal.querySelector('#gold-status');
  let sgbIssues = null;
  const money0 = (v) => (isNum(v) ? `₹${Math.round(v).toLocaleString('en-IN')}` : '–');
  const loadSgb = async () => {
    if (sgbIssues) return;
    try {
      sgbIssues = await api.get('/api/sgb/issues');
    } catch (e) {
      goldPick.innerHTML = '<option value="">List unavailable (offline?) · type the details by hand</option>';
      goldStatus.textContent = `Could not load the bond list: ${e.message}. You can still type the code and details.`;
      return;
    }
    const current = existingDetails?.code || '';
    goldPick.innerHTML = `<option value="">Choose a series…</option>${sgbIssues.map((i) => `<option value="${esc(i.symbol)}" ${i.symbol === current ? 'selected' : ''}>${esc(i.symbol)} · issued ${i.issue_date ? fmtDate(i.issue_date) : '?'} at ${money0(i.face_value)} · now ${money0(i.ltp)}${i.matured ? ' · matured' : ''}</option>`).join('')}`;
  };
  goldPick.addEventListener('change', () => {
    const i = sgbIssues?.find((x) => x.symbol === goldPick.value);
    if (!i) return;
    form.elements.gold_code.value = i.symbol;
    form.elements.gold_series.value = i.name;
    form.elements.gold_issue_price.value = isNum(i.face_value) ? i.face_value : '';
    if (i.issue_date) {
      form.elements.gold_issue_date.value = i.issue_date;
      if (lockAuto) form.elements.lock_in_until.value = addYears(i.issue_date, 5);
    }
    if (!editing && !nameEdited) nameInput.value = i.name;
  });
  if (kind === 'GOLD') loadSgb();
  // Gold bond: the issue date fills "Locked until" with the early-redemption date (five years on), unless typed by hand
  form.elements.gold_issue_date.addEventListener('change', () => { if (kind === 'GOLD' && lockAuto && form.elements.gold_issue_date.value) form.elements.lock_in_until.value = addYears(form.elements.gold_issue_date.value, 5); });
  form.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener('change', () => setKind(r.value)));
  if (kind === 'NPS') loadNps();

  // ---- mutual fund: AMFI scheme search
  const results = modal.querySelector('#scheme-results');
  const q = form.elements.q;
  const schemeNote = modal.querySelector('#scheme-change-note');
  let timer = null;
  let seq = 0;
  const updateSchemeNote = () => {
    if (!editing || kind !== 'MF') return;
    const code = Number(codeInput.value);
    if (!code || code === original.code) { schemeNote.hidden = true; return; }
    const to = selected.code === code && selected.name ? `“${selected.name}” (${code})` : `scheme code ${code}`;
    const from = original.schemeName ? `“${original.schemeName}”` : `scheme code ${original.code}`;
    schemeNote.innerHTML = `This fund will be re-linked from ${esc(from)} to ${esc(to)}. Its NAV history will be fetched and all values recalculated. Transactions are not modified.`;
    schemeNote.hidden = false;
  };
  modal.querySelector('#btn-change-scheme')?.addEventListener('click', () => {
    modal.querySelector('#scheme-search').hidden = false;
    q.focus();
  });
  q.addEventListener('input', () => {
    clearTimeout(timer);
    const text = q.value.trim();
    if (text.length < 3) { results.hidden = true; results.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      results.hidden = false;
      results.innerHTML = '<div class="muted small pad">Searching…</div>';
      try {
        const list = await api.get(`/api/schemes/search?q=${encodeURIComponent(text)}`);
        if (my !== seq) return;
        results.innerHTML = list.length
          ? list.map((s) => `<button type="button" class="result" data-code="${s.scheme_code}" data-name="${esc(s.scheme_name)}"><span>${esc(s.scheme_name)}</span><span class="muted small">${s.scheme_code}</span></button>`).join('')
          : '<div class="muted small pad">No matching schemes</div>';
      } catch (e) {
        if (my === seq) results.innerHTML = `<div class="form-error pad">${esc(e.message)}</div>`;
      }
    }, 350);
  });
  results.addEventListener('click', (e) => {
    const b = e.target.closest('.result');
    if (!b) return;
    selected = { code: Number(b.dataset.code), name: b.dataset.name };
    codeInput.value = b.dataset.code;
    if (!nameEdited || !nameInput.value.trim()) nameInput.value = b.dataset.name;
    q.value = b.dataset.name;
    results.hidden = true;
    results.innerHTML = '';
    if (editing) {
      modal.querySelector('#scheme-name').textContent = b.dataset.name;
      modal.querySelector('#scheme-meta').textContent = `code ${b.dataset.code} · new selection`;
    }
    updateSchemeNote();
  });
  codeInput.addEventListener('input', () => {
    if (Number(codeInput.value) !== selected.code) selected = { code: Number(codeInput.value), name: '' };
    updateSchemeNote();
  });

  // ---- stock: symbol search and quote lookup
  const stockResults = modal.querySelector('#stock-results');
  const qStock = form.elements.q_stock;
  const symbolHint = modal.querySelector('#symbol-hint');
  const symbolNote = modal.querySelector('#symbol-change-note');
  let stockTimer = null;
  let stockSeq = 0;
  let lookupSeq = 0;
  const updateSymbolNote = () => {
    if (!editing || kind !== 'STOCK') return;
    const sym = symbolInput.value.trim().toUpperCase();
    if (!sym || sym === original.symbol) { symbolNote.hidden = true; return; }
    const to = stockInfo?.symbol === sym && stockInfo.name ? `“${stockInfo.name}” (${sym}${stockInfo.currency ? `, ${stockInfo.currency}` : ''})` : sym;
    const from = original.stockName ? `“${original.stockName}” (${original.symbol})` : original.symbol;
    symbolNote.innerHTML = `This holding will be re-linked from ${esc(from)} to ${esc(to)}. Its price history will be fetched and all values recalculated. Transactions are not modified${stockInfo?.currency && existing?.currency && stockInfo.currency !== existing.currency ? `, but note the currency changes from ${esc(existing.currency)} to ${esc(stockInfo.currency)}` : ''}.`;
    symbolNote.hidden = false;
  };
  const lookupSymbol = async () => {
    const sym = symbolInput.value.trim().toUpperCase();
    if (!sym) { symbolHint.textContent = 'Pick a search result, or type the symbol used by Yahoo Finance'; return; }
    if (stockInfo?.symbol === sym && stockInfo.currency) { updateSymbolNote(); return; }
    const my = ++lookupSeq;
    symbolHint.textContent = `Looking up ${sym}…`;
    try {
      const r = await api.get(`/api/stocks/${encodeURIComponent(sym)}/quote`);
      if (my !== lookupSeq) return;
      stockInfo = { symbol: sym, name: r.name || sym, currency: r.currency, exchange: r.exchange };
      symbolHint.textContent = `${stockInfo.name} · ${[r.exchange, r.currency ? `prices in ${r.currency}` : ''].filter(Boolean).join(' · ')} · ${fmtMoney(r.price, r.currency || BASE, 2)} on ${fmtDate(r.date)}`;
      if (!nameEdited || !nameInput.value.trim()) nameInput.value = stockInfo.name;
      if (editing) {
        modal.querySelector('#stock-name').textContent = stockInfo.name;
        modal.querySelector('#stock-meta').textContent = `${sym} · ${r.exchange || ''} · prices in ${r.currency || '?'} · new selection`;
      }
      updateSymbolNote();
    } catch (e) {
      if (my !== lookupSeq) return;
      stockInfo = { symbol: sym, name: '', currency: null, exchange: null };
      symbolHint.textContent = `Could not look up ${sym}: ${e.message}`;
      updateSymbolNote();
    }
  };
  modal.querySelector('#btn-change-symbol')?.addEventListener('click', () => {
    modal.querySelector('#stock-search').hidden = false;
    qStock.focus();
  });
  qStock.addEventListener('input', () => {
    clearTimeout(stockTimer);
    const text = qStock.value.trim();
    if (text.length < 2) { stockResults.hidden = true; stockResults.innerHTML = ''; return; }
    stockTimer = setTimeout(async () => {
      const my = ++stockSeq;
      stockResults.hidden = false;
      stockResults.innerHTML = '<div class="muted small pad">Searching…</div>';
      try {
        const list = await api.get(`/api/stocks/search?q=${encodeURIComponent(text)}`);
        if (my !== stockSeq) return;
        stockResults.innerHTML = list.length
          ? list.map((s) => `<button type="button" class="result" data-symbol="${esc(s.symbol)}" data-name="${esc(s.name)}"><span><b>${esc(s.symbol)}</b> · ${esc(s.name)}</span><span class="muted small">${esc([s.exchange, s.type === 'EQUITY' ? '' : s.type].filter(Boolean).join(' · '))}</span></button>`).join('')
          : '<div class="muted small pad">No matching symbols. Try the ticker, e.g. RELIANCE.NS or AAPL.</div>';
      } catch (e) {
        if (my === stockSeq) stockResults.innerHTML = `<div class="form-error pad">${esc(e.message)}</div>`;
      }
    }, 350);
  });
  stockResults.addEventListener('click', (e) => {
    const b = e.target.closest('.result');
    if (!b) return;
    symbolInput.value = b.dataset.symbol;
    stockInfo = { symbol: b.dataset.symbol, name: b.dataset.name, currency: null, exchange: null };
    if (!nameEdited || !nameInput.value.trim()) nameInput.value = b.dataset.name;
    qStock.value = b.dataset.name;
    stockResults.hidden = true;
    stockResults.innerHTML = '';
    lookupSymbol();
  });
  let symbolTimer = null;
  symbolInput.addEventListener('input', () => {
    clearTimeout(symbolTimer);
    symbolTimer = setTimeout(lookupSymbol, 600);
  });
  symbolInput.addEventListener('change', () => { clearTimeout(symbolTimer); lookupSymbol(); });

  // ---- shared bits
  const updateFolioOption = () => {
    const wrap = modal.querySelector('#apply-folio-wrap');
    const changed = editing && folioInput.value.trim() !== original.folio && oldFolioTxns > 0;
    wrap.hidden = !changed;
    modal.querySelector('#apply-folio-count').textContent = oldFolioTxns;
  };
  modal.querySelector('#btn-use-scheme-name')?.addEventListener('click', () => {
    const name = kind === 'STOCK' ? stockInfo?.name : selected.name;
    if (name) { nameInput.value = name; nameEdited = true; }
    else toast(kind === 'STOCK' ? 'Pick a stock first' : 'Pick a scheme first', 'warn');
  });
  folioInput.addEventListener('input', updateFolioOption);
  nameInput.addEventListener('input', () => { nameEdited = nameInput.value.trim() !== ''; });
  form.querySelectorAll('input[name="locked"]').forEach((r) =>
    r.addEventListener('change', () => { modal.querySelector('#lock-until-field').hidden = form.elements.locked.value !== '1'; }),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const fd = new FormData(form);
    const stock = kind === 'STOCK';
    const npsKind = kind === 'NPS';
    const body = {
      name: String(fd.get('name')).trim(),
      kind,
      scheme_code: kind === 'MF' ? Number(fd.get('scheme_code')) || null : null,
      symbol: stock ? String(fd.get('symbol')).trim().toUpperCase() : null,
      details: null,
      folio_number: String(fd.get('folio_number')).trim(),
      locked: fd.get('locked') === '1',
      lock_in_until: fd.get('lock_in_until') || null,
      notes: String(fd.get('notes')).trim(),
    };
    if (editing) {
      const wrap = modal.querySelector('#apply-folio-wrap');
      body.apply_folio_to_transactions = !wrap.hidden && form.elements.apply_folio.checked;
    }
    if (kind === 'MF' && (!Number.isInteger(body.scheme_code) || body.scheme_code <= 0)) {
      err.textContent = 'Pick a scheme (or type its AMFI scheme code).';
      err.hidden = false;
      return;
    }
    if (stock && !body.symbol) {
      err.textContent = 'Pick a stock from the search, or type its symbol (e.g. RELIANCE.NS, BHP.AX, AAPL).';
      err.hidden = false;
      return;
    }
    if (npsKind) {
      const picked = [...form.querySelectorAll('input[name="nps_scheme"]:checked')].filter((c) => c.dataset.id);
      if (!npsGroups || !pfmSel.value) { err.textContent = 'The NPS scheme list has not loaded yet. Check your connection and try again.'; err.hidden = false; return; }
      if (!picked.length) { err.textContent = 'Tick at least one scheme (E, C, G or A).'; err.hidden = false; return; }
      body.details = {
        pfm_id: pfmSel.value,
        pfm: pfmSel.selectedOptions[0]?.textContent || '',
        tier: tierSel.value,
        variant: variantSel.value,
        schemes: Object.fromEntries(picked.map((c) => [c.value, c.dataset.id])),
      };
      if (!body.name) body.name = suggestedNpsName();
    }
    if (kind === 'EPF') {
      body.details = { employer: String(fd.get('epf_employer') || '').trim() };
      if (!body.name) body.name = `EPF${body.details.employer ? ` · ${body.details.employer}` : ''}`;
    }
    if (kind === 'PPF') {
      body.details = { bank: String(fd.get('ppf_bank') || '').trim(), opened: String(fd.get('ppf_opened') || '') || null };
      if (!body.name) body.name = `PPF${body.details.bank ? ` · ${body.details.bank}` : ''}`;
    }
    if (kind === 'GOLD') {
      body.details = {
        series: String(fd.get('gold_series') || '').trim(),
        code: String(fd.get('gold_code') || '').trim().toUpperCase(),
        issue_date: String(fd.get('gold_issue_date') || '') || null,
        issue_date_from: String(fd.get('gold_issue_date') || '') && String(fd.get('gold_issue_date')) === (sgbIssues?.find((x) => x.symbol === String(fd.get('gold_code') || '').trim().toUpperCase())?.issue_date || existingDetails?.issue_date_from === 'sgb' && existingDetails?.issue_date) ? 'sgb' : null,
        issue_price: fd.get('gold_issue_price') ? Number(fd.get('gold_issue_price')) : null,
        isin: existingDetails?.isin || null,
      };
      if (!body.name) body.name = body.details.series || 'Sovereign Gold Bond';
    }
    let fdDeposit = null;
    if (kind === 'FD') {
      const md = String(fd.get('fd_maturity_date') || '') || null;
      body.details = {
        bank: String(fd.get('fd_bank') || '').trim(),
        maturity_date: md,
        maturity_value: fd.get('fd_maturity_value') ? Number(fd.get('fd_maturity_value')) : null,
        rate: fd.get('fd_rate') ? Number(fd.get('fd_rate')) : null,
        payout: String(fd.get('fd_payout') || 'cumulative'),
      };
      if (!editing) {
        const dd = String(fd.get('fd_deposit_date') || '');
        const principal = Number(fd.get('fd_principal')) || 0;
        if ((dd && !principal) || (!dd && principal)) { err.textContent = 'Enter both the deposit date and the principal, or leave both empty to import the deposit later.'; err.hidden = false; return; }
        if (dd && md && md <= dd) { err.textContent = 'The maturity date must be after the deposit date.'; err.hidden = false; return; }
        if (dd && principal) fdDeposit = { date: dd, folio_number: body.folio_number, scheme: '', type: 'LUMPSUM', amount: principal, units: principal, nav: 1, notes: '' };
      }
      if (!body.name) body.name = `FD${body.details.bank ? ` · ${body.details.bank}` : ''}`;
    }
    let insPremiums = null;
    if (kind === 'INS') {
      const num = (n) => (fd.get(n) ? Number(fd.get(n)) : null);
      const str = (n) => String(fd.get(n) || '') || null;
      body.details = {
        insurer: String(fd.get('ins_insurer') || '').trim(),
        plan: String(fd.get('ins_plan') || '').trim(),
        premium: num('ins_premium'),
        frequency: String(fd.get('ins_frequency') || 'yearly'),
        first_premium: str('ins_first_premium'),
        last_premium: str('ins_last_premium'),
        maturity_date: str('ins_maturity_date'),
        maturity_value: num('ins_maturity_value'),
        sum_assured: num('ins_sum_assured'),
      };
      const t = body.details;
      if (t.first_premium && t.maturity_date && t.maturity_date <= t.first_premium) { err.textContent = 'The maturity date must be after the first premium.'; err.hidden = false; return; }
      if (t.first_premium && t.last_premium && t.last_premium < t.first_premium) { err.textContent = 'The last premium cannot be before the first.'; err.hidden = false; return; }
      if (!editing && form.elements.ins_backfill.checked && t.premium && t.first_premium) {
        const today = todayISO();
        const end = [t.last_premium, t.maturity_date, today].filter(Boolean).sort()[0];
        insPremiums = [];
        for (let n = 0; n < 2400; n++) {
          const due = addMonths(t.first_premium, n * FREQ_MONTHS[t.frequency]);
          if (due > end) break;
          insPremiums.push({ date: due, folio_number: body.folio_number, scheme: '', type: 'SIP', amount: t.premium, units: t.premium, nav: 1, notes: '' });
        }
        if (!insPremiums.length) insPremiums = null;
      }
      if (!body.name) body.name = insName();
    }
    if (!body.name) body.name = stock ? stockInfo?.name || body.symbol : selected.name || '';
    if (!body.name) {
      err.textContent = 'Give it a display name.';
      err.hidden = false;
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const saved = editing ? await api.put(`/api/funds/${existing.id}`, body) : await api.post('/api/funds', body);
      let depositError = null;
      if (fdDeposit && saved?.id) {
        try { await api.post(`/api/funds/${saved.id}/transactions`, fdDeposit); } catch (e3) { depositError = e3.message; }
      }
      if (insPremiums && saved?.id) {
        try { await api.post(`/api/funds/${saved.id}/transactions/bulk`, { transactions: insPremiums }); } catch (e3) { depositError = e3.message; }
      }
      closeModal();
      if (depositError) toast(`${KINDS[kind].label} added, but the ${insPremiums ? 'premiums' : 'deposit'} could not be recorded: ${depositError}. Add ${insPremiums ? 'them' : 'it'} with + Add transaction.`, 'warn');
      else if (saved.nav_error) toast(`Saved, but prices could not be fetched: ${saved.nav_error}`, 'warn');
      else if (editing) {
        const bits = [`${KINDS[kind].label} updated`];
        if (npsKind ? JSON.stringify(body.details.schemes) !== JSON.stringify(existingDetails?.schemes || {}) : stock ? body.symbol !== original.symbol : body.scheme_code !== original.code) bits.push(npsKind ? 'schemes changed' : stock ? 're-linked to the new symbol' : 're-linked to the new scheme');
        if (saved.transactions_updated) bits.push(`${stock ? 'account' : 'folio'} changed on ${saved.transactions_updated} transaction${saved.transactions_updated === 1 ? '' : 's'}`);
        toast(bits.join(' · '));
      } else toast(`${KINDS[kind].label} added${saved.currency && saved.currency !== BASE ? ` · prices in ${saved.currency}` : ''}`);
      if (editing) render();
      else location.hash = `#/fund/${saved.id}`;
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- transaction add / edit modal
function txnFormHtml(fund, tx, exit = null) {
  const today = todayISO();
  const k = kindOf(fund);
  const stock = k.key === 'STOCK';
  const gold = k.key === 'GOLD';
  const nps = k.key === 'NPS';
  const cur = fund.currency || BASE;
  const type = tx.type || (stock || gold ? 'LUMPSUM' : 'SIP');
  const letters = nps ? Object.keys(fund.details?.schemes || {}) : [];
  const schemeNow = tx.scheme || exit?.scheme || fund.scheme || letters[0] || '';
  const exitNote = exit
    ? `<div class="banner small">Selling all <b>${fmtNum(exit.units, 4)} ${k.unit}</b>${exit.scoped ? ` in this ${k.folio.toLowerCase()}` : ''} at the latest ${k.price.toLowerCase()}. Change the date and the amount to match your ${stock ? 'contract note' : 'statement'}; once the ${k.unit} held reach zero the ${k.lower} moves to the Closed tab with all its data.${exit.folios > 1 && !exit.scoped ? ` This ${k.lower} spans ${exit.folios} ${k.folioPlural}: to exit them one at a time, filter to a ${k.folio.toLowerCase()} first.` : ''}</div>`
    : '';
  const opt = (value, label) => `<option value="${value}" ${type === value ? 'selected' : ''}>${label}</option>`;
  const typeOptions = nps
    ? opt('SIP', 'Contribution') + opt('LUMPSUM', 'Lumpsum contribution') + opt('REDEMPTION', 'Withdrawal') + opt('SWITCH_IN', 'Switch in (rebalance into this scheme)') + opt('SWITCH_OUT', 'Switch out (rebalance out of this scheme)') + opt('CHARGE', 'Charges (units deducted)')
    : gold
      ? opt('LUMPSUM', 'Purchase') + opt('REDEMPTION', 'Redemption / sale') + opt('DIVIDEND', 'Interest received') + opt('SIP', 'SIP (purchase)') + opt('BONUS', 'Bonus units')
    : stock
      ? opt('LUMPSUM', 'Buy') + opt('REDEMPTION', 'Sell') + opt('SIP', 'SIP (buy)') + opt('DIVIDEND', 'Dividend received') + opt('BONUS', 'Bonus / free shares') + opt('CHARGE', 'Charges (shares deducted)')
      : opt('SIP', 'SIP (purchase)') + opt('LUMPSUM', 'Lumpsum (purchase)') + opt('REDEMPTION', 'Redemption (sell)') + opt('DIVIDEND', 'Dividend / IDCW payout') + opt('BONUS', 'Bonus units') + opt('CHARGE', 'Charges (units deducted)');
  const unitHead = k.unit[0].toUpperCase() + k.unit.slice(1);
  const folioField = nps
    ? `<label class="field">Scheme
        <select name="scheme" ${exit ? 'disabled' : ''}>${letters.map((L) => `<option value="${L}" ${schemeNow === L ? 'selected' : ''}>Scheme ${L} · ${SCHEME_NAMES[L] || ''}</option>`).join('')}</select>
        <span class="hint">Each scheme has its own NAV and units.</span>
        <input type="hidden" name="folio_number" value="${esc(tx.folio_number ?? fund.folio_number ?? '')}">
      </label>`
    : `<label class="field">${k.folio}${stock ? ' (optional)' : ' number'}
        <input name="folio_number" value="${esc(tx.folio_number ?? fund.folio_number ?? '')}" placeholder="${stock ? 'e.g. Zerodha, ESPP' : 'One folio, or several separated by /'}">
      </label>`;
  return `
  <form id="txn-form" class="form" novalidate>
    ${exitNote}
    <div class="form-row">
      <label class="field">Date
        <input type="date" name="date" required value="${tx.date ?? today}" max="${today}">
      </label>
      <label class="field">Type
        <select name="type">${typeOptions}</select>
      </label>
    </div>
    <div class="form-row">
      ${folioField}
      <label class="field"><span id="amount-label">Amount (${esc(cur)})</span>
        <input type="number" name="amount" min="0" step="0.01" value="${tx.amount ?? ''}" placeholder="${nps ? '50000' : stock ? '4000' : '5000'}">
        <span class="hint" id="amount-hint"></span>
      </label>
    </div>
    <div class="form-row">
      <label class="field">${k.price}${stock ? ` per share (${esc(cur)})` : ''}
        <input type="number" name="nav" min="0" step="0.0001" value="${tx.nav || ''}">
        <span class="hint" id="nav-hint">Auto-filled from ${k.price} history for the chosen date</span>
      </label>
      <label class="field">${unitHead}
        <input type="number" name="units" min="0" step="0.0001" value="${tx.units ?? ''}">
        <span class="hint" id="units-hint">Auto = amount ÷ ${k.price.toLowerCase()}. Edit to match your statement${stock ? ' (brokerage, fees)' : ' (stamp duty etc.)'}. For a sale, enter the amount received and the ${k.unit} sold.</span>
      </label>
    </div>
    ${tx.id ? '' : '<label class="check" id="folio-split-wrap" hidden><input type="checkbox" name="split_folios" checked> <span id="folio-split-text"></span></label>'}
    <label class="field">Comment
      <input name="notes" value="${esc(tx.notes ?? '')}" maxlength="500" placeholder="Optional, e.g. ${stock ? 'ESPP purchase, vested RSUs' : 'top-up on market dip, bonus money'}">
    </label>
    <div class="form-error" id="txn-form-error" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">${tx.id ? 'Save changes' : exit ? 'Record exit' : 'Add transaction'}</button>
    </div>
  </form>`;
}

/**
 * Add / edit one transaction. opts.exitUnits opens the form as an "Exit": a sale of everything held,
 * with the units pre-filled and the amount worked out as units x latest price (editable).
 */
/**
 * EPF: one month in one dialog. The employee, employer and pension amounts of the same date and type are
 * edited together; a cleared amount deletes that entry, a newly filled one creates it.
 * entries: the existing entries of the row (empty when adding); date / type seed a new row.
 */
/** EPF / PPF: one dialog for one date. EPF has employee, employer and pension boxes (a whole month); PPF has a
 * single amount. Editing a row updates, removes or adds the entries behind it. */
function openEpfGroupModal(fund, { entries = [], date, type } = {}) {
  const ppf = fund.kind === 'PPF';
  const cur = fund.currency || BASE;
  const today = todayISO();
  const editing = entries.length > 0;
  const first = entries[0];
  const t0 = first?.type || type || 'SIP';
  const d0 = first?.date || date || today;
  const by = Object.fromEntries(entries.map((t) => [t.scheme || '', t]));
  const amountOf = (t) => (t ? (t.type === 'BONUS' ? t.units : t.amount) : '');
  const rate0 = entries.find((t) => isNum(t.rate))?.rate ?? (fund.transactions || []).find((t) => isNum(t.rate))?.rate ?? '';
  const notes0 = entries.find((t) => t.notes)?.notes || '';
  const opt = (v, l) => `<option value="${v}" ${t0 === v ? 'selected' : ''}>${l}</option>`;
  const shares = ppf
    ? [{ key: '', label: `Amount (${esc(cur)})`, placeholder: 'e.g. 5000', hint: '' }]
    : [
        { key: 'EE', label: `Employee share (${esc(cur)})`, placeholder: 'e.g. 1800', hint: '' },
        { key: 'ER', label: `Employer share (${esc(cur)})`, placeholder: 'e.g. 550', hint: "The employer's EPF share only, without the pension part." },
        { key: 'EPS', label: `Pension (EPS) contribution (${esc(cur)})`, placeholder: 'e.g. 1250', hint: 'Tracked separately; not part of the balance.' },
      ];
  const field = (sh) => `<label class="field">${sh.label}
        <input type="number" name="amt_${sh.key}" min="0" step="0.01" value="${amountOf(by[sh.key])}" placeholder="${sh.placeholder}">
        ${sh.hint ? `<span class="hint" id="hint-${sh.key}">${sh.hint}</span>` : ''}
      </label>`;
  const rateField = `<label class="field">Interest rate % (optional)
        <input type="number" name="rate" min="0" max="100" step="0.01" value="${rate0}" placeholder="e.g. ${ppf ? '7.1' : '8.25'}">
      </label>`;
  const amountRows = ppf
    ? `<div class="form-row">${field(shares[0])}${rateField}</div>`
    : `<div class="form-row">${field(shares[0])}${field(shares[1])}</div><div class="form-row">${field(shares[2])}${rateField}</div>`;
  const modal = openModal(editing ? `Edit ${fmtDate(d0)} · ${esc(fund.name)}` : `${ppf ? 'Add an entry' : 'Add a month'} · ${esc(fund.name)}`, `
  <form id="txn-form" class="form" novalidate>
    <div class="form-row">
      <label class="field">Date
        <input type="date" name="date" required value="${d0}" max="${today}">
        <span class="hint">${ppf ? "Deposits made by the 5th earn that month's interest; the year's interest goes on 31 March." : "Deposits go on the 15th of the month, the year's interest on 31 March."}</span>
      </label>
      <label class="field">Type
        <select name="type">${opt('SIP', 'Deposit')}${opt('LUMPSUM', 'Transfer in / opening balance')}${opt('BONUS', 'Interest credited')}${opt('REDEMPTION', 'Withdrawal')}</select>
      </label>
    </div>
    ${amountRows}
    <label class="field">Comment
      <input name="notes" value="${esc(notes0)}" maxlength="500" placeholder="Optional">
    </label>
    <input type="hidden" name="folio_number" value="${esc(first?.folio_number ?? fund.folio_number ?? '')}">
    ${editing ? '<p class="muted small">Leave an amount empty to remove that entry for this date.</p>' : ''}
    <div class="form-error" id="txn-form-error" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">${editing ? 'Save changes' : 'Add'}</button>
    </div>
  </form>`);
  const form = modal.querySelector('#txn-form');
  const typeSel = form.elements.type;
  const applyType = () => {
    if (ppf) return;
    const bonus = typeSel.value === 'BONUS';
    form.elements.amt_EPS.disabled = bonus;
    modal.querySelector('#hint-EPS').textContent = bonus ? 'The pension scheme earns no interest.' : 'Tracked separately; not part of the balance.';
  };
  typeSel.addEventListener('change', applyType);
  applyType();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = modal.querySelector('#txn-form-error');
    err.hidden = true;
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    const d = form.elements.date.value;
    const t = typeSel.value;
    if (!d) return fail('A date is required.');
    const num = (name) => parseFloat(form.elements[name].value) || 0;
    const values = Object.fromEntries(shares.map((sh) => [sh.key, sh.key === 'EPS' && t === 'BONUS' ? 0 : num(`amt_${sh.key}`)]));
    if (!Object.values(values).some((v) => v > 0)) return fail(ppf ? 'Enter the amount.' : 'Enter at least one amount.');
    const rate = form.elements.rate.value ? parseFloat(form.elements.rate.value) : null;
    const notes = form.elements.notes.value.trim();
    const folio = form.elements.folio_number.value.trim();
    const ops = [];
    const creates = [];
    for (const sh of shares) {
      const v = values[sh.key];
      const body = { date: d, folio_number: folio, scheme: sh.key, type: t, amount: t === 'BONUS' ? 0 : v, units: v, nav: 1, rate, notes };
      if (by[sh.key] && v > 0) ops.push(api.put(`/api/transactions/${by[sh.key].id}`, body));
      else if (by[sh.key]) ops.push(api.del(`/api/transactions/${by[sh.key].id}`));
      else if (v > 0) creates.push(body);
    }
    if (creates.length) ops.push(api.post(`/api/funds/${fund.id}/transactions/bulk`, { transactions: creates }));
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await Promise.all(ops);
      closeModal();
      toast(editing ? (ppf ? 'Entry updated' : 'Month updated') : (ppf ? 'Entry added' : 'Month added'));
      render();
    } catch (e2) {
      fail(e2.message);
      btn.disabled = false;
    }
  });
}

/** Fixed deposit or insurance policy: one dialog for a deposit / premium, interest or a benefit paid out, or the payout
 * at maturity / closure / surrender. The rupee-as-unit bookkeeping is done here: money put in is rupees at 1, money
 * paid out along the way is cash with no units, and a payout takes every rupee still held at the amount received
 * (the server works the factor out). */
function openFdTxnModal(fund, existing, seed) {
  const ins = fund.kind === 'INS';
  const cur = fund.currency || BASE;
  const today = todayISO();
  const editing = Boolean(existing?.id);
  const t0 = existing?.type || seed?.type || (ins ? 'SIP' : 'LUMPSUM');
  const d0 = existing?.date || seed?.date || today;
  const a0 = existing ? existing.amount : isNum(seed?.amount) ? Number(seed.amount).toFixed(2) : '';
  const opt = (v, l) => `<option value="${v}" ${t0 === v ? 'selected' : ''}>${l}</option>`;
  const typeOpts = ins
    ? opt('SIP', 'Premium') + opt('LUMPSUM', 'Single premium / top-up') + opt('DIVIDEND', 'Benefit received (survival benefit, bonus paid out)') + opt('REDEMPTION', 'Payout (maturity or surrender)')
    : opt('LUMPSUM', 'Deposit') + opt('DIVIDEND', 'Interest paid out') + opt('REDEMPTION', 'Payout (maturity or premature closure)');
  const x = fund.fd || fund.policy || {};
  const title = editing ? 'Edit transaction' : seed?.payout ? `Matured / paid out · ${esc(fund.name)}` : seed?.premium ? `Premium paid · ${esc(fund.name)}` : `Add transaction · ${esc(fund.name)}`;
  const modal = openModal(title, `
  <form id="txn-form" class="form" novalidate>
    ${seed?.payout ? `<div class="banner small">Records the money the ${ins ? 'insurer' : 'bank'} paid out and closes the ${ins ? 'policy' : 'deposit'}; the gain over ${ins ? 'the premiums paid' : 'the principal'} is the ${ins ? 'return' : 'interest'} earned. ${isNum(x.maturity_value) && x.matured ? `The maturity value ${ins ? 'you entered' : 'from the FD advice'} is pre-filled; change it to the amount actually credited${ins ? '' : ' (after any tax deducted at source)'}.` : 'Enter the amount actually credited.'}</div>` : ''}
    ${seed?.premium ? '<div class="banner small">The next premium from the schedule is pre-filled. Change the date to the day it was actually paid.</div>' : ''}
    <div class="form-row">
      <label class="field">Date
        <input type="date" name="date" required value="${d0}" max="${today}">
      </label>
      <label class="field">Type
        <select name="type">${typeOpts}</select>
      </label>
    </div>
    <div class="form-row">
      <label class="field">Amount (${esc(cur)})
        <input type="number" name="amount" min="0" step="0.01" value="${a0}" placeholder="e.g. 100000">
        <span class="hint" id="amount-hint"></span>
      </label>
      <label class="field">${ins ? 'Policy number' : 'Account number'}
        <input name="folio_number" value="${esc(existing?.folio_number ?? fund.folio_number ?? '')}" placeholder="Optional">
      </label>
    </div>
    <label class="field">Comment
      <input name="notes" value="${esc(existing?.notes ?? '')}" maxlength="500" placeholder="Optional${ins ? '' : ', e.g. renewed from the earlier deposit'}">
    </label>
    <div class="form-error" id="txn-form-error" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">${editing ? 'Save changes' : seed?.payout ? 'Record payout' : seed?.premium ? 'Record premium' : 'Add transaction'}</button>
    </div>
  </form>`);
  const form = modal.querySelector('#txn-form');
  const typeSel = form.elements.type;
  const amountHint = modal.querySelector('#amount-hint');
  const applyType = () => {
    const t = typeSel.value;
    amountHint.textContent = ins
      ? (t === 'DIVIDEND' ? 'Money the policy paid you along the way (a survival benefit or a bonus paid out); the policy carries on.' : t === 'REDEMPTION' ? 'Everything the insurer paid out: the whole policy leaves the holding and it is marked Closed.' : 'The premium as paid, with any GST.')
      : (t === 'DIVIDEND' ? 'Interest credited to your bank account; the deposit itself is unchanged.' : t === 'REDEMPTION' ? 'Everything the bank paid out: the whole deposit leaves the holding and it is marked Closed.' : 'The principal placed with the bank (a renewal is a new deposit).');
  };
  typeSel.addEventListener('change', applyType);
  applyType();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = modal.querySelector('#txn-form-error');
    err.hidden = true;
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    const d = form.elements.date.value;
    const t = typeSel.value;
    const amount = parseFloat(form.elements.amount.value) || 0;
    if (!d) return fail('A date is required.');
    if (!(amount > 0)) return fail('Enter the amount.');
    const body = {
      date: d, folio_number: form.elements.folio_number.value.trim(), scheme: '', type: t, amount, notes: form.elements.notes.value.trim(),
      units: t === 'DIVIDEND' ? 0 : t === 'LUMPSUM' || t === 'SIP' ? amount : null, nav: t === 'LUMPSUM' || t === 'SIP' ? 1 : null,
    };
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      if (editing) await api.put(`/api/transactions/${existing.id}`, body);
      else await api.post(`/api/funds/${fund.id}/transactions`, body);
      closeModal();
      toast(editing ? 'Transaction updated' : t === 'REDEMPTION' ? `Payout recorded · the ${ins ? 'policy' : 'deposit'} is closed` : seed?.premium ? 'Premium recorded' : 'Transaction added');
      render();
    } catch (e2) {
      fail(e2.message);
      btn.disabled = false;
    }
  });
}

/** EPF: a job change. The new employer's account is created under the same UAN and every employee / employer
 * share entry moves to it; the pension (EPS) record stays with the old account unless asked otherwise. */
function openEpfTransferModal(fund) {
  const today = todayISO();
  const s = fund.summary || {};
  const M = (v) => fmtMoney(v, fund.currency || BASE);
  const modal = openModal(`Moved jobs · ${esc(fund.name)}`, `
  <form id="txn-form" class="form" novalidate>
    <div class="banner small">A new EPF account is created for the new employer under the same UAN <b>${esc(fund.folio_number || '')}</b>, and every employee and employer share entry (deposits and interest, ${M(s.current_value)} in balance) moves to it, so its history, by-year table and returns continue unbroken. The pension (EPS) record (${M(s.pension_paid)} paid in) stays here, and this account is listed under Closed.</div>
    <div class="form-row">
      <label class="field">New employer
        <input name="employer" required placeholder="e.g. NewCo" maxlength="120">
      </label>
      <label class="field">Date of change
        <input type="date" name="date" required value="${today}" max="${today}">
      </label>
    </div>
    <label class="field">Display name of the new account
      <input name="name" required maxlength="200" placeholder="EPF · NewCo">
    </label>
    <label class="check"><input type="checkbox" name="move_pension"> Also move the pension (EPS) entries <span class="muted">(normally they stay with the old account)</span></label>
    <div class="form-error" id="txn-form-error" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">Move to the new account</button>
    </div>
  </form>`);
  const form = modal.querySelector('#txn-form');
  const employer = form.elements.employer;
  const name = form.elements.name;
  let nameEdited = false;
  employer.addEventListener('input', () => { if (!nameEdited) name.value = `EPF · ${employer.value.trim()}`.replace(/ · $/, ''); });
  name.addEventListener('input', () => { nameEdited = name.value.trim() !== ''; });
  employer.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = modal.querySelector('#txn-form-error');
    err.hidden = true;
    const body = { employer: employer.value.trim(), name: name.value.trim() || `EPF · ${employer.value.trim()}`, date: form.elements.date.value, move_pension: form.elements.move_pension.checked };
    if (!body.employer || !body.date) { err.textContent = 'The new employer and the date of change are required.'; err.hidden = false; return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const saved = await api.post(`/api/funds/${fund.id}/epf-transfer`, body);
      closeModal();
      toast(`${saved.moved} entr${saved.moved === 1 ? 'y' : 'ies'} moved to ${saved.name}`);
      location.hash = `#/fund/${saved.id}`;
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

/** EPF / PPF: the interest credited for one financial year, dated 31 March. */
function openEpfInterestModal(fund) {
  const ppf = fund.kind === 'PPF';
  const acct = fund.epf || fund.ppf || {};
  const cur = fund.currency || BASE;
  const years = acct.years || [];
  const fyNow = Number((acct.current_fy || '').slice(0, 4)) || new Date().getFullYear();
  const starts = [...new Set([...years.map((y) => Number(y.fy.slice(0, 4))), fyNow - 1, fyNow])].sort((a, b) => b - a);
  const pending = acct.pending_interest_fy;
  const chosen = pending ? Number(pending.slice(0, 4)) : fyNow - 1;
  const recorded = (fy) => (fund.transactions || []).filter((t) => t.type === 'BONUS' && fyOfDate(t.date) === fyLabel(fy));
  const shares = ppf
    ? [['', `Interest credited (${esc(cur)})`, 'e.g. 232']]
    : [['EE', `Interest on the employee share (${esc(cur)})`, 'e.g. 606'], ['ER', `Interest on the employer share (${esc(cur)})`, 'e.g. 249']];
  const modal = openModal(`Year interest · ${esc(fund.name)}`, `
  <form id="txn-form" class="form" novalidate>
    <div class="form-row">
      <label class="field">Financial year
        <select name="fy">${starts.map((y) => `<option value="${y}" ${y === chosen ? 'selected' : ''}>${fyLabel(y)}${recorded(y).length ? ' (already recorded)' : ''}</option>`).join('')}</select>
        <span class="hint">Credited on 31 March of that year.</span>
      </label>
      <label class="field">Interest rate % (optional)
        <input type="number" name="rate" min="0" max="100" step="0.01" placeholder="e.g. ${ppf ? '7.1' : '8.25'}">
      </label>
    </div>
    <div class="form-row">
      ${shares.map(([key, label, ph]) => `<label class="field">${label}
        <input type="number" name="int_${key}" min="0" step="0.01" placeholder="${ph}">
      </label>`).join('')}
    </div>
    <div class="form-error" id="txn-form-error" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">Record interest</button>
    </div>
  </form>`);
  const form = modal.querySelector('#txn-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = modal.querySelector('#txn-form-error');
    err.hidden = true;
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    const fy = Number(form.elements.fy.value);
    const rate = form.elements.rate.value ? parseFloat(form.elements.rate.value) : null;
    const amounts = shares.map(([key]) => [key, parseFloat(form.elements[`int_${key}`].value) || 0]);
    if (!amounts.some(([, a]) => a > 0)) return fail(ppf ? 'Enter the interest credited.' : 'Enter the interest credited on at least one share.');
    if (recorded(fy).length) return fail(`Interest for FY ${fyLabel(fy)} is already recorded; edit or delete those entries in the table instead.`);
    const date = `${fy + 1}-03-31`;
    const items = amounts.filter(([, a]) => a > 0).map(([scheme, a]) => ({ date, folio_number: fund.folio_number || '', scheme, type: 'BONUS', amount: 0, units: a, nav: 1, rate, notes: `Interest for FY ${fyLabel(fy)}` }));
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api.post(`/api/funds/${fund.id}/transactions/bulk`, { transactions: items });
      closeModal();
      toast(`Interest for FY ${fyLabel(fy)} recorded`);
      render();
    } catch (e2) {
      fail(e2.message);
      btn.disabled = false;
    }
  });
}

function openTxnModal(fund, existing, opts = {}) {
  const k = kindOf(fund);
  if (k.key === 'EPF' || k.key === 'PPF') return openEpfGroupModal(fund, existing ? { entries: [existing] } : {});
  if (k.key === 'FD' || k.key === 'INS') return openFdTxnModal(fund, existing, null);
  const stock = k.key === 'STOCK';
  const gold = k.key === 'GOLD';
  const cur = fund.currency || BASE;
  const nps = k.key === 'NPS';
  const exit = !existing && isNum(opts.exitUnits) && opts.exitUnits > 0 ? { units: opts.exitUnits, folios: opts.folios || 0, scoped: Boolean(opts.scoped), scheme: opts.scheme || '' } : null;
  const seed = existing || (exit ? { type: 'REDEMPTION', units: Number(exit.units.toFixed(4)), scheme: exit.scheme } : {});
  const modal = openModal(existing ? 'Edit transaction' : exit ? `Exit · ${esc(fund.name)}` : `Add transaction · ${esc(fund.name)}`, txnFormHtml(fund, seed, exit));
  const form = modal.querySelector('#txn-form');
  const { date, amount, nav, units, type: typeSel } = form.elements;
  const schemeSel = nps ? form.elements.scheme : null;
  const hint = modal.querySelector('#nav-hint');
  const folioInput = form.elements.folio_number;
  const splitWrap = modal.querySelector('#folio-split-wrap');
  const updateSplit = () => {
    if (!splitWrap) return;
    const parts = splitFolios(folioInput.value);
    splitWrap.hidden = !parts;
    if (parts) modal.querySelector('#folio-split-text').textContent = `${parts.length} ${k.folioPlural} detected: create ${parts.length} transactions, splitting the amount and ${k.unit} equally between them`;
  };
  folioInput.addEventListener('input', updateSplit);
  updateSplit();
  let navTouched = Boolean(existing);
  let unitsTouched = Boolean(existing) || Boolean(exit);
  let amountTouched = false;
  let seq = 0;

  const unitsDrive = () => exit || typeSel.value === 'CHARGE'; // units are the input; the amount follows the price
  const recompute = () => {
    const n = parseFloat(nav.value);
    if (unitsDrive() && !amountTouched) {
      // Exit / charges: the units are given; the amount follows the price until the user types the real figure.
      const u = parseFloat(units.value);
      amount.value = u > 0 && n > 0 ? (u * n).toFixed(2) : '';
      return;
    }
    if (unitsTouched) return;
    const a = parseFloat(amount.value);
    units.value = a > 0 && n > 0 ? (a / n).toFixed(4) : '';
  };

  // Dividends carry money but no units; bonus units carry units but no money; charges are units whose
  // value follows from the NAV. Disable or pre-fill the boxes so the form cannot be filled in contradictorily.
  const unitsHint = modal.querySelector('#units-hint');
  const amountHint = modal.querySelector('#amount-hint');
  const unitsHintDefault = unitsHint.textContent;
  const applyType = () => {
    const t = typeSel.value;
    const div = t === 'DIVIDEND';
    const bonus = t === 'BONUS';
    const charge = t === 'CHARGE';
    units.disabled = div;
    amount.disabled = bonus;
    if (div) units.value = '0';
    else if (units.value === '0') { units.value = ''; unitsTouched = false; recompute(); }
    if (bonus) amount.value = '0';
    else if (amount.value === '0') amount.value = '';
    if (charge) { unitsTouched = true; recompute(); }
    unitsHint.textContent = div ? 'Not applicable: a dividend does not change the units you hold.' : bonus ? `Number of free ${k.unit} received. They are added at zero cost.` : charge ? `Number of ${k.unit} deducted for charges.` : unitsHintDefault;
    amountHint.textContent = div ? 'Cash received. It counts as money coming back in the XIRR.' : bonus ? 'Nothing paid for bonus / free units.' : charge ? `Auto = ${k.unit} × ${k.price.toLowerCase()}: the value deducted. Change it if your statement shows a different figure.` : t === 'SWITCH_IN' || t === 'SWITCH_OUT' ? 'Value moved between schemes; it is not money you paid or received.' : '';
    if (div || bonus) hint.textContent = `${k.price} on that day, for your records only (optional).`;
  };

  const fetchNav = async () => {
    if (navTouched || !date.value) return;
    const my = ++seq;
    const schemeId = nps ? (fund.details?.schemes || {})[schemeSel?.value] : null;
    if (nps && !schemeId) { hint.textContent = 'Pick a scheme to look up its NAV.'; return; }
    hint.textContent = `Looking up ${k.price.toLowerCase()}…`;
    try {
      const r = gold
        ? await api.get(`/api/gold/price?on=${date.value}`)
        : stock
        ? await api.get(`/api/stocks/${encodeURIComponent(fund.symbol)}/quote?on=${date.value}`)
        : nps
          ? await api.get(`/api/nps/${encodeURIComponent(schemeId)}/nav?on=${date.value}`)
          : await api.get(`/api/schemes/${fund.scheme_code}/nav?on=${date.value}`);
      if (my !== seq) return;
      const price = stock || gold ? r.price : r.nav;
      nav.value = stock ? Number(price.toFixed(4)) : price;
      hint.textContent = r.date === date.value
        ? `${k.price} on ${fmtDate(r.date)}${stock ? ' (closing price)' : gold ? ' (gold price you entered)' : ''}`
        : `No ${k.price.toLowerCase()} on ${fmtDate(date.value)}; using ${fmtDate(r.date)}. Adjust if your statement differs.`;
      recompute();
    } catch (e) {
      if (my === seq) hint.textContent = `${k.price} lookup failed: ${e.message}. Enter it manually.`;
    }
  };

  date.addEventListener('change', fetchNav);
  schemeSel?.addEventListener('change', () => { navTouched = false; fetchNav(); });
  amount.addEventListener('input', () => { amountTouched = amount.value !== ''; recompute(); });
  nav.addEventListener('input', () => { navTouched = true; recompute(); });
  units.addEventListener('input', () => { unitsTouched = units.value !== ''; if (!unitsTouched || unitsDrive()) recompute(); });
  typeSel.addEventListener('change', applyType);
  applyType();
  if (exit) amountHint.textContent = `Auto = ${k.unit} × ${k.price.toLowerCase()}. Type the amount you actually received if it differs.`;
  if (!existing) fetchNav();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = modal.querySelector('#txn-form-error');
    err.hidden = true;
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    const body = {
      date: date.value,
      folio_number: form.elements.folio_number.value.trim(),
      scheme: schemeSel ? schemeSel.value : '',
      type: typeSel.value,
      amount: amount.value ? parseFloat(amount.value) : 0,
      nav: nav.value ? parseFloat(nav.value) : null,
      units: units.value ? parseFloat(units.value) : null,
      notes: form.elements.notes.value.trim(),
    };
    if (!body.date) return fail('A date is required.');
    if (nps && !body.scheme) return fail('Pick the scheme this belongs to.');
    if (body.type === 'DIVIDEND') {
      body.units = 0;
      if (!(body.amount > 0)) return fail('Enter the dividend amount received.');
    } else if (body.type === 'BONUS') {
      body.amount = 0;
      if (!(body.units > 0)) return fail(`Enter the number of bonus ${k.unit} received.`);
    } else if (body.type === 'CHARGE') {
      if (!(body.units > 0)) return fail(`Enter the number of ${k.unit} deducted.`);
      if (!(body.amount > 0) && !(body.nav > 0)) return fail(`Enter the ${k.price.toLowerCase()} on that day or the amount deducted.`);
    } else if (!(body.amount > 0) || !(body.nav > 0)) {
      return fail(`A positive amount and a positive ${k.price.toLowerCase()} are required.`);
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const purchaseOrSale = !['DIVIDEND', 'BONUS', 'CHARGE'].includes(body.type) && !nps;
    const parts = purchaseOrSale && !existing && splitWrap && !splitWrap.hidden && form.elements.split_folios.checked ? splitFolios(body.folio_number) : null;
    try {
      if (existing) await api.put(`/api/transactions/${existing.id}`, body);
      else if (parts) {
        // One purchase spread over several folios: one transaction per folio, amount and units divided equally.
        const amounts = distribute(body.amount, parts.length, 2);
        const unitParts = body.units ? distribute(body.units, parts.length, 4) : null;
        const items = parts.map((folio, kk) => ({
          ...body,
          folio_number: folio,
          amount: amounts[kk],
          units: unitParts ? unitParts[kk] : null,
          notes: [body.notes, `Split ${kk + 1}/${parts.length} of ${fmtMoney(body.amount, cur, 2)} across ${k.folioPlural} ${body.folio_number}`].filter(Boolean).join(' · '),
        }));
        await api.post(`/api/funds/${fund.id}/transactions/bulk`, { transactions: items });
      } else await api.post(`/api/funds/${fund.id}/transactions`, body);
      closeModal();
      toast(existing ? 'Transaction updated' : parts ? `${parts.length} transactions added, one per ${k.folio.toLowerCase()}` : exit ? 'Exit recorded' : 'Transaction added');
      render();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- password protection (vault)
const SHIELD_ICON =
  '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16.5" r="1.5"/></svg>';

let locked = false;
let authInfo = { min_password_length: 8, idle_lock_minutes: 30 };

function setLocked(isLocked) {
  locked = isLocked;
  document.body.classList.toggle('locked', isLocked);
}

/** Route to the normal app, the unlock screen or the first-run password setup, based on vault state. */
function applyAuth(status) {
  authInfo = { ...authInfo, ...status };
  if (status.base_currency) BASE = status.base_currency;
  if (status.version) document.getElementById('app-version').textContent = `v${status.version}`;
  if (status.state === 'unlocked') {
    setLocked(false);
    render();
    return;
  }
  setLocked(true);
  destroyChart();
  closeModal();
  if (status.state === 'setup') renderSetup();
  else renderLock();
}

async function boot() {
  try {
    applyAuth(await api.get('/api/auth/status'));
  } catch (err) {
    app.innerHTML = errorCard(err);
  }
}

function renderLock() {
  const idle = authInfo.idle_lock_minutes;
  app.innerHTML = `
    <section class="card auth-card">
      <div class="auth-icon">${SHIELD_ICON}</div>
      <h1>Unlock your portfolio</h1>
      <p class="muted">Your data is encrypted on this computer. Enter your password to open it.</p>
      ${authInfo.notice?.message ? `<div class="banner warn" style="text-align:left">${esc(authInfo.notice.message)}</div>` : ''}
      <form id="unlock-form" class="form" novalidate>
        <label class="field">Password
          <input type="password" name="password" autocomplete="current-password" required>
        </label>
        <div class="form-error" id="auth-error" hidden></div>
        <div class="form-actions"><button type="submit" class="btn primary">Unlock</button></div>
      </form>
      <p class="footnote">There is no password recovery. If the password is lost, the data cannot be opened.${idle ? ` The app locks itself after ${idle} minutes without use.` : ''}${authInfo.version ? ` Version ${authInfo.version}.` : ''}</p>
      ${dataFolderLine()}
    </section>`;
  const form = document.getElementById('unlock-form');
  const err = document.getElementById('auth-error');
  document.getElementById('btn-data-dir')?.addEventListener('click', openDataDirModal);
  document.getElementById('btn-cloud-lock')?.addEventListener('click', openCloudModal);
  cloudHint();
  form.elements.password.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Unlocking…';
    try {
      await api.post('/api/auth/unlock', { password: form.elements.password.value });
      applyAuth({ state: 'unlocked' });
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      form.elements.password.value = '';
      form.elements.password.focus();
      btn.disabled = false;
      btn.textContent = 'Unlock';
    }
  });
}

/** Where the vault file is, with a way to change it (shown on the lock and setup screens). */
function dataFolderLine() {
  if (!authInfo.vault_path) return '';
  return `<p class="footnote">Vault file: <code>${esc(authInfo.vault_path)}</code> · <button type="button" class="link-btn" id="btn-data-dir">Change folder…</button> · <button type="button" class="link-btn" id="btn-cloud-lock">Cloud backup…</button></p><div id="cloud-hint"></div>`;
}

const PROVIDER_ORDER = ['google', 'onedrive', 'dropbox'];
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const fmtBytes = (n) => (isNum(n) ? (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`) : '');

/** On the lock screen: when a provider holds a copy saved more recently by another device, offer to restore it. */
async function cloudHint() {
  const box = document.getElementById('cloud-hint');
  if (!box) return;
  let st;
  try { st = await api.get('/api/cloud/status?check=true'); } catch { return; }
  const newer = PROVIDER_ORDER.map((k) => [k, st.providers[k]]).filter(([, p]) => p.connected && p.newer_remote);
  const failed = PROVIDER_ORDER.map((k) => [k, st.providers[k]]).filter(([, p]) => p.connected && p.last_error);
  if (!document.getElementById('cloud-hint')) return;
  box.innerHTML = [
    ...newer.map(([k, p]) => `<div class="banner" style="text-align:left">A newer copy of the vault is in <b>${esc(p.label)}</b>, saved ${fmtWhen(p.remote.modified)}${p.remote.device ? ` from ${esc(p.remote.device)}` : ''}; this device's file is from ${fmtWhen(st.local?.modified)}. <button type="button" class="link-btn" data-restore="${k}">Restore it here</button></div>`),
    ...failed.map(([, p]) => `<div class="banner warn" style="text-align:left">The last backup to ${esc(p.label)} failed: ${esc(p.last_error)}</div>`),
  ].join('');
  box.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => restoreFrom(b.dataset.restore, st.providers[b.dataset.restore].label)));
}

async function restoreFrom(provider, label) {
  const ok = await confirmDialog(`Restore from ${esc(label)}?`, `The vault file on this device will be replaced by the copy in ${esc(label)}. The current file is kept beside it as <code>portfolio.before-restore-…enc</code>, so nothing is lost, and you unlock with the restored file's password.`);
  if (!ok) return;
  try {
    await api.post('/api/cloud/restore', { provider });
    closeModal();
    toast(`Vault restored from ${label}`);
    boot();
  } catch (e) {
    toast(`Restore failed: ${e.message}`, 'error');
  }
}

/** Back up to Google Drive, OneDrive or Dropbox: set up each provider once, connect, then every change is uploaded. */
async function openCloudModal() {
  const modal = openModal('Cloud backup', '<p class="empty small">Loading…</p>', { wide: true });
  const box = modal.querySelector('.modal-body') || modal;
  let polling = null;
  const stopPolling = () => { if (polling) { clearInterval(polling); polling = null; } };

  const providerHtml = (key, p, st) => {
    const remote = p.remote
      ? `in the cloud: ${fmtWhen(p.remote.modified)}${p.remote.device ? ` from ${esc(p.remote.device)}` : ''} · ${fmtBytes(p.remote.size)}`
      : p.remote_error ? `could not check the cloud copy: ${esc(p.remote_error)}` : p.connected ? 'no backup in the cloud yet' : '';
    const line = p.connected
      ? `Connected as <b>${esc(p.account || '')}</b>${p.last_backup ? ` · last backup ${fmtWhen(p.last_backup)} (${fmtBytes(p.last_size)})` : ' · not backed up yet'}${p.last_error ? ` · <span class="danger-text">last attempt failed: ${esc(p.last_error)}</span>` : ''}`
      : p.configured ? 'Set up, not connected' : 'Not set up';
    return `
    <div class="cloud-provider" data-provider="${key}">
      <div class="head"><b>${esc(p.label)}</b><span class="muted small">${line}</span></div>
      ${p.connected && p.newer_remote ? `<div class="banner small">A newer copy was saved ${fmtWhen(p.remote.modified)}${p.remote.device ? ` from ${esc(p.remote.device)}` : ''}; this device's file is from ${fmtWhen(st.local?.modified)}.</div>` : ''}
      ${remote ? `<div class="muted small">${remote}</div>` : ''}
      <div class="head-actions" style="margin-top:8px">
        ${p.connected ? `<button type="button" class="btn ghost small" data-act="backup">Back up now</button><button type="button" class="btn ghost small" data-act="restore" ${p.remote ? '' : 'disabled'}>Restore from ${esc(p.label)}</button><button type="button" class="btn ghost small danger-text" data-act="disconnect">Disconnect</button>` : `<button type="button" class="btn primary small" data-act="connect" ${p.configured ? '' : 'disabled'}>Connect ${esc(p.label)}</button>`}
        <button type="button" class="btn ghost small" data-act="setup">${p.configured ? 'Change setup' : 'Set up…'}</button>
      </div>
      <form class="form cloud-setup" hidden>
        <p class="muted small">${esc(p.setup)} <a href="${esc(p.console)}" target="_blank" rel="noopener">Open the console</a>.</p>
        <div class="form-row">
          <label class="field">Client ID<input name="client_id" value="${esc(p.client_id || '')}" maxlength="300" autocomplete="off"></label>
          ${p.needs_secret ? `<label class="field">Client secret<input name="client_secret" type="password" maxlength="300" autocomplete="off" placeholder="${p.configured ? '(unchanged)' : ''}"></label>` : ''}
        </div>
        <div class="form-error" hidden></div>
        <div class="form-actions"><button type="button" class="btn ghost small" data-act="setup-cancel">Cancel</button><button type="submit" class="btn primary small">Save</button></div>
      </form>
    </div>`;
  };

  async function render(check = true) {
    let st;
    try { st = await api.get(`/api/cloud/status?check=${check}`); } catch (e) { box.innerHTML = `<p class="form-error">${esc(e.message)}</p>`; return; }
    box.innerHTML = `
      <p class="muted small">The vault file is encrypted before it leaves this device, so the cloud only ever holds ciphertext. Connect a provider once through its normal sign-in page; after that every change is backed up there a few seconds later, and any other device can restore the latest copy. The app only has access to its own folder, never to your other files. This device: <b>${esc(st.device)}</b>${st.local ? ` · vault file ${fmtWhen(st.local.modified)} (${fmtBytes(st.local.size)})` : ''}.</p>
      ${PROVIDER_ORDER.map((k) => providerHtml(k, st.providers[k], st)).join('')}
      <div class="form-actions"><button type="button" class="btn ghost" data-close>Close</button></div>`;
    box.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { stopPolling(); closeModal(); }));
    box.querySelectorAll('.cloud-provider').forEach((card) => {
      const key = card.dataset.provider;
      const p = st.providers[key];
      const setup = card.querySelector('.cloud-setup');
      card.querySelector('[data-act="setup"]').addEventListener('click', () => { setup.hidden = !setup.hidden; if (!setup.hidden) setup.elements.client_id.focus(); });
      card.querySelector('[data-act="setup-cancel"]').addEventListener('click', () => { setup.hidden = true; });
      setup.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = setup.querySelector('.form-error');
        err.hidden = true;
        try {
          await api.put('/api/cloud/credentials', { provider: key, client_id: setup.elements.client_id.value.trim(), client_secret: setup.elements.client_secret ? setup.elements.client_secret.value.trim() || null : null });
          toast(setup.elements.client_id.value.trim() ? `${p.label} set up` : `${p.label} setup removed`);
          render(false);
        } catch (e2) { err.textContent = e2.message; err.hidden = false; }
      });
      card.querySelector('[data-act="connect"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const r = await api.post('/api/cloud/connect', { provider: key });
          const win = window.open(r.auth_url, '_blank');
          btn.textContent = 'Waiting for the sign-in in your browser…';
          if (!win) toast('Your browser blocked the sign-in window; allow pop-ups for this app and try again', 'warn');
          stopPolling();
          const started = Date.now();
          polling = setInterval(async () => {
            if (!document.body.contains(box)) { stopPolling(); return; } // the dialog was closed
            if (Date.now() - started > 300000) { stopPolling(); render(false); return; }
            try {
              const now = await api.get('/api/cloud/status');
              if (now.providers[key].connected) { stopPolling(); toast(`${p.label} connected`); render(true); }
            } catch { /* keep waiting */ }
          }, 2000);
        } catch (e2) { toast(e2.message, 'error'); btn.disabled = false; }
      });
      card.querySelector('[data-act="backup"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Backing up…';
        try { const r = await api.post('/api/cloud/backup', { provider: key }); toast(`Backed up to ${p.label} (${fmtBytes(r.size)})`); } catch (e2) { toast(`Backup failed: ${e2.message}`, 'error'); }
        render(true);
      });
      card.querySelector('[data-act="restore"]')?.addEventListener('click', () => restoreFrom(key, p.label));
      card.querySelector('[data-act="disconnect"]')?.addEventListener('click', async () => {
        const ok = await confirmDialog(`Disconnect ${esc(p.label)}?`, 'Backups to it stop; the copy already there is left as it is.');
        if (!ok) return;
        try { await api.del(`/api/cloud/${key}`); toast(`${p.label} disconnected`); render(false); } catch (e2) { toast(e2.message, 'error'); }
      });
    });
  }
  render(true);
}

/** Choose the folder the vault file lives in, from the next start on: a cloud-synced folder shares it with the phone. */
function openDataDirModal() {
  const current = authInfo.configured_data_dir || '';
  const modal = openModal('Data folder', `
  <form id="txn-form" class="form" novalidate>
    <p class="muted small">The vault file <code>portfolio.enc</code> is kept in this folder. Choose a folder that OneDrive, Google Drive or Dropbox syncs to use the same data on another device, and keep only one device open at a time: the app locks itself rather than overwrite a file another device changed.</p>
    <label class="field">Folder
      <input name="path" value="${esc(current)}" placeholder="${esc(authInfo.data_dir || '')}" maxlength="1000">
      <span class="hint">The full path. Leave it empty to go back to the default folder, ${esc(authInfo.data_dir || '')}.</span>
    </label>
    <label class="check"><input type="checkbox" name="copy_vault" checked> Copy the current vault file there if that folder has none</label>
    <div class="form-error" id="txn-form-error" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">Save</button>
    </div>
  </form>`);
  const form = modal.querySelector('#txn-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = modal.querySelector('#txn-form-error');
    err.hidden = true;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await api.put('/api/settings/data-dir', { path: form.elements.path.value.trim() || null, copy_vault: form.elements.copy_vault.checked });
      closeModal();
      const where = res.data_dir || 'the default folder';
      await confirmDialog('Data folder saved', `From the next start the app will keep its vault in <b>${esc(where)}</b>${res.copied ? ', where the current vault file has now been copied' : res.vault_exists_there ? ', which already holds a vault file' : ''}. Close the app and open it again to switch.`);
      boot();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
  form.elements.path.focus();
}

function renderSetup() {
  const min = authInfo.min_password_length || 8;
  const n = authInfo.legacy_funds;
  const legacy = authInfo.has_legacy
    ? `<div class="banner warn">Your existing data${isNum(n) ? ` (${n} fund${n === 1 ? '' : 's'})` : ''} will be encrypted with this password, and the unencrypted file will be removed.</div>`
    : '';
  app.innerHTML = `
    <section class="card auth-card">
      <div class="auth-icon">${SHIELD_ICON}</div>
      <h1>Protect your data with a password</h1>
      <p class="muted">Everything you enter is stored encrypted on this computer and can only be opened with this password.</p>
      ${legacy}
      <form id="setup-form" class="form" novalidate>
        <label class="field">Password
          <input type="password" name="password" autocomplete="new-password" required minlength="${min}">
          <span class="hint">At least ${min} characters. A long phrase you will remember works best.</span>
        </label>
        <label class="field">Confirm password
          <input type="password" name="confirm" autocomplete="new-password" required>
        </label>
        <label class="check warn-check"><input type="checkbox" name="ack" required> I understand that if I forget this password my data cannot be recovered. There is no reset.</label>
        <div class="form-error" id="auth-error" hidden></div>
        <div class="form-actions"><button type="submit" class="btn primary">Set password and continue</button></div>
      </form>
      ${dataFolderLine()}
    </section>`;
  const form = document.getElementById('setup-form');
  const err = document.getElementById('auth-error');
  document.getElementById('btn-data-dir')?.addEventListener('click', openDataDirModal);
  document.getElementById('btn-cloud-lock')?.addEventListener('click', openCloudModal);
  cloudHint();
  form.elements.password.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    const pw = form.elements.password.value;
    if (pw.length < min) return fail(`Password must be at least ${min} characters.`);
    if (pw !== form.elements.confirm.value) return fail('The two passwords do not match.');
    if (!form.elements.ack.checked) return fail('Please confirm you understand there is no password recovery.');
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Encrypting…';
    try {
      const res = await api.post('/api/auth/setup', { password: pw });
      toast(res.migrated ? 'Your existing data is now encrypted.' : 'Password set. Your data will be stored encrypted.');
      applyAuth({ state: 'unlocked' });
    } catch (e2) {
      fail(e2.message);
      btn.disabled = false;
      btn.textContent = 'Set password and continue';
    }
  });
}

function openPasswordModal() {
  const min = authInfo.min_password_length || 8;
  const modal = openModal('Change password', `
    <form id="pw-form" class="form" novalidate>
      <label class="field">Current password <input type="password" name="current" autocomplete="current-password" required></label>
      <label class="field">New password
        <input type="password" name="new" autocomplete="new-password" required minlength="${min}">
        <span class="hint">At least ${min} characters. There is still no recovery if you forget it.</span>
      </label>
      <label class="field">Confirm new password <input type="password" name="confirm" autocomplete="new-password" required></label>
      <div class="form-error" id="pw-error" hidden></div>
      <div class="form-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">Change password</button>
      </div>
    </form>`);
  const form = modal.querySelector('#pw-form');
  const err = modal.querySelector('#pw-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    const next = form.elements.new.value;
    if (next.length < min) return fail(`New password must be at least ${min} characters.`);
    if (next !== form.elements.confirm.value) return fail('The new passwords do not match.');
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api.post('/api/auth/change-password', { current: form.elements.current.value, new: next });
      closeModal();
      toast('Password changed');
    } catch (e2) {
      fail(e2.message);
      btn.disabled = false;
    }
  });
}

async function lockNow() {
  try {
    await api.post('/api/auth/lock');
  } catch (e) {
    toast(`Could not lock: ${e.message}`, 'error');
    return;
  }
  applyAuth({ state: 'locked' });
}

// ---------------------------------------------------------------- global actions
async function refreshNav() {
  const btn = document.getElementById('btn-refresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    const r = await api.post('/api/nav/refresh');
    const failed = Object.values(r.failed);
    if (failed.length) toast(`Prices refreshed for ${r.requested - failed.length} of ${r.requested} sources. ${failed[0]}`, 'warn');
    else toast(r.requested ? `Prices refreshed for ${r.requested} source${r.requested === 1 ? '' : 's'}` : 'Nothing to refresh');
    await render();
  } catch (e) {
    toast(`Refresh failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh prices';
  }
}

// ---------------------------------------------------------------- router
async function render() {
  if (locked) return; // the lock / setup screen owns the page until the vault is open
  destroyChart();
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/fund\/(\d+)(?:\?(.*))?$/);
  try {
    if (m) {
      const fp = new URLSearchParams(m[2] || '');
      await renderFund(Number(m[1]), fp.get('folio'), fp.get('scheme'));
    } else {
      const tab = new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '').get('tab');
      if (tab === 'closed' || tab === 'active') state.holdingsTab = tab; // #/?tab=closed opens the Closed tab
      await renderPortfolio();
    }
  } catch (err) {
    if (err?.status === 423 || err?.status === 409) return; // vault-state listener switches to the lock screen
    app.innerHTML = errorCard(err);
  }
  window.scrollTo(0, 0);
}

document.getElementById('btn-add-fund').addEventListener('click', () => openFundModal(null));
document.getElementById('btn-refresh').addEventListener('click', refreshNav);
document.getElementById('btn-lock').addEventListener('click', lockNow);
document.getElementById('btn-password').addEventListener('click', openPasswordModal);
document.getElementById('btn-cloud').addEventListener('click', openCloudModal);
let bootPending = false;
window.addEventListener('vault-state', () => {
  // an API call hit a locked (423) or not-yet-set-up (409) vault, e.g. after the idle auto-lock
  if (bootPending) return;
  bootPending = true;
  boot().finally(() => { bootPending = false; });
});
document.getElementById('btn-theme').addEventListener('click', () => {
  state.theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
  save('theme', state.theme);
  applyTheme();
  render();
});
darkQuery.addEventListener('change', () => {
  if (state.theme === 'auto') { applyTheme(); render(); }
});
document.addEventListener('click', (e) => {
  if (e.target.closest('#btn-add-fund-inline')) openFundModal(null);
  if (e.target.closest('[data-action="reload"]')) location.reload();
});
window.addEventListener('hashchange', render);

applyTheme();
boot();
