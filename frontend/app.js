// Investment Tracker frontend: hash-routed single page app, no build step.
//   #/            portfolio overview
//   #/fund/<id>   one mutual fund with its transactions

import { api } from './api.js';
import { valueChart, updateValueChart, segmentedBar, themeTokens } from './charts.js';
import { fmtINR, fmtPct, fmtNum, fmtDate, esc, todayISO, isNum } from './format.js';
import { openModal, closeModal, toast, confirmDialog } from './ui.js';

const app = document.getElementById('app');
const RANGES = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '3Y': 36, All: null };

function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

const state = {
  chart: null,
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

function statusBadge(locked, until) {
  if (!locked) return `<span class="badge open">${UNLOCK_ICON} Open</span>`;
  const till = until ? ` till ${fmtDate(until)}` : '';
  return `<span class="badge locked" title="Under lock-in${till}">${LOCK_ICON} Locked${till}</span>`;
}

function hero(label, value, profit, absPct) {
  const has = isNum(profit);
  const up = has && profit >= 0;
  return `
    <section class="card hero">
      <div class="tile-label">${label}</div>
      <div class="hero-value">${fmtINR(value)}</div>
      ${has
        ? `<div class="delta ${up ? 'up' : 'down'}"><span aria-hidden="true">${up ? '▲' : '▼'}</span> ${fmtINR(Math.abs(profit))}
             <span class="muted">(${fmtPct(absPct)}) ${up ? 'gain' : 'loss'} overall</span></div>`
        : '<div class="muted small">Add transactions to see returns</div>'}
    </section>`;
}

function tile(label, valueHtml, sub = '') {
  return `<div class="card tile"><div class="tile-label">${label}</div><div class="tile-value">${valueHtml}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ''}</div>`;
}

function deltaValue(profit) {
  if (!isNum(profit)) return '–';
  const up = profit >= 0;
  return `<span class="delta ${up ? 'up' : 'down'}"><span aria-hidden="true">${up ? '▲' : '▼'}</span> ${fmtINR(Math.abs(profit))}</span>`;
}

function rangeButtons() {
  return `<div class="range-filter" role="group" aria-label="Time range">${Object.keys(RANGES)
    .map((k) => `<button type="button" class="range-btn${k === state.range ? ' active' : ''}" data-range="${k}">${k}</button>`)
    .join('')}</div>`;
}

function navErrorBanner(errors) {
  const msgs = Object.values(errors || {});
  if (!msgs.length) return '';
  return `<div class="banner warn" role="status">⚠ NAV refresh failed for ${msgs.length} scheme${msgs.length > 1 ? 's' : ''}; showing last cached values. <span class="small">${esc(msgs[0])}</span></div>`;
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
}

function mountChart(history) {
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
  state.chart = valueChart(canvas, filterHistory(history, state.range));
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
async function renderPortfolio() {
  app.innerHTML = loading();
  const data = await api.get('/api/portfolio');
  const t = data.totals;

  if (!data.funds.length) {
    app.innerHTML = `
      <div class="page-head"><h1>Portfolio</h1></div>
      <section class="card empty-card">
        <h2>No funds yet</h2>
        <p>Add a mutual fund, then record your SIP installments or lumpsum purchases. NAVs are fetched automatically from AMFI data.</p>
        <button type="button" class="btn primary" id="btn-add-fund-inline">+ Add your first fund</button>
      </section>`;
    return;
  }

  const asOf = data.funds.map((f) => f.summary.latest_nav_date).filter(Boolean).sort().pop();
  const tokens = themeTokens();
  const rows = data.funds
    .map((f) => {
      const s = f.summary;
      const sub = [f.scheme?.scheme_category, f.folio_number ? `Folio ${f.folio_number}` : ''].filter(Boolean).join(' · ');
      return `
        <tr class="row-link" data-href="#/fund/${f.id}" tabindex="0">
          <td><div class="fund-name">${esc(f.name)}</div><div class="muted small">${esc(sub)}</div></td>
          <td>${statusBadge(f.locked, f.lock_in_until)}</td>
          <td class="num">${fmtINR(s.invested)}</td>
          <td class="num">${fmtINR(s.current_value)}</td>
          <td class="num">${deltaValue(s.profit)}<div class="muted small">${fmtPct(s.abs_return_pct)}</div></td>
          <td class="num">${fmtPct(pct(s.xirr))}</td>
          <td class="num muted small">${isNum(s.latest_nav) ? `${fmtNum(s.latest_nav, 4)}<br>${fmtDate(s.latest_nav_date)}` : '–'}</td>
        </tr>`;
    })
    .join('');

  app.innerHTML = `
    ${navErrorBanner(data.nav_errors)}
    <div class="page-head">
      <h1>Portfolio</h1>
      <div class="muted small">${asOf ? `NAV as of ${fmtDate(asOf)} · ` : ''}${t.fund_count} fund${t.fund_count === 1 ? '' : 's'}</div>
    </div>
    <section class="summary-grid">
      ${hero('Current value', t.current_value, t.invested ? t.profit : null, t.abs_return_pct)}
      <div class="tiles">
        ${tile('Total investment', fmtINR(t.invested))}
        ${tile('Total profit', deltaValue(t.invested ? t.profit : null), isNum(t.abs_return_pct) ? `${fmtPct(t.abs_return_pct)} absolute` : '')}
        ${tile('XIRR', fmtPct(pct(t.xirr)), 'annualised, all funds')}
        ${tile('Redeemable now', fmtINR(t.unlocked_value), `${fmtINR(t.locked_value)} locked`)}
      </div>
    </section>
    <section class="card chart-card">
      <div class="card-head"><h2>Portfolio value over time</h2>${rangeButtons()}</div>
      <div class="chart-wrap"><canvas id="value-chart" role="img" aria-label="Portfolio current value and invested amount over time"></canvas></div>
    </section>
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
        <div class="kv-row"><span>Redeemable now</span><span class="muted small">${t.fund_count - t.locked_count} open fund${t.fund_count - t.locked_count === 1 ? '' : 's'} · invested ${fmtINR(t.unlocked_invested)}</span><b>${fmtINR(t.unlocked_value)}</b></div>
        <div class="kv-row"><span>Locked</span><span class="muted small">${t.locked_count} locked fund${t.locked_count === 1 ? '' : 's'} · invested ${fmtINR(t.locked_invested)}</span><b>${fmtINR(t.locked_value)}</b></div>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Funds</h2><button type="button" class="btn primary small" id="btn-add-fund-inline">+ Add fund</button></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Fund</th><th>Status</th><th class="num">Invested</th><th class="num">Current value</th><th class="num">P&amp;L</th><th class="num">XIRR</th><th class="num">Latest NAV</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td colspan="2">Total</td><td class="num">${fmtINR(t.invested)}</td><td class="num">${fmtINR(t.current_value)}</td><td class="num">${deltaValue(t.invested ? t.profit : null)}</td><td class="num">${fmtPct(pct(t.xirr))}</td><td></td></tr></tfoot>
        </table>
      </div>
    </section>`;

  mountChart(data.history);
  wireRange(app);
  app.querySelectorAll('tr.row-link').forEach((tr) => {
    const go = () => { location.hash = tr.dataset.href; };
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });
}

// ---------------------------------------------------------------- fund view
function txnTable(txns) {
  const totalAmount = txns.reduce((s, t) => s + t.amount, 0);
  const totalUnits = txns.reduce((s, t) => s + t.units, 0);
  const body = txns
    .map(
      (tx) => `
      <tr data-id="${tx.id}">
        <td>${fmtDate(tx.date)}</td>
        <td>${esc(tx.folio_number) || '–'}</td>
        <td><span class="chip">${tx.type === 'SIP' ? 'SIP' : 'Lumpsum'}</span></td>
        <td class="num">${fmtINR(tx.amount, 2)}</td>
        <td class="num">${fmtNum(tx.nav, 4)}</td>
        <td class="num">${fmtNum(tx.units, 4)}</td>
        <td class="row-actions"><button type="button" class="link-btn" data-edit>Edit</button><button type="button" class="link-btn danger-text" data-del>Delete</button></td>
      </tr>`,
    )
    .join('');
  return `
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Date</th><th>Folio</th><th>Type</th><th class="num">Amount</th><th class="num">NAV</th><th class="num">Units</th><th></th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td colspan="3">Total (${txns.length} transaction${txns.length === 1 ? '' : 's'})</td><td class="num">${fmtINR(totalAmount, 2)}</td><td></td><td class="num">${fmtNum(totalUnits, 4)}</td><td></td></tr></tfoot>
      </table>
    </div>`;
}

async function renderFund(id) {
  app.innerHTML = loading();
  const f = await api.get(`/api/funds/${id}`);
  const s = f.summary;
  const meta = [
    f.folio_number ? `Folio <b>${esc(f.folio_number)}</b>` : '',
    `Scheme code <b>${f.scheme_code}</b>`,
    f.scheme?.fund_house ? esc(f.scheme.fund_house) : '',
    f.scheme?.scheme_category ? esc(f.scheme.scheme_category) : '',
  ].filter(Boolean).join(' · ');

  app.innerHTML = `
    ${navErrorBanner(f.nav_errors)}
    <a class="back-link" href="#/">← Portfolio</a>
    <div class="page-head">
      <div>
        <h1>${esc(f.name)} ${statusBadge(f.locked, f.lock_in_until)}</h1>
        <div class="meta muted small">${meta}</div>
        ${f.notes ? `<div class="notes">${esc(f.notes)}</div>` : ''}
      </div>
      <div class="head-actions">
        <button type="button" class="btn ghost small" id="btn-edit-fund">Edit fund</button>
        <button type="button" class="btn ghost small danger-text" id="btn-delete-fund">Delete</button>
      </div>
    </div>
    <section class="summary-grid">
      ${hero('Current value', s.current_value, s.invested ? s.profit : null, s.abs_return_pct)}
      <div class="tiles">
        ${tile('Total investment', fmtINR(s.invested))}
        ${tile('Total profit', deltaValue(s.invested ? s.profit : null), isNum(s.abs_return_pct) ? `${fmtPct(s.abs_return_pct)} absolute` : '')}
        ${tile('XIRR', fmtPct(pct(s.xirr)), 'annualised')}
        ${tile('Latest NAV', isNum(s.latest_nav) ? fmtNum(s.latest_nav, 4) : '–', s.latest_nav_date ? `as of ${fmtDate(s.latest_nav_date)} · ${fmtNum(s.units, 3)} units held` : 'NAV not fetched yet')}
      </div>
    </section>
    <section class="card chart-card">
      <div class="card-head"><h2>Value over time</h2>${rangeButtons()}</div>
      <div class="chart-wrap"><canvas id="value-chart" role="img" aria-label="Current value and invested amount of ${esc(f.name)} over time"></canvas></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Transactions</h2><button type="button" class="btn primary small" id="btn-add-txn">+ Add transaction</button></div>
      ${f.transactions.length ? txnTable(f.transactions) : '<p class="empty">No transactions yet. Add your SIP installments or lumpsum purchases to see value and returns.</p>'}
    </section>`;

  mountChart(f.history);
  wireRange(app);

  document.getElementById('btn-add-txn').addEventListener('click', () => openTxnModal(f, null));
  document.getElementById('btn-edit-fund').addEventListener('click', () => openFundModal(f));
  document.getElementById('btn-delete-fund').addEventListener('click', async () => {
    const ok = await confirmDialog('Delete fund?', `This removes <b>${esc(f.name)}</b> and all ${f.transactions.length} of its transactions. This cannot be undone.`);
    if (!ok) return;
    try {
      await api.del(`/api/funds/${f.id}`);
      toast('Fund deleted');
      location.hash = '#/';
    } catch (e) {
      toast(`Delete failed: ${e.message}`, 'error');
    }
  });

  app.querySelector('tbody')?.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const tx = f.transactions.find((t) => t.id === Number(tr.dataset.id));
    if (!tx) return;
    if (e.target.closest('[data-edit]')) openTxnModal(f, tx);
    if (e.target.closest('[data-del]')) {
      const ok = await confirmDialog('Delete transaction?', `${tx.type === 'SIP' ? 'SIP' : 'Lumpsum'} of ${fmtINR(tx.amount, 2)} on ${fmtDate(tx.date)} will be removed.`);
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
  return `
  <form id="fund-form" class="form" novalidate>
    <label class="field">Search scheme
      <input name="q" placeholder="Type a fund name, e.g. Parag Parikh Flexi Cap Direct Growth" autocomplete="off">
      <span class="hint">Searches the AMFI scheme list. Pick the exact plan: Direct / Regular, Growth / IDCW.</span>
    </label>
    <div id="scheme-results" class="search-results" hidden></div>
    <div class="form-row">
      <label class="field">Scheme code (AMFI)
        <input name="scheme_code" required inputmode="numeric" pattern="[0-9]+" value="${f.scheme_code ?? ''}" placeholder="e.g. 122639">
      </label>
      <label class="field">Folio number
        <input name="folio_number" value="${esc(f.folio_number ?? '')}" placeholder="e.g. 1234567/89">
      </label>
    </div>
    <label class="field">Display name
      <input name="name" required value="${esc(f.name ?? '')}" placeholder="Shown in your portfolio">
    </label>
    <fieldset class="field">
      <legend>Status</legend>
      <div class="radio-row">
        <label><input type="radio" name="locked" value="0" ${f.locked ? '' : 'checked'}> Open — can be redeemed</label>
        <label><input type="radio" name="locked" value="1" ${f.locked ? 'checked' : ''}> Locked — under lock-in (e.g. ELSS)</label>
      </div>
    </fieldset>
    <label class="field" id="lock-until-field" ${f.locked ? '' : 'hidden'}>Locked until (optional)
      <input type="date" name="lock_in_until" value="${f.lock_in_until ?? ''}">
    </label>
    <label class="field">Notes
      <input name="notes" value="${esc(f.notes ?? '')}" placeholder="Optional">
    </label>
    <div class="form-error" id="fund-form-error" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">${f.id ? 'Save changes' : 'Add fund'}</button>
    </div>
  </form>`;
}

function openFundModal(existing) {
  const modal = openModal(existing ? 'Edit fund' : 'Add mutual fund', fundFormHtml(existing || {}));
  const form = modal.querySelector('#fund-form');
  const results = modal.querySelector('#scheme-results');
  const q = form.elements.q;
  const nameInput = form.elements.name;
  let timer = null;
  let seq = 0;
  let nameEdited = Boolean(existing);

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
    form.elements.scheme_code.value = b.dataset.code;
    if (!nameEdited || !nameInput.value.trim()) nameInput.value = b.dataset.name;
    q.value = b.dataset.name;
    results.hidden = true;
    results.innerHTML = '';
  });

  nameInput.addEventListener('input', () => { nameEdited = nameInput.value.trim() !== ''; });
  form.querySelectorAll('input[name="locked"]').forEach((r) =>
    r.addEventListener('change', () => { modal.querySelector('#lock-until-field').hidden = form.elements.locked.value !== '1'; }),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = modal.querySelector('#fund-form-error');
    err.hidden = true;
    const fd = new FormData(form);
    const body = {
      name: String(fd.get('name')).trim(),
      scheme_code: Number(fd.get('scheme_code')),
      folio_number: String(fd.get('folio_number')).trim(),
      locked: fd.get('locked') === '1',
      lock_in_until: fd.get('lock_in_until') || null,
      notes: String(fd.get('notes')).trim(),
    };
    if (!body.name || !Number.isInteger(body.scheme_code) || body.scheme_code <= 0) {
      err.textContent = 'Pick a scheme (or type its AMFI scheme code) and give the fund a name.';
      err.hidden = false;
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const saved = existing ? await api.put(`/api/funds/${existing.id}`, body) : await api.post('/api/funds', body);
      closeModal();
      if (saved.nav_error) toast(`Fund saved, but NAV could not be fetched: ${saved.nav_error}`, 'warn');
      else toast(existing ? 'Fund updated' : 'Fund added');
      if (existing) render();
      else location.hash = `#/fund/${saved.id}`;
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- transaction add / edit modal
function txnFormHtml(fund, tx) {
  const today = todayISO();
  return `
  <form id="txn-form" class="form" novalidate>
    <div class="form-row">
      <label class="field">Date
        <input type="date" name="date" required value="${tx.date ?? today}" max="${today}">
      </label>
      <label class="field">Type
        <select name="type">
          <option value="SIP" ${tx.type === 'LUMPSUM' ? '' : 'selected'}>SIP</option>
          <option value="LUMPSUM" ${tx.type === 'LUMPSUM' ? 'selected' : ''}>Lumpsum</option>
        </select>
      </label>
    </div>
    <div class="form-row">
      <label class="field">Folio number
        <input name="folio_number" value="${esc(tx.folio_number ?? fund.folio_number ?? '')}">
      </label>
      <label class="field">Amount (₹)
        <input type="number" name="amount" required min="0.01" step="0.01" value="${tx.amount ?? ''}" placeholder="5000">
      </label>
    </div>
    <div class="form-row">
      <label class="field">NAV
        <input type="number" name="nav" required min="0.0001" step="0.0001" value="${tx.nav ?? ''}">
        <span class="hint" id="nav-hint">Auto-filled from NAV history for the chosen date</span>
      </label>
      <label class="field">Units
        <input type="number" name="units" required min="0.0001" step="0.0001" value="${tx.units ?? ''}">
        <span class="hint">Auto = amount ÷ NAV. Edit to match your statement (stamp duty etc.).</span>
      </label>
    </div>
    <label class="field">Notes
      <input name="notes" value="${esc(tx.notes ?? '')}" placeholder="Optional">
    </label>
    <div class="form-error" id="txn-form-error" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">${tx.id ? 'Save changes' : 'Add transaction'}</button>
    </div>
  </form>`;
}

function openTxnModal(fund, existing) {
  const modal = openModal(existing ? 'Edit transaction' : `Add transaction · ${esc(fund.name)}`, txnFormHtml(fund, existing || {}));
  const form = modal.querySelector('#txn-form');
  const { date, amount, nav, units } = form.elements;
  const hint = modal.querySelector('#nav-hint');
  let navTouched = Boolean(existing);
  let unitsTouched = Boolean(existing);
  let seq = 0;

  const recompute = () => {
    if (unitsTouched) return;
    const a = parseFloat(amount.value);
    const n = parseFloat(nav.value);
    units.value = a > 0 && n > 0 ? (a / n).toFixed(4) : '';
  };

  const fetchNav = async () => {
    if (navTouched || !date.value) return;
    const my = ++seq;
    hint.textContent = 'Looking up NAV…';
    try {
      const r = await api.get(`/api/schemes/${fund.scheme_code}/nav?on=${date.value}`);
      if (my !== seq) return;
      nav.value = r.nav;
      hint.textContent = r.date === date.value
        ? `NAV on ${fmtDate(r.date)}`
        : `No NAV published on ${fmtDate(date.value)}; using ${fmtDate(r.date)}. Adjust if your statement differs.`;
      recompute();
    } catch (e) {
      if (my === seq) hint.textContent = `NAV lookup failed: ${e.message}. Enter it manually.`;
    }
  };

  date.addEventListener('change', fetchNav);
  amount.addEventListener('input', recompute);
  nav.addEventListener('input', () => { navTouched = true; recompute(); });
  units.addEventListener('input', () => { unitsTouched = units.value !== ''; if (!unitsTouched) recompute(); });
  if (!existing) fetchNav();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = modal.querySelector('#txn-form-error');
    err.hidden = true;
    const body = {
      date: date.value,
      folio_number: form.elements.folio_number.value.trim(),
      type: form.elements.type.value,
      amount: parseFloat(amount.value),
      nav: parseFloat(nav.value),
      units: units.value ? parseFloat(units.value) : null,
      notes: form.elements.notes.value.trim(),
    };
    if (!body.date || !(body.amount > 0) || !(body.nav > 0)) {
      err.textContent = 'Date, a positive amount and a positive NAV are required.';
      err.hidden = false;
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      if (existing) await api.put(`/api/transactions/${existing.id}`, body);
      else await api.post(`/api/funds/${fund.id}/transactions`, body);
      closeModal();
      toast(existing ? 'Transaction updated' : 'Transaction added');
      render();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- global actions
async function refreshNav() {
  const btn = document.getElementById('btn-refresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    const r = await api.post('/api/nav/refresh');
    const failed = Object.values(r.failed);
    if (failed.length) toast(`NAV refreshed for ${r.requested - failed.length} of ${r.requested} schemes. ${failed[0]}`, 'warn');
    else toast(r.requested ? `NAV refreshed for ${r.requested} scheme${r.requested === 1 ? '' : 's'}` : 'No funds to refresh');
    await render();
  } catch (e) {
    toast(`Refresh failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh NAV';
  }
}

// ---------------------------------------------------------------- router
async function render() {
  destroyChart();
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/fund\/(\d+)$/);
  try {
    if (m) await renderFund(Number(m[1]));
    else await renderPortfolio();
  } catch (err) {
    app.innerHTML = errorCard(err);
  }
  window.scrollTo(0, 0);
}

document.getElementById('btn-add-fund').addEventListener('click', () => openFundModal(null));
document.getElementById('btn-refresh').addEventListener('click', refreshNav);
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
render();
