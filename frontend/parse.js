// Pure parsing helpers for importing tabular transaction data.
// No DOM access here so it can be unit-tested in Node.

export const NPS_SCHEMES = ['E', 'C', 'G', 'A'];
const NPS_FIELDS = NPS_SCHEMES.flatMap((l) => [`units_${l.toLowerCase()}`, `nav_${l.toLowerCase()}`]);

export const FIELDS = ['ignore', 'folio', 'name', 'type', 'date', 'amount', 'units', 'nav', 'notes', ...NPS_FIELDS];
export const FIELD_LABELS = {
  ignore: '— ignore —',
  folio: 'Folio / account',
  name: 'Name',
  type: 'Type',
  date: 'Date',
  amount: 'Amount',
  units: 'Units / shares',
  nav: 'NAV / price',
  notes: 'Comment',
  ...Object.fromEntries(NPS_SCHEMES.flatMap((l) => [[`units_${l.toLowerCase()}`, `Units ${l} (NPS)`], [`nav_${l.toLowerCase()}`, `NAV ${l} (NPS)`]])),
};

// Order matters: NPS per-scheme columns ("Quantity Purchased E", "Purchased at NAV G") must be matched
// before the generic units / NAV hints; "Type of Investment" must hit `type` before `amount` sees "invest";
// "Quantity Purchased" must hit `units` before anything sees "purchase".
const HEADER_HINTS = [
  ...NPS_SCHEMES.map((l) => [`units_${l.toLowerCase()}`, new RegExp(`(?:unit|quantity|qty)[^\\n]*\\b${l}\\b\\s*$`, 'i')]),
  ...NPS_SCHEMES.map((l) => [`nav_${l.toLowerCase()}`, new RegExp(`(?:\\bnav\\b|price)[^\\n]*\\b${l}\\b\\s*$`, 'i')]),
  ['folio', /folio|account|demat|client\s*(id|code)|\bpran\b/i],
  ['date', /date/i],
  ['units', /unit|quantity|qty|shares/i],
  ['nav', /\bnav\b|price|rate/i],
  ['type', /\btype\b|transaction|nature|mode|action|side|buy\s*\/\s*sell/i],
  ['name', /scheme|fund|mf\s*name|^name$|symbol|ticker|stock|scrip|company|security/i],
  ['amount', /amount|value|invest|cost|consideration|contribution/i],
  ['notes', /comment|note|remark/i],
];

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

// ------------------------------------------------------------------ table splitting

function detectDelimiter(lines) {
  const sample = lines.slice(0, 5);
  const count = (ch) => sample.reduce((s, l) => s + (l.split(ch).length - 1), 0);
  if (count('\t') > 0) return '\t';
  if (count('|') >= sample.length) return '|';
  if (count(';') > count(',')) return ';';
  return ',';
}

function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
    } else if (c === delim && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function looksLikeHeader(cells) {
  let hits = 0;
  for (const c of cells) if (HEADER_HINTS.some(([, re]) => re.test(c))) hits++;
  const hasData = cells.some((c) => parseDate(c) || (parseNumber(c) !== null && Math.abs(parseNumber(c)) > 100));
  return hits >= 2 && !hasData;
}

/** A spreadsheet cell can hold a line break inside quotes ("Deposit\n(Employee)"); keep such cells on one line. */
function joinQuotedLines(text) {
  let out = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if ((ch === '\n' || ch === '\r') && quoted) { out += ' '; continue; }
    out += ch;
  }
  return out;
}

/** Rows of cells from pasted text, no header detection. Handles TSV, CSV, semicolons and markdown pipes. */
function splitRows(text) {
  const lines = joinQuotedLines(String(text || ''))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^[\s|:\-+]+$/.test(l)); // drop blank and markdown separator rows
  if (!lines.length) return { rows: [], delimiter: null };
  const delimiter = detectDelimiter(lines);
  let rows = lines.map((l) => splitLine(delimiter === '|' ? l.replace(/^\|/, '').replace(/\|$/, '') : l, delimiter));
  if (delimiter !== '|') rows = rows.map((r) => r.filter((c) => c !== '|')); // "|<tab>cell<tab>|" copies from a sheet
  const width = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => (r.length < width ? [...r, ...new Array(width - r.length).fill('')] : r));
  return { rows, delimiter };
}

