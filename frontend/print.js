// Print or save as PDF: a dialog to choose what goes on paper, and the #/print view that lays the chosen sections out
// as a report. The printing itself is the platform's: the browser's print dialog on the PC (Save as PDF is one of its
// printers) and Android's print dialog on a phone or tablet, reached through the app's AndroidApp.print bridge.

import { api } from './api.js';
import { valueChart, donutChart, seriesColors } from './charts.js';
import { fmtMoney, fmtPct, fmtNum, fmtDate, esc, todayISO, isNum } from './format.js';
import { openModal, closeModal, toast } from './ui.js';
import { KINDS, ASSET_CLASSES } from './app.js';

export const SECTIONS = [
  { key: 'summary', label: 'Summary', hint: 'invested, value, profit, realised gains, XIRR' },
  { key: 'allocation', label: 'Allocation by asset class', hint: 'the ring and its table', portfolio: true },
  { key: 'holdings', label: 'Holdings list', hint: 'one line per holding: folio or account, invested, value, P&L, XIRR' },
  { key: 'folios', label: 'Folio-wise breakdown', hint: 'each folio, account, scheme or share of a holding' },
  { key: 'details', label: 'Holding details', hint: 'scheme or symbol, terms, maturity, schedule' },
  { key: 'income', label: 'Income and realised gains', hint: 'dividends, interest, sale proceeds and gains in the period' },
  { key: 'transactions', label: 'Transactions', hint: 'every entry in the period, oldest first' },
  { key: 'upcoming', label: 'Upcoming dates', hint: 'maturities, premiums due, interest dates, lock-ins ending' },
  { key: 'charts', label: 'Value over time', hint: 'the chart, as a picture' },
];
const PRESETS = {
  snapshot: { label: 'Snapshot', hint: 'summary, allocation, holdings list', keys: ['summary', 'allocation', 'holdings'] },
  statement: { label: 'Statement', hint: 'summary, holdings, folios and every transaction', keys: ['summary', 'holdings', 'folios', 'transactions'] },
  tax: { label: 'Tax year', hint: 'income, realised gains and the transactions of the last financial year', keys: ['summary', 'income', 'transactions'], period: 'lastfy' },
  everything: { label: 'Everything', hint: 'all sections', keys: SECTIONS.map((s) => s.key) },
};
const DEFAULTS = { scope: 'portfolio', fund: '', status: 'active', kinds: 'all', sections: PRESETS.snapshot.keys.join(','), period: 'all', from: '', to: '', comments: '1', title: '' };
const SELLS = new Set(['REDEMPTION', 'SWITCH_OUT', 'CHARGE']);

const kindOf = (f) => KINDS[f?.kind] || KINDS.MF;
const classOf = (kind) => ASSET_CLASSES.find((c) => c.kind === kind) || { kind, label: kind, one: 'holding', many: 'holdings' };
const classIndex = (kind) => { const i = ASSET_CLASSES.findIndex((c) => c.kind === kind); return i < 0 ? 99 : i; };
const M = (v, cur = 'INR', d = 0) => (isNum(v) ? fmtMoney(v, cur, d) : '–');
const pct = (x) => (isNum(x) ? fmtPct(x * 100) : '–');
const delta = (v, cur = 'INR') => (!isNum(v) ? '–' : `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${fmtMoney(Math.abs(v), cur)}</span>`);
const inr = (f) => (f.needs_fx ? f.base?.summary : f.summary) || null;
const sum = (list, pick = (t) => t.amount) => list.reduce((s, t) => s + (pick(t) || 0), 0);
const byClassThenName = (a, b) => classIndex(a.kind || 'MF') - classIndex(b.kind || 'MF') || String(a.name).localeCompare(String(b.name));

// ---------------------------------------------------------------- options <-> URL

function parseOptions(qs) {
  const p = new URLSearchParams(qs || '');
  const o = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (p.has(k)) o[k] = p.get(k);
  return o;
}

function encodeOptions(o) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v !== DEFAULTS[k]) p.set(k, v);
  return p.toString();
}

/** Indian financial year, April to March; offset 0 = the current one. */
function fyBounds(offset = 0) {
  const n = new Date();
  const y = (n.getMonth() >= 3 ? n.getFullYear() : n.getFullYear() - 1) + offset;
  return { from: `${y}-04-01`, to: `${y + 1}-03-31`, label: `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}` };
}

function periodOf(o) {
  switch (o.period) {
    case 'thisfy': return fyBounds(0);
    case 'lastfy': return fyBounds(-1);
    case 'thisyear': { const y = new Date().getFullYear(); return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) }; }
    case 'custom': return { from: o.from || '', to: o.to || '', label: `${o.from ? fmtDate(o.from) : 'the start'} to ${o.to ? fmtDate(o.to) : 'today'}` };
    default: return { from: '', to: '', label: 'all time' };
  }
}
const inPeriod = (p) => (t) => (!p.from || t.date >= p.from) && (!p.to || t.date <= p.to);

/** Hand the page to the platform's print dialog: Android's through the app bridge, the browser's otherwise. */
export function doPrint() {
  if (window.AndroidApp && typeof window.AndroidApp.print === 'function') { window.AndroidApp.print(); return; }
  window.print();
}

// ---------------------------------------------------------------- the dialog

