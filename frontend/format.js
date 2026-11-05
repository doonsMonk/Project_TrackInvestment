// Number and date formatting helpers. INR uses Indian conventions (lakh / crore, en-IN grouping);
// other currencies use their own symbol with international grouping.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

const formatters = new Map();
function moneyFormatter(currency, decimals) {
  const key = `${currency}|${decimals}`;
  let f = formatters.get(key);
  if (!f) {
    const locale = currency === 'INR' ? 'en-IN' : 'en-US';
    try {
      f = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    } catch {
      // unknown / non-ISO code: fall back to "CODE 1,234.00"
      const plain = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      f = { format: (v) => `${currency} ${plain.format(v)}` };
    }
    formatters.set(key, f);
  }
  return f;
}

/** Money in any currency: fmtMoney(1234.5, 'AUD') -> 'A$1,235', fmtMoney(123456, 'INR') -> '₹1,23,456'. */
export const fmtMoney = (n, currency = 'INR', decimals = 0) => (isNum(n) ? moneyFormatter(currency || 'INR', decimals).format(n) : '–');

export const fmtINR = (n, decimals = 0) => fmtMoney(n, 'INR', decimals);

const symbols = new Map();
/** The symbol a currency is displayed with: '₹', 'A$', '$', '£', or the code itself when there is none. */
export function currencySymbol(currency = 'INR') {
  let s = symbols.get(currency);
  if (s === undefined) {
    try {
      s = new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency')?.value || currency;
    } catch {
      s = currency;
    }
    symbols.set(currency, s);
  }
  return s;
}

/** Compact money for axis ticks and end labels: ₹1.25 L, ₹2.40 Cr, ₹850; A$1.2K, $3.40M. */
export function fmtCompact(n, currency = 'INR') {
  if (!isNum(n)) return '–';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (currency === 'INR') {
    if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
    if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`;
    if (a >= 1e3) return `${sign}₹${(a / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
    return `${sign}₹${a.toFixed(0)}`;
  }
  const sym = currencySymbol(currency);
  const sep = /[A-Za-z]$/.test(sym) ? ' ' : '';
  if (a >= 1e9) return `${sign}${sym}${sep}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${sym}${sep}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}${sym}${sep}${(a / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return `${sign}${sym}${sep}${a.toFixed(0)}`;
}

export const fmtPct = (p, d = 2) => (isNum(p) ? `${p > 0 ? '+' : ''}${p.toFixed(d)}%` : '–');

export const fmtNum = (n, d = 2) =>
  isNum(n) ? new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n) : '–';

/** '2026-10-30' -> '30 Oct 2026' */
export function fmtDate(iso) {
  if (!iso) return '–';
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Axis tick label whose detail depends on the span being plotted. */
export function fmtAxisDate(iso, spanDays) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (spanDays > 900) return `${MONTHS[Number(m) - 1]} ${y}`;
  if (spanDays > 120) return `${MONTHS[Number(m) - 1]} '${y.slice(2)}`;
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