/** Split pasted text into { rows, header, delimiter }. Handles TSV, CSV, semicolons and markdown pipes. */
export function parseTable(text) {
  const { rows, delimiter } = splitRows(text);
  if (!rows.length) return { rows: [], header: null, delimiter: null };
  const header = looksLikeHeader(rows[0]) ? rows.shift() : null;
  return { rows, header, delimiter };
}

/** Guess which field each column holds. Returns an array of FIELDS values, one per column. */
export function autoMap(header, rows) {
  const width = header ? header.length : rows[0]?.length || 0;
  const map = new Array(width).fill('ignore');
  if (header) {
    const used = new Set();
    header.forEach((h, i) => {
      for (const [field, re] of HEADER_HINTS) {
        if (re.test(h) && !used.has(field)) { map[i] = field; used.add(field); break; }
      }
    });
    return map;
  }
  if (width === 7) return ['folio', 'name', 'type', 'date', 'amount', 'units', 'nav'];
  if (width === 11) return ['folio', 'name', 'type', 'date', 'amount', 'units_e', 'units_c', 'units_g', 'nav_e', 'nav_c', 'nav_g']; // NPS statement
  // No header: infer what we safely can from the content.
  const sample = rows.slice(0, 25);
  const numeric = [];
  for (let i = 0; i < width; i++) {
    const vals = sample.map((r) => r[i]).filter((v) => v !== '');
    if (!vals.length) continue;
    const dates = vals.filter((v) => parseDate(v)).length;
    const nums = vals.filter((v) => parseNumber(v) !== null).length;
    if (dates / vals.length >= 0.6) map[i] = 'date';
    else if (vals.some((v) => /\b(sip|lump\s*sum|purchase|systematic|buy|sell|bought|sold)\b/i.test(v))) map[i] = 'type';
    else if (nums / vals.length >= 0.8) numeric.push(i);
    else if (vals.every((v) => /^[\w\/\-]+$/.test(v)) && vals.every((v) => /\d/.test(v))) map[i] = 'folio';
    else map[i] = 'name';
  }
  if (numeric.length) {
    const mean = (i) => sample.reduce((s, r) => s + Math.abs(parseNumber(r[i]) || 0), 0) / sample.length;
    numeric.sort((a, b) => mean(b) - mean(a));
    map[numeric[0]] = 'amount'; // the biggest numbers are the amounts; units vs NAV is left to the user
  }
  return map;
}

// ------------------------------------------------------------------ cell parsing

function iso(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 100) y += y <= 69 ? 2000 : 1900;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Accepts 11-Mar-2019, 11 March 2019, Mar 11, 2019, 11/03/2019, 11-03-19, 2019-03-11. Returns ISO or null. */
export function parseDate(s) {
  const v = String(s ?? '').trim();
  if (!v) return null;
  let m;
  if ((m = v.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[T\s].*)?$/))) return iso(m[1], m[2], m[3]);
  if ((m = v.match(/^(\d{1,2})[-\/.\s]+([A-Za-z]{3,9})[-\/.,\s]+(\d{2,4})$/))) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mon ? iso(m[3], mon, m[1]) : null;
  }
  if ((m = v.match(/^([A-Za-z]{3,9})[-\/.\s]+(\d{1,2}),?[-\/.\s]+(\d{2,4})$/))) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mon ? iso(m[3], mon, m[2]) : null;
  }
  if ((m = v.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/))) {
    let [, a, b, y] = m;
    if (Number(a) <= 12 && Number(b) > 12) [a, b] = [b, a]; // clearly MM-DD-YYYY
    return iso(y, b, a); // Indian default: DD-MM-YYYY
  }
  return null;
}

/** "-10,000.00" -> -10000, "(1,500)" -> -1500, "₹ 5,000" -> 5000. Returns null when not a number. */
export function parseNumber(s) {
  let v = String(s ?? '').trim();
  if (!v) return null;
  const negParen = /^\(.*\)$/.test(v);
  v = v.replace(/[^\d.\-]/g, '');
  if (!v || v === '-' || v === '.') return null;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return negParen ? -Math.abs(n) : n;
}

