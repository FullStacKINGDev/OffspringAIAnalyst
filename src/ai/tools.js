// Tools the model can call. Every number in an answer comes from one of these handlers.
const { plStatement, plTrend, topMovements, budgetPlan } = require('../analysis/pl');
const { trialBalance, balanceSheet } = require('../analysis/balance');
const { revenueForecast } = require('../analysis/forecast');
const { yearEndProjection } = require('../analysis/projection');
const { dataQualityReport } = require('../analysis/dataQuality');

const month = (desc) => ({ type: 'string', description: `${desc} Month as YYYY-MM.` });

const TOOLS = [
  {
    name: 'pl_statement',
    description: 'Profit & loss for a period (sum of months), optionally compared with budget, prior year or the previous period. '
      + 'Returns MBR lines (revenue by segment, COGS, General, Personnel, EBIT, EBIT %, Interest, Taxes, Net Income) or section/account detail, '
      + 'variances, and the largest drivers of the variance. Use for: current revenue/profit, actual vs budget, YoY, "why did X change".',
    parameters: {
      type: 'object',
      properties: {
        from: month('First month. Defaults to the start of the current financial year.'),
        to: month('Last month. Defaults to the latest month with actuals.'),
        level: { type: 'string', enum: ['mbr', 'section', 'account'], description: 'mbr = MBR categories (default); section = workfile cost sections; account = G/L accounts.' },
        compare_with: { type: 'string', enum: ['none', 'budget', 'prior_year', 'previous_period'], description: 'Comparison basis. budget only has MBR-category detail.' },
      },
    },
  },
  {
    name: 'pl_trend',
    description: 'Time series for one or more P&L lines by month, fiscal quarter or year, with budget, prior-year and period-over-period changes, '
      + 'plus highlights (highest/lowest period, biggest increases, largest budget variances). Use for trends, growth rates and "which months" questions.',
    parameters: {
      type: 'object',
      properties: {
        lines: { type: 'array', items: { type: 'string' }, description: 'MBR line (e.g. "Total Revenue", "Airline", "EBIT", "Net Income", "Personnel"), workfile section (e.g. "Sales Expenses") or G/L account code (e.g. "4720").' },
        from: month('First month. Defaults to 11 months before the latest actual month.'),
        to: month('Last month. Defaults to the latest month with actuals.'),
        granularity: { type: 'string', enum: ['month', 'fiscal_quarter', 'fiscal_year', 'calendar_year'] },
        include_budget: { type: 'boolean', description: 'Add budget and budget variance (MBR lines only). Default true.' },
        include_prior_year: { type: 'boolean', description: 'Add prior-year value and YoY change. Default true.' },
      },
      required: ['lines'],
    },
  },
  {
    name: 'top_movements',
    description: 'Ranks G/L accounts (or sections) by change between a period and its prior year / previous period. '
      + 'Use for "which expenses are increasing the most", "biggest revenue changes", cost drivers.',
    parameters: {
      type: 'object',
      properties: {
        from: month('First month. Defaults to current FY start.'),
        to: month('Last month. Defaults to latest actual month.'),
        compare_with: { type: 'string', enum: ['prior_year', 'previous_period'] },
        level: { type: 'string', enum: ['account', 'section'] },
        type: { type: 'string', enum: ['expense', 'revenue', 'financial', 'tax', 'all'], description: 'Default expense.' },
        direction: { type: 'string', enum: ['any', 'increase', 'decrease', 'adverse', 'favourable'] },
        top_n: { type: 'integer', minimum: 1, maximum: 40 },
      },
    },
  },
  {
    name: 'budget_plan',
    description: 'The official budget for a financial year from the MBR BUDGET sheet: full-year totals by MBR line, '
      + 'revenue by segment, budget for the months with actuals vs the remaining months, and every month. '
      + 'Use for "what is the budget", "annual budget/forecast", "how much is left to reach budget".',
    parameters: {
      type: 'object',
      properties: { fiscal_year: { type: 'string', description: 'e.g. "FY2027" (= FY 26/27). Defaults to the current financial year.' } },
    },
  },
  {
    name: 'trial_balance',
    description: 'Exact Online trial balance for the current financial year to date: opening, debit, credit, closing and movement per G/L account, '
      + 'with automatic flags (material movements, balances on the wrong side, uncleared suspense, differences vs the P&L workfile).',
    parameters: {
      type: 'object',
      properties: {
        statement: { type: 'string', enum: ['all', 'balance_sheet', 'profit_and_loss'] },
        search: { type: 'string', description: 'Account code prefix or text in the account name/group.' },
        sort: { type: 'string', enum: ['abs_movement', 'abs_closing', 'activity', 'code'] },
        only_flagged: { type: 'boolean', description: 'Only accounts with at least one flag.' },
        top_n: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'balance_sheet',
    description: 'Balance sheet derived from the trial balance: opening (start of FY) vs closing (latest period) by group, totals, '
      + 'balance check, key metrics (cash, current ratio, group receivable share, deferred income) and material movements.',
    parameters: {
      type: 'object',
      properties: { detail: { type: 'string', enum: ['summary', 'account'] } },
    },
  },
  {
    name: 'revenue_forecast',
    description: 'Offspring revenue (INVOICING) forecast of subscription invoices by invoice month, quarter, customer or currency, '
      + 'with optional straight-line revenue-recognition estimate and data-quality flags. This is billing, not P&L revenue.',
    parameters: {
      type: 'object',
      properties: {
        from: month('First invoice month.'),
        to: month('Last invoice month.'),
        group_by: { type: 'string', enum: ['invoice_month', 'fiscal_quarter', 'customer', 'currency', 'invoice'] },
        customer: { type: 'string', description: 'Filter by customer name (substring).' },
        top_n: { type: 'integer', minimum: 1, maximum: 120 },
        include_recognition: { type: 'boolean', description: 'Add the derived revenue-recognition estimate by month and fiscal year.' },
      },
    },
  },
  {
    name: 'year_end_projection',
    description: 'AI projection of full-year results: actual YTD plus three methods for the remaining months (budget, run-rate, prior-year pattern), '
      + 'compared with the full-year budget, and the monthly run-rate needed to meet budget. Label results as AI projections.',
    parameters: {
      type: 'object',
      properties: { fiscal_year: { type: 'string', description: 'e.g. "FY2027". Defaults to the current financial year.' } },
    },
  },
  {
    name: 'data_quality_report',
    description: 'Reconciliation results across sources (TB vs workfile, MBR report vs recomputed, budget versions, forecast duplicates, labels). '
      + 'Use for risks, reliability, discrepancies or whenever an answer relies on a figure with a known issue.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A finding id such as "DQ10" to get that finding with its evidence.' },
        severity: { type: 'string', enum: ['high', 'medium', 'low', 'info'] },
        area: { type: 'string', description: 'Filter by area or title text, e.g. "Budget", "Trial balance", "Revenue forecast".' },
      },
    },
  },
];

const HANDLERS = {
  pl_statement: plStatement,
  pl_trend: plTrend,
  budget_plan: budgetPlan,
  top_movements: topMovements,
  trial_balance: trialBalance,
  balance_sheet: balanceSheet,
  revenue_forecast: revenueForecast,
  year_end_projection: yearEndProjection,
  data_quality_report: dataQualityReport,
};

const TOOL_SCHEMAS = TOOLS.map((t) => ({ type: 'function', function: t }));

function runTool(store, name, args) {
  const fn = HANDLERS[name];
  if (!fn) return { error: `Unknown tool ${name}` };
  try {
    return fn(store, args || {});
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { TOOL_SCHEMAS, runTool, TOOLS };
