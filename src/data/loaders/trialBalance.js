// Exact Online trial balance export ("Balance sheet / Profit and loss statement", Balance type = Trial balance).
const { readWorkbook, sheetGrid, text, num, findCell, cellRef } = require('../../lib/excel');

const CODE_RE = /^(\d{3,6})\s*-\s*(.+)$/;

const HEADERS = {
  opening: /^opening balance$/i,
  debit: /^debit$/i,
  credit: /^credit$/i,
  trialDebit: /^trial \(debit\)$/i,
  trialCredit: /^trial \(credit\)$/i,
  closing: /^closing balance$/i,
};

// Value right of a label cell such as "Financial year" -> 2027.
function valueRightOf(sheet, labelRe) {
  const hit = findCell(sheet, (v) => labelRe.test(text(v)), { toRow: 15 });
  if (!hit) return null;
  const row = sheet.grid[hit.r];
  for (let c = hit.c + 1; c < row.length; c++) {
    if (text(row[c])) return row[c];
  }
  return null;
}

async function loadTrialBalance(file) {
  const wb = await readWorkbook(file);
  const ws = wb.worksheets[0];
  const sheet = sheetGrid(ws);
  const { grid } = sheet;

  const firstText = (re) => {
    const hit = findCell(sheet, (v) => re.test(text(v)), { toRow: 10 });
    return hit ? text(grid[hit.r][hit.c]) : null;
  };

  const meta = {
    company: (firstText(/^Company:/i) || '').replace(/^Company:\s*/i, '') || null,
    prepared: (firstText(/^Date:/i) || '').replace(/^Date:\s*/i, '') || null,
    financialYear: Number(valueRightOf(sheet, /^Financial year$/i)) || null,
    periodText: text(valueRightOf(sheet, /^Period$/i)) || null,
    viewOptions: [],
  };
  const pm = (meta.periodText || '').match(/(\d+)\s*-\s*(\d+)/);
  meta.periodFrom = pm ? Number(pm[1]) : null;
  meta.periodTo = pm ? Number(pm[2]) : null;
  for (const re of [/^Exclude: Opening balance$/i, /^Exclude: Adjustment entries$/i]) {
    const hit = findCell(sheet, (v) => re.test(text(v)), { toRow: 12 });
    if (hit) meta.viewOptions.push(`${text(grid[hit.r][hit.c])} = ${text(grid[hit.r][hit.c + 1]) || '(blank)'}`);
  }

  const header = findCell(sheet, (v) => HEADERS.opening.test(text(v)));
  if (!header) throw new Error(`Trial balance header ("Opening balance") not found in ${file}`);
  const cols = {};
  grid[header.r].forEach((v, c) => {
    for (const [key, re] of Object.entries(HEADERS)) if (re.test(text(v)) && !cols[key]) cols[key] = c;
  });

  const accounts = [];
  const resultLines = [];
  let inResult = false;
  for (let r = header.r + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    const label = text(row[1]);
    if (!label) continue;
    if (/^Result$/i.test(label)) { inResult = true; continue; }
    // Exact omits zero amounts in this export, so a blank amount cell is a zero balance.
    const vals = {};
    for (const key of Object.keys(HEADERS)) vals[key] = num(row[cols[key]]) ?? 0;
    const m = label.match(CODE_RE);
    if (!inResult && m) {
      accounts.push({ code: m[1], name: m[2].trim(), ...vals, ref: cellRef(r, 1) });
    } else if (inResult) {
      resultLines.push({ label, ...vals, ref: cellRef(r, 1) });
    }
  }

  return {
    kind: 'trialBalance',
    sheet: ws.name,
    meta,
    accounts,
    resultLines,
    uncomputedCells: sheet.uncomputed.size,
  };
}

module.exports = { loadTrialBalance };
