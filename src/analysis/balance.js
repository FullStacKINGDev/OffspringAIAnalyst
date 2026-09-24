// Trial balance and balance sheet analysis (Exact Online TB export).
// TB amounts keep Exact's sign: debit positive, credit negative.
const config = require('../config');
const P = require('../lib/periods');
const { BS_GROUP_ORDER } = require('../data/accountMap');
const { r2, pct, accountTotals } = require('./pl');

function tbPeriod(store) {
  const { meta } = store.trialBalance;
  const months = meta.months;
  return {
    financial_year: meta.financialYear ? `FY${meta.financialYear}` : null,
    periods: meta.periodText,
    months: months.length ? P.rangeLabel(months[0], months[months.length - 1]) : null,
    opening_balance_date: months.length ? `start of ${P.monthLabel(months[0])}` : null,
    closing_balance_date: months.length ? `end of ${P.monthLabel(months[months.length - 1])}` : null,
    prepared: meta.prepared,
    export_view_options: meta.viewOptions,
  };
}

// Differences between TB P&L closing balances and the P&L workfile for the same months.
function tbVsWorkfile(store) {
  const tb = store.trialBalance;
  const wf = accountTotals(store, tb.meta.months.filter((m) => store.actualMonthSet.has(m)));
  const out = new Map();
  for (const a of tb.accounts.filter((x) => x.statement === 'profit_and_loss')) {
    const wfRaw = store.accountByCode.has(a.code) ? -(wf.get(a.code) || 0) : null;
    if (wfRaw == null) { out.set(a.code, { workfile: null, diff: null }); continue; }
    const diff = a.closing - wfRaw;
    out.set(a.code, { workfile: wfRaw, diff });
  }
  return out;
}

function accountFlags(store, a, recon) {
  const flags = [];
  const mat = config.materiality;
  const movement = a.closing - a.opening;
  if (Math.abs(a.opening + a.debit - a.credit - a.closing) > 0.01) {
    flags.push('Arithmetic check failed: opening + debit - credit does not equal closing balance');
  }
  if (a.statement === 'balance_sheet') {
    if (a.side === 'asset' && !a.contra && a.closing < -1) flags.push('Credit balance on an asset account (unexpected side)');
    if (a.contra && a.closing > 1) flags.push('Debit balance on a contra-asset account (unexpected side)');
    if (a.side === 'liability' && a.closing > 1) flags.push('Debit balance on a liability account (unexpected side)');
    if (a.side === 'suspense' && Math.abs(a.closing) > 1) flags.push(`Suspense account not cleared (balance ${r2(a.closing)})`);
    if (Math.abs(movement) >= mat) flags.push(`Material movement (>= EUR ${mat.toLocaleString('en')})`);
    else if (Math.abs(a.opening) > 0 && Math.abs(movement / a.opening) >= 0.5 && Math.abs(movement) >= mat / 5) flags.push('Large relative movement (>= 50%)');
    if (Math.abs(a.opening) < 0.01 && Math.abs(a.closing) >= 1) flags.push('New balance this year (opening balance was zero)');
    if (Math.abs(a.opening) >= 1 && Math.abs(a.closing) < 0.01) flags.push('Balance fully cleared this year');
    if (!a.mapped) flags.push('Account not in the balance-sheet mapping; grouped by code range');
  } else {
    const isRevenue = /^8/.test(a.code);
    if (isRevenue && a.closing > 1) flags.push('Revenue account with a net debit balance');
    if (/^[47]/.test(a.code) && a.closing < -1) flags.push('Expense account with a net credit balance');
    const r = recon?.get(a.code);
    if (r && r.diff != null && Math.abs(r.diff) >= 0.5) flags.push(`Differs from P&L workfile by ${r2(r.diff)} (TB ${r2(a.closing)} vs workfile ${r2(r.workfile)})`);
    if (r && r.workfile == null) flags.push('Account not present in the P&L workfile');
  }
  if (Math.abs(a.opening) < 0.01 && Math.abs(a.closing) < 0.01 && a.debit + a.credit > 0) flags.push('Postings fully offset within the period (nil opening and closing)');
  return flags;
}