export async function openPrintModal({ fundId = null, current = null } = {}) {
  let funds = [];
  try { funds = await api.get('/api/funds'); } catch (e) { toast(`Could not load the holdings: ${e.message}`, 'error'); return; }
  if (!funds.length) { toast('Nothing to print yet: add a holding first', 'warn'); return; }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('printOptions') || 'null'); } catch { saved = null; }
  const o = { ...DEFAULTS, ...(saved || {}), ...(current || {}) };
  if (fundId) { o.scope = 'fund'; o.fund = String(fundId); }
  else if (!current) o.scope = 'portfolio';
  if (!funds.some((f) => String(f.id) === o.fund)) o.fund = String(fundId || funds[0].id);
  funds = [...funds].sort(byClassThenName);
  const kindsPresent = ASSET_CLASSES.filter((c) => funds.some((f) => (f.kind || 'MF') === c.kind));
  const chosenKinds = o.kinds === 'all' ? null : new Set(o.kinds.split(','));
  const chosenSections = new Set(o.sections.split(',').filter(Boolean));
  const modal = openModal('Print or save as PDF', `
  <form id="print-form" class="form" novalidate>
    <fieldset class="field">
      <legend>What to print</legend>
      <div class="radio-row">
        <label><input type="radio" name="scope" value="portfolio" ${o.scope === 'portfolio' ? 'checked' : ''}> The whole portfolio</label>
        <label><input type="radio" name="scope" value="fund" ${o.scope === 'fund' ? 'checked' : ''}> One holding</label>
      </div>
      <select name="fund" ${o.scope === 'fund' ? '' : 'disabled'} aria-label="Holding to print">${funds.map((f) => `<option value="${f.id}" ${String(f.id) === o.fund ? 'selected' : ''}>${esc(f.name)}${f.closed ? ' (closed)' : ''} · ${esc(classOf(f.kind || 'MF').label)}</option>`).join('')}</select>
    </fieldset>
    <div id="print-portfolio-opts" ${o.scope === 'portfolio' ? '' : 'hidden'}>
      <div class="form-row">
        <fieldset class="field">
          <legend>Holdings</legend>
          <div class="radio-row">
            <label><input type="radio" name="status" value="active" ${o.status === 'active' ? 'checked' : ''}> Active</label>
            <label><input type="radio" name="status" value="closed" ${o.status === 'closed' ? 'checked' : ''}> Closed</label>
            <label><input type="radio" name="status" value="all" ${o.status === 'all' ? 'checked' : ''}> Both</label>
          </div>
        </fieldset>
        <fieldset class="field">
          <legend>Asset classes</legend>
          <div class="check-grid narrow">${kindsPresent.map((c) => `<label class="check"><input type="checkbox" name="kind" value="${c.kind}" ${!chosenKinds || chosenKinds.has(c.kind) ? 'checked' : ''}> ${esc(c.label)}</label>`).join('')}</div>
        </fieldset>
      </div>
    </div>
    <fieldset class="field">
      <legend>Sections</legend>
      <div class="preset-row">${Object.entries(PRESETS).map(([k, p]) => `<button type="button" class="btn ghost small" data-preset="${k}" title="${esc(p.hint)}">${esc(p.label)}</button>`).join('')}</div>
      <div class="check-grid">${SECTIONS.map((s) => `<label class="check" data-section="${s.key}"><input type="checkbox" name="section" value="${s.key}" ${chosenSections.has(s.key) ? 'checked' : ''}> <span><b>${esc(s.label)}</b> <span class="muted">· ${esc(s.hint)}</span></span></label>`).join('')}</div>
    </fieldset>
    <div class="form-row">
      <label class="field">Period for transactions and income
        <select name="period">
          <option value="all" ${o.period === 'all' ? 'selected' : ''}>All time</option>
          <option value="thisfy" ${o.period === 'thisfy' ? 'selected' : ''}>This financial year (${esc(fyBounds(0).label)})</option>
          <option value="lastfy" ${o.period === 'lastfy' ? 'selected' : ''}>Last financial year (${esc(fyBounds(-1).label)})</option>
          <option value="thisyear" ${o.period === 'thisyear' ? 'selected' : ''}>This calendar year</option>
          <option value="custom" ${o.period === 'custom' ? 'selected' : ''}>Custom dates…</option>
        </select>
      </label>
      <div class="form-row" id="print-custom" ${o.period === 'custom' ? '' : 'hidden'}>
        <label class="field">From <input type="date" name="from" value="${esc(o.from)}"></label>
        <label class="field">To <input type="date" name="to" value="${esc(o.to)}"></label>
      </div>
    </div>
    <div class="form-row">
      <label class="field">Heading note (optional)
        <input name="title" value="${esc(o.title)}" maxlength="120" placeholder="e.g. For the accountant, FY 2025-26">
      </label>
      <label class="check" style="align-self:end"><input type="checkbox" name="comments" ${o.comments === '1' ? 'checked' : ''}> Include the comments on transactions</label>
    </div>
    <p class="hint">The report opens as a preview on the next screen. Print it from there, or choose <b>Save as PDF</b> in the print dialog to get a file. Prices are the ones the app holds now; refresh them first if you want today's.</p>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">Preview</button>
    </div>
  </form>`, { wide: true });
  const form = modal.querySelector('#print-form');
  const portfolioOpts = modal.querySelector('#print-portfolio-opts');
  const fundSel = form.elements.fund;
  const applyScope = () => {
    const fundScope = form.elements.scope.value === 'fund';
    portfolioOpts.hidden = fundScope;
    fundSel.disabled = !fundScope;
    modal.querySelector('[data-section="allocation"]').hidden = fundScope;
  };
  form.querySelectorAll('input[name="scope"]').forEach((r) => r.addEventListener('change', applyScope));
  applyScope();
  form.elements.period.addEventListener('change', () => { modal.querySelector('#print-custom').hidden = form.elements.period.value !== 'custom'; });
  modal.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    const p = PRESETS[b.dataset.preset];
    form.querySelectorAll('input[name="section"]').forEach((c) => { c.checked = p.keys.includes(c.value); });
    if (p.period) { form.elements.period.value = p.period; modal.querySelector('#print-custom').hidden = true; }
  }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const sections = fd.getAll('section');
    if (!sections.length) { toast('Tick at least one section', 'warn'); return; }
    const kinds = fd.getAll('kind');
    const opts = {
      scope: String(fd.get('scope')),
      fund: String(fd.get('fund') || o.fund),
      status: String(fd.get('status') || 'active'),
      kinds: kinds.length === kindsPresent.length ? 'all' : kinds.join(','),
      sections: sections.join(','),
      period: String(fd.get('period')),
      from: String(fd.get('from') || ''),
      to: String(fd.get('to') || ''),
      comments: fd.get('comments') ? '1' : '0',
      title: String(fd.get('title') || '').trim(),
    };
    if (opts.scope === 'portfolio' && opts.kinds === '') { toast('Tick at least one asset class', 'warn'); return; }
    try { localStorage.setItem('printOptions', JSON.stringify(opts)); } catch { /* storage unavailable */ }
    closeModal();
    const next = `#/print?${encodeOptions(opts)}`;
    if (location.hash === next) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = next;
  });
}

