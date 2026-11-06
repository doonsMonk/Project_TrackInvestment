// Bulk import of transactions: paste rows from Excel / Sheets / CSV, preview, then save in one request.
// Works for mutual funds (NAV, units, folio), stocks (price, shares, account) and NPS accounts (one row
// per contribution with units and NAV per scheme E / C / G, which expands into one transaction per scheme).

import { api } from './api.js';
import { esc } from './format.js';
import { openModal, closeModal, toast } from './ui.js';
import { FIELDS, FIELD_LABELS, parseTable, autoMap, buildRows, parseEpfYear, buildEpfRows, parsePpfYear, buildPpfRows, fyLabel } from './parse.js';

const PREVIEW_LIMIT = 200;
const NOISE_WORDS = new Set(['fund', 'plan', 'growth', 'direct', 'regular', 'the', 'and', 'option', 'scheme', 'ltd', 'limited', 'inc', 'corp', 'plc', 'tier', 'pension']);
const TYPE_WORDS = { SWITCH_IN: 'Switch in', SWITCH_OUT: 'Switch out', CHARGE: 'Charges', REDEMPTION: 'Sale', DIVIDEND: 'Dividend', BONUS: 'Bonus' };

function wordsFor(fund) {
  if (fund.kind === 'NPS') {
    return { price: 'NAV', units: 'units', folio: 'PRAN', sell: 'Withdrawal', buy: 'Contribution', thing: 'NPS account',
      example: '110045678901 | SBI PENSION FUND SCHEME E,C,G - TIER I | SIP | 5-Apr-2021 | -10,000.00 | 150.2500 | 80.1000 | 90.5000 | 30.1200 | 28.4400 | 25.6700' };
  }
  if (fund.kind === 'GOLD') {
    return { price: 'price per gram', units: 'grams', folio: 'folio', sell: 'Redemption', buy: 'Purchase', thing: 'gold bond',
      example: '87654321 | Sovereign Gold Bonds 2021-22-Series-X | LUMP SUM | 8-Mar-2022 | -50,590.00 | 10 | 5,059.00' };
  }
  const stock = fund.kind === 'STOCK';
  return stock
    ? { price: 'price', units: 'shares', folio: 'account', sell: 'Sell', buy: 'Buy', thing: 'stock',
        example: 'Broker-1 | Reliance Industries | Buy | 15-Jan-2024 | -25,000.00 | 10 | 2,500.00' }
    : { price: 'NAV', units: 'units', folio: 'folio', sell: 'Redemption', buy: 'Lumpsum', thing: 'fund',
        example: '1234567/89 | UTI Nifty 50 Index Fund | SIP | 11-Mar-2021 | -5,000.00 | 50.0000 | 100.0000' };
}

function columnsHint(fund, w) {
  if (fund.kind === 'NPS') {
    return 'Columns are read from the header row, or in this order without one: PRAN, Scheme name, Type, Date, Amount, Units E, Units C, Units G, NAV E, NAV C, NAV G. One row becomes one transaction per scheme. Negative amounts are contributions, shared out by each scheme’s value; a row with 0 amount and negative units everywhere is charges deducted; 0 amount with units going down in one scheme and up in another is a rebalance (switch).';
  }
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  return `Columns are read from the header row, or in this order without one: ${cap(w.folio)}, Name, Type, Date, Amount, ${cap(w.units)}, ${cap(w.price)}. Negative amounts count as purchases; negative ${w.units} or a type like “${w.sell}” mean a sale. Missing ${w.price} or ${w.units} are filled from ${w.price} history. Amounts are in ${esc(fund.currency || 'INR')}.`;
}

