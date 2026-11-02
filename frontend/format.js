// Number and date formatting helpers (Indian conventions: lakh / crore, en-IN grouping).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

export const fmtINR = (n, decimals = 0) => (isNum(n) ? (decimals ? inr2 : inr0).format(n) : '–');

/** Compact INR for axis ticks and end labels: ₹1.25 L, ₹2.40 Cr, ₹850 */
export function fmtCompact(n) {
  if (!isNum(n)) return '–';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${sign}₹${(a / 1e3).toFixed(1)}K`;
  return `${sign}₹${a.toFixed(0)}`;
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