export function parseType(s, fallback = 'SIP') {
  const v = String(s ?? '');
  if (/reinvest/i.test(v)) return 'LUMPSUM'; // "dividend reinvestment" buys units with the payout
  if (/dividend|\bdiv\b|payout|idcw|income\s*distribution/i.test(v)) return 'DIVIDEND';
  if (/bonus|\bfree\b|split|\bgift/i.test(v)) return 'BONUS';
  if (/charge|\bfee|maintenance|deduct/i.test(v)) return 'CHARGE';
  if (/redeem|redemption|\bsell\b|\bsold\b|switch[\s-]*out|\bswp\b|withdraw|^\s*s\s*$/i.test(v)) return 'REDEMPTION';
  if (/\bsip\b|systematic|contribution/i.test(v)) return 'SIP';
  if (/lump|purchase|buy|bought|one[\s-]?time|additional|switch|^\s*b\s*$/i.test(v)) return 'LUMPSUM';
  return fallback;
}

// ------------------------------------------------------------------ multi-folio rows

/**
 * "7999131051/79935563576" -> ['7999131051', '79935563576'] (a purchase spread over two folios).
 * Returns null for a single folio, including forms like "1234567/89" or "PP/1001" where the part after
 * the separator is only a short suffix rather than a full folio number.
 */