function formHtml(fund) {
  const w = wordsFor(fund);
  const stock = fund.kind === 'STOCK';
  const typeOptions = stock
    ? '<option value="LUMPSUM">Buy</option><option value="SIP">SIP (buy)</option>'
    : fund.kind === 'GOLD'
      ? '<option value="LUMPSUM">Purchase</option><option value="SIP">SIP (purchase)</option>'
    : fund.kind === 'NPS'
      ? '<option value="SIP">Contribution</option><option value="LUMPSUM">Lumpsum contribution</option>'
      : '<option value="SIP">SIP</option><option value="LUMPSUM">Lumpsum</option>';
  return `
  <form id="import-form" class="form" novalidate>
    <label class="field">Paste rows
      <textarea name="raw" rows="6" spellcheck="false" placeholder="Paste from Excel, Google Sheets or a CSV. A header row is optional.&#10;${esc(w.example)}"></textarea>
      <span class="hint">${columnsHint(fund, w)}</span>
    </label>
    <div class="form-row">
      <label class="field">…or choose a file
        <input type="file" name="file" accept=".csv,.tsv,.txt">
      </label>
      <label class="field">Type when the data has none
        <select name="default_type">${typeOptions}</select>
      </label>
    </div>
    <label class="field">Comment for imported rows (optional)
      <input name="batch_note" maxlength="500" placeholder="e.g. Imported from ${stock ? 'broker contract notes' : fund.kind === 'NPS' ? 'the eNPS transaction statement' : 'CAS statement'}, Nov 2026">
      <span class="hint">Applied to rows that have no comment column of their own. Comments can be edited per row after importing.</span>
    </label>
    <label class="check"><input type="checkbox" name="skip_dupes" checked> Skip rows already recorded (same date, amount and ${w.units})</label>
    <label class="check" ${fund.kind === 'NPS' ? 'hidden' : ''}><input type="checkbox" name="split_folios" checked> Split rows that list several ${w.folio}s (e.g. 1234567890/2345678901) equally between them: one transaction per ${w.folio} with half the amount and ${w.units}</label>
    ${fund.kind === 'GOLD' ? '<label class="check" id="gold-price-wrap" hidden><input type="checkbox" name="gold_price" checked> <span id="gold-price-text"></span></label>' : ''}
    <div id="import-preview"><p class="empty small">Paste rows above to see a preview.</p></div>
    <div class="form-error" id="import-error" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary" id="import-submit" disabled>Import</button>
    </div>
  </form>`;
}

const significantWords = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NOISE_WORDS.has(w));

function looselyMatches(name, fund) {
  const words = significantWords(name);
  if (!words.length) return true;
  if (fund.kind === 'NPS' && /pension|\bnps\b|scheme\s*[ecga]\b/i.test(name)) return true;
  const target = new Set([
    ...significantWords(fund.name),
    ...significantWords(fund.scheme?.scheme_name),
    ...significantWords(fund.quote?.name),
    ...significantWords(fund.details?.pfm),
    ...significantWords(fund.details?.series),
    ...significantWords(fund.details?.code),
    ...significantWords(fund.gold?.exchange_name),
    ...significantWords(String(fund.symbol || '').replace(/\..*$/, '')),
  ]);
  if (fund.symbol && String(name).trim().toUpperCase() === fund.symbol) return true;
  return words.filter((w) => target.has(w)).length / words.length >= 0.5;
}

// ------------------------------------------------------------------ EPF: one financial year's sheet at a time
function epfFormHtml() {
  const now = new Date();
  const fyNow = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return `
  <form id="import-form" class="form" novalidate>
    <label class="field">Paste one financial year's sheet
      <textarea name="raw" rows="8" spellcheck="false" placeholder="Balance | 24000 | 7300 | 15000 |  | 2021-2022 |  | 25500 | 7800&#10;Month | Deposit (Employee) | Deposit (Employer) | Pension Contr | IR% | Interest Employee | Interest Employer | Balance Employee | Balance Employer&#10;April | 1800 | 550 | 1250 | 8.25 | 0 | 0 | 27300 | 8350&#10;…&#10;March | 1800 | 550 | 1250 | 8.25 | 2100 | 650 | 49500 | 15150"></textarea>
      <span class="hint">Copy the whole year from your sheet, with the Balance line on top if it has one. Year Total and Overall Total lines are skipped, and so are the balance columns: the app works balances out from deposits and the interest you enter. Deposits are dated the 15th of each month and the year's interest 31 March.</span>
    </label>
    <div class="form-row">
      <label class="field">…or choose a file
        <input type="file" name="file" accept=".csv,.tsv,.txt">
      </label>
      <label class="field">Financial year (starting year)
        <input type="number" name="fy" min="1952" max="${fyNow}" placeholder="e.g. 2011 for 2011-12">
        <span class="hint" id="fy-hint">Read from the sheet's Balance line when it carries one.</span>
      </label>
    </div>
    <label class="check"><input type="checkbox" name="skip_dupes" checked> Skip entries already recorded (same month, share and amount)</label>
    <label class="check" id="opening-wrap" hidden><input type="checkbox" name="opening" checked> <span id="opening-text"></span></label>
    <div id="import-preview"><p class="empty small">Paste a year above to see a preview.</p></div>
    <div class="form-error" id="import-error" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary" id="import-submit" disabled>Import</button>
    </div>
  </form>`;
}

