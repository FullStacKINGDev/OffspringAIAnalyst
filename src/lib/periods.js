// Month keys are 'YYYY-MM' strings throughout the app.
const { fyStartMonth } = require('../config');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// English and Dutch month abbreviations as they appear in the source workbooks.
const MONTH_LOOKUP = {
  jan: 1, feb: 2, mar: 3, mrt: 3, apr: 4, may: 5, mei: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12,
};

const mk = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

function parseMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return { y, m };
}

function isMonthKey(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

function monthFromName(name) {
  if (name == null) return null;
  return MONTH_LOOKUP[String(name).trim().toLowerCase().slice(0, 3)] || null;
}

function monthKeyFromDate(d) {
  if (d instanceof Date) return mk(d.getUTCFullYear(), d.getUTCMonth() + 1);
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}`;
  }
  return null;
}

function isoDate(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  return null;
}

function addMonths(key, n) {
  const { y, m } = parseMonth(key);
  const idx = y * 12 + (m - 1) + n;
  return mk(Math.floor(idx / 12), (idx % 12) + 1);
}

function monthRange(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  for (let k = from; k <= to; k = addMonths(k, 1)) out.push(k);
  return out;
}

// Financial year number = calendar year in which the FY ends.
function fyOf(key) {
  const { y, m } = parseMonth(key);
  if (fyStartMonth === 1) return y;
  return m >= fyStartMonth ? y + 1 : y;
}

const fyLabel = (fy) => `FY${fy}`;

function fyStart(fy) {
  return fyStartMonth === 1 ? mk(fy, 1) : mk(fy - 1, fyStartMonth);
}

function fyEnd(fy) {
  return addMonths(fyStart(fy), 11);
}

const fyMonths = (fy) => monthRange(fyStart(fy), fyEnd(fy));

// Accepts 'FY2027', 'FY27', 'FY 26/27', '2027' or 2027 and returns 2027.
function parseFy(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 100 ? 2000 + v : v;
  const s = String(v).trim();
  let m = s.match(/(\d{2,4})\s*\/\s*(\d{2,4})/);
  if (m) {
    const end = Number(m[2]);
    return end < 100 ? 2000 + end : end;
  }
  m = s.match(/(\d{4}|\d{2})\s*$/);
  if (m) {
    const n = Number(m[1]);
    return n < 100 ? 2000 + n : n;
  }
  return null;
}

// Fiscal quarter: Q1 = first three months of the FY.
function fiscalQuarter(key) {
  const { m } = parseMonth(key);
  const offset = (m - fyStartMonth + 12) % 12;
  return `${fyLabel(fyOf(key))} Q${Math.floor(offset / 3) + 1}`;
}

function monthLabel(key) {
  const { y, m } = parseMonth(key);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function rangeLabel(from, to) {
  if (from === to) return monthLabel(from);
  return `${monthLabel(from)} – ${monthLabel(to)}`;
}

module.exports = {
  MONTH_NAMES, mk, parseMonth, isMonthKey, monthFromName, monthKeyFromDate, isoDate,
  addMonths, monthRange, fyOf, fyLabel, fyStart, fyEnd, fyMonths, parseFy,
  fiscalQuarter, monthLabel, rangeLabel,
};
