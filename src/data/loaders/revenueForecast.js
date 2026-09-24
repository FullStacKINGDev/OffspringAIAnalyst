// Offspring revenue (invoicing) forecast: one row per expected subscription invoice.
const { readWorkbook, sheetGrid, text, num, findCell, cellRef } = require('../../lib/excel');
const { monthKeyFromDate, isoDate } = require('../../lib/periods');

const norm = (s) => text(s).toLowerCase().replace(/[^a-z]/g, '');

const COLS = {
  invoiceMonth: (h) => h === 'invoicemonth',
  customer: (h) => h === 'customer',
  subStart: (h) => h.startsWith('substart'),
  subEnd: (h) => h.startsWith('subend'),
  currency: (h) => h === 'cur' || h === 'currency',
  amountFc: (h) => h.startsWith('amountfc'),
  amountEur: (h) => h.startsWith('amounteur'),
  remarks: (h) => h.startsWith('remark'),
};

async function loadRevenueForecast(file) {
  const wb = await readWorkbook(file);
  const ws = wb.worksheets[0];
  const sheet = sheetGrid(ws);
  const { grid } = sheet;
  const hdr = findCell(sheet, (v) => norm(v) === 'invoicemonth', { toRow: 10 });
  if (!hdr) throw new Error(`Revenue forecast header ("Invoice Month") not found in ${file}`);
  const cols = {};
  (grid[hdr.r] || []).forEach((v, c) => {
    const h = norm(v);
    for (const [k, test] of Object.entries(COLS)) if (!cols[k] && test(h)) cols[k] = c;
  });

  const rows = [];
  for (let r = hdr.r + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    const invoiceMonth = monthKeyFromDate(row[cols.invoiceMonth]);
    const customer = text(row[cols.customer]);
    if (!invoiceMonth || !customer) continue;
    rows.push({
      invoiceMonth,
      invoiceDate: isoDate(row[cols.invoiceMonth]),
      customer,
      subStart: isoDate(row[cols.subStart]),
      subEnd: isoDate(row[cols.subEnd]),
      currency: text(row[cols.currency]) || null,
      amountFc: num(row[cols.amountFc]),
      amountEur: num(row[cols.amountEur]),
      remarks: cols.remarks ? text(row[cols.remarks]) || null : null,
      ref: cellRef(r, cols.customer),
    });
  }
  return { kind: 'revenueForecast', sheet: ws.name, rows };
}

module.exports = { loadRevenueForecast };