function openEpfImportModal(fund, onDone) {
  const modal = openModal(`Import a financial year · ${esc(fund.name)}`, epfFormHtml(), { wide: true });
  const form = modal.querySelector('#import-form');
  const raw = form.elements.raw;
  const fyInput = form.elements.fy;
  const preview = modal.querySelector('#import-preview');
  const err = modal.querySelector('#import-error');
  const submit = modal.querySelector('#import-submit');
  const openingWrap = modal.querySelector('#opening-wrap');
  const existing = fund.transactions || [];
  const state = { parsed: null, rows: [] };
  const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
  let timer = null;

  const skipDupes = () => form.elements.skip_dupes.checked;
  const toImport = () => state.rows.filter((r) => r.status === 'ok' || (r.status === 'dup' && !skipDupes()));
  const hasEarlier = (fy) => existing.some((t) => t.date < `${fy}-04-01`);

  function reparse() {
    state.parsed = parseEpfYear(raw.value);
    if (state.parsed.fyStart !== null && !fyInput.dataset.touched) fyInput.value = state.parsed.fyStart;
    rebuild();
  }

  function rebuild() {
    const fy = Number(fyInput.value) || null;
    const p = state.parsed;
    const showOpening = Boolean(p?.opening) && Boolean(fy) && !hasEarlier(fy);
    openingWrap.hidden = !showOpening;
    if (showOpening) {
      const o = p.opening;
      modal.querySelector('#opening-text').textContent = `Also record the balances the sheet brings into FY ${fyLabel(fy)} (employee ${money(o.balance_ee)}, employer ${money(o.balance_er)}, pension ${money(o.pension)}, of which ${money(o.balance_ee - o.deposit_ee + (o.balance_er - o.deposit_er))} is interest to date) as of 1 April ${fy}, since no earlier year is in the app yet`;
    }
    state.rows = p && fy ? buildEpfRows(p, { fyStart: fy, existing, includeOpening: showOpening && form.elements.opening.checked, uan: fund.folio_number || '' }) : [];
    renderPreview();
  }

  function renderPreview() {
    const p = state.parsed;
    if (!p || (!p.months.length && !p.opening)) {
      preview.innerHTML = raw.value.trim() ? '<p class="empty small">No month rows found. Each line should start with the month name (April … March).</p>' : '<p class="empty small">Paste a year above to see a preview.</p>';
      submit.disabled = true;
      submit.textContent = 'Import';
      return;
    }
    const fy = Number(fyInput.value) || null;
    const n = toImport().length;
    const dup = state.rows.filter((r) => r.status === 'dup').length;
    const rowsFor = (m) => state.rows.filter((r) => r.label && r.label.startsWith(`${m.month} `));
    const body = p.months
      .map((m) => {
        const rs = rowsFor(m);
        const st = !rs.length ? 'nothing to import' : rs.every((r) => r.status === 'dup') ? (skipDupes() ? 'Skipped · already recorded' : 'Duplicate · will import') : rs.some((r) => r.status === 'dup') ? 'Partly recorded' : 'Ready';
        const cls = !rs.length ? 'status-dup' : rs.every((r) => r.status === 'dup') && skipDupes() ? 'status-dup' : 'status-ok';
        return `<tr class="${cls}"><td class="status">${esc(st)}</td><td>${esc(m.month)}</td><td class="num">${money(m.ee)}</td><td class="num">${money(m.er)}</td><td class="num">${money(m.eps)}</td><td class="num">${m.rate ?? '–'}</td><td class="num">${money(m.int_ee)}</td><td class="num">${money(m.int_er)}</td></tr>`;
      })
      .join('');
    const intEe = p.months.reduce((s, m) => s + (m.int_ee > 0 ? m.int_ee : 0), 0);
    const intEr = p.months.reduce((s, m) => s + (m.int_er > 0 ? m.int_er : 0), 0);
    preview.innerHTML = `
      <div class="preview-summary">${p.months.length} month${p.months.length === 1 ? '' : 's'}${fy ? ` of FY <b>${fyLabel(fy)}</b>` : ''} · <b>${n}</b> entr${n === 1 ? 'y' : 'ies'} to import${dup ? ` · ${dup} already recorded` : ''}${intEe || intEr ? ` · interest for the year ${money(intEe)} employee, ${money(intEr)} employer` : ' · no interest for the year yet'}
        ${!fy ? '<span class="danger-text"> · enter the financial year</span>' : ''}</div>
      ${p.warnings.map((w) => `<div class="banner warn small">${esc(w)}</div>`).join('')}
      <div class="preview-wrap"><table class="data preview"><thead><tr><th>Status</th><th>Month</th><th class="num">Employee</th><th class="num">Employer</th><th class="num">Pension (EPS)</th><th class="num">IR%</th><th class="num">Interest employee</th><th class="num">Interest employer</th></tr></thead><tbody>${body}</tbody></table></div>`;
    submit.disabled = n === 0 || !fy;
    submit.textContent = n ? `Import ${n} entr${n === 1 ? 'y' : 'ies'}` : 'Import';
  }

  raw.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(reparse, 300); });
  form.elements.file.addEventListener('change', async () => {
    const f = form.elements.file.files[0];
    if (!f) return;
    raw.value = await f.text();
    reparse();
  });
  fyInput.addEventListener('input', () => { fyInput.dataset.touched = '1'; rebuild(); });
  form.elements.skip_dupes.addEventListener('change', renderPreview);
  form.elements.opening.addEventListener('change', rebuild);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const items = toImport().map((r) => ({ date: r.date, folio_number: r.folio || '', scheme: r.scheme, type: r.type, amount: r.amount, nav: 1, units: r.units, rate: r.rate, notes: r.notes || '' }));
    if (!items.length) return;
    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'Importing…';
    try {
      const res = await api.post(`/api/funds/${fund.id}/transactions/bulk`, { transactions: items });
      closeModal();
      toast(`Imported ${res.created} entr${res.created === 1 ? 'y' : 'ies'}`);
      onDone?.();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      submit.disabled = false;
      submit.textContent = label;
    }
  });
  raw.focus();
}

