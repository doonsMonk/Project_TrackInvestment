// Import a CAMS / KFintech consolidated account statement (CAS): the PDF is read by the backend, the page shows what
// it found scheme by scheme (which holding each one is, or could be), and imports with the usual routes: a holding
// created where needed, then the transactions the holding does not have yet.

import { api } from './api.js';
import { fmtMoney, fmtNum, fmtDate, esc, isNum } from './format.js';
import { openModal, closeModal, toast } from './ui.js';

const TYPE_LABEL = { SIP: 'SIP', LUMPSUM: 'Purchase', REDEMPTION: 'Redemption', DIVIDEND: 'Dividend / IDCW' };
const SKIP_WHY = { tax: 'stamp duty / STT / TDS, not a transaction', reversal: 'reversed or rejected', segregation: 'segregated portfolio', other: 'no units, no money' };

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('The file could not be read'));
  r.readAsDataURL(file);
});

export function openCasImportModal(onDone) {
  const modal = openModal('Import a CAS statement', `
  <form id="cas-form" class="form" novalidate>
    <p class="hint">Ask CAMS or KFintech for the <b>detailed</b> consolidated account statement by email (their "CAS" or "mailback" pages): one PDF lists every transaction of every mutual fund you hold, across fund houses, for the period you choose. Pick that PDF here and type its password, usually your PAN. The file stays on this device.</p>
    <div class="form-row">
      <label class="field">Statement PDF
        <input type="file" name="file" accept=".pdf,application/pdf">
      </label>
      <label class="field">PDF password
        <input type="password" name="password" autocomplete="off" placeholder="usually your PAN">
      </label>
    </div>
    <div class="form-error" id="cas-error" hidden></div>
    <div id="cas-preview"></div>
    <div class="form-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary" id="cas-submit">Read the statement</button>
    </div>
  </form>`, { wide: true });
  const form = modal.querySelector('#cas-form');
  const err = modal.querySelector('#cas-error');
  const preview = modal.querySelector('#cas-preview');
  const submit = modal.querySelector('#cas-submit');
  let statement = null; // what the backend read
  let funds = [];
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };

  const plan = () => {
    // one line per scheme: what the user chose in its select, and the transactions that would go in
    const out = [];
    for (const sel of preview.querySelectorAll('select[data-scheme]')) {
      const [fi, si] = sel.dataset.scheme.split('.').map(Number);
      const folio = statement.folios[fi];
      const sc = folio.schemes[si];
      const v = sel.value;
      const fresh = sc.transactions.filter((t) => !t.existing_id && !t.replace_id);
      const replace = sc.transactions.filter((t) => t.replace_id);
      if (v === 'skip' || !v) { out.push({ folio, sc, action: 'skip', txns: [], replace: [] }); continue; }
      if (v.startsWith('fund:')) out.push({ folio, sc, action: 'fund', fund_id: Number(v.slice(5)), txns: fresh, replace });
      else if (v.startsWith('new:')) { const code = Number(v.slice(4)); out.push({ folio, sc, action: 'new', scheme_code: code, name: sel.selectedOptions[0]?.dataset.name || sc.name, txns: sc.transactions, replace: [] }); }
    }
    return out;
  };

  const renderPreview = () => {
    const st = statement;
    const mf = funds.filter((f) => f.kind === 'MF');
    const blocks = [];
    st.folios.forEach((folio, fi) => folio.schemes.forEach((sc, si) => {
      const m = sc.match || {};
      const options = [];
      if (m.fund_id) options.push(`<option value="fund:${m.fund_id}" selected>Add to ${esc(m.fund_name)} (matched by ${m.by === 'code' ? 'scheme code' : 'folio and name'})</option>`);
      if (m.scheme_code) options.push(`<option value="new:${m.scheme_code}" data-name="${esc(sc.name)}" ${m.fund_id ? '' : 'selected'}>Create a new holding: ${esc(m.scheme_code_name || sc.name)} (code ${m.scheme_code})</option>`);
      (m.candidates || []).forEach((c, i) => { if (c.scheme_code !== m.scheme_code) options.push(`<option value="new:${c.scheme_code}" data-name="${esc(sc.name)}" ${!m.fund_id && !m.scheme_code && i === 0 ? 'selected' : ''}>Create a new holding as ${esc(c.scheme_name)} (code ${c.scheme_code})</option>`); });
      mf.filter((f) => f.id !== m.fund_id).forEach((f) => options.push(`<option value="fund:${f.id}">Add to ${esc(f.name)}</option>`));
      options.push(`<option value="skip" ${!options.some((o) => o.includes('selected')) ? 'selected' : ''}>Skip this scheme</option>`);
      const fresh = sc.transactions.filter((t) => !t.existing_id).length;
      const dup = sc.transactions.length - fresh;
      const rows = sc.transactions.map((t) => `<tr class="${t.existing_id ? 'status-dup' : 'status-ok'}"><td class="status">${t.existing_id ? 'Already recorded' : t.replace_id ? `${TYPE_LABEL[t.type] || t.type} · replaces the instalment recorded from the SIP schedule` : TYPE_LABEL[t.type] || t.type}</td><td>${fmtDate(t.date)}</td><td title="${esc(t.notes || '')}">${esc(t.notes || TYPE_LABEL[t.type] || t.type)}</td><td class="num">${fmtMoney(t.amount, 'INR', 2)}</td><td class="num">${t.units ? fmtNum(t.units, 3) : '–'}</td><td class="num">${isNum(t.nav) ? fmtNum(t.nav, 4) : '–'}</td></tr>`)
        .concat(sc.skipped.map((t) => `<tr class="status-dup"><td class="status">Skipped · ${SKIP_WHY[t.why] || t.why}</td><td>${fmtDate(t.date)}</td><td>${esc(t.description)}</td><td class="num">${isNum(t.amount) ? fmtMoney(Math.abs(t.amount), 'INR', 2) : ''}</td><td></td><td></td></tr>`))
        .join('');
      blocks.push(`
        <div class="cas-scheme">
          <div class="cas-scheme-head">
            <div><b>${esc(sc.name)}</b><div class="muted small">${esc(folio.amc || '')} · folio ${esc(folio.folio)} · ${esc(sc.rta || '')}${sc.isin ? ` · ISIN ${esc(sc.isin)}` : ''} · ${isNum(sc.close) ? `${fmtNum(sc.close, 3)} units at the end` : ''}${isNum(sc.value) ? ` · worth ${fmtMoney(sc.value, 'INR')} on ${fmtDate(sc.valuation_date)}` : ''}</div></div>
            <label class="field">Goes to <select data-scheme="${fi}.${si}">${options.join('')}</select></label>
          </div>
          <div class="muted small">${fresh} new transaction${fresh === 1 ? '' : 's'}${dup ? ` · ${dup} already recorded` : ''}${sc.skipped.length ? ` · ${sc.skipped.length} skipped` : ''}${!m.fund_id && !m.scheme_code && !(m.candidates || []).length ? ' · <b>no matching scheme found: pick a holding, or add the fund first and read the statement again</b>' : ''}</div>
          <div class="preview-wrap"><table class="data preview"><thead><tr><th>Status</th><th>Date</th><th>Description</th><th class="num">Amount</th><th class="num">Units</th><th class="num">NAV</th></tr></thead><tbody>${rows}</tbody></table></div>
        </div>`);
    }));
    const nSchemes = st.folios.reduce((n, f) => n + f.schemes.length, 0);
    preview.innerHTML = `
      <div class="preview-summary">${esc(st.source === 'KFINTECH' ? 'KFintech' : st.source === 'CAMS' ? 'CAMS' : 'Statement')} · ${fmtDate(st.period.from)} to ${fmtDate(st.period.to)} · ${st.folios.length} folio${st.folios.length === 1 ? '' : 's'} · ${nSchemes} scheme${nSchemes === 1 ? '' : 's'}</div>
      ${st.scheme_list_error ? `<div class="banner warn small">mfapi.in's scheme list could not be fetched (${esc(st.scheme_list_error)}), so new schemes cannot be created from this statement right now; existing holdings are matched by folio and name.</div>` : ''}
      ${blocks.join('')}
      <p class="hint">Purchases and SIPs come in with the units and NAV the statement shows; stamp duty, STT and reversed entries are not transactions and are left out. A switch is recorded as a redemption in one fund and a purchase in the other. Entries already in the app are skipped.</p>`;
    const update = () => {
      const p = plan();
      const n = p.reduce((s, x) => s + x.txns.length, 0);
      const r = p.reduce((s, x) => s + (x.replace || []).length, 0);
      const created = p.filter((x) => x.action === 'new').length;
      submit.textContent = n || created || r ? `Import ${n} transaction${n === 1 ? '' : 's'}${r ? ` · update ${r} from the schedule` : ''}${created ? ` · create ${created} holding${created === 1 ? '' : 's'}` : ''}` : 'Nothing to import';
      submit.disabled = !(n || created || r);
    };
    preview.querySelectorAll('select[data-scheme]').forEach((sel) => sel.addEventListener('change', update));
    update();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (!statement) {
      const file = form.elements.file.files[0];
      if (!file) return fail('Pick the statement PDF first.');
      submit.disabled = true;
      submit.textContent = 'Reading…';
      try {
        const [pdf_base64, list] = await Promise.all([fileToBase64(file), api.get('/api/funds')]);
        funds = list;
        statement = await api.post('/api/import/cas', { pdf_base64, password: form.elements.password.value });
        form.elements.file.disabled = true;
        form.elements.password.disabled = true;
        renderPreview();
      } catch (e2) {
        fail(e2.message);
        submit.disabled = false;
        submit.textContent = 'Read the statement';
      }
      return;
    }
    const p = plan().filter((x) => x.action !== 'skip');
    submit.disabled = true;
    submit.textContent = 'Importing…';
    let created = 0;
    let added = 0;
    try {
      for (const x of p) {
        let fundId = x.fund_id;
        if (x.action === 'new') {
          const saved = await api.post('/api/funds', { name: x.name, kind: 'MF', scheme_code: x.scheme_code, symbol: null, details: null, folio_number: x.folio.folio, locked: false, lock_in_until: null, notes: '' });
          fundId = saved.id;
          created += 1;
          if (saved.nav_error) toast(`${x.name}: prices could not be fetched yet (${saved.nav_error})`, 'warn');
        }
        for (const t of x.replace || []) {
          await api.put(`/api/transactions/${t.replace_id}`, { date: t.date, folio_number: x.folio.folio, scheme: '', type: t.type, amount: t.amount, units: t.units, nav: t.nav, notes: t.notes || '' });
          added += 1;
        }
        if (!x.txns.length) continue;
        const res = await api.post(`/api/funds/${fundId}/transactions/bulk`, {
          transactions: x.txns.map((t) => ({ date: t.date, folio_number: x.folio.folio, scheme: '', type: t.type, amount: t.amount, units: t.units, nav: t.nav, notes: t.notes || '' })),
        });
        added += res.created || 0;
      }
      closeModal();
      toast(`Imported ${added} transaction${added === 1 ? '' : 's'}${created ? ` and created ${created} holding${created === 1 ? '' : 's'}` : ''} from the statement`);
      onDone?.();
    } catch (e2) {
      fail(`${e2.message} · ${added} transaction${added === 1 ? '' : 's'} and ${created} holding${created === 1 ? '' : 's'} were imported before the error; read the statement again to continue, already recorded entries will be skipped.`);
      submit.disabled = false;
      submit.textContent = 'Import';
    }
  });
}