export function splitFolios(folio) {
  const parts = String(folio || '')
    .split(/\s*[\/,;&|]\s*|\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  if (!parts.every((p) => p.replace(/\D/g, '').length >= 5)) return null;
  return parts;
}

/** Split `total` into n parts with the given decimals; the last part absorbs rounding so the parts add up exactly. */
export function distribute(total, n, decimals) {
  const f = 10 ** decimals;
  const share = Math.floor(Math.round(total * f) / n) / f;
  const parts = new Array(n).fill(share);
  parts[n - 1] = Math.round((total - share * (n - 1)) * f) / f;
  return parts;
}

// ------------------------------------------------------------------ EPF financial-year tables

const EPF_MONTHS = ['april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'january', 'february', 'march'];
const EPF_HINTS = [
  ['int_ee', /interest[\s\S]*employee|employee[\s\S]*interest/i],
  ['int_er', /interest[\s\S]*employer|employer[\s\S]*interest/i],
  ['ee', /(deposit|contrib)[\s\S]*employee|employee[\s\S]*(deposit|contrib)/i],
  ['er', /(deposit|contrib)[\s\S]*employer|employer[\s\S]*(deposit|contrib)/i],
  ['eps', /pension|\beps\b/i],
  ['rate', /\bir\b|rate|%/i],
];

export const fyLabel = (start) => `${start}-${String((start + 1) % 100).padStart(2, '0')}`;

/** "2010-2011", "2010-11", "FY 2010-11" -> 2010; null when the text holds no financial year. */
export function parseFinancialYear(s) {
  const m = String(s || '').match(/(?:^|[^\d])((?:19|20)\d{2})\s*[-–\/]\s*((?:19|20)?\d{2})(?!\d)/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2].length === 2 ? m[1].slice(0, 2) + m[2] : m[2]);
  return end === start + 1 ? start : null;
}

/**
 * Read one financial year's EPF sheet: an optional "Balance" line (deposits to date, the year label and
 * closing balances brought forward), a header line starting with "Month", one line per month with the
 * employee / employer deposits, pension contribution, interest rate and the interest credited, and total
 * lines (ignored). Returns { fyStart, opening, months, warnings }; `months` are in April..March order.
 */
export function parseEpfYear(text) {
  const { rows } = splitRows(text);
  const warnings = [];
  const first = (r) => r.find((c) => c !== '') || '';
  const headerRow = rows.find((r) => /^month$/i.test(first(r)));
  let map = { month: 0, ee: 1, er: 2, eps: 3, rate: 4, int_ee: 5, int_er: 6 }; // the sheet's column order
  if (headerRow) {
    const found = {};
    headerRow.forEach((h, i) => {
      if (/^month$/i.test(h)) { found.month = i; return; }
      for (const [field, re] of EPF_HINTS) if (found[field] === undefined && re.test(h)) { found[field] = i; break; }
    });
    if (found.ee !== undefined && found.er !== undefined) map = { ...map, ...found };
    else warnings.push('Could not recognise the deposit columns from the header; using the standard column order.');
  }
  let fyStart = null;
  let opening = null;
  const balanceRow = rows.find((r) => /^(opening\s+)?balance$/i.test(first(r)));
  if (balanceRow) {
    const nums = balanceRow.slice(1).map((c) => (parseFinancialYear(c) !== null ? null : parseNumber(c)));
    const vals = nums.filter((n) => n !== null);
    fyStart = balanceRow.map(parseFinancialYear).find((y) => y !== null) ?? null;
    if (vals.length >= 3) {
      opening = { deposit_ee: vals[0], deposit_er: vals[1], pension: vals[2], balance_ee: vals[3] ?? vals[0], balance_er: vals[4] ?? vals[1] };
      if (!(opening.deposit_ee || opening.deposit_er || opening.pension)) opening = null;
    }
  }
  if (fyStart === null) {
    for (const r of rows) for (const c of r) { const y = parseFinancialYear(c); if (y !== null) { fyStart = y; break; } }
  }
  const months = [];
  for (const r of rows) {
    const idx = EPF_MONTHS.indexOf(String(r[map.month] || '').trim().toLowerCase().slice(0, 9).replace(/[^a-z]/g, ''));
    if (idx < 0) continue;
    const num = (field) => (map[field] === undefined ? 0 : parseNumber(r[map[field]]) ?? 0);
    const rateRaw = map.rate === undefined ? null : parseNumber(r[map.rate]);
    months.push({ index: idx, month: EPF_MONTHS[idx][0].toUpperCase() + EPF_MONTHS[idx].slice(1), ee: num('ee'), er: num('er'), eps: num('eps'), rate: rateRaw, int_ee: num('int_ee'), int_er: num('int_er') });
  }
  months.sort((a, b) => a.index - b.index);
  const seen = new Set();
  for (const m of months) { if (seen.has(m.index)) warnings.push(`${m.month} appears more than once.`); seen.add(m.index); }
  return { fyStart, opening, months, warnings };
}

/**
 * Transactions for one EPF year from parseEpfYear's result: deposits dated the 15th of each month (employee,
 * employer and pension shares separately), the year's interest on 31 March, and optionally the opening
 * balances brought forward (deposits as a transfer in, interest to date as interest) dated 1 April.
 * existing: the account's current transactions, used to flag duplicates.
 */
export function buildEpfRows(parsed, { fyStart, existing = [], includeOpening = false, uan = '' } = {}) {
  const fy = fyStart ?? parsed.fyStart;
  const out = [];
  if (fy === null || fy === undefined) return out;
  const label = fyLabel(fy);
  const push = (row) => {
    const dup = existing.find((t) => t.date === row.date && t.scheme === row.scheme && t.type === row.type
      && Math.abs((row.type === 'BONUS' ? t.units : t.amount) - (row.type === 'BONUS' ? row.units : row.amount)) < 0.01);
    out.push({ status: dup ? 'dup' : 'ok', folio: uan, notes: '', ...row });
  };
  if (includeOpening && parsed.opening) {
    const o = parsed.opening;
    const date = `${fy}-04-01`;
    for (const [scheme, amount] of [['EE', o.deposit_ee], ['ER', o.deposit_er], ['EPS', o.pension]]) {
      if (amount > 0) push({ date, scheme, type: 'LUMPSUM', amount, units: amount, nav: 1, rate: null, notes: `Opening balance brought forward into FY ${label}`, label: `Opening ${scheme} balance ₹${amount.toLocaleString('en-IN')}` });
    }
    for (const [scheme, interest] of [['EE', o.balance_ee - o.deposit_ee], ['ER', o.balance_er - o.deposit_er]]) {
      if (interest > 0.005) push({ date, scheme, type: 'BONUS', amount: 0, units: Math.round(interest * 100) / 100, nav: 1, rate: null, notes: `Interest credited before FY ${label}`, label: `Opening ${scheme} interest ₹${interest.toLocaleString('en-IN')}` });
    }
  }
  let intEe = 0;
  let intEr = 0;
  let rate = null;
  for (const m of parsed.months) {
    const year = m.index < 9 ? fy : fy + 1;
    const monthNum = ((m.index + 3) % 12) + 1;
    const date = `${year}-${String(monthNum).padStart(2, '0')}-15`;
    if (m.rate !== null && m.rate > 0) rate = m.rate;
    for (const [scheme, amount] of [['EE', m.ee], ['ER', m.er], ['EPS', m.eps]]) {
      if (amount > 0) push({ date, scheme, type: 'SIP', amount, units: amount, nav: 1, rate: m.rate, label: `${m.month} ${year}: ${scheme} ₹${amount.toLocaleString('en-IN')}` });
    }
    intEe += m.int_ee > 0 ? m.int_ee : 0;
    intEr += m.int_er > 0 ? m.int_er : 0;
  }
  const interestDate = `${fy + 1}-03-31`;
  for (const [scheme, interest] of [['EE', intEe], ['ER', intEr]]) {
    if (interest > 0) push({ date: interestDate, scheme, type: 'BONUS', amount: 0, units: Math.round(interest * 100) / 100, nav: 1, rate, notes: `Interest for FY ${label}`, label: `Interest FY ${label}: ${scheme} ₹${interest.toLocaleString('en-IN')}` });
  }
  return out;
}

// ------------------------------------------------------------------ row building

const typeClass = (type) => (!type || type === 'SIP' || type === 'LUMPSUM' ? 'BUY' : type);

function markDuplicate(out, existing) {
  const dup = existing.find(
    (t) =>
      t.date === out.date &&
      typeClass(t.type) === typeClass(out.type) &&
      Math.abs(t.amount - out.amount) < 0.01 &&
      (out.units === null || Math.abs(t.units - out.units) < 0.001) &&
      (!out.scheme || !t.scheme || t.scheme === out.scheme) &&
      (!out.folio || !t.folio_number || t.folio_number === out.folio), // same SIP in two folios is not a duplicate
  );
  if (dup) { out.status = 'dup'; out.message = 'Already recorded'; }
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * NPS statement row: one line carries units and NAV for each scheme (E, C, G ...). Expand it into one
 * transaction per scheme:
 *   money out and units in everywhere      -> a contribution, the amount shared out by each scheme's value
 *                                             (units x NAV); the shortfall against the sum is the POP charge
 *   money in and units out everywhere      -> a withdrawal, shared out the same way
 *   no money, units out everywhere         -> charges (units deducted for fees)
 *   no money, units in and out             -> a rebalance: switch out of the schemes losing units, into the
 *                                             schemes gaining them (no cash moves)
 */
function expandNps(out, legs, amt, typeGiven, fail, money) {
  if (!legs.length) return fail('No units in any scheme column');
  const gross = Math.abs(amt ?? 0);
  const allPos = legs.every((l) => l.sign > 0);
  const allNeg = legs.every((l) => l.sign < 0);
  const n = legs.length;
  const label = (l, what) => `${l.scheme}: ${l.units.toLocaleString('en-IN', { maximumFractionDigits: 4 })} units${l.nav ? ` @ ${l.nav}` : ''} · ${what}`;
  let built;
  if (gross > 0 && (allPos || allNeg)) {
    if (legs.some((l) => l.nav === null)) return fail('Each scheme needs its NAV so the amount can be shared out between E, C and G');
    const total = legs.reduce((s, l) => s + l.value, 0);
    const amounts = legs.map((l) => round2((gross * l.value) / total));
    amounts[n - 1] = round2(gross - amounts.slice(0, -1).reduce((s, a) => s + a, 0)); // sum exactly to the gross
    const type = allNeg ? 'REDEMPTION' : typeGiven && (out.type === 'SIP' || out.type === 'LUMPSUM') ? out.type : out.type === 'REDEMPTION' ? 'SIP' : out.type;
    const what = allNeg ? 'withdrawal' : 'contribution';
    const charge = gross - total;
    built = legs.map((l, k) => ({ type: allNeg ? 'REDEMPTION' : type, amount: amounts[k], units: l.units, nav: l.nav, scheme: l.scheme,
      message: `${label(l, what)} ${money(amounts[k])}${k === 0 && charge > 0.5 && !allNeg ? ` · ${money(round2(charge))} of the ${money(gross)} went in charges` : ''}` }));
  } else if (gross === 0 || amt === null) {
    if (allNeg) {
      built = legs.map((l) => ({ type: 'CHARGE', amount: l.value === null ? 0 : round2(l.value), units: l.units, nav: l.nav, scheme: l.scheme, message: label(l, `charges deducted${l.value !== null ? ` (${money(round2(l.value))})` : ''}`) }));
    } else {
      built = legs.map((l) => ({ type: l.sign < 0 ? 'SWITCH_OUT' : 'SWITCH_IN', amount: l.value === null ? 0 : round2(l.value), units: l.units, nav: l.nav, scheme: l.scheme,
        message: label(l, l.sign < 0 ? `switched out${l.value !== null ? ` (${money(round2(l.value))})` : ''}` : `switched in${l.value !== null ? ` (${money(round2(l.value))})` : ''}`) }));
      if (built.some((b) => b.type.startsWith('SWITCH') && b.amount === 0)) return fail('A rebalance needs the NAV of every scheme involved');
    }
  } else {
    return fail('Units go up in one scheme and down in another, yet money moved too; split this row into a contribution and a rebalance');
  }
  return built.map((b, k) => ({ ...out, ...b, part: k + 1, parts: n }));
}

/**
 * Turn raw rows + column map into validated transaction candidates (one or more per source row:
 * a row whose folio lists several folios is split equally when splitFolios is on; an NPS row with
 * per-scheme unit columns becomes one transaction per scheme).
 * existing: the holding's current transactions, used to flag duplicates.
 * Each candidate carries `index` (its source row), `scheme` (NPS) and, when split, `part` / `parts`.
 */
export function buildRows(rows, map, { defaultType = 'SIP', defaultFolio = '', existing = [], splitFolios: split = true, currency = 'INR' } = {}) {
  const col = (field) => map.indexOf(field);
  const money = (n) => (currency === 'INR' ? `₹${n.toLocaleString('en-IN')}` : `${n.toLocaleString('en-US')} ${currency}`);
  const ci = { folio: col('folio'), name: col('name'), type: col('type'), date: col('date'), amount: col('amount'), units: col('units'), nav: col('nav'), notes: col('notes') };
  const npsCols = NPS_SCHEMES.filter((l) => col(`units_${l.toLowerCase()}`) >= 0);
  // Statements that show purchases as negative cash flow show redemptions as positive.
  const negativeAmountsPresent = ci.amount >= 0 && rows.some((r) => (parseNumber(r[ci.amount]) ?? 0) < 0);

  return rows.flatMap((r, index) => {
    const get = (f) => (col(f) >= 0 ? r[col(f)] : '');
    const out = { index, folio: get('folio') || defaultFolio, name: get('name'), scheme: '', type: parseType(get('type'), defaultType), notes: String(get('notes')).trim(), date: null, amount: null, units: null, nav: null, status: 'ok', message: '' };

    const fail = (msg) => { out.status = 'error'; out.message = msg; return [out]; };
    if (ci.date < 0) return fail('No date column mapped');
    if (ci.amount < 0 && !npsCols.length) return fail('No amount column mapped');

    out.date = parseDate(get('date'));
    if (!out.date) return fail(`Unrecognised date "${get('date')}"`);
    const typeGiven = ci.type >= 0 && get('type') !== '' && parseType(get('type'), '') !== '';

    if (npsCols.length) {
      const amt = get('amount') === '' ? null : parseNumber(get('amount'));
      if (get('amount') !== '' && amt === null) return fail(`Unrecognised amount "${get('amount')}"`);
      const legs = [];
      for (const L of npsCols) {
        const uRaw = get(`units_${L.toLowerCase()}`);
        if (uRaw === '') continue;
        const u = parseNumber(uRaw);
        if (u === null) return fail(`Unrecognised units for scheme ${L}: "${uRaw}"`);
        if (u === 0) continue;
        const nRaw = get(`nav_${L.toLowerCase()}`);
        const nv = nRaw === '' ? null : parseNumber(nRaw);
        if (nRaw !== '' && (nv === null || nv <= 0)) return fail(`Unrecognised NAV for scheme ${L}: "${nRaw}"`);
        legs.push({ scheme: L, units: round4(Math.abs(u)), sign: Math.sign(u), nav: nv, value: nv ? Math.abs(u) * nv : null });
      }
      const expanded = expandNps(out, legs, amt, typeGiven, fail, money);
      return expanded.map((row) => markDuplicate(row, existing));
    }

    let amt = parseNumber(get('amount'));
    if (amt === null) {
      if (get('amount') === '' && (out.type === 'BONUS' || out.type === 'CHARGE')) amt = 0; // no money column needed
      else return fail(`Unrecognised amount "${get('amount')}"`);
    }
    out.amount = round2(Math.abs(amt));

    let rawUnits = null;
    if (ci.units >= 0 && get('units') !== '') {
      rawUnits = parseNumber(get('units'));
      if (rawUnits === null) return fail(`Unrecognised units "${get('units')}"`);
      out.units = Math.abs(rawUnits);
    }
    // Direction, unless the type column already said so:
    //   negative units with money -> sale (even if the type column says SIP); negative units, no money -> charges
    //   money but 0 units -> dividend; units but 0 money -> bonus / free units
    //   positive amount in a file whose purchases are negative -> sale
    if (!typeGiven || out.type === 'SIP' || out.type === 'LUMPSUM') {
      if (rawUnits !== null && rawUnits < 0) out.type = out.amount > 0 ? 'REDEMPTION' : 'CHARGE';
      else if (rawUnits === 0 && out.amount > 0) out.type = 'DIVIDEND';
      else if (out.amount === 0 && rawUnits !== null && rawUnits > 0) out.type = 'BONUS';
      else if (rawUnits === null && negativeAmountsPresent && amt > 0) out.type = 'REDEMPTION';
    }
    if (ci.nav >= 0 && get('nav') !== '') {
      const n = parseNumber(get('nav'));
      if (n === null || n < 0) return fail(`Unrecognised NAV / price "${get('nav')}"`);
      out.nav = n > 0 ? n : null;
    }
    if (out.type === 'DIVIDEND') {
      if (!(out.amount > 0)) return fail('A dividend needs the amount received');
      out.units = 0;
    } else if (out.type === 'BONUS') {
      if (!(out.units > 0)) return fail('Bonus / free units need the number received');
      out.amount = 0;
    } else if (out.type === 'CHARGE') {
      if (!(out.units > 0)) return fail('Charges need the number of units deducted');
      if (!out.amount && out.nav) out.amount = round2(out.units * out.nav);
      if (!out.amount && !out.nav) out.message = 'Value of the units will be filled from NAV history';
    } else {
      if (!(out.amount > 0)) return fail(`Unrecognised amount "${get('amount')}"`);
      if (out.units !== null && !(out.units > 0)) return fail(`Unrecognised units "${get('units')}"`);
      if (out.nav === null && out.units !== null) out.nav = round4(out.amount / out.units);
      if (out.units === null && out.nav !== null) out.units = round4(out.amount / out.nav);
      if (out.nav === null && out.units === null) out.message = 'Price and units will be filled from price history';
    }

    const folios = split ? splitFolios(out.folio) : null;
    if (!folios) return [markDuplicate(out, existing)];

    // One purchase spread over several folios: divide amount and units equally, keep the NAV.
    const n = folios.length;
    const amounts = distribute(out.amount, n, 2);
    const unitParts = out.units === null ? null : distribute(out.units, n, 4);
    const origin = `Split ${'#'}/${n} of ${money(out.amount)} across folios ${out.folio}`;
    return folios.map((folio, k) => {
      const note = origin.replace('#', String(k + 1));
      const part = {
        ...out,
        folio,
        amount: amounts[k],
        units: unitParts ? unitParts[k] : null,
        part: k + 1,
        parts: n,
        notes: out.notes ? `${out.notes} · ${note}` : note,
        message: out.message ? `${out.message} · split ${k + 1}/${n}` : `Split ${k + 1}/${n}: ${money(amounts[k])}${unitParts ? `, ${unitParts[k]} units` : ''}`,
      };
      return markDuplicate(part, existing);
    });
  });
}
