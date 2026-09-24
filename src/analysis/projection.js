// Year-end projection for a financial year: actual YTD plus three transparent methods for the
// remaining months. These are AI-generated projections, never an official forecast.
const P = require('../lib/periods');
const { r2, pct, accountTotals, mbrFromAccounts, budgetMbr } = require('./pl');
const { recognitionSchedule } = require('./forecast');

const LINES = ['Total Revenue', 'COGS', 'General', 'Personnel', 'Total Expenses', 'EBIT', 'Interest', 'Taxes', 'Net Income'];

function yearEndProjection(store, { fiscal_year } = {}) {
  const fy = P.parseFy(fiscal_year) || store.currentFy;
  const months = P.fyMonths(fy);
  const actualMonths = months.filter((m) => store.actualMonthSet.has(m));
  const remaining = months.filter((m) => !store.actualMonthSet.has(m) && m > (actualMonths[actualMonths.length - 1] || ''));
  const gaps = months.filter((m) => !store.actualMonthSet.has(m) && !remaining.includes(m));
  if (!actualMonths.length) return { error: `No actuals for ${P.fyLabel(fy)} yet.` };

  const ytd = mbrFromAccounts(store, accountTotals(store, actualMonths));
  const fullBudget = budgetMbr(store, months);
  const remBudget = remaining.length ? budgetMbr(store, remaining) : null;

  // Run-rate: average of the last three actual months.
  const last3 = actualMonths.slice(-3);
  const last3Mbr = mbrFromAccounts(store, accountTotals(store, last3));

  // Prior-year pattern: PY actuals for the remaining months, scaled by YTD growth vs PY.
  const pyYtdMonths = actualMonths.map((m) => P.addMonths(m, -12));
  const pyRemMonths = remaining.map((m) => P.addMonths(m, -12));
  const pyAvailable = [...pyYtdMonths, ...pyRemMonths].every((m) => store.actualMonthSet.has(m));
  const pyYtd = pyAvailable ? mbrFromAccounts(store, accountTotals(store, pyYtdMonths)) : null;
  const pyRem = pyAvailable ? mbrFromAccounts(store, accountTotals(store, pyRemMonths)) : null;

  const methods = {
    budget_for_remaining_months: {
      description: `Actual ${P.rangeLabel(actualMonths[0], actualMonths[actualMonths.length - 1])} + budget for ${remaining.length ? P.rangeLabel(remaining[0], remaining[remaining.length - 1]) : 'no remaining months'}`,
      assumptions: ['Remaining months perform exactly to the MBR BUDGET sheet.'],
      values: {},
    },
    run_rate: {
      description: `Actual YTD + average of the last ${last3.length} actual months (${P.rangeLabel(last3[0], last3[last3.length - 1])}) x ${remaining.length} remaining months`,
      assumptions: ['No seasonality or growth beyond the recent monthly average.', 'One-off items in the last three months are repeated.'],
      values: {},
    },
    prior_year_pattern: {
      description: 'Actual YTD + prior-year actuals for the remaining months, scaled by YTD growth vs the same months last year (per line)',
      assumptions: ['Remaining months follow last year\'s seasonality.', 'The YTD growth rate vs prior year continues for the rest of the year.'],
      values: {},
    },
  };

  for (const l of LINES) {
    const a = ytd[l];
    if (remBudget) {
      const b = remBudget.lines[l];
      methods.budget_for_remaining_months.values[l] = b == null ? null : r2(a + b);
    } else methods.budget_for_remaining_months.values[l] = r2(a);
    methods.run_rate.values[l] = r2(a + (last3Mbr[l] / last3.length) * remaining.length);
    if (pyAvailable && Math.abs(pyYtd[l]) > 1 && Math.sign(pyYtd[l]) === Math.sign(a)) {
      methods.prior_year_pattern.values[l] = r2(a + pyRem[l] * (a / pyYtd[l]));
    } else {
      methods.prior_year_pattern.values[l] = null;
    }
  }
  if (!pyAvailable) methods.prior_year_pattern.unavailable = 'Prior-year actuals are not available for all required months.';
  // Keep subtotals consistent with their components where each method has them.
  for (const m of Object.values(methods)) {
    const v = m.values;
    if (m === methods.prior_year_pattern || m === methods.run_rate) {
      if ([v.COGS, v.General, v.Personnel].every((x) => x != null)) v['Total Expenses'] = r2(v.COGS + v.General + v.Personnel);
      if (v['Total Revenue'] != null && v['Total Expenses'] != null) v.EBIT = r2(v['Total Revenue'] + v['Total Expenses']);
      if ([v.EBIT, v.Interest, v.Taxes].every((x) => x != null)) v['Net Income'] = r2(v.EBIT + v.Interest + v.Taxes);
    }
    if (v.EBIT != null && v['Total Revenue']) v['EBIT %'] = r2((v.EBIT / v['Total Revenue']) * 100);
  }

  const vsBudget = {};
  for (const [name, m] of Object.entries(methods)) {
    vsBudget[name] = {};
    for (const l of ['Total Revenue', 'EBIT', 'Net Income']) {
      const b = fullBudget.lines[l];
      const v = m.values[l];
      vsBudget[name][l] = v == null || b == null ? null : { projection: v, full_year_budget: r2(b), gap: r2(v - b), gap_pct: pct(v - b, b) };
    }
  }

  const required = {};
  if (remaining.length) {
    for (const l of ['Total Revenue', 'EBIT']) {
      const b = fullBudget.lines[l];
      if (b == null) continue;
      required[l] = {
        full_year_budget: r2(b),
        actual_ytd: r2(ytd[l]),
        still_needed: r2(b - ytd[l]),
        required_monthly_average: r2((b - ytd[l]) / remaining.length),
        recent_monthly_average: r2(last3Mbr[l] / last3.length),
        ytd_budget_achieved_pct: r2((ytd[l] / b) * 100),
      };
    }
  }

  // Invoicing pipeline for the remaining months, as context.
  let invoicing = null;
  if (store.forecast && remaining.length) {
    const rows = store.forecast.rows.filter((r) => r.invoiceMonth >= remaining[0] && r.invoiceMonth <= remaining[remaining.length - 1]);
    let inFy = 0;
    for (const r of rows) {
      const sched = recognitionSchedule(r);
      if (sched) for (const [m, v] of Object.entries(sched)) if (P.fyOf(m) === fy) inFy += v;
    }
    invoicing = {
      remaining_months_forecast_invoicing_eur: r2(rows.reduce((s, r) => s + (r.amountEur || 0), 0)),
      invoices: rows.length,
      of_which_recognised_as_revenue_in_this_fy_estimate: r2(inFy),
      caveat: 'Invoicing (billing), NOT P&L revenue. Do not add it to YTD revenue or compare it with the remaining revenue budget. '
        + 'Only the part of each subscription that falls inside the financial year becomes FY revenue (straight-line estimate above); '
        + 'the release of existing deferred income is not included in that estimate.',
    };
  }

  return {
    label: 'AI-GENERATED PROJECTION: not an official company forecast or budget.',
    fiscal_year: P.fyLabel(fy),
    fiscal_year_months: P.rangeLabel(months[0], months[11]),
    actual_months: actualMonths.length ? P.rangeLabel(actualMonths[0], actualMonths[actualMonths.length - 1]) : null,
    remaining_months: remaining.length,
    ...(gaps.length ? { warnings: [`Months without actuals inside the year: ${gaps.map(P.monthLabel).join(', ')} (not treated as zero).`] } : {}),
    currency: store.currency,
    sign_convention: 'MBR presentation: income positive, costs negative.',
    actual_ytd: Object.fromEntries([...LINES, 'EBIT %'].map((l) => [l, r2(ytd[l])])),
    full_year_budget: Object.fromEntries([...LINES, 'EBIT %'].map((l) => [l, r2(fullBudget.lines[l])])),
    methods,
    projection_vs_full_year_budget: vsBudget,
    ...(Object.keys(required).length ? { run_rate_needed_to_meet_budget: required } : {}),
    ...(invoicing ? { invoicing_pipeline_context: invoicing } : {}),
    sources: [
      `${store.files.workfile} › sheet "${store.plSheet}" (actuals)`,
      `${store.files.mbr} › sheet "BUDGET" (budget)`,
      ...(invoicing ? [`${store.forecast.file} (invoicing forecast)`] : []),
    ],
  };
}

module.exports = { yearEndProjection };
