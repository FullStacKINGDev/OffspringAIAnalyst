// Deterministic headline figures for the UI sidebar (no AI involved).
const config = require('../config');
const P = require('../lib/periods');
const { plStatement, plTrend } = require('./pl');
const { balanceSheet } = require('./balance');

const SOURCE_ROLES = {
  plWorkfile: 'Primary source of P&L actuals (account level, monthly)',
  mbr: 'Budget; MBR report pages used for reconciliation',
  trialBalance: 'Trial balance and balance sheet; cross-check of the P&L',
  revenueForecast: 'Expected subscription invoices (billing, not revenue)',
};

function overview(store) {
  const latest = store.latestActualMonth;
  const fy = store.currentFy;
  const ytdB = plStatement(store, { compare_with: 'budget' });
  const ytdPy = plStatement(store, { compare_with: 'prior_year' });
  const row = (res, line) => res.rows.find((r) => r.line === line) || {};

  const trend = plTrend(store, {
    lines: ['Total Revenue', 'EBIT', 'Net Income'],
    from: P.addMonths(latest, -11),
    to: latest,
    include_prior_year: false,
  });
  const series = (i) => trend.series[i].points.map((p) => ({ month: p.period, label: P.monthLabel(p.period), actual: p.actual, budget: p.budget ?? null }));

  const kpi = (line, i) => ({
    line,
    actual: row(ytdB, line).actual,
    budget: row(ytdB, line).comparison,
    vs_budget_pct: row(ytdB, line).variance_pct,
    prior_year: row(ytdPy, line).comparison,
    vs_prior_year_pct: row(ytdPy, line).variance_pct,
    trend: series(i).map(({ label, actual }) => ({ label, actual })),
  });

  const bs = store.trialBalance ? balanceSheet(store) : null;
  const counts = {};
  for (const i of store.issues || []) counts[i.severity] = (counts[i.severity] || 0) + 1;
  const monthsElapsed = P.monthRange(P.fyStart(fy), latest).length;

  return {
    company: store.company.replace(/^\d+\s*-\s*/, ''),
    currency: store.currency,
    model: config.model,
    latest_month: P.monthLabel(latest),
    fiscal_year: P.fyLabel(fy),
    fiscal_year_range: P.rangeLabel(P.fyStart(fy), P.fyEnd(fy)),
    ytd_range: ytdB.period.label,
    fy_progress: { months_elapsed: monthsElapsed, months_total: 12 },
    kpis: [kpi('Total Revenue', 0), kpi('EBIT', 1), kpi('Net Income', 2)],
    ebit_margin: { actual: row(ytdB, 'EBIT %').actual, budget: row(ytdB, 'EBIT %').comparison },
    revenue_trend: series(0),
    balance: bs ? {
      as_of: bs.period.closing_balance_date,
      cash: bs.key_metrics.cash_and_bank,
      deferred_income: bs.key_metrics.deferred_income,
      group_receivable: (() => {
        const g = bs.groups.find((x) => /group company/i.test(x.group));
        return g ? { opening: g.opening, closing: g.closing } : null;
      })(),
    } : null,
    sources: store.sources.map((s) => ({ ...s, role: SOURCE_ROLES[s.kind] || '' })),
    issues: {
      counts,
      total: (store.issues || []).length,
      list: (store.issues || []).map((i) => ({ id: i.id, severity: i.severity, area: i.area, title: i.title })),
    },
    loaded_at: store.loadedAt,
  };
}

module.exports = { overview };