// ---------------------------------------------------------------- the report

/** The #/print route: fetch what the chosen sections need, lay them out, then turn the charts into pictures. */
export async function renderPrintPage(qs) {
  const o = parseOptions(qs);
  const root = document.getElementById('app');
  root.innerHTML = `${toolbarHtml(o)}<div class="print-report"><p class="empty">Preparing the report…</p></div>`;
  wireToolbar(root, o);
  const portfolio = await api.get('/api/portfolio');
  const base = portfolio.base_currency || 'INR';
  const sections = new Set(o.sections.split(',').filter(Boolean));
  const period = periodOf(o);
  let rows = portfolio.funds || [];
  if (o.scope === 'fund') rows = rows.filter((f) => String(f.id) === o.fund);
  else {
    if (o.status === 'active') rows = rows.filter((f) => !f.closed);
    else if (o.status === 'closed') rows = rows.filter((f) => f.closed);
    if (o.kinds !== 'all') { const ks = new Set(o.kinds.split(',')); rows = rows.filter((f) => ks.has(f.kind || 'MF')); }
  }
  rows = [...rows].sort(byClassThenName);
  const needDetail = ['folios', 'details', 'transactions', 'income'].some((k) => sections.has(k)) || (sections.has('charts') && o.scope === 'fund');
  const detail = {};
  if (needDetail && rows.length) {
    const got = await Promise.all(rows.map((f) => api.get(`/api/funds/${f.id}`).catch(() => null)));
    rows.forEach((f, i) => { if (got[i]) detail[f.id] = got[i]; });
  }
  const ctx = { o, portfolio, base, rows, detail, period, sections, comments: o.comments === '1' };
  const asOf = rows.map((f) => f.summary?.latest_nav_date).filter(Boolean).sort().pop();
  const single = o.scope === 'fund' ? rows[0] : null;
  const scopeText = single ? `${esc(single.name)}` : `Portfolio${o.status === 'closed' ? ' · closed holdings' : o.status === 'all' ? ' · active and closed holdings' : ''}${o.kinds !== 'all' ? ` · ${o.kinds.split(',').map((k) => classOf(k).label).join(', ')}` : ''}`;
  const periodUsed = sections.has('transactions') || sections.has('income');
  const parts = [];
  if (!rows.length) parts.push('<p class="empty">Nothing matches this choice of holdings.</p>');
  else {
    if (sections.has('summary')) parts.push(single ? fundSummary(single, detail[single.id], ctx) : portfolioSummary(ctx));
    if (sections.has('allocation') && !single) parts.push(allocationSection(ctx));
    if (sections.has('holdings')) parts.push(holdingsSection(ctx));
    if (sections.has('folios')) parts.push(foliosSection(ctx));
    if (sections.has('details')) parts.push(detailsSection(ctx));
    if (sections.has('income')) parts.push(incomeSection(ctx));
    if (sections.has('transactions')) parts.push(transactionsSection(ctx));
    if (sections.has('upcoming')) parts.push(upcomingSection(ctx));
    if (sections.has('charts')) parts.push(chartsSection(ctx));
  }
  root.querySelector('.print-report').innerHTML = `
    <div class="print-head">
      <div class="print-app">Investment Tracker</div>
      <h1>${scopeText}</h1>
      <div class="meta">Printed ${fmtDate(todayISO())}${asOf ? ` · prices as of ${fmtDate(asOf)}` : ''} · ${single ? `${kindOf(single).label.toLowerCase()}${single.currency && single.currency !== base ? ` · figures in ${esc(single.currency)}` : ''}` : `${rows.length} holding${rows.length === 1 ? '' : 's'} · figures in ${esc(base)}`}${periodUsed ? ` · period: ${esc(period.label)}` : ''}</div>
      ${o.title ? `<div class="print-title">${esc(o.title)}</div>` : ''}
    </div>
    ${parts.join('')}
    <div class="print-foot small">Every figure comes from the entries you recorded and the prices the app fetched; nothing here is advice. XIRR is the annualised return with each cashflow on its own date.</div>`;
  await drawCharts(root, ctx);
}

function toolbarHtml(o) {
  return `
    <div class="print-toolbar" role="toolbar" aria-label="Print">
      <button type="button" class="btn ghost small" id="print-back">← Back</button>
      <span class="muted small">Preview · what you see is what prints</span>
      <span class="spacer"></span>
      <button type="button" class="btn ghost small" id="print-change">Change what is printed…</button>
      <button type="button" class="btn primary small" id="print-go" title="Opens the print dialog; choose Save as PDF there for a file">Print / save as PDF</button>
    </div>`;
}

function wireToolbar(root, o) {
  root.querySelector('#print-back').addEventListener('click', () => {
    location.hash = o.scope === 'fund' ? `#/fund/${o.fund}` : '#/'; // back to the page the report came from, however many previews were made
  });
  root.querySelector('#print-change').addEventListener('click', () => openPrintModal({ current: o }));
  root.querySelector('#print-go').addEventListener('click', doPrint);
}

