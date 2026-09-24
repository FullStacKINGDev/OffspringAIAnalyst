// Loads every source workbook and builds one normalized financial model.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { loadTrialBalance } = require('./loaders/trialBalance');
const { loadPlWorkfile } = require('./loaders/plWorkfile');
const { loadMbr } = require('./loaders/mbr');
const { loadRevenueForecast } = require('./loaders/revenueForecast');
const { REVENUE_SEGMENTS, classifyBalanceSheet } = require('./accountMap');
const P = require('../lib/periods');

const SOURCE_PATTERNS = [
  { kind: 'trialBalance', re: /\bTB\b/i, loader: loadTrialBalance, label: 'Trial balance (Exact Online)' },
  { kind: 'mbr', re: /MBR/i, loader: loadMbr, label: 'Monthly Business Review P&L (Offspring)' },
  { kind: 'plWorkfile', re: /workfile/i, loader: loadPlWorkfile, label: 'P&L workfile (Offspring)' },
  { kind: 'revenueForecast', re: /revenue\s*forecast/i, loader: loadRevenueForecast, label: 'Revenue (invoicing) forecast (Offspring)' },
];

function listWorkbooks(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listWorkbooks(full));
    else if (/\.xlsx$/i.test(entry.name) && !entry.name.startsWith('~$')) out.push(full);
  }
  return out;
}

async function loadStore(dataDir = config.dataDir) {
  const files = listWorkbooks(dataDir);
  const raw = {};
  const sources = [];
  const loadErrors = [];
  for (const pattern of SOURCE_PATTERNS) {
    const matches = files.filter((f) => pattern.re.test(path.basename(f)));
    if (!matches.length) { loadErrors.push(`No file found for ${pattern.label}`); continue; }
    // Several candidates: take the most recently modified one.
    matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const file = matches[0];
    try {
      raw[pattern.kind] = await pattern.loader(file);
      sources.push({
        kind: pattern.kind,
        label: pattern.label,
        file: path.relative(config.root, file).replace(/\\/g, '/'),
        modified: fs.statSync(file).mtime.toISOString(),
      });
    } catch (e) {
      loadErrors.push(`${pattern.label}: ${e.message}`);
    }
  }
  return buildModel(raw, sources, loadErrors);
}

function buildModel(raw, sources, loadErrors) {
  const wf = raw.plWorkfile;
  const mbr = raw.mbr;
  const tb = raw.trialBalance;
  const fc = raw.revenueForecast;
  const fileOf = (kind) => sources.find((s) => s.kind === kind)?.file;

  // ---- P&L accounts (actuals) ----
  const sectionRemark = {};
  for (const t of wf?.pl.sectionTotals || []) if (t.remark) sectionRemark[t.section] = t.remark;

  const plAccounts = (wf?.pl.accounts || []).map((a) => {
    let category = null;
    let type;
    if (a.section === 'Turnover' || /^8/.test(a.code)) {
      category = REVENUE_SEGMENTS[a.code] || 'Unmapped revenue';
      type = 'revenue';
    } else {
      category = sectionRemark[a.section] || 'Unmapped';
      type = category === 'Interest' ? 'financial' : category === 'Taxes' ? 'tax' : 'expense';
    }
    return { ...a, category, type };
  });
  const accountByCode = new Map(plAccounts.map((a) => [a.code, a]));
  const actualMonths = [...(wf?.pl.months || [])].sort();
  const actualMonthSet = new Set(actualMonths);
  const latestActualMonth = actualMonths[actualMonths.length - 1] || null;
  const currentFy = latestActualMonth ? P.fyOf(latestActualMonth) : null;

  // ---- Budget (MBR BUDGET sheet) ----
  const budgetMonths = mbr?.budget?.months || {};
  const revenueSplit = mbr?.budget?.revenueSplit || null;

  // ---- Trial balance ----
  let trialBalance = null;
  if (tb) {
    const fy = tb.meta.financialYear;
    const months = fy && tb.meta.periodFrom
      ? P.monthRange(P.addMonths(P.fyStart(fy), tb.meta.periodFrom - 1), P.addMonths(P.fyStart(fy), tb.meta.periodTo - 1))
      : [];
    const accounts = tb.accounts.map((a) => {
      const isPl = accountByCode.has(a.code) || (Number(a.code) >= 4000 && a.opening === 0);
      const cls = isPl ? null : classifyBalanceSheet(a.code);
      return {
        ...a,
        statement: isPl ? 'profit_and_loss' : 'balance_sheet',
        bsGroup: cls?.group || null,
        contra: !!cls?.contra,
        side: cls?.side || null,
        mapped: cls ? cls.mapped : true,
        plCategory: accountByCode.get(a.code)?.category || null,
      };
    });
    trialBalance = { meta: { ...tb.meta, months }, accounts, resultLines: tb.resultLines, file: fileOf('trialBalance'), sheet: tb.sheet };
  }

  return {
    loadedAt: new Date().toISOString(),
    currency: config.currency,
    company: tb?.meta.company || 'WorldACD Market Data B.V.',
    sources,
    loadErrors,
    fyStartMonth: config.fyStartMonth,
    actualMonths,
    actualMonthSet,
    latestActualMonth,
    currentFy,
    plAccounts,
    accountByCode,
    plSheet: wf?.pl.sheet,
    plStated: wf?.pl.stated || {},
    plSectionTotals: wf?.pl.sectionTotals || [],
    plUncomputedMonthCells: wf?.pl.uncomputedMonthCells || 0,
    budgetOverview: wf?.budgetOverview || null,
    workfileSheets: wf?.sheets || [],
    budgetMonths,
    revenueSplit,
    mbrActual: mbr?.actual || null,
    mbrReports: { aToB: mbr?.aToB || null, aToPy: mbr?.aToPy || null },
    mbrSheets: mbr?.sheets || [],
    trialBalance,
    forecast: fc ? { rows: fc.rows, sheet: fc.sheet, file: fileOf('revenueForecast') } : null,
    files: {
      workfile: fileOf('plWorkfile'),
      mbr: fileOf('mbr'),
      trialBalance: fileOf('trialBalance'),
      forecast: fileOf('revenueForecast'),
    },
  };
}

module.exports = { loadStore };