// ------------------------------------------------------------------ PPF: one financial year's sheet at a time
function ppfFormHtml() {
  const now = new Date();
  const fyNow = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return `
  <form id="import-form" class="form" novalidate>
    <label class="field">Paste one financial year's sheet
      <textarea name="raw" rows="8" spellcheck="false" placeholder="Balance | 0 |  |  |  | 2021&#10;Month | Deposit | Before 5th | Interest Rate | Interest | Balance&#10;April | 0 | After 5th | 7.1 | 0 | 0&#10;…&#10;November | 5000 | Before 5th | 7.1 | 29.58 | 5000&#10;…&#10;March | 0 | After 5th | 7.1 | 29.58 | 5000&#10; | 5000 |  |  | 147.9 | 5147.9"></textarea>
      <span class="hint">Copy the whole year from your sheet, with the Balance line on top. The balance column and the totals line are skipped: the app works the balance out from deposits and the interest you enter. A deposit marked Before 5th is dated the 1st of its month, one marked After 5th the 15th, and the monthly interest figures are added up into one entry dated 31 March.</span>
    </label>
    <div class="form-row">
      <label class="field">…or choose a file
        <input type="file" name="file" accept=".csv,.tsv,.txt">
      </label>
      <label class="field">Financial year (starting year)
        <input type="number" name="fy" min="1968" max="${fyNow}" placeholder="e.g. 2021 for 2021-22">
        <span class="hint" id="fy-hint">Read from the sheet's Balance line when it carries the year.</span>
      </label>
    </div>
    <label class="check"><input type="checkbox" name="skip_dupes" checked> Skip entries already recorded (same date, type and amount)</label>
    <label class="check" id="opening-wrap" hidden><input type="checkbox" name="opening" checked> <span id="opening-text"></span></label>
    <div id="import-preview"><p class="empty small">Paste a year above to see a preview.</p></div>
    <div class="form-error" id="import-error" hidden></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary" id="import-submit" disabled>Import</button>
    </div>
  </form>`;
}

