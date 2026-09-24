const ExcelJS = require('exceljs');

async function readWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb;
}

// Plain value for a cell: number | string | Date | null.
// Formulas saved without a cached result, and Excel error values, come back as null and are
// reported via `uncomputed` so callers never mistake them for zero.
function readCell(cell) {
  let v = cell.value;
  if (v == null) return { v: null };
  if (v instanceof Date) return { v };
  if (typeof v === 'object') {
    if ('result' in v) {
      const r = v.result;
      if (r == null || (typeof r === 'object' && !(r instanceof Date) && r.error)) return { v: null, uncomputed: true };
      return { v: r };
    }
    if (v.formula || v.sharedFormula) return { v: null, uncomputed: true };
    if (v.richText) return { v: v.richText.map((t) => t.text).join('') };
    if (v.error) return { v: null, uncomputed: true };
    if (v.text != null) return { v: v.text };
    return { v: null };
  }
  return { v };
}

// Sheet as a sparse grid: grid[row][col] with 1-based Excel row and column numbers,
// so cell references in sources stay exact.
function sheetGrid(ws) {
  const grid = [];
  const uncomputed = new Set();
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    const cells = [];
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      const { v, uncomputed: u } = readCell(cell);
      cells[c] = v;
      if (u) uncomputed.add(`${r}:${c}`);
    });
    grid[r] = cells;
  });
  return { grid, uncomputed, rowCount: ws.rowCount, name: ws.name };
}

const text = (v) => (v == null ? '' : String(v).trim());
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function colLetter(c) {
  let s = '';
  while (c > 0) {
    const r = (c - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}

const cellRef = (r, c) => `${colLetter(c)}${r}`;

// First cell (row, col) whose text satisfies the predicate, scanning top to bottom.
function findCell({ grid }, predicate, { fromRow = 1, toRow = grid.length } = {}) {
  for (let r = fromRow; r < Math.min(toRow + 1, grid.length); r++) {
    const row = grid[r];
    if (!row) continue;
    for (let c = 1; c < row.length; c++) {
      if (row[c] != null && predicate(row[c], r, c)) return { r, c };
    }
  }
  return null;
}

module.exports = { readWorkbook, sheetGrid, text, num, colLetter, cellRef, findCell };