function trialBalance(store, { statement = 'all', search, sort = 'abs_movement', top_n = 100, only_flagged = false } = {}) {
  const tb = store.trialBalance;
  if (!tb) return { error: 'No trial balance loaded.' };
  const recon = tbVsWorkfile(store);
  let rows = tb.accounts.map((a) => {
    const movement = a.closing - a.opening;
    return {
      account: `${a.code} - ${a.name}`,
      code: a.code,
      statement: a.statement,
      group: a.statement === 'balance_sheet' ? a.bsGroup : a.plCategory,
      opening: r2(a.opening),
      debit: r2(a.debit),
      credit: r2(a.credit),
      closing: r2(a.closing),
      movement: r2(movement),
      movement_pct: pct(movement, a.opening),
      flags: accountFlags(store, a, recon),
    };
  });
  if (statement !== 'all') rows = rows.filter((r) => r.statement === statement);
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter((r) => r.code.startsWith(q) || r.account.toLowerCase().includes(q) || (r.group || '').toLowerCase().includes(q));
  }
  if (only_flagged) rows = rows.filter((r) => r.flags.length);
  const sorters = {
    abs_movement: (a, b) => Math.abs(b.movement) - Math.abs(a.movement),
    abs_closing: (a, b) => Math.abs(b.closing) - Math.abs(a.closing),
    activity: (a, b) => (b.debit + b.credit) - (a.debit + a.credit),
    code: (a, b) => a.code.localeCompare(b.code),
  };
  rows.sort(sorters[sort] || sorters.abs_movement);

  const totalDebit = tb.accounts.reduce((s, a) => s + a.debit, 0);
  const totalCredit = tb.accounts.reduce((s, a) => s + a.credit, 0);
  return {
    period: tbPeriod(store),
    currency: store.currency,
    sign_convention: 'Exact Online convention: debit balances positive, credit balances negative. movement = closing - opening. For P&L accounts the closing balance is the year-to-date result (revenue negative, costs positive).',
    totals: { debit: r2(totalDebit), credit: r2(totalCredit), in_balance: Math.abs(totalDebit - totalCredit) < 0.01 },
    result_lines: tb.resultLines.map((l) => ({ label: l.label, balance: r2(l.trialDebit - l.trialCredit), note: 'Shown with its credit side from the Trial (Credit) column; the export prints this line unsigned.' })),
    accounts_returned: Math.min(rows.length, top_n),
    accounts_matching: rows.length,
    accounts: rows.slice(0, top_n),
    sources: [`${tb.file} › sheet "${tb.sheet}"`],
  };
}