const section = (title, body, sub = '') => `<section class="print-section"><h2>${title}${sub ? ` <span class="small">${sub}</span>` : ''}</h2>${body}</section>`;
const tile = (l, v, s = '') => `<div class="tile-print"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
const statusText = (f) => (f.closed ? `Closed${f.closed_on ? ` ${fmtDate(f.closed_on)}` : ''}` : f.locked ? `Locked${f.lock_in_until ? ` till ${fmtDate(f.lock_in_until)}` : ''}` : 'Open');
const folioText = (f, d) => {
  const k = kindOf(f);
  if (d?.folios?.length > 1) return `${k.folioPlural}: ${d.folios.map((p) => esc(p.label)).join(', ')}`;
  return f.folio_count > 1 ? `${f.folio_count} ${k.folioPlural}` : f.folio_number ? `${k.folio} ${esc(f.folio_number)}` : '';
};

function portfolioSummary({ rows, portfolio, base, o }) {
  const sums = rows.map(inr).filter(Boolean);
  const active = rows.filter((f) => !f.closed);
  const invested = sum(sums, (s) => s.invested);
  const value = sum(sums, (s) => s.current_value);
  const realised = sum(sums, (s) => s.realised_gain);
  const dividends = sum(sums, (s) => s.dividends);
  const whole = o.status === 'active' && o.kinds === 'all';
  const t = portfolio.totals || {};
  const locked = sum(active.filter((f) => f.locked).map(inr).filter(Boolean), (s) => s.current_value);
  return section('Summary', `<div class="tiles-print">
    ${tile('Current value', M(value, base), `${active.length} active holding${active.length === 1 ? '' : 's'}${rows.length > active.length ? ` · ${rows.length - active.length} closed` : ''}`)}
    ${tile('Invested', M(invested, base), 'cost of what is held (FIFO)')}
    ${tile('Unrealised profit', delta(value - invested, base), invested ? `${fmtPct(((value - invested) / invested) * 100)} absolute` : '')}
    ${tile('Realised gains', M(realised, base), 'from sales, payouts and closures')}
    ${tile('Dividends and interest received', M(dividends, base), 'cash paid out to you')}
    ${tile('XIRR', whole ? pct(t.xirr) : '–', whole ? 'annualised, all holdings' : 'shown for the whole portfolio only')}
    ${tile('Locked', M(locked, base), `${M(value - locked, base)} redeemable now`)}
  </div>`);
}

function fundSummary(f, d, { base }) {
  const x = d || f;
  const s = x.summary || f.summary || {};
  const cur = f.currency || base;
  const k = kindOf(f);
  const bs = f.needs_fx ? x.base?.summary : null;
  const rupee = f.kind === 'EPF' || f.kind === 'PPF';
  const tiles = [
    tile(rupee ? 'Balance' : 'Current value', M(s.current_value, cur), bs ? `≈ ${M(bs.current_value, base)}` : statusText(f)),
    tile(rupee ? 'Deposits' : 'Invested', M(s.invested, cur), s.redeemed ? `${M(s.purchased, cur)} in · ${M(s.redeemed, cur)} ${k.sold}` : ''),
    tile(rupee ? 'Interest credited' : 'Unrealised profit', rupee ? M(s.interest ?? s.bonus_units, cur) : delta(s.invested ? s.profit : null, cur), !rupee && isNum(s.abs_return_pct) ? `${fmtPct(s.abs_return_pct)} absolute` : ''),
    tile('Realised', M((s.realised_gain || 0) + (s.dividends || 0), cur), [s.realised_gain ? `${M(s.realised_gain, cur)} ${k.realisedWhat || 'from sales'}` : '', s.dividends ? `${M(s.dividends, cur)} ${k.dividendWord || 'dividends'}` : ''].filter(Boolean).join(' · ')),
    tile('XIRR', pct(s.xirr), bs ? `${pct(bs.xirr)} in ${esc(base)}` : 'annualised'),
    rupee ? '' : tile(`Latest ${k.price.toLowerCase()}`, isNum(s.latest_nav) ? M(s.latest_nav, cur, k.priceDecimals) : '–', s.latest_nav_date ? `as of ${fmtDate(s.latest_nav_date)} · ${fmtNum(s.units, 3)} ${k.unit} held` : ''),
  ];
  return section('Summary', `<div class="tiles-print">${tiles.join('')}</div><p class="small">${esc(k.label)} · ${folioText(f, d) || 'no folio recorded'} · ${statusText(f)}</p>`);
}

function allocationSection({ rows, base }) {
  const active = rows.filter((f) => !f.closed);
  const colors = seriesColors();
  const byKind = new Map();
  for (const f of active) {
    const s = inr(f);
    if (!s) continue;
    const kind = f.kind || 'MF';
    const e = byKind.get(kind) || { kind, count: 0, invested: 0, value: 0 };
    e.count += 1; e.invested += s.invested; e.value += Math.max(0, s.current_value);
    byKind.set(kind, e);
  }
  const parts = [...byKind.values()].sort((a, b) => classIndex(a.kind) - classIndex(b.kind));
  const total = sum(parts, (p) => p.value);
  if (!parts.length) return section('Allocation', '<p class="small">No active holdings.</p>');
  const ringParts = parts.map((p) => ({ label: classOf(p.kind).label, value: p.value, color: colors[classIndex(p.kind) % colors.length] }));
  const body = parts.map((p) => `<tr><td><i class="swatch" style="background:${colors[classIndex(p.kind) % colors.length]}"></i> ${esc(classOf(p.kind).label)}</td><td class="num">${p.count}</td><td class="num">${M(p.invested, base)}</td><td class="num">${M(p.value, base)}</td><td class="num">${total ? ((p.value / total) * 100).toFixed(1) : '0.0'}%</td></tr>`).join('');
  return section('Allocation by asset class', `<div class="alloc-print">
    <div class="print-ring" data-chart="allocation" data-parts="${esc(JSON.stringify(ringParts))}" aria-label="Allocation ring"></div>
    <table><thead><tr><th>Class</th><th class="num">Holdings</th><th class="num">Invested</th><th class="num">Current value</th><th class="num">Share</th></tr></thead><tbody>${body}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${sum(parts, (p) => p.count)}</td><td class="num">${M(sum(parts, (p) => p.invested), base)}</td><td class="num">${M(total, base)}</td><td class="num">100%</td></tr></tfoot></table>
  </div>`, 'active holdings, by current value');
}

function holdingsSection({ rows, base, detail }) {
  const active = rows.filter((f) => !f.closed);
  const closed = rows.filter((f) => f.closed);
  const group = (list, rowHtml) => {
    const kinds = [...new Set(list.map((f) => f.kind || 'MF'))].sort((a, b) => classIndex(a) - classIndex(b));
    return kinds.map((kind) => `<tr class="subhead"><td colspan="8">${esc(classOf(kind).label)}</td></tr>${list.filter((f) => (f.kind || 'MF') === kind).map(rowHtml).join('')}`).join('');
  };
  const nameCell = (f) => `<td><b>${esc(f.name)}</b><div class="small">${[folioText(f, detail[f.id]), f.needs_fx ? `in ${esc(f.currency)}` : ''].filter(Boolean).join(' · ')}</div></td>`;
  const activeRows = group(active, (f) => {
    const s = inr(f); const n = f.summary || {}; const k = kindOf(f); const cur = f.currency || base;
    return `<tr>${nameCell(f)}<td>${statusText(f)}</td><td class="num">${s ? M(s.invested, base) : '–'}</td><td class="num">${s ? M(s.current_value, base) : '–'}</td><td class="num">${s ? delta(s.invested ? s.profit : null, base) : '–'}<div class="small">${s && isNum(s.abs_return_pct) ? fmtPct(s.abs_return_pct) : ''}</div></td><td class="num">${pct(s?.xirr)}</td><td class="num small">${isNum(n.latest_nav) && !(f.kind === 'EPF' || f.kind === 'PPF') ? `${M(n.latest_nav, cur, k.priceDecimals)}<br>${fmtDate(n.latest_nav_date)}` : ''}</td></tr>`;
  });
  const closedRows = group(closed, (f) => {
    const s = inr(f);
    return `<tr>${nameCell(f)}<td>${statusText(f)}</td><td class="num">${s ? M(s.purchased, base) : '–'}</td><td class="num">${s ? M(s.redeemed, base) : '–'}</td><td class="num">${s ? delta(s.realised_total, base) : '–'}<div class="small">${s?.dividends ? `incl. ${M(s.dividends, base)} dividends` : ''}</div></td><td class="num">${pct(s?.xirr)}</td><td></td></tr>`;
  });
  const sums = active.map(inr).filter(Boolean);
  const inv = sum(sums, (s) => s.invested); const val = sum(sums, (s) => s.current_value);
  const activeTable = active.length ? `<table><thead><tr><th>Holding</th><th>Status</th><th class="num">Invested</th><th class="num">Current value</th><th class="num">P&amp;L</th><th class="num">XIRR</th><th class="num">Latest price</th></tr></thead>
    <tbody>${activeRows}</tbody><tfoot><tr><td colspan="2">Total (${active.length})</td><td class="num">${M(inv, base)}</td><td class="num">${M(val, base)}</td><td class="num">${delta(val - inv, base)}</td><td colspan="2"></td></tr></tfoot></table>` : '';
  const closedTable = closed.length ? `<h3>Closed holdings</h3><table><thead><tr><th>Holding</th><th>Closed</th><th class="num">Bought</th><th class="num">Sold for</th><th class="num">Realised</th><th class="num">XIRR</th><th></th></tr></thead><tbody>${closedRows}</tbody></table>` : '';
  return section('Holdings', activeTable + closedTable, `figures in ${esc(base)}`);
}

function foliosSection({ rows, detail, base }) {
  const blocks = rows.map((f) => {
    const d = detail[f.id];
    if (!d) return '';
    const k = kindOf(f); const cur = f.currency || base;
    const parts = f.kind === 'NPS' || f.kind === 'EPF' ? (d.schemes || []).map((p) => ({ label: f.kind === 'EPF' ? p.name : `Scheme ${p.scheme}`, s: p.summary })) : (d.folios || []).map((p) => ({ label: p.label, s: p.summary }));
    if (parts.length < 2) return '';
    const unitHead = f.kind === 'EPF' || f.kind === 'PPF' ? null : k.unit[0].toUpperCase() + k.unit.slice(1);
    const body = parts.map((p) => `<tr><td>${esc(p.label)}</td><td class="num">${p.s.txn_count ?? ''}</td><td class="num">${M(p.s.invested, cur)}</td>${unitHead ? `<td class="num">${fmtNum(p.s.units, 3)}</td>` : ''}<td class="num">${M(p.s.current_value, cur)}</td><td class="num">${delta(p.s.invested ? p.s.profit : null, cur)}</td><td class="num">${pct(p.s.xirr)}</td></tr>`).join('');
    const t = d.folios_total || d.schemes_total || d.summary;
    return `<div class="holding-block"><h3>${esc(f.name)} <span class="small">${esc(k.label)}${f.needs_fx ? ` · in ${esc(cur)}` : ''}</span></h3>
      <table><thead><tr><th>${f.kind === 'NPS' ? 'Scheme' : f.kind === 'EPF' ? 'Share' : k.folio}</th><th class="num">Entries</th><th class="num">Invested</th>${unitHead ? `<th class="num">${unitHead}</th>` : ''}<th class="num">Current value</th><th class="num">P&amp;L</th><th class="num">XIRR</th></tr></thead>
      <tbody>${body}</tbody>${t ? `<tfoot><tr><td>All</td><td class="num">${t.txn_count ?? ''}</td><td class="num">${M(t.invested, cur)}</td>${unitHead ? `<td class="num">${fmtNum(t.units, 3)}</td>` : ''}<td class="num">${M(t.current_value, cur)}</td><td class="num">${delta(t.invested ? t.profit : null, cur)}</td><td class="num">${pct(t.xirr)}</td></tr></tfoot>` : ''}</table></div>`;
  }).filter(Boolean);
  return section('Folio-wise breakdown', blocks.length ? blocks.join('') : '<p class="small">No holding here spans more than one folio, account, scheme or share.</p>');
}

function detailRows(f, d, base) {
  const k = kindOf(f); const x = d || f; const det = f.details || {}; const cur = f.currency || base; const out = [];
  const add = (l, v) => { if (v !== undefined && v !== null && v !== '') out.push([l, v]); };
  add('Kind', k.label);
  add(f.folio_count > 1 ? k.folioPlural[0].toUpperCase() + k.folioPlural.slice(1) : k.folio, d?.folios?.length > 1 ? d.folios.map((p) => esc(p.label)).join(', ') : esc(f.folio_number || ''));
  add('Status', statusText(f));
  switch (f.kind) {
    case 'STOCK': add('Symbol', esc([f.symbol, f.exchange].filter(Boolean).join(' · '))); add('Currency', esc(f.currency)); add('Company', esc(x.quote?.name || '')); break;
    case 'NPS': add('Pension fund manager', esc(det.pfm || '')); add('Tier', esc(det.tier || '')); add('Schemes', Object.keys(det.schemes || {}).join(', ')); break;
    case 'EPF': add('Employer', esc(det.employer || '')); add('Interest pending', x.epf?.pending_interest_fy ? `FY ${esc(x.epf.pending_interest_fy)} not yet entered` : null); break;
    case 'PPF': add('Bank / post office', esc(det.bank || '')); add('Opened', x.ppf?.opened_on ? fmtDate(x.ppf.opened_on) : null); add('Matures', x.ppf?.matures_on ? fmtDate(x.ppf.matures_on) : null); add('Extended till', x.ppf?.extended_till ? fmtDate(x.ppf.extended_till) : null); break;
    case 'GOLD': { const g = x.gold || {};
      add('Series', esc(det.series || '')); add('NSE code', esc(det.code || '')); add('Issue date', g.issue_date ? fmtDate(g.issue_date) : null);
      add('Issue price', isNum(det.issue_price) ? `${M(det.issue_price, cur, 2)} per gram` : null);
      add('Interest', isNum(g.interest_per_payment) ? `${M(g.interest_per_payment, cur, 2)} every six months${g.next_interest ? ` · next ${fmtDate(g.next_interest)}` : ''}` : null);
      add('Early redemption', g.exit_from ? `from ${fmtDate(g.exit_from)}` : null); add('Maturity', g.maturity ? fmtDate(g.maturity) : null);
      add('Price', isNum(g.price) ? `${M(g.price, cur, 2)} per gram as of ${fmtDate(g.price_date)}` : null); break; }
    case 'FD': { const t = x.fd || {};
      add('Bank', esc(det.bank || '')); add('Deposited', t.deposit_date ? `${M(t.principal, cur)} on ${fmtDate(t.deposit_date)}` : null);
      add('Matures', t.maturity_date ? fmtDate(t.maturity_date) : null); add('Maturity value', isNum(t.maturity_value) ? M(t.maturity_value, cur) : null);
      add('Rate', isNum(t.effective_rate) ? `${fmtPct(t.effective_rate * 100)} a year effective${isNum(t.quoted_rate) ? ` · ${t.quoted_rate}% quoted` : ''}` : isNum(t.quoted_rate) ? `${t.quoted_rate}% quoted` : null);
      add('Interest', t.payout === 'periodic' ? 'paid out periodically' : 'cumulative'); break; }
    case 'INS': { const p = x.policy || {};
      add('Insurer', esc(det.insurer || '')); add('Plan', esc(det.plan || '')); add('Premium', p.premium ? `${M(p.premium, cur)} ${esc(p.frequency || 'yearly')}` : null);
      add('Premiums', isNum(p.premiums_total) ? `${p.premiums_paid} paid of ${p.premiums_total} · ${M(p.paid_total, cur)} paid · ${M(p.pending_total, cur)} still to come` : `${p.premiums_paid || 0} paid`);
      add('First premium', p.first_premium ? fmtDate(p.first_premium) : null); add('Last premium', p.last_premium ? fmtDate(p.last_premium) : null);
      add('Next due', p.next_due ? `${fmtDate(p.next_due)}${p.overdue ? ` · ${p.overdue} not yet recorded` : ''}` : null);
      add('Matures', p.maturity_date ? fmtDate(p.maturity_date) : null); add('Maturity value', isNum(p.maturity_value) ? M(p.maturity_value, cur) : null);
      add('Policy return', isNum(p.policy_rate) ? `${fmtPct(p.policy_rate * 100)} a year` : null); add('Sum assured', isNum(p.sum_assured) ? M(p.sum_assured, cur) : null); break; }
    default: add('AMFI scheme code', f.scheme_code); add('Scheme', esc(x.scheme?.scheme_name || '')); add('Fund house', esc(x.scheme?.fund_house || '')); add('Category', esc(x.scheme?.scheme_category || ''));
  }
  if (f.notes) add('Notes', esc(f.notes));
  return out;
}

function detailsSection({ rows, detail, base }) {
  const blocks = rows.map((f) => `<div class="holding-block"><h3>${esc(f.name)}</h3><dl>${detailRows(f, detail[f.id], base).map(([l, v]) => `<dt>${l}</dt><dd>${v}</dd>`).join('')}</dl></div>`);
  return section('Holding details', `<div class="details-grid">${blocks.join('')}</div>`);
}

function incomeSection({ rows, detail, period, base }) {
  const lines = []; const totals = { dividends: 0, interest: 0, sold: 0, gain: 0, charges: 0 }; let foreign = 0;
  for (const f of rows) {
    const d = detail[f.id]; if (!d) continue;
    const cur = f.currency || base; const rupee = f.kind === 'EPF' || f.kind === 'PPF';
    const tx = (d.transactions || []).filter(inPeriod(period));
    const line = {
      dividends: sum(tx.filter((t) => t.type === 'DIVIDEND')),
      interest: rupee ? sum(tx.filter((t) => t.type === 'BONUS'), (t) => t.units) : 0,
      sold: sum(tx.filter((t) => t.type === 'REDEMPTION')),
      gain: sum(tx.filter((t) => SELLS.has(t.type)), (t) => t.gain),
      charges: sum(tx.filter((t) => t.type === 'CHARGE')),
    };
    if (!Object.values(line).some((v) => v)) continue;
    if (cur === base) for (const k of Object.keys(totals)) totals[k] += line[k]; else foreign += 1;
    lines.push(`<tr><td><b>${esc(f.name)}</b><div class="small">${esc(kindOf(f).label)}${cur !== base ? ` · in ${esc(cur)}, not in the total` : ''}</div></td><td class="num">${line.dividends ? M(line.dividends, cur, 2) : ''}</td><td class="num">${line.interest ? M(line.interest, cur, 2) : ''}</td><td class="num">${line.sold ? M(line.sold, cur, 2) : ''}</td><td class="num">${line.sold || line.gain ? delta(line.gain, cur) : ''}</td><td class="num">${line.charges ? M(line.charges, cur, 2) : ''}</td></tr>`);
  }
  if (!lines.length) return section('Income and realised gains', `<p class="small">Nothing received, sold or credited in this period (${esc(period.label)}).</p>`);
  return section('Income and realised gains', `<table><thead><tr><th>Holding</th><th class="num">Dividends / interest received</th><th class="num">Interest credited (EPF, PPF)</th><th class="num">Sale and payout proceeds</th><th class="num">Realised gain</th><th class="num">Charges</th></tr></thead>
    <tbody>${lines.join('')}</tbody><tfoot><tr><td>Total in ${esc(base)}${foreign ? ` (${foreign} holding${foreign === 1 ? '' : 's'} in other currencies left out)` : ''}</td><td class="num">${M(totals.dividends, base, 2)}</td><td class="num">${M(totals.interest, base, 2)}</td><td class="num">${M(totals.sold, base, 2)}</td><td class="num">${delta(totals.gain, base)}</td><td class="num">${M(totals.charges, base, 2)}</td></tr></tfoot></table>
    <p class="small">Realised gain is each sale's proceeds less the cost of the units sold, oldest units first (FIFO). Dividends and interest received are cash; interest credited to EPF and PPF stays in the account.</p>`, esc(period.label));
}