function openPpfImportModal(fund, onDone) {
  const modal = openModal(`Import a financial year · ${esc(fund.name)}`, ppfFormHtml(), { wide: true });
  const form = modal.querySelector('#import-form');
  const raw = form.elements.raw;
  const fyInput = form.elements.fy;
  const preview = modal.querySelector('#import-preview');
  const err = modal.querySelector('#import-error');
  const submit = modal.querySelector('#import-submit');
  const openingWrap = modal.querySelector('#opening-wrap');
  const existing = fund.transactions || [];
  const state = { parsed: null, rows: [] };
  const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
  let timer = null;

  const skipDupes = () => form.elements.skip_dupes.checked;
  const toImport = () => state.rows.filter((r) => r.status === 'ok' || (r.status === 'dup' && !skipDupes()));
  const hasEarlier = (fy) => existing.some((t) => t.date < `${fy}-04-01`);

  function reparse() {
    state.parsed = parsePpfYear(raw.value);
    if (state.parsed.fyStart !== null && !fyInput.dataset.touched) fyInput.value = state.parsed.fyStart;
    rebuild();
  }

  function rebuild() {
    const fy = Number(fyInput.value) || null;
    const p = state.parsed;
    const showOpening = Boolean(p?.opening) && Boolean(fy) && !hasEarlier(fy);
    openingWrap.hidden = !showOpening;
    if (showOpening) {
      modal.querySelector('#opening-text').textContent = `Also record the balance the sheet brings into FY ${fyLabel(fy)} (${money(p.opening.balance)}) as a transfer in dated 1 April ${fy}, since no earlier year is in the app yet`;
    }
    state.rows = p && fy ? buildPpfRows(p, { fyStart: fy, existing, includeOpening: showOpening && form.elements.opening.checked, account: fund.folio_number || '' }) : [];
    renderPreview();
  }

  function renderPreview() {
    const p = state.parsed;
    if (!p || (!p.months.length && !p.opening)) {
      preview.innerHTML = raw.value.trim() ? '<p class="empty small">No month rows found. Each line should start with the month name (April … March).</p>' : '<p class="empty small">Paste a year above to see a preview.</p>';
      submit.disabled = true;
      submit.textContent = 'Import';
      return;
    }
    const fy = Number(fyInput.value) || null;
    const n = toImport().length;
    const dup = state.rows.filter((r) => r.status === 'dup').length;
    const rowsFor = (m) => state.rows.filter((r) => r.label && r.label.startsWith(`${m.month} `));
    const body = p.months
      .map((m) => {
        const rs = rowsFor(m);
        const st = !m.deposit ? 'no deposit' : !rs.length ? 'nothing to import' : rs.every((r) => r.status === 'dup') ? (skipDupes() ? 'Skipped · already recorded' : 'Duplicate · will import') : 'Ready';
        const cls = !rs.length || (rs.every((r) => r.status === 'dup') && skipDupes()) ? 'status-dup' : 'status-ok';
        return `<tr class="${cls}"><td class="status">${esc(st)}</td><td>${esc(m.month)}</td><td class="num">${money(m.deposit)}</td><td>${m.timing ? `${m.timing} the 5th` : '–'}</td><td class="num">${m.rate ?? '–'}</td><td class="num">${money(m.interest)}</td></tr>`;
      })
      .join('');
    const interest = state.rows.find((r) => r.type === 'BONUS')?.units || 0;
    preview.innerHTML = `
      <div class="preview-summary">${p.months.length} month${p.months.length === 1 ? '' : 's'}${fy ? ` of FY <b>${fyLabel(fy)}</b>` : ''} · <b>${n}</b> entr${n === 1 ? 'y' : 'ies'} to import${dup ? ` · ${dup} already recorded` : ''}${interest ? ` · interest for the year ${money(interest)}` : ' · no interest for the year yet'}
        ${!fy ? '<span class="danger-text"> · enter the financial year</span>' : ''}</div>
      ${p.warnings.map((w) => `<div class="banner warn small">${esc(w)}</div>`).join('')}
      <div class="preview-wrap"><table class="data preview"><thead><tr><th>Status</th><th>Month</th><th class="num">Deposit</th><th>Timing</th><th class="num">IR%</th><th class="num">Interest</th></tr></thead><tbody>${body}</tbody></table></div>`;
    submit.disabled = n === 0 || !fy;
    submit.textContent = n ? `Import ${n} entr${n === 1 ? 'y' : 'ies'}` : 'Import';
  }

  raw.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(reparse, 300); });
  form.elements.file.addEventListener('change', async () => {
    const f = form.elements.file.files[0];
    if (!f) return;
    raw.value = await f.text();
    reparse();
  });
  fyInput.addEventListener('input', () => { fyInput.dataset.touched = '1'; rebuild(); });
  form.elements.skip_dupes.addEventListener('change', renderPreview);
  form.elements.opening.addEventListener('change', rebuild);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const items = toImport().map((r) => ({ date: r.date, folio_number: r.folio || '', scheme: '', type: r.type, amount: r.amount, nav: 1, units: r.units, rate: r.rate, notes: r.notes || '' }));
    if (!items.length) return;
    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'Importing…';
    try {
      const res = await api.post(`/api/funds/${fund.id}/transactions/bulk`, { transactions: items });
      closeModal();
      toast(`Imported ${res.created} entr${res.created === 1 ? 'y' : 'ies'}`);
      onDone?.();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      submit.disabled = false;
      submit.textContent = label;
    }
  });
  raw.focus();
}

