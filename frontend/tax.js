// Capital gains and tax: the #/tax page for one financial year. The numbers come from /api/tax (backend/tax.py),
// which matches every sale to the units it sold oldest-first, sorts each piece into its section of the Income-tax
// Act by the holding's tax class and the dates, nets the sections, sets losses off, applies the equity exemption and
// estimates the tax, with the dividends, interest and payouts of the year alongside. The user's slab rate is kept
// on this device; the Print button hands the same report to the print view.

import { api } from './api.js';
import { fmtMoney, fmtNum, fmtDate, esc, isNum } from './format.js';
import { KINDS } from './app.js';

export const SLABS = [0, 5, 10, 15, 20, 25, 30];
const SLAB_KEY = 'taxSlab';

export function savedSlab() {
  try { const raw = localStorage.getItem(SLAB_KEY); const v = Number(raw); return raw !== null && SLABS.includes(v) ? v : 30; } catch { return 30; }
}
function saveSlab(v) {
  try { localStorage.setItem(SLAB_KEY, String(v)); } catch { /* private window: the choice lasts for this page only */ }
}

const M = (v) => (isNum(v) ? fmtMoney(v, 'INR', 0) : '–');
const signed = (v) => (!isNum(v) ? '–' : `<span class="${v < 0 ? 'down' : 'up'}">${v < 0 ? '−' : ''}${fmtMoney(Math.abs(v), 'INR')}</span>`);
const plain = (v) => (!isNum(v) ? '–' : `${v < 0 ? '−' : ''}${fmtMoney(Math.abs(v), 'INR')}`);
const rateText = (r) => (isNum(r) ? `${Number((r * 100).toFixed(1))}%` : 'slab');
const TERM = { long: ['Long-term', 'lt'], short: ['Short-term', 'st'], 'deemed-short': ['Short-term · s. 50AA', 'st'], redeemed: ['RBI redemption', 'ex'], exempt: ['Exempt', 'ex'], unknown: ['Unknown', 'st'] };
const TREAT = { slab: ['Slab rate', 'st'], exempt: ['Exempt', 'ex'], attention: ['Needs a look', 'warn'], '80C': ['80C', 'lt'], '80CCD': ['80CCD', 'lt'] };
const CLASS_SHORT = { equity: 'Equity', debt: 'Debt', other: 'Other', sgb: 'Gold bond', exempt: 'No capital gains' };
const chip = (pair) => `<span class="chip ${pair[1]}">${esc(pair[0])}</span>`;
const holding = (x) => `<a href="#/fund/${x.fund_id}">${esc(x.name)}</a>`;
const kindChip = (kind) => (kind && kind !== 'MF' ? `<span class="chip kind ${kind.toLowerCase()}">${esc((KINDS[kind] || { label: kind }).label)}</span>` : '');
const months = (ln) => (isNum(ln.months) ? `${ln.months} mo` : '–');
const tile = (label, value, sub = '') => `<div class="card tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ''}</div>`;

// ---------------------------------------------------------------- the pieces of the report (shared with the print view)