function txnTable(f, d, period, comments, base) {
  const k = kindOf(f); const cur = f.currency || base;
  const txns = (d.transactions || []).filter(inPeriod(period)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));
  if (!txns.length) return '<p class="small">No transactions in this period.</p>';
  const rupee = f.kind === 'EPF' || f.kind === 'PPF'; const term = f.kind === 'FD' || f.kind === 'INS'; const nps = f.kind === 'NPS';
  const shareName = (s) => ({ EE: 'Employee', ER: 'Employer', EPS: 'Pension' }[s] || s || '');
  const hasGain = txns.some((t) => SELLS.has(t.type) && isNum(t.gain));
  const cols = [
    { h: 'Date', c: (t) => fmtDate(t.date) },
    nps ? { h: 'Scheme', c: (t) => esc(t.scheme || '') } : f.kind === 'EPF' ? { h: 'Share', c: (t) => shareName(t.scheme) } : rupee || term ? null : { h: k.folio, c: (t) => esc(t.folio_number || '') },
    { h: 'Type', c: (t) => esc(k.types[t.type] || t.type) },
    { h: `Amount (${esc(cur)})`, num: true, c: (t) => (t.type === 'BONUS' ? (rupee ? M(t.units, cur, 2) : '–') : M(t.amount, cur, 2)) },
    rupee ? { h: 'Rate %', num: true, c: (t) => (isNum(t.rate) ? `${t.rate}%` : '') } : term ? null : { h: k.price, num: true, c: (t) => (t.nav > 0 ? fmtNum(t.nav, k.priceDecimals) : '') },
    rupee || term ? null : { h: k.unit[0].toUpperCase() + k.unit.slice(1), num: true, c: (t) => (t.type === 'DIVIDEND' ? '' : `${SELLS.has(t.type) ? '−' : t.type === 'BONUS' || t.type === 'SWITCH_IN' ? '+' : ''}${fmtNum(t.units, 4)}`) },
    hasGain ? { h: 'Gain', num: true, c: (t) => (SELLS.has(t.type) && isNum(t.gain) ? delta(t.gain, cur) : '') } : null,
    comments ? { h: 'Comment', c: (t) => esc(t.notes || '') } : null,
  ].filter(Boolean);
  const body = txns.map((t) => `<tr>${cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.c(t)}</td>`).join('')}</tr>`).join('');
  const bought = sum(txns.filter((t) => t.type === 'SIP' || t.type === 'LUMPSUM'));
  const sold = sum(txns.filter((t) => t.type === 'REDEMPTION'));
  const div = sum(txns.filter((t) => t.type === 'DIVIDEND'));
  const credited = rupee ? sum(txns.filter((t) => t.type === 'BONUS'), (t) => t.units) : 0;
  const foot = [bought ? `${M(bought, cur, 2)} ${rupee ? 'deposited' : term ? 'paid in' : 'bought'}` : '', sold ? `${M(sold, cur, 2)} ${k.sold}` : '', div ? `${M(div, cur, 2)} ${k.dividendWord || 'dividends'}` : '', credited ? `${M(credited, cur, 2)} interest credited` : ''].filter(Boolean).join(' · ');
  return `<table><thead><tr>${cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${c.h}</th>`).join('')}</tr></thead><tbody>${body}</tbody>
    <tfoot><tr><td colspan="${cols.length}">${txns.length} transaction${txns.length === 1 ? '' : 's'}${foot ? ` · ${foot}` : ''}</td></tr></tfoot></table>`;
}

