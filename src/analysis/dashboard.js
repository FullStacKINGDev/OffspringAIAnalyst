// Chart data for the Home dashboard. Everything comes from the same deterministic engine the AI tools use,
// so the dashboard and Reflex AI can never disagree. Amounts are natural (revenue and costs both positive).
const P = require('../lib/periods');
const { r2, pct, accountTotals, mbrFromAccounts, budgetMbr, plStatement, topMovements, budgetPlan } = require('./pl');
const { balanceSheet } = require('./balance');

// Part-to-whole charts show at most 6 slices; the rest folds into "Other".
function foldToSix(items, otherLabel = 'Other') {
  const sorted = [...items].filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= 6) return sorted;
  const head = sorted.slice(0, 5);
  const tail = sorted.slice(5);
  return [...head, { key: 'other', label: otherLabel, value: tail.reduce((s, x) => s + x.value, 0), parts: tail.map((x) => x.label) }];
}

function dashboardCharts(store) {
  const fy = store.currentFy;
  const latest = store.latestActualMonth;
  const ytdMonths = P.monthRange(P.fyStart(fy), latest).filter((m) => store.actualMonthSet.has(m));
  const ytdLabel = P.rangeLabel(ytdMonths[0], ytdMonths[ytdMonths.length - 1]);
  const ytd = mbrFromAccounts(store, accountTotals(store, ytdMonths));
  const vsBudget = plStatement(store, { compare_with: 'budget' }).rows;
  const row = (l) => vsBudget.find((x) => x.line === l) || {};

  // 1) Revenue mix (part-to-whole). Slot order is fixed per segment so colours follow the segment.
  const revenueMix = [
    { key: 'Airline', label: 'Airline', value: ytd.Airline },
    { key: 'Forwarder', label: 'Forwarder', value: ytd.Forwarder },
    { key: 'GSA', label: 'GSA', value: ytd.GSA },
    { key: 'Airport', label: 'Airport', value: ytd.Airport },
    { key: 'Shipper', label: 'Shipper', value: ytd.Shipper },
    { key: 'Other', label: 'Other revenue & PY adj.', value: ytd['Other Revenue'] + ytd['PY Adjustments'] },
  ].map((x) => ({ ...x, value: r2(x.value) }));

  // 2) Segment variance vs budget, in % (segments differ ~50x in size, so % shows the story).
  const segmentsVsBudget = ['Airline', 'Forwarder', 'GSA', 'Airport', 'Shipper', 'Other Revenue']
    .map((l) => ({ label: l, actual: row(l).actual, budget: row(l).comparison, variance: row(l).variance, variance_pct: row(l).variance_pct }))
    .filter((x) => x.variance_pct != null);

  // 3) Revenue across the financial year: this year (actual), last year (actual), this year's budget.
  const fyMonths = P.fyMonths(fy);
  const monthRevenue = (m) => (store.actualMonthSet.has(m) ? r2(mbrFromAccounts(store, accountTotals(store, [m]))['Total Revenue']) : null);
  const revenueYear = {
    labels: fyMonths.map((m) => P.monthLabel(m).slice(0, 3)),
    months: fyMonths,
    series: [
      { key: 'actual', name: `${P.fyLabel(fy)} actual`, values: fyMonths.map(monthRevenue) },
      { key: 'budget', name: `${P.fyLabel(fy)} budget`, values: fyMonths.map((m) => r2(budgetMbr(store, [m]).lines['Total Revenue'])) },
      { key: 'prior', name: `${P.fyLabel(fy - 1)} actual`, values: fyMonths.map((m) => monthRevenue(P.addMonths(m, -12))) },
    ],
  };

  // 4) EBIT vs budget, last 12 months.
  const last12 = P.monthRange(P.addMonths(latest, -11), latest);
  const ebitTrend = {
    labels: last12.map((m) => P.monthLabel(m).slice(0, 3)),
    months: last12,
    series: [
      { key: 'actual', name: 'EBIT actual', values: last12.map((m) => r2(mbrFromAccounts(store, accountTotals(store, [m])).EBIT)) },
      { key: 'budget', name: 'EBIT budget', values: last12.map((m) => r2(budgetMbr(store, [m]).lines.EBIT)) },
    ],
  };

  // 5) Cost mix by workfile section (operating costs, YTD).
  const totals = accountTotals(store, ytdMonths);
  const sections = new Map();
  for (const a of store.plAccounts.filter((x) => x.type === 'expense')) {
    const cost = -(totals.get(a.code) || 0);
    sections.set(a.section, (sections.get(a.section) || 0) + cost);
  }
  const costMix = foldToSix([...sections].map(([label, value]) => ({ key: label, label: label.replace(/ Expenses$/, ''), value: r2(value) })), 'Other costs');

  // 6) Biggest cost changes vs the same months last year (diverging).
  const movers = topMovements(store, { compare_with: 'prior_year', type: 'expense', top_n: 8 });
  const costMovers = movers.movements.map((m) => ({
    label: m.line.replace(/^\d+ - /, ''),
    account: m.line,
    change: m.change,
    change_pct: m.change_pct,
    actual: m.actual_amount,
    prior: m.comparison_amount,
  }));

  // 6b) EBIT bridge: budget EBIT + the profit effect of each MBR line = actual EBIT. The budget only exists by
  // MBR category, so the bridge stops there. Amounts are natural (costs positive); effect is the profit impact.
  let ebitBridge = null;
  if (row('EBIT').comparison != null) {
    const steps = [
      { key: 'revenue', line: 'Total Revenue', label: 'Revenue', type: 'revenue' },
      { key: 'cogs', line: 'COGS', label: 'COGS', type: 'expense' },
      { key: 'general', line: 'General', label: 'General', type: 'expense' },
      { key: 'personnel', line: 'Personnel', label: 'Personnel', type: 'expense' },
    ].map((s) => {
      const sign = s.type === 'expense' ? -1 : 1;
      const actual = r2(sign * row(s.line).actual);
      const budget = r2(sign * row(s.line).comparison);
      return { key: s.key, label: s.label, type: s.type, actual, budget, effect: r2(row(s.line).variance), change_pct: pct(actual - budget, budget) };
    });
    const variance = r2(row('EBIT').variance);
    const residual = r2(variance - steps.reduce((sum, s) => sum + s.effect, 0));
    if (Math.abs(residual) >= 0.005) steps.push({ key: 'rounding', label: 'Rounding', type: 'other', actual: null, budget: null, effect: residual, change_pct: null });
    ebitBridge = { budget: r2(row('EBIT').comparison), actual: r2(row('EBIT').actual), variance, variance_pct: row('EBIT').variance_pct, steps };
  }

  // 6c) Progress against the full-year budget, next to where the phased budget expects to be by now.
  let budgetProgress = null;
  try {
    const plan = budgetPlan(store, { fiscal_year: P.fyLabel(fy) });
    const toDate = plan.budget_for_months_with_actuals || {};
    budgetProgress = {
      through: P.monthLabel(latest),
      items: [['Total Revenue', 'Revenue'], ['EBIT', 'EBIT']].map(([line, label]) => {
        const full = plan.full_year[line];
        const actual = plan.actual_to_date[line].actual;
        return {
          label, actual: r2(actual), full_year_budget: r2(full), budget_to_date: r2(toDate[line]),
          pct_achieved: pct(actual, full), pct_planned: pct(toDate[line], full),
        };
      }),
    };
  } catch { budgetProgress = null; }

  // 7) Asset mix and the largest balance-sheet movements since the start of the year.
  let assetMix = null;
  let balanceMoves = null;
  if (store.trialBalance) {
    const bs = balanceSheet(store, {});
    balanceMoves = {
      since: bs.period.opening_balance_date,
      as_of: bs.period.closing_balance_date,
      materiality: bs.materiality_threshold,
      items: bs.material_movements.slice(0, 8).map((mv) => {
        let label = mv.account.replace(/^\d+ - /, '');
        if (/^Result for the period/.test(label)) label = 'Result for the period';
        else if (mv.group === 'Cash and bank') label = `Bank ${label}`;
        return { label, account: mv.account, side: mv.side, group: mv.group, opening: mv.opening, closing: mv.closing, movement: mv.movement, movement_pct: mv.movement_pct };
      }),
    };
    const g = (name) => (bs.groups.find((x) => x.group === name) || {}).closing || 0;
    assetMix = {
      as_of: bs.period.closing_balance_date,
      total: bs.totals.assets.closing,
      items: [
        { key: 'group', label: 'Receivable from Shanwick B.V.', value: g('Receivable from group company (Shanwick B.V.)') },
        { key: 'cash', label: 'Cash and bank', value: g('Cash and bank') },
        { key: 'trade', label: 'Trade receivables', value: g('Trade receivables') },
        { key: 'tax', label: 'Tax receivables', value: g('Tax receivables') },
        { key: 'other', label: 'Other receivables', value: g('Other receivables and prepayments') },
        { key: 'fixed', label: 'Fixed assets', value: g('Intangible fixed assets') + g('Tangible fixed assets') },
      ].map((x) => ({ ...x, value: r2(x.value) })),
    };
  }

  // 8) Invoicing forecast by month, and 9) the distribution of invoice sizes (histogram).
  let invoicing = null;
  let invoiceSizes = null;
  if (store.forecast) {
    const rows = store.forecast.rows.filter((r) => r.amountEur != null);
    const months = [...new Set(rows.map((r) => r.invoiceMonth))].sort();
    invoicing = {
      total: r2(rows.reduce((s, r) => s + r.amountEur, 0)),
      items: months.map((m) => {
        const list = rows.filter((r) => r.invoiceMonth === m);
        return { label: P.monthLabel(m), month: m, value: r2(list.reduce((s, r) => s + r.amountEur, 0)), invoices: list.length };
      }),
    };
    const width = 10000;
    const max = Math.max(...rows.map((r) => r.amountEur));
    const bins = [];
    for (let from = 0; from < max; from += width) {
      const inBin = rows.filter((r) => r.amountEur >= from && r.amountEur < from + width);
      bins.push({ from, to: from + width, count: inBin.length, amount: r2(inBin.reduce((s, r) => s + r.amountEur, 0)) });
    }
    const sortedAmounts = rows.map((r) => r.amountEur).sort((a, b) => a - b);
    const median = sortedAmounts.length % 2 ? sortedAmounts[(sortedAmounts.length - 1) / 2] : (sortedAmounts[sortedAmounts.length / 2 - 1] + sortedAmounts[sortedAmounts.length / 2]) / 2;
    invoiceSizes = { bin_width: width, bins, invoices: rows.length, median: r2(median), largest: r2(max) };
  }

  return {
    ytd_label: ytdLabel,
    fiscal_year: P.fyLabel(fy),
    revenue_mix: { total: r2(ytd['Total Revenue']), items: revenueMix },
    segments_vs_budget: segmentsVsBudget,
    revenue_year: revenueYear,
    ebit_trend: ebitTrend,
    cost_mix: { total: r2(costMix.reduce((s, x) => s + x.value, 0)), items: costMix },
    cost_movers: { comparison: movers.comparison && movers.comparison.label, items: costMovers },
    ebit_bridge: ebitBridge,
    budget_progress: budgetProgress,
    asset_mix: assetMix,
    balance_moves: balanceMoves,
    invoicing,
    invoice_sizes: invoiceSizes,
    growth: {
      revenue_vs_py_pct: pct(ytd['Total Revenue'] - mbrFromAccounts(store, accountTotals(store, ytdMonths.map((m) => P.addMonths(m, -12))))['Total Revenue'],
        mbrFromAccounts(store, accountTotals(store, ytdMonths.map((m) => P.addMonths(m, -12))))['Total Revenue']),
    },
  };
}

module.exports = { dashboardCharts };