function balanceSheet(store, { detail = 'summary' } = {}) {
  const tb = store.trialBalance;
  if (!tb) return { error: 'No trial balance loaded.' };
  const bs = tb.accounts.filter((a) => a.statement === 'balance_sheet');
  const pl = tb.accounts.filter((a) => a.statement === 'profit_and_loss');
  const recon = tbVsWorkfile(store);

  // Presentation amount: assets as debit balances, liabilities and equity as credit balances.
  const natural = (side, v) => (side === 'asset' ? v : -v);
  const groups = new Map();
  const addTo = (group, side, name, opening, closing, flags = []) => {
    if (!groups.has(group)) groups.set(group, { group, side, opening: 0, closing: 0, accounts: [] });
    const g = groups.get(group);
    g.opening += opening;
    g.closing += closing;
    g.accounts.push({ account: name, opening: r2(opening), closing: r2(closing), movement: r2(closing - opening), movement_pct: pct(closing - opening, opening), ...(flags.length ? { flags } : {}) });
  };
  for (const a of bs) {
    // Suspense sits with liabilities when in credit and with assets when in debit.
    const side = a.side === 'suspense' ? (a.closing < 0 ? 'liability' : 'asset') : a.side;
    addTo(a.bsGroup, side, `${a.code} - ${a.name}`, natural(side, a.opening), natural(side, a.closing), accountFlags(store, a, recon));
  }
  for (const l of tb.resultLines.filter((x) => !/^Total:/i.test(x.label))) {
    const bal = l.trialDebit - l.trialCredit;
    addTo('Equity', 'equity', l.label, -bal, -bal);
  }
  const plResult = pl.reduce((s, a) => s + a.closing, 0);
  addTo('Equity', 'equity', `Result for the period (${tbPeriod(store).months}, from P&L accounts)`, 0, -plResult);

  const order = (g) => { const i = BS_GROUP_ORDER.indexOf(g); return i < 0 ? 999 : i; };
  const list = [...groups.values()].sort((a, b) => order(a.group) - order(b.group));
  const sideTotal = (side, k) => list.filter((g) => g.side === side).reduce((s, g) => s + g[k], 0);
  const totals = {};
  for (const side of ['asset', 'liability', 'equity']) {
    totals[side] = { opening: r2(sideTotal(side, 'opening')), closing: r2(sideTotal(side, 'closing')) };
    totals[side].movement = r2(totals[side].closing - totals[side].opening);
  }
  const check = (k) => r2(sideTotal('asset', k) - sideTotal('liability', k) - sideTotal('equity', k));

  const g = (name) => groups.get(name) || { opening: 0, closing: 0 };
  const cash = g('Cash and bank');
  const currentAssets = list.filter((x) => x.side === 'asset' && !/fixed assets/i.test(x.group));
  const caTotal = (k) => currentAssets.reduce((s, x) => s + x[k], 0);
  const ic = g('Receivable from group company (Shanwick B.V.)');
  const liab = (k) => sideTotal('liability', k);
  const metrics = {
    cash_and_bank: { opening: r2(cash.opening), closing: r2(cash.closing) },
    current_ratio: { opening: r2(caTotal('opening') / liab('opening')), closing: r2(caTotal('closing') / liab('closing')) },
    current_ratio_excluding_group_receivable: {
      opening: r2((caTotal('opening') - ic.opening) / liab('opening')),
      closing: r2((caTotal('closing') - ic.closing) / liab('closing')),
    },
    group_receivable_share_of_total_assets_pct: {
      opening: pct(ic.opening, totals.asset.opening),
      closing: pct(ic.closing, totals.asset.closing),
    },
    deferred_income: { opening: r2(g('Deferred income').opening), closing: r2(g('Deferred income').closing) },
    note: 'All liabilities in the TB are current (no long-term debt accounts). Current assets exclude fixed assets.',
  };

  const materialMoves = list.flatMap((x) => x.accounts.map((a) => ({ ...a, group: x.group, side: x.side })))
    .filter((a) => Math.abs(a.movement) >= config.materiality)
    .sort((a, b) => Math.abs(b.movement) - Math.abs(a.movement))
    .map(({ account, group, side, opening, closing, movement, movement_pct }) => ({ account, group, side, opening, closing, movement, movement_pct }));

  return {
    period: tbPeriod(store),
    currency: store.currency,
    sign_convention: 'Presentation amounts: assets, liabilities and equity are all shown as positive balances. A negative asset (or liability) amount means the balance is on the unexpected side. movement = closing - opening.',
    classification_basis: 'Balance-sheet grouping follows the Dutch decimal chart of accounts (0xxx fixed assets/equity, 1xxx current assets/liabilities) and the account names; see src/data/accountMap.js.',
    groups: list.map((x) => ({
      group: x.group,
      side: x.side,
      opening: r2(x.opening),
      closing: r2(x.closing),
      movement: r2(x.closing - x.opening),
      movement_pct: pct(x.closing - x.opening, x.opening),
      ...(detail === 'account' ? { accounts: x.accounts } : {}),
    })),
    totals: { assets: totals.asset, liabilities: totals.liability, equity: totals.equity },
    balance_check: { opening_difference: check('opening'), closing_difference: check('closing'), note: 'assets - liabilities - equity; 0 means the balance sheet balances.' },
    key_metrics: metrics,
    material_movements: materialMoves,
    materiality_threshold: config.materiality,
    sources: [`${tb.file} › sheet "${tb.sheet}"`],
  };
}

module.exports = { trialBalance, balanceSheet, tbVsWorkfile, tbPeriod };