export function gainsBySectionTable(r) {
  const keys = ['111A', '112A', '112', 'slab'];
  const rows = keys.map((k) => r.buckets[k]).filter((b) => b.count || b.gains || b.losses);
  if (!rows.length) return '';
  return `<div class="table-wrap"><table class="data tax-sections">
    <thead><tr><th>Section</th><th class="num">Gains</th><th class="num">Losses</th><th class="num col-opt">Set off</th><th class="num col-opt">Exemption</th><th class="num">Taxable</th><th class="num">Rate</th><th class="num">Tax</th></tr></thead>
    <tbody>${rows.map((b) => `<tr><td>${esc(b.label)}</td><td class="num">${M(b.gains)}</td><td class="num">${b.losses ? plain(b.losses) : '–'}</td><td class="num col-opt">${b.set_off ? `−${M(b.set_off)}` : '–'}</td><td class="num col-opt">${b.exemption ? `−${M(b.exemption)}` : '–'}</td><td class="num">${M(b.taxable)}</td><td class="num">${rateText(b.rate)}</td><td class="num">${M(b.tax)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Tax on capital gains</td><td class="num">${M(rows.reduce((s, b) => s + b.gains, 0))}</td><td class="num">${plain(rows.reduce((s, b) => s + b.losses, 0)) || '–'}</td><td class="num col-opt"></td><td class="num col-opt"></td><td class="num">${M(rows.reduce((s, b) => s + b.taxable, 0))}</td><td></td><td class="num">${M(r.estimate.tax_on_gains)}</td></tr></tfoot>
  </table></div>`;
}

export function linesTable(r, { comments = true } = {}) {
  if (!r.lines.length) return `<p class="empty small">No sale, redemption or switch-out in FY ${esc(r.fy)}.</p>`;
  return `<div class="table-wrap"><table class="data tax-lines">
    <thead><tr><th>Sold</th><th>Holding</th><th class="col-opt">Bought</th><th class="num col-opt">Units</th><th class="col-opt">Held</th><th>Term</th><th class="num">Proceeds</th><th class="num col-opt">Cost</th><th class="num">Gain</th><th class="num">Taxable</th><th>Section</th><th class="num">Rate</th></tr></thead>
    <tbody>${r.lines.map((ln) => `<tr>
      <td class="nowrap">${fmtDate(ln.sale_date)}</td>
      <td>${kindChip(ln.kind)}${holding(ln)}${ln.scheme ? ` <span class="muted small">· ${esc(ln.scheme)}</span>` : ''}${comments && ln.note ? `<div class="muted small">${esc(ln.note)}</div>` : ''}</td>
      <td class="nowrap col-opt">${ln.buy_date ? fmtDate(ln.buy_date) : '–'}</td>
      <td class="num col-opt">${fmtNum(ln.units, 3)}</td>
      <td class="nowrap col-opt">${months(ln)}</td>
      <td>${chip(TERM[ln.term] || TERM.unknown)}</td>
      <td class="num">${M(ln.proceeds)}</td>
      <td class="num col-opt">${M(ln.cost)}</td>
      <td class="num">${signed(ln.gain)}</td>
      <td class="num">${ln.section === 'exempt' ? '<span class="muted">exempt</span>' : signed(ln.taxable_gain)}</td>
      <td class="nowrap">${ln.section === 'slab' ? 'slab' : ln.section === 'exempt' ? '47(viic)' : ln.section}</td>
      <td class="num">${ln.section === 'exempt' ? '–' : rateText(ln.rate)}</td>
    </tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="6">${r.lines.length} piece${r.lines.length === 1 ? '' : 's'} of ${new Set(r.lines.map((l) => l.sale_id)).size} sale${new Set(r.lines.map((l) => l.sale_id)).size === 1 ? '' : 's'}</td><td class="num">${M(r.totals.proceeds)}</td><td class="num col-opt">${M(r.totals.cost)}</td><td class="num">${signed(r.totals.gain)}</td><td colspan="3"></td></tr></tfoot>
  </table></div>`;
}

export function incomeTable(r, { comments = true } = {}) {
  if (!r.income.length) return `<p class="empty small">No dividend, interest or payout recorded in FY ${esc(r.fy)}.</p>`;
  return `<div class="table-wrap"><table class="data tax-income">
    <thead><tr><th>What</th><th>Holding</th><th class="num">Amount</th><th>Treatment</th></tr></thead>
    <tbody>${r.income.map((x) => `<tr><td>${esc(x.what)}${comments && x.note ? `<div class="muted small">${esc(x.note)}</div>` : ''}</td><td>${kindChip(x.kind)}${holding(x)}</td><td class="num">${M(x.amount)}</td><td>${chip(TREAT[x.treatment] || TREAT.attention)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="2">At the slab rate ${M(r.totals.slab_income)} · exempt ${M(r.totals.exempt_income)}${r.totals.attention_income ? ` · needing a look ${M(r.totals.attention_income)}` : ''}</td><td class="num">${M(r.totals.slab_income + r.totals.exempt_income + r.totals.attention_income)}</td><td></td></tr></tfoot>
  </table></div>`;
}

export function deductionsTable(r, { comments = true } = {}) {
  if (!r.deductions.length) return `<p class="empty small">No deposit, premium or contribution that qualifies for a deduction in FY ${esc(r.fy)}.</p>`;
  return `<div class="table-wrap"><table class="data tax-deductions">
    <thead><tr><th>What</th><th>Holding</th><th class="num">Amount</th><th>Section</th></tr></thead>
    <tbody>${r.deductions.map((x) => `<tr><td>${esc(x.what)}${comments && x.note ? `<div class="muted small">${esc(x.note)}</div>` : ''}</td><td>${kindChip(x.kind)}${holding(x)}</td><td class="num">${M(x.amount)}</td><td>${chip(TREAT[x.treatment] || TREAT['80C'])}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="2">Section 80C items ${M(r.totals.deductions_80c)} (the limit is ₹1,50,000)${r.totals.deductions_nps ? ` · NPS ${M(r.totals.deductions_nps)}` : ''}</td><td class="num">${M(r.totals.deductions_80c + r.totals.deductions_nps)}</td><td></td></tr></tfoot>
  </table></div>`;
}

export function estimateHtml(r) {
  const e = r.estimate;
  return `<div class="tax-estimate">
    <div><span class="muted">Tax on capital gains</span> ${M(e.tax_on_gains)}</div>
    <div><span class="muted">Tax on slab-rate income at ${esc(String(r.slab))}%</span> ${M(e.tax_on_income)}</div>
    <div><span class="muted">Health and education cess 4%</span> ${M(e.cess)}</div>
    <div class="total"><span>Estimated tax</span> <b>${M(e.total)}</b></div>
  </div>`;
}

export function notesHtml(r) {
  const y = Number(r.fy.slice(0, 4));
  const post = r.to >= r.rules.cutover;
  const pre = r.from < r.rules.cutover;
  return `<ul class="tax-notes small">
    <li><b>Matching.</b> Each sale is matched to the oldest units still held in that scheme or share (first in, first out), as the Act requires; the gain of each piece is its share of the sale less what those units cost.</li>
    <li><b>Equity</b> (listed shares, equity-oriented funds): long-term after 12 months. ${post ? `Short-term gains at 20% (section 111A), long-term at 12.5% on the part above the year's ₹${(r.exemption.limit / 100000).toFixed(2)} lakh exemption (section 112A)` : ''}${post && pre ? '; ' : ''}${pre ? `sales before 23 July 2024: 15% and 10%${y < 2024 ? ', exemption ₹1 lakh' : ''}` : ''}. Units bought before 1 February 2018 use the 31 January 2018 price as cost when that is higher.</li>
    <li><b>Debt funds.</b> Units bought on or after 1 April 2023 are taxed at the slab rate whatever the holding period (section 50AA). Older units: long-term after 24 months${pre ? ' (36 before 23 July 2024)' : ''}, at 12.5% without indexation${pre ? ' (20% with indexation before 23 July 2024)' : ''}; short-term at the slab rate.</li>
    <li><b>Other funds</b> (gold, silver, international, multi-asset, hybrid that is neither equity- nor debt-oriented): long-term after 24 months at 12.5%; ${y < 2025 ? 'until 31 March 2025 units bought from April 2023 fell under section 50AA (slab rate); ' : ''}short-term at the slab rate.</li>
    <li><b>Sovereign Gold Bonds.</b> Redeemed through RBI (maturity, or an interest date from the fifth year) the gain is exempt (section 47(viic)); sold on the exchange it is a listed bond: long-term after 12 months at 12.5%, short-term at the slab rate. Put the word "exchange" in the sale's comment to tell the app. The 2.5% interest is income at the slab rate.</li>
    <li><b>Losses.</b> A short-term loss is set off against any capital gain, a long-term loss only against long-term gains; what is left can be carried forward for eight years if the return is filed in time.</li>
    <li><b>Other income.</b> Dividends (IDCW), gold-bond and fixed-deposit interest and a taxable policy payout are income from other sources at your slab rate; PPF interest, EPF interest (contributions within ₹2.5 lakh a year) and a policy within section 10(10D) are exempt. NPS, EPF and PPF withdrawals follow their own rules, flagged where they need a look.</li>
    <li><b>Not included.</b> Surcharge (income above ₹50 lakh), the section 87A rebate, securities transaction tax, stamp duty and the deductions' limits. Shares in another currency are taken as unlisted abroad (24-month rule) at the exchange rate of each date. Where a year mixes rates, a section shows the weighted rate.</li>
    <li>Check the figures against Form 26AS / AIS and the capital gains statements of the fund houses (CAMS / KFintech) before filing. Nothing here is advice.</li>
  </ul>`;
}

/** The report's body for the print view: estimate, sections, the lines, other income and deductions. */
export function printBody(r, { comments = true } = {}) {
  return `
    <h3>Capital gains by section</h3>${gainsBySectionTable(r) || '<p class="empty small">No capital gains in this year.</p>'}
    ${estimateHtml(r)}
    <h3>Every sale</h3>${linesTable(r, { comments })}
    <h3>Dividends, interest and payouts</h3>${incomeTable(r, { comments })}
    <h3>Deductions</h3>${deductionsTable(r, { comments })}
    ${r.carry_forward.short_term || r.carry_forward.long_term ? `<p class="small">Loss to carry forward: short-term ${M(r.carry_forward.short_term)}, long-term ${M(r.carry_forward.long_term)}.</p>` : ''}
    <details class="small"><summary>Rules applied</summary>${notesHtml(r)}</details>`;
}

// ---------------------------------------------------------------- the page

function openPositionsTable(r) {
  if (!r.open_positions.length) return '<p class="empty small">Nothing held that capital gains tax applies to.</p>';
  return `<div class="table-wrap"><table class="data tax-open">
    <thead><tr><th>Holding</th><th>Class</th><th class="num">Short-term units</th><th class="num">Gain if sold</th><th class="num">Long-term units</th><th class="num">Gain if sold</th><th class="col-opt">Oldest short-term lot turns long-term</th></tr></thead>
    <tbody>${r.open_positions.map((u) => `<tr>
      <td>${kindChip(u.kind)}${holding(u)}</td>
      <td class="nowrap">${esc(CLASS_SHORT[u.class] || u.class)}${u.slab_only ? ' <span class="muted small">· slab rate whatever the holding period</span>' : ''}</td>
      <td class="num">${u.short.units ? `${fmtNum(u.short.units, 3)}<div class="muted small">${M(u.short.value)}</div>` : '–'}</td>
      <td class="num">${u.short.units ? signed(u.short.gain) : '–'}</td>
      <td class="num">${u.long.units ? `${fmtNum(u.long.units, 3)}<div class="muted small">${M(u.long.value)}</div>` : '–'}</td>
      <td class="num">${u.long.units ? signed(u.long.gain) : '–'}</td>
      <td class="nowrap col-opt">${u.next_long_term ? fmtDate(u.next_long_term) : u.slab_only ? 'never (section 50AA)' : '–'}</td>
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="muted small">At the latest prices, before any set-off or exemption. Equity long-term gains of up to ${M(r.exemption.left)} more would still fall inside this year's ₹${(r.exemption.limit / 100000).toFixed(2)} lakh exemption.</p>`;
}

function classesTable(r) {
  const rows = r.classes.filter((c) => c.class !== 'exempt');
  if (!rows.length) return '';
  return `<div class="table-wrap"><table class="data tax-classes">
    <thead><tr><th>Holding</th><th>Tax class</th><th>Why</th></tr></thead>
    <tbody>${rows.map((c) => `<tr><td>${kindChip(c.kind)}${holding(c)}</td><td class="nowrap">${esc(CLASS_SHORT[c.class] || c.class)}${c.source === 'chosen' ? ' <span class="chip ex">set by you</span>' : ''}</td><td class="small">${esc(c.reason)}${c.kind === 'MF' && c.source !== 'chosen' ? ' <span class="muted">· change it under Edit on the holding</span>' : ''}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function pageHtml(r) {
  const e = r.estimate;
  const b = r.buckets;
  const carry = r.carry_forward.short_term || r.carry_forward.long_term;
  return `
    <section class="card">
      <div class="card-head">
        <h2>Capital gains and tax</h2>
        <div class="head-actions tax-controls">
          <label class="small">Year <select id="tax-fy">${r.years.map((y) => `<option value="${y}" ${y === r.fy ? 'selected' : ''}>FY ${y}</option>`).join('')}</select></label>
          <label class="small" title="Your marginal income-tax rate: what the last rupee of your income is taxed at. It applies to the items taxed at the slab rate.">Slab <select id="tax-slab">${SLABS.map((s) => `<option value="${s}" ${s === r.slab ? 'selected' : ''}>${s}%</option>`).join('')}</select></label>
          <button type="button" class="btn ghost small" id="btn-tax-print">Print / save as PDF</button>
        </div>
      </div>
      <p class="muted small">${fmtDate(r.from)} to ${fmtDate(r.to)} · an estimate from the entries in the app and the prices it holds, under the rules for an individual resident in India · not advice.</p>
      ${r.warnings.map((w) => `<div class="banner warn small">${esc(w)}</div>`).join('')}
    </section>
    <div class="tiles tiles-4">
      ${tile('Estimated tax', M(e.total), `${M(e.tax_on_gains)} on gains · ${M(e.tax_on_income)} on income · ${M(e.cess)} cess`)}
      ${tile('Short-term equity gains', signed(b['111A'].net), `section 111A · tax ${M(b['111A'].tax)}`)}
      ${tile('Long-term equity gains', signed(b['112A'].net), `section 112A · exemption used ${M(r.exemption.used)} of ${M(r.exemption.limit)} · tax ${M(b['112A'].tax)}`)}
      ${tile('Other gains', signed(b['112'].net + b.slab.net), `long-term ${plain(b['112'].net)} at ${rateText(b['112'].rate ?? 0.125)} · slab-rate ${plain(b.slab.net)} · tax ${M(b['112'].tax + b.slab.tax)}`)}
      ${tile('Slab-rate income', M(r.totals.slab_income), `dividends, interest, payouts · at ${esc(String(r.slab))}% ${M(e.tax_on_income)}`)}
      ${tile('Exempt', M(r.totals.exempt_income + b.exempt.gains), `${b.exempt.gains ? `gold bond redemption ${M(b.exempt.gains)} · ` : ''}exempt income ${M(r.totals.exempt_income)}`)}
      ${carry ? tile('Loss to carry forward', M(r.carry_forward.short_term + r.carry_forward.long_term), `short-term ${M(r.carry_forward.short_term)} · long-term ${M(r.carry_forward.long_term)} · for up to eight years`) : ''}
      ${r.totals.attention_income ? tile('Needs a look', M(r.totals.attention_income), 'withdrawals or payouts whose tax depends on facts the app does not hold') : ''}
    </div>
    <section class="card">
      <div class="card-head"><h2>Capital gains by section</h2></div>
      ${gainsBySectionTable(r) || `<p class="empty small">No capital gains in FY ${esc(r.fy)}.</p>`}
      ${estimateHtml(r)}
    </section>
    <section class="card">
      <div class="card-head"><h2>Every sale</h2><span class="muted small">each sale split by the lots it took, oldest first</span></div>
      ${linesTable(r)}
    </section>
    <section class="card">
      <div class="card-head"><h2>Dividends, interest and payouts</h2></div>
      ${incomeTable(r)}
    </section>
    <section class="card">
      <div class="card-head"><h2>Deductions</h2><span class="muted small">old tax regime, except the employer's NPS share</span></div>
      ${deductionsTable(r)}
    </section>
    <section class="card">
      <div class="card-head"><h2>If you sold today</h2><span class="muted small">what is short-term and what is long-term now</span></div>
      ${openPositionsTable(r)}
    </section>
    ${classesTable(r) ? `<section class="card"><div class="card-head"><h2>How each holding is treated</h2></div>${classesTable(r)}</section>` : ''}
    <section class="card">
      <div class="card-head"><h2>The rules applied</h2></div>
      ${notesHtml(r)}
    </section>`;
}

function go(fy, slab) {
  location.hash = `#/tax?fy=${encodeURIComponent(fy)}&slab=${slab}`;
}

export async function renderTaxPage(qs) {
  const p = new URLSearchParams(qs || '');
  const root = document.getElementById('app');
  root.innerHTML = '<section class="card"><p class="empty">Working the gains out…</p></section>';
  const slab = p.has('slab') && SLABS.includes(Number(p.get('slab'))) ? Number(p.get('slab')) : savedSlab();
  const fy = p.get('fy') || '';
  const r = await api.get(`/api/tax?slab=${slab}${fy ? `&fy=${encodeURIComponent(fy)}` : ''}`);
  root.innerHTML = pageHtml(r);
  root.querySelector('#tax-fy').addEventListener('change', (e) => go(e.target.value, slab));
  root.querySelector('#tax-slab').addEventListener('change', (e) => { saveSlab(Number(e.target.value)); go(r.fy, Number(e.target.value)); });
  root.querySelector('#btn-tax-print').addEventListener('click', () => {
    const q = new URLSearchParams({ scope: 'portfolio', status: 'all', sections: 'tax', period: 'custom', from: r.from, to: r.to, title: `Capital gains and tax · FY ${r.fy}` });
    location.hash = `#/print?${q.toString()}`;
  });
}
