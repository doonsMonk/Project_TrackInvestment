// Bulk import of transactions: paste rows from Excel / Sheets / CSV, preview, then save in one request.
// Works for mutual funds (NAV, units, folio), stocks (price, shares, account) and NPS accounts (one row
// per contribution with units and NAV per scheme E / C / G, which expands into one transaction per scheme).

import { api } from './api.js';
import { esc } from './format.js';
import { openModal, closeModal, toast } from './ui.js';
import { FIELDS, FIELD_LABELS, parseTable, autoMap, buildRows, parseEpfYear, buildEpfRows, fyLabel } from './parse.js';

const PREVIEW_LIMIT = 200;
const NOISE_WORDS = new Set(['fund', 'plan', 'growth', 'direct', 'regular', 'the', 'and', 'option', 'scheme', 'ltd', 'limited', 'inc', 'corp', 'plc', 'tier', 'pension']);
const TYPE_WORDS = { SWITCH_IN: 'Switch in', SWITCH_OUT: 'Switch out', CHARGE: 'Charges', REDEMPTION: 'Sale', DIVIDEND: 'Dividend', BONUS: 'Bonus' };

function wordsFor(fund) {
  if (fund.kind === 'NPS') {
    return { price: 'NAV', units: 'units', folio: 'PRAN', sell: 'Withdrawal', buy: 'Contribution', thing: 'NPS account',
      example: '6765656545 | ICICI PRUDENTIAL PENSION FUND SCHEME E,C,G - TIER I | SIP | 3-May-2018 | -50,000.00 | 1383.5034 | 206.4528 | 367.8363 | 26.5703 | 24.7441 | 21.0116' };
  }
  const stock = fund.kind === 'STOCK';
  return stock
    ? { price: 'price', units: 'shares', folio: 'account', sell: 'Sell', buy: 'Buy', thing: 'stock',
        example: 'ESPP-1 | Acme Leisure | Buy | 15-Jan-2024 | -4,000.00 | 100 | 40.00' }
    : { price: 'NAV', units: 'units', folio: 'folio', sell: 'Redemption', buy: 'Lumpsum', thing: 'fund',
        example: '1234567 | ICICI Prudential Nifty 50 Index Fund | SIP | 11-Mar-2019 | -10,000.00 | 90.7050 | 110.2469' };
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
    <label class="check" ${fund.kind === 'NPS' ? 'hidden' : ''}><input type="checkbox" name="split_folios" checked> Split rows that list several ${w.folio}s (e.g. 7999131051/79935563576) equally between them: one transaction per ${w.folio} with half the amount and ${w.units}</label>
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
      <textarea name="raw" rows="8" spellcheck="false" placeholder="Balance | 1960 | 599 | 1361 |  | 2011-2012 |  | 1973 | 603&#10;Month | Deposit (Employee) | Deposit (Employer) | Pension Contr | IR% | Interest Employee | Interest Employer | Balance Employee | Balance Employer&#10;April | 750 | 229 | 521 | 8.25 | 0 | 0 | 2723 | 832&#10;…&#10;March | 1113 | 572 | 541 | 8.25 | 606 | 249 | 14222 | 6380"></textarea>
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

export function openImportModal(fund, onDone) {
  if (fund.kind === 'EPF') return openEpfImportModal(fund, onDone);
  const w = wordsFor(fund);
  const nps = fund.kind === 'NPS';
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
    const names = [...new Set(state.rows.map((r) => r[i]).filter(Boolean))];
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
    const counts = { ok: 0, dup: 0, error: 0 };
    state.built.forEach((r) => counts[r.status]++);
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
        const cls = b.status === 'error' ? 'status-err' : b.status === 'dup' && skip ? 'status-dup' : 'status-ok';
        const base = b.message || 'Ready';
        const label = b.status === 'error' ? b.message
          : b.status === 'dup' ? `${b.scheme ? `${b.scheme}: ` : ''}${skip ? 'Skipped · already recorded' : 'Duplicate · will import'}`
          : b.scheme ? base
          : b.type === 'REDEMPTION' ? `${w.sell} · ${base === 'Ready' ? `${b.units ?? '?'} ${w.units} sold` : base}`
          : b.type === 'DIVIDEND' ? `Dividend · ${b.amount.toLocaleString('en-IN')} ${fund.currency || 'INR'} received`
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
    submit.disabled = n === 0 || unknownSchemes.length > 0;
    submit.textContent = n ? `Import ${n} transaction${n === 1 ? '' : 's'}` : 'Import';
  }

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
    if (!items.length) return;
    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'Importing…';
    try {
      const res = await api.post(`/api/funds/${fund.id}/transactions/bulk`, { transactions: items });
      closeModal();
      toast(`Imported ${res.created} transaction${res.created === 1 ? '' : 's'}`);
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
