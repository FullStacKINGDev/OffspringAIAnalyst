// Offspring's P&L workfile: account-level monthly P&L ("P&L WACD") plus budget worksheets.
const { readWorkbook, sheetGrid, text, num, findCell, cellRef } = require('../../lib/excel');
const { mk, monthFromName, parseFy, fyStart, addMonths } = require('../../lib/periods');

const CODE_RE = /^(\d{3,6})\s*-\s*(.+)$/;
const STATED_ROWS = /^(Result|EBIT|Cost|Rev distribution per FY|Cost distribution per FY)$/i;

function parsePlSheet(ws) {
  const sheet = sheetGrid(ws);
  const { grid, uncomputed } = sheet;
  const hdr = findCell(sheet, (v) => /^Particulars$/i.test(text(v)));
  if (!hdr) throw new Error('"Particulars" header row not found in P&L sheet');
  const yearRow = grid[hdr.r];
  const monthRow = grid[hdr.r + 1] || [];

  const monthCols = [];
  const fyTotalCols = [];
  let remarksCol = null;
  for (let c = hdr.c + 1; c < Math.max(yearRow.length, monthRow.length); c++) {
    const y = yearRow[c];
    const mName = text(monthRow[c]);
    const yNum = typeof y === 'number' ? y : /^\d{4}$/.test(text(y)) ? Number(text(y)) : null;
    const m = monthFromName(mName);
    if (yNum && m && !/total/i.test(mName)) monthCols.push({ col: c, month: mk(yNum, m) });
    else if (/^FY\s?\d{4}$/i.test(text(y))) fyTotalCols.push({ col: c, fy: parseFy(text(y)) });
    else if (/^remarks$/i.test(text(y))) remarksCol = c;
  }

  const accounts = [];
  const sectionTotals = [];
  const stated = {};
  const stack = [];
  let uncomputedMonthCells = 0;

  const readMonths = (r, blankIsZero) => {
    const out = {};
    for (const { col, month } of monthCols) {
      const v = num(grid[r][col]);
      if (v != null) out[month] = v;
      else if (uncomputed.has(`${r}:${col}`)) uncomputedMonthCells++;
      else if (blankIsZero) out[month] = 0;
    }
    return out;
  };

  for (let r = hdr.r + 2; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    const label = text(row[hdr.c]);
    if (!label) continue;
    if (/^Total: Profit and loss statement$/i.test(label)) continue;

    const code = label.match(CODE_RE);
    if (code) {
      const fyTotals = {};
      for (const { col, fy } of fyTotalCols) {
        const v = num(row[col]);
        if (v != null) fyTotals[fy] = v;
      }
      accounts.push({
        code: code[1],
        name: code[2].trim(),
        section: stack[stack.length - 1] || null,
        parentSection: stack[stack.length - 2] || null,
        // Blank month cells in the ledger export mean no postings in that month.
        monthly: readMonths(r, true),
        statedFyTotals: fyTotals,
        row: r,
        ref: cellRef(r, hdr.c),
      });
    } else if (/^Total:/i.test(label)) {
      const name = label.replace(/^Total:\s*/i, '').trim();
      sectionTotals.push({
        section: name,
        remark: remarksCol ? text(row[remarksCol]) || null : null,
        monthly: readMonths(r, false),
        ref: cellRef(r, hdr.c),
      });
      const idx = stack.lastIndexOf(name);
      if (idx >= 0) stack.length = idx;
    } else if (STATED_ROWS.test(label)) {
      stated[label] = { monthly: readMonths(r, false), ref: cellRef(r, hdr.c) };
    } else {
      stack.push(label);
    }
  }

  // A month is available when at least one account has a non-blank cell in that column.
  const available = monthCols
    .filter(({ col }) => accounts.some((a) => num(grid[a.row][col]) != null))
    .map((x) => x.month);

  return { sheet: ws.name, months: available, accounts, sectionTotals, stated, uncomputedMonthCells };
}

// "Budget - Overview": revenue / cost / EBIT blocks with Budget and Actual rows per FY.
function parseBudgetOverview(ws) {
  const sheet = sheetGrid(ws);
  const { grid } = sheet;
  const rows = [];
  let block = null;
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    // Block header: "<n> | Revenue | | Apr | May | ..."
    if (typeof row[1] === 'number' && text(row[2])) {
      const monthStart = row.findIndex((v, c) => c > 2 && monthFromName(v));
      // Some blocks (EBIT) have no month header of their own and reuse the previous layout.
      block = { name: text(row[2]), monthStart: monthStart > 0 ? monthStart : block ? block.monthStart : -1 };
      continue;
    }
    if (!block || block.monthStart < 0) continue;
    const kind = text(row[2]);
    const fyText = text(row[3]);
    if (!/^(Budget|Actual)$/i.test(kind) || !/FY/i.test(fyText)) continue;
    const fy = parseFy(fyText);
    const values = {};
    for (let i = 0; i < 12; i++) {
      const v = num(row[block.monthStart + i]);
      if (v != null) values[addMonths(fyStart(fy), i)] = v;
    }
    // Rows holding monthly distribution shares or margins (all values <= 1.5) are not amounts.
    const amounts = Object.values(values);
    if (!amounts.length || amounts.every((v) => Math.abs(v) <= 1.5)) continue;
    rows.push({ block: block.name, kind, fyLabel: fyText, fy, values, ref: cellRef(r, 2) });
  }
  return { sheet: ws.name, rows };
}

async function loadPlWorkfile(file) {
  const wb = await readWorkbook(file);
  const plWs = wb.getWorksheet('P&L WACD') || wb.worksheets.find((w) => /p&l/i.test(w.name));
  if (!plWs) throw new Error(`No P&L sheet found in ${file}`);
  const pl = parsePlSheet(plWs);
  const boWs = wb.getWorksheet('Budget - Overview');
  return {
    kind: 'plWorkfile',
    pl,
    budgetOverview: boWs ? parseBudgetOverview(boWs) : null,
    sheets: wb.worksheets.map((w) => ({ name: w.name, state: w.state })),
  };
}

module.exports = { loadPlWorkfile };