function transactionsSection({ rows, detail, period, comments, base }) {
  const blocks = rows.map((f) => {
    const d = detail[f.id];
    if (!d) return '';
    return `<div class="txn-block"><h3>${esc(f.name)} <span class="small">${esc(kindOf(f).label)}${folioText(f, d) ? ` · ${folioText(f, d)}` : ''}${f.needs_fx ? ` · in ${esc(f.currency)}` : ''}</span></h3>${txnTable(f, d, period, comments, base)}</div>`;
  });
  return section('Transactions', blocks.join(''), esc(period.label));
}

function upcomingSection({ rows, base }) {
  const today = todayISO(); const out = [];
  for (const f of rows) {
    if (f.closed) continue;
    const cur = f.currency || base;
    const add = (date, what, amount, overdue = false) => { if (date) out.push({ date, name: f.name, what, amount: isNum(amount) ? M(amount, cur) : '', overdue }); };
    if (f.fd?.maturity_date) add(f.fd.maturity_date, f.fd.awaiting_payout ? 'Deposit matured · payout to record' : 'Deposit matures', f.fd.maturity_value, Boolean(f.fd.awaiting_payout));
    if (f.policy?.next_due) add(f.policy.next_due, f.policy.overdue ? `Premium due · ${f.policy.overdue} not yet recorded` : 'Premium due', f.policy.premium, Boolean(f.policy.overdue));
    if (f.policy?.maturity_date) add(f.policy.maturity_date, f.policy.awaiting_payout ? 'Policy matured · payout to record' : 'Policy matures', f.policy.maturity_value, Boolean(f.policy.awaiting_payout));
    if (f.gold?.next_interest) add(f.gold.next_interest, 'Bond interest due', f.gold.interest_per_payment);
    if (f.gold?.exit_from && f.gold.exit_from >= today) add(f.gold.exit_from, 'Early redemption opens');
    if (f.gold?.maturity) add(f.gold.maturity, 'Bond matures');
    if (f.ppf?.matures_on) add(f.ppf.extended_till || f.ppf.matures_on, f.ppf.extended_till ? 'PPF extension ends' : 'PPF matures');
    if (f.epf?.pending_interest_fy) add(today, `EPF interest for FY ${f.epf.pending_interest_fy} to enter`, null, true);
    for (const x of f.sips?.pending || []) add(x.date, 'SIP instalment due, not recorded', x.amount, true);
    for (const sch of f.sips?.schedules || []) if (sch.next_due) add(sch.next_due, `SIP instalment (${sch.every})`, sch.amount);
    if (f.lock_in_until && !f.fd && !f.policy && !f.gold && !f.ppf) add(f.lock_in_until, 'Lock-in ends');
  }
  const list = out.filter((x) => x.overdue || x.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  if (!list.length) return section('Upcoming dates', '<p class="small">Nothing scheduled for these holdings.</p>');
  return section('Upcoming dates', `<table><thead><tr><th>Date</th><th>Holding</th><th>What</th><th class="num">Amount</th></tr></thead><tbody>${list.map((x) => `<tr${x.overdue ? ' class="overdue"' : ''}><td>${fmtDate(x.date)}${x.overdue ? ' <span class="small">(overdue)</span>' : ''}</td><td>${esc(x.name)}</td><td>${esc(x.what)}</td><td class="num">${x.amount}</td></tr>`).join('')}</tbody></table>`);
}

function chartsSection({ o, rows, base }) {
  if (o.scope === 'fund' && rows[0]) {
    const f = rows[0];
    return section('Value over time', `<div class="print-chart" data-chart="value" data-fund="${f.id}" data-currency="${esc(f.currency || base)}" aria-label="Value over time"></div>`, `${esc(f.name)}${f.needs_fx ? ` · in ${esc(f.currency)}` : ''}`);
  }
  return section('Value over time', '<div class="print-chart" data-chart="value" aria-label="Portfolio value over time"></div>', `whole portfolio · in ${esc(base)}`);
}

/** Render each chart placeholder with Chart.js, then keep only a picture of it (pictures print reliably everywhere). */
async function drawCharts(root, { portfolio, detail, base }) {
  for (const el of root.querySelectorAll('[data-chart]')) {
    if (!window.Chart) { el.innerHTML = '<p class="small">The chart library did not load.</p>'; continue; }
    const canvas = document.createElement('canvas');
    el.appendChild(canvas);
    let chart = null;
    try {
      if (el.dataset.chart === 'value') {
        const hist = el.dataset.fund ? detail[el.dataset.fund]?.history : portfolio.history;
        if (!hist?.length) { el.innerHTML = '<p class="small">No history yet.</p>'; continue; }
        chart = valueChart(canvas, hist, { currency: el.dataset.currency || base });
      } else {
        chart = donutChart(canvas, JSON.parse(el.dataset.parts), { currency: base, centreLabel: 'current value' });
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const img = document.createElement('img');
      img.src = chart.toBase64Image('image/png', 1);
      img.alt = el.getAttribute('aria-label') || 'chart';
      el.innerHTML = '';
      el.appendChild(img);
    } catch (e) {
      el.innerHTML = `<p class="small">Chart could not be drawn: ${esc(e.message)}</p>`;
    } finally {
      chart?.destroy();
    }
  }
}
