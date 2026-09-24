// Revenue (invoicing) forecast analysis. The forecast lists expected subscription invoices;
// invoiced amounts are recognised as revenue over the subscription period, so billing and
// P&L revenue are different measures.
const P = require('../lib/periods');
const { r2, budgetMbr } = require('./pl');

const DAY = 86400000;
const eur = (v) => `EUR ${Number(v).toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const toDate = (s) => new Date(`${s}T00:00:00Z`);

// Straight-line split of an invoice over its subscription period (inclusive), by month.
function recognitionSchedule(row) {
  if (!row.subStart || !row.subEnd || row.amountEur == null) return null;
  const start = toDate(row.subStart);
  const end = toDate(row.subEnd);
  const days = Math.round((end - start) / DAY) + 1;
  if (days <= 0) return null;
  const perDay = row.amountEur / days;
  const out = {};
  for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
    const k = P.monthKeyFromDate(new Date(t));
    out[k] = (out[k] || 0) + perDay;
  }
  return out;
}

function overlaps(a, b) {
  return a.subStart && a.subEnd && b.subStart && b.subEnd && a.subStart <= b.subEnd && b.subStart <= a.subEnd;
}

function forecastQualityFlags(rows) {
  const flags = [];
  const byCustomer = new Map();
  for (const r of rows) {
    const k = r.customer.trim().toLowerCase();
    if (!byCustomer.has(k)) byCustomer.set(k, []);
    byCustomer.get(k).push(r);
  }
  for (const list of byCustomer.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (!overlaps(a, b)) continue;
        const same = Math.abs((a.amountEur || 0) - (b.amountEur || 0)) < 0.01;
        flags.push({
          type: same ? 'possible_duplicate' : 'overlapping_subscriptions',
          customer: a.customer,
          detail: `${same ? 'Same amount and overlapping' : 'Overlapping'} subscription periods: ${a.invoiceMonth} invoice (${a.subStart} to ${a.subEnd}, ${eur(a.amountEur)}) and ${b.invoiceMonth} invoice (${b.subStart} to ${b.subEnd}, ${eur(b.amountEur)}).`,
          rows: [a.ref, b.ref],
        });
      }
    }
  }
  for (const r of rows) {
    if (r.amountEur == null) flags.push({ type: 'missing_eur_amount', customer: r.customer, detail: `No EUR amount for ${r.invoiceMonth} invoice.`, rows: [r.ref] });
    if (r.subStart && r.invoiceDate && r.subStart < r.invoiceDate.slice(0, 7) + '-01' && P.monthRange(r.subStart.slice(0, 7), r.invoiceMonth).length > 2) {
      flags.push({ type: 'late_invoice', customer: r.customer, detail: `Invoice month ${r.invoiceMonth} is more than a month after subscription start ${r.subStart}.`, rows: [r.ref] });
    }
  }
  return flags;
}

function revenueForecast(store, { from, to, group_by = 'invoice_month', customer, top_n = 15, include_recognition = false } = {}) {
  const fc = store.forecast;
  if (!fc) return { error: 'No revenue forecast loaded.' };
  const allMonths = [...new Set(fc.rows.map((r) => r.invoiceMonth))].sort();
  let rows = fc.rows.filter((r) => (!from || r.invoiceMonth >= from) && (!to || r.invoiceMonth <= to));
  if (customer) {
    const q = String(customer).toLowerCase();
    rows = rows.filter((r) => r.customer.toLowerCase().includes(q));
  }
  const total = rows.reduce((s, r) => s + (r.amountEur || 0), 0);

  const group = (keyFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (!m.has(k)) m.set(k, { key: k, invoices: 0, amount_eur: 0, currencies: new Set() });
      const g = m.get(k);
      g.invoices++;
      g.amount_eur += r.amountEur || 0;
      g.currencies.add(r.currency);
    }
    return [...m.values()].map((g) => ({ ...g, amount_eur: r2(g.amount_eur), share_pct: r2((g.amount_eur / total) * 100), currencies: [...g.currencies] }));
  };

  let groups;
  if (group_by === 'customer') {
    groups = group((r) => r.customer).sort((a, b) => b.amount_eur - a.amount_eur).slice(0, top_n);
  } else if (group_by === 'currency') {
    groups = group((r) => r.currency).map((g) => {
      const list = rows.filter((r) => r.currency === g.key);
      const fcSum = list.reduce((s, r) => s + (r.amountFc || 0), 0);
      return { ...g, amount_fc: r2(fcSum), implied_eur_per_unit: g.key === 'EUR' ? 1 : Math.round((g.amount_eur / fcSum) * 1e6) / 1e6 };
    });
  } else if (group_by === 'fiscal_quarter') {
    groups = group((r) => P.fiscalQuarter(r.invoiceMonth));
  } else if (group_by === 'invoice') {
    groups = rows.map((r) => ({ invoice_month: r.invoiceMonth, customer: r.customer, subscription: `${r.subStart} to ${r.subEnd}`, currency: r.currency, amount_fc: r.amountFc, amount_eur: r2(r.amountEur) })).slice(0, top_n);
  } else {
    groups = group((r) => r.invoiceMonth).sort((a, b) => a.key.localeCompare(b.key));
  }

  const result = {
    measure: 'Forecast INVOICING (billing) of subscriptions, by invoice month. Not P&L revenue: invoices are recognised as revenue over the subscription period (via deferred income).',
    file_coverage: { first_invoice_month: allMonths[0], last_invoice_month: allMonths[allMonths.length - 1], total_rows: fc.rows.length },
    filter: { from: from || null, to: to || null, customer: customer || null },
    currency: 'EUR (amounts converted by Offspring; see implied rates with group_by="currency")',
    total_invoiced_eur: r2(total),
    invoices: rows.length,
    customers: new Set(rows.map((r) => r.customer)).size,
    group_by,
    groups,
  };

  // Budgeted P&L revenue for the same months, for context only (different measure).
  const months = [...new Set(rows.map((r) => r.invoiceMonth))].sort();
  const bud = months.length ? budgetMbr(store, months) : null;
  if (bud && !bud.missingMonths.length) {
    result.context_budget_revenue_same_months = {
      amount: r2(bud.lines['Total Revenue']),
      months: P.rangeLabel(months[0], months[months.length - 1]),
      caveat: 'Budgeted P&L (recognised) revenue. Not directly comparable with invoicing.',
    };
  }

  if (include_recognition) {
    const byMonth = {};
    let unscheduled = 0;
    for (const r of rows) {
      const s = recognitionSchedule(r);
      if (!s) { unscheduled += r.amountEur || 0; continue; }
      for (const [m, v] of Object.entries(s)) byMonth[m] = (byMonth[m] || 0) + v;
    }
    const fy = store.currentFy;
    const inFy = Object.entries(byMonth).filter(([m]) => P.fyOf(m) === fy).reduce((s, [, v]) => s + v, 0);
    const byFy = {};
    for (const [m, v] of Object.entries(byMonth)) byFy[P.fyLabel(P.fyOf(m))] = r2((byFy[P.fyLabel(P.fyOf(m))] || 0) + v);
    result.derived_recognition_estimate = {
      label: 'DERIVED ESTIMATE (not an official forecast): forecast invoices spread straight-line over their subscription dates.',
      recognised_in_current_fy: { fiscal_year: P.fyLabel(fy), amount: r2(inFy) },
      by_fiscal_year: byFy,
      by_month: Object.fromEntries(Object.entries(byMonth).sort().map(([m, v]) => [m, r2(v)])),
      ...(unscheduled ? { not_scheduled_missing_dates: r2(unscheduled) } : {}),
      limitations: 'Covers only the invoices in this forecast. Excludes release of existing deferred income (TB account 1620) and any invoices not listed.',
    };
  }

  const flags = forecastQualityFlags(rows);
  if (flags.length) result.data_quality_flags = flags;
  result.sources = [`${fc.file} › sheet "${fc.sheet}"`];
  return result;
}

module.exports = { revenueForecast, recognitionSchedule, forecastQualityFlags };
