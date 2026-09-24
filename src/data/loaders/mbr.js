// Monthly Business Review workbook: ACTUAL (category x month), BUDGET, "A to B" and "A to PY".
const { readWorkbook, sheetGrid, text, num, findCell, cellRef } = require('../../lib/excel');
const { monthKeyFromDate, parseFy, MONTH_NAMES, mk } = require('../../lib/periods');

function parseActual(ws) {
  const sheet = sheetGrid(ws);
  const { grid } = sheet;
  const meta = {};
  for (let r = 1; r < Math.min(grid.length, 10); r++) {
    const row = grid[r] || [];
    if (/current year end/i.test(text(row[2]))) meta.currentYearEnd = monthKeyFromDate(row[1]);
    if (/current year start/i.test(text(row[2]))) meta.currentYearStart = monthKeyFromDate(row[1]);
  }
  const hdr = findCell(sheet, (v) => /^Period$/i.test(text(v)));
  if (!hdr) throw new Error('ACTUAL sheet: "Period" header not found');
  const catCol = hdr.c - 1;
  const amtCol = hdr.c + 1;
  const rows = [];
  for (let r = hdr.r + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    const category = text(row[catCol]);
    const month = monthKeyFromDate(row[hdr.c]);
    const amount = num(row[amtCol]);
    if (category && month && amount != null) rows.push({ category, month, amount, ref: cellRef(r, catCol) });
  }
  return { sheet: ws.name, meta, rows };
}

const BUDGET_COLS = {
  ebitStated: /^EBIT - Budget$/i,
  revenue: /^Revenue - Budget$/i,
  cogs: /^COGS - Budget$/i,
  general: /^General - Budget$/i,
  personnel: /^Personnel - Budget$/i,
  interest: /^Interest - Budget$/i,
  taxes: /^Taxes - Budget$/i,
};

function parseBudget(ws) {
  const sheet = sheetGrid(ws);
  const { grid } = sheet;
  const hdr = findCell(sheet, (v) => /^Period$/i.test(text(v)));
  if (!hdr) throw new Error('BUDGET sheet: "Period" header not found');
  const cols = {};
  (grid[hdr.r] || []).forEach((v, c) => {
    for (const [k, re] of Object.entries(BUDGET_COLS)) if (re.test(text(v))) cols[k] = c;
  });

  const months = {};
  for (let r = hdr.r + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    const month = monthKeyFromDate(row[hdr.c]);
    if (!month) continue;
    const rec = {};
    let any = false;
    for (const k of Object.keys(BUDGET_COLS)) {
      const v = cols[k] ? num(row[cols[k]]) : null;
      rec[k] = v;
      if (v != null) any = true;
    }
    if (any) months[month] = { ...rec, ref: cellRef(r, hdr.c) };
  }

  // Revenue split by segment, e.g. "FY 26/27 | Based on past avg trend" with Airline 0.6, ...
  let revenueSplit = null;
  const fyCell = findCell(sheet, (v, r, c) => /^FY\s*\d{2}\s*\/\s*\d{2}$/i.test(text(v)) && c !== hdr.c, { toRow: hdr.r });
  if (fyCell) {
    const shares = {};
    for (let r = fyCell.r + 1; r < grid.length; r++) {
      const row = grid[r] || [];
      const seg = text(row[fyCell.c]);
      const pct = num(row[fyCell.c + 1]);
      if (!seg || pct == null) break;
      shares[seg] = pct;
    }
    revenueSplit = {
      fyLabel: text(grid[fyCell.r][fyCell.c]),
      fy: parseFy(text(grid[fyCell.r][fyCell.c])),
      basis: text(grid[fyCell.r][fyCell.c + 1]) || null,
      shares,
      ref: cellRef(fyCell.r, fyCell.c),
    };
  }
  return { sheet: ws.name, months, revenueSplit };
}

// "As of 31 August 2026" -> '2026-08'
function parseAsOf(s) {
  const m = text(s).match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  const idx = MONTH_NAMES.findIndex((n) => m[2].toLowerCase().startsWith(n.toLowerCase()));
  return idx >= 0 ? mk(Number(m[3]), idx + 1) : null;
}

// Actual-to-Budget / Actual-to-PY report pages as they were reported to management.
function parseComparison(ws) {
  const sheet = sheetGrid(ws);
  const { grid, uncomputed } = sheet;
  const labelsHit = findCell(sheet, (v) => /^ACTUAL$/i.test(text(v)));
  if (!labelsHit) return null;
  const labels = grid[labelsHit.r];
  const groups = grid[labelsHit.r - 1] || [];
  const colMap = [];
  labels.forEach((v, c) => {
    const label = text(v);
    const group = text(groups[c]);
    if (!label) return;
    let slot = null;
    if (/MTD/i.test(group)) slot = 'mtd';
    else if (/^YTD A to/i.test(group)) slot = 'ytdPct';
    else if (/YTD/i.test(group)) slot = 'ytd';
    else if (/^FY/i.test(group)) slot = 'fullYear';
    if (!slot) return;
    const field = /ACTUAL/i.test(label) ? 'actual' : /△|Δ|delta/i.test(label) ? 'delta' : slot === 'ytdPct' ? 'pct' : 'comparison';
    colMap.push({ c, slot, field, group, label });
  });

  const lines = [];
  for (let r = labelsHit.r + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    const name = text(row[2]) || text(row[1]);
    if (!name) continue;
    const rec = { line: name, ref: cellRef(r, 2), uncomputed: [] };
    for (const { c, slot, field } of colMap) {
      rec[slot] = rec[slot] || {};
      rec[slot][field] = num(row[c]);
      if (uncomputed.has(`${r}:${c}`)) rec.uncomputed.push(`${slot}.${field}`);
    }
    lines.push(rec);
  }

  const title = text((grid[1] || [])[1]);
  return {
    sheet: ws.name,
    title,
    asOf: parseAsOf((grid[2] || [])[1]),
    currencyNote: text((grid[3] || [])[1]),
    comparisonLabel: text(labels[colMap.find((x) => x.slot === 'ytd' && x.field === 'comparison')?.c]),
    fullYearLabel: colMap.find((x) => x.slot === 'fullYear')?.group || null,
    lines,
  };
}

async function loadMbr(file) {
  const wb = await readWorkbook(file);
  const get = (name) => wb.getWorksheet(name);
  return {
    kind: 'mbr',
    actual: get('ACTUAL') ? parseActual(get('ACTUAL')) : null,
    budget: get('BUDGET') ? parseBudget(get('BUDGET')) : null,
    aToB: get('A to B') ? parseComparison(get('A to B')) : null,
    aToPy: get('A to PY') ? parseComparison(get('A to PY')) : null,
    sheets: wb.worksheets.map((w) => ({ name: w.name, state: w.state })),
  };
}

module.exports = { loadMbr };