export function openImportModal(fund, onDone) {
  if (fund.kind === 'EPF') return openEpfImportModal(fund, onDone);
  if (fund.kind === 'PPF') return openPpfImportModal(fund, onDone);
  const w = wordsFor(fund);
  const nps = fund.kind === 'NPS';
  const gold = fund.kind === 'GOLD';
  const modal = openModal(`Import transactions · ${esc(fund.name)}`, formHtml(fund), { wide: true });
  const form = modal.querySelector('#import-form');
  const raw = form.elements.raw;
  const preview = modal.querySelector('#import-preview');
  const err = modal.querySelector('#import-error');
  const submit = modal.querySelector('#import-submit');
  const state = { rows: [], header: null, map: [], built: [] };
  let timer = null;

  const skipDupes = () => form.elements.skip_dupes.checked;
  const toImport = () => state.built.filter((r) => r.status === 'ok' || (r.status === 'dup' && !skipDupes()));
  // a gold bond's sheet ends with a "Current Value" line: its date and price can be recorded as the gold price
  const manualGold = gold && fund.gold?.price_source !== 'sgb'; // a bond priced from the exchange needs no entered price
  const priceLine = () => (manualGold ? state.built.find((r) => r.status === 'price' && r.date && r.nav > 0) : null);
  const recordPrice = () => Boolean(priceLine() && form.elements.gold_price?.checked);

  function reparse() {
    const { rows, header } = parseTable(raw.value);
    state.rows = rows;
    state.header = header;
    state.map = autoMap(header, rows);
    rebuild();
  }

  function rebuild() {
    state.built = buildRows(state.rows, state.map, {
      defaultType: form.elements.default_type.value,
      defaultFolio: fund.folio_number || '',
      existing: fund.transactions || [],
      splitFolios: !nps && form.elements.split_folios.checked,
      currency: fund.currency || 'INR',
    });
    renderPreview();
  }

  function nameWarning() {
    const i = state.map.indexOf('name');
    if (i < 0) return '';
    const summary = new Set(state.built.filter((b) => b.status === 'price').map((b) => b.index));
    const names = [...new Set(state.rows.map((r, idx) => (summary.has(idx) ? '' : r[i])).filter(Boolean))];
    if (names.length > 1 && !nps) {
      return `<div class="banner warn small">The rows mention ${names.length} different names. Everything imported here goes into <b>${esc(fund.name)}</b>. Paste one ${w.thing} at a time, or set that column to “ignore” if this is intended.</div>`;
    }
    if (names.length >= 1 && !names.some((n) => looselyMatches(n, fund))) {
      return `<div class="banner warn small">The data says “${esc(names[0])}” but this page is <b>${esc(fund.name)}</b>. Make sure you are importing into the right ${w.thing}.</div>`;
    }
    return '';
  }

  function renderPreview() {
    if (!state.rows.length) {
      preview.innerHTML = '<p class="empty small">Paste rows above to see a preview.</p>';
      submit.disabled = true;
      submit.textContent = 'Import';
      return;
    }
    const skip = skipDupes();
    const counts = { ok: 0, dup: 0, error: 0, price: 0 };
    state.built.forEach((r) => counts[r.status]++);
    const pl = priceLine();
    const priceWrap = modal.querySelector('#gold-price-wrap');
    if (priceWrap) {
      priceWrap.hidden = !pl;
      if (pl) modal.querySelector('#gold-price-text').textContent = `Also record the gold price ₹${pl.nav.toLocaleString('en-IN')} per gram as of ${pl.date} from the sheet's Current Value line (it values every gold bond)`;
    }
    const n = toImport().length;
    const splitRows = new Set(state.built.filter((b) => b.parts && !b.scheme).map((b) => b.index)).size;
    const needsMapping = !state.map.includes('date') || !(state.map.includes('amount') || state.map.some((f) => f.startsWith('units_')));
    const unknownSchemes = nps ? [...new Set(state.built.filter((b) => b.scheme && !(fund.details?.schemes || {})[b.scheme]).map((b) => b.scheme))] : [];

    const mapRow = state.map
      .map(
        (f, i) => `<th><select data-col="${i}" class="map-select" aria-label="Meaning of column ${i + 1}">${FIELDS.map(
          (x) => `<option value="${x}" ${x === f ? 'selected' : ''}>${FIELD_LABELS[x]}</option>`,
        ).join('')}</select>${state.header ? `<div class="muted small">${esc(state.header[i])}</div>` : ''}</th>`,
      )
      .join('');

    const body = state.built
      .slice(0, PREVIEW_LIMIT)
      .map((b) => {
        const cls = b.status === 'error' ? 'status-err' : (b.status === 'dup' && skip) || b.status === 'price' ? 'status-dup' : 'status-ok';
        const base = b.message || 'Ready';
        const label = b.status === 'error' ? b.message
          : b.status === 'price' ? (manualGold && b.nav > 0 && b.date ? `Gold price · ₹${b.nav.toLocaleString('en-IN')} per gram on ${b.date}` : gold ? 'Skipped · summary line (this bond is priced from the exchange)' : 'Skipped · summary line')
          : b.status === 'dup' ? `${b.scheme ? `${b.scheme}: ` : ''}${skip ? 'Skipped · already recorded' : 'Duplicate · will import'}`
          : b.scheme ? base
          : b.type === 'REDEMPTION' ? `${w.sell} · ${base === 'Ready' ? `${b.units ?? '?'} ${w.units} sold` : base}`
          : b.type === 'DIVIDEND' ? `${gold ? 'Interest' : 'Dividend'} · ${b.amount.toLocaleString('en-IN')} ${fund.currency || 'INR'} received`
          : b.type === 'BONUS' ? `Bonus · ${b.units} free ${w.units}`
          : b.type === 'CHARGE' ? `Charges · ${b.units} ${w.units} deducted${b.message && b.message !== 'Ready' ? ` · ${b.message}` : ''}`
          : TYPE_WORDS[b.type] && base === 'Ready' ? TYPE_WORDS[b.type] : base;
        const cells = state.rows[b.index].map((c) => `<td title="${esc(c)}">${esc(c)}</td>`).join('');
        return `<tr class="${cls}${b.parts ? ' split-row' : ''}"><td class="status">${esc(label)}</td>${cells}</tr>`;
      })
      .join('');
    const more = state.built.length > PREVIEW_LIMIT ? `<p class="muted small">…and ${state.built.length - PREVIEW_LIMIT} more (all will be imported)</p>` : '';

    preview.innerHTML = `
      <div class="preview-summary">${state.rows.length} row${state.rows.length === 1 ? '' : 's'} · <b>${n}</b> transaction${n === 1 ? '' : 's'} to import${splitRows ? ` · ${splitRows} row${splitRows === 1 ? '' : 's'} split across ${w.folio}s` : ''}${counts.dup ? ` · ${counts.dup} already recorded` : ''}${counts.error ? ` · <span class="danger-text">${counts.error} with errors (skipped)</span>` : ''}
        ${needsMapping ? '<span class="danger-text"> · map the Date and Amount columns using the dropdowns</span>' : ''}</div>
      ${unknownSchemes.length ? `<div class="banner warn small">The data has units for scheme${unknownSchemes.length === 1 ? '' : 's'} <b>${esc(unknownSchemes.join(', '))}</b>, which this account is not set up with. Add the scheme under Edit NPS first, or set that column to “ignore”.</div>` : ''}
      ${nameWarning()}
      <div class="preview-wrap"><table class="data preview"><thead><tr><th>Status</th>${mapRow}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
    submit.disabled = (n === 0 && !recordPrice()) || unknownSchemes.length > 0;
    submit.textContent = n ? `Import ${n} transaction${n === 1 ? '' : 's'}${recordPrice() ? ' + gold price' : ''}` : recordPrice() ? 'Record the gold price' : 'Import';
  }
  form.elements.gold_price?.addEventListener('change', renderPreview);

  raw.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(reparse, 300);
  });
  form.elements.file.addEventListener('change', async () => {
    const f = form.elements.file.files[0];
    if (!f) return;
    raw.value = await f.text();
    reparse();
  });
  form.elements.default_type.addEventListener('change', rebuild);
  form.elements.split_folios.addEventListener('change', rebuild);
  form.elements.skip_dupes.addEventListener('change', renderPreview);
  preview.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-col]');
    if (!sel) return;
    const col = Number(sel.dataset.col);
    state.map.forEach((f, i) => { if (i !== col && f === sel.value && f !== 'ignore') state.map[i] = 'ignore'; });
    state.map[col] = sel.value;
    rebuild();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const batchNote = form.elements.batch_note.value.trim();
    const items = toImport().map((r) => ({
      date: r.date,
      folio_number: r.folio || '',
      scheme: r.scheme || '',
      type: r.type,
      amount: r.amount,
      nav: r.nav,
      units: r.units,
      notes: r.notes || batchNote,
    }));
    // A split row's own comment is kept; the batch comment is only used for rows that have none.
    const pl = recordPrice() ? priceLine() : null;
    if (!items.length && !pl) return;
    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'Importing…';
    try {
      if (pl) await api.post('/api/gold/price', { date: pl.date, price: pl.nav });
      const res = items.length ? await api.post(`/api/funds/${fund.id}/transactions/bulk`, { transactions: items }) : { created: 0 };
      closeModal();
      toast(`${items.length ? `Imported ${res.created} transaction${res.created === 1 ? '' : 's'}` : ''}${pl ? `${items.length ? ' · ' : ''}gold price recorded for ${pl.date}` : ''}`);
      onDone?.();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      submit.disabled = false;
      submit.textContent = label;
    }
  });

  raw.focus();
}
