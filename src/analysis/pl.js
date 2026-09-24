// Deterministic P&L engine. All amounts use the MBR presentation ("profit impact"):
// income positive, costs negative, so subtotals are plain sums and a positive variance is
// always favourable to profit.
const P = require('../lib/periods');

const REVENUE_LINES = ['Airline', 'Forwarder', 'GSA', 'Airport', 'Shipper', 'PY Adjustments', 'Other Revenue'];
const COST_LINES = ['COGS', 'General', 'Personnel'];
const MBR_LINES = [...REVENUE_LINES, 'Total Revenue', ...COST_LINES, 'Total Expenses', 'EBIT', 'EBIT %', 'Interest', 'Taxes', 'Net Income'];
const LINE_TYPE = {
  'Total Revenue': 'revenue', 'Total Expenses': 'expense', EBIT: 'profit', 'EBIT %': 'margin',
  Interest: 'financial', Taxes: 'tax', 'Net Income': 'profit',
};
for (const l of REVENUE_LINES) LINE_TYPE[l] = 'revenue';
for (const l of COST_LINES) LINE_TYPE[l] = 'expense';

const SIGN_CONVENTION = 'MBR presentation: income is positive and costs are negative. variance = actual - comparison, '
  + 'so a positive variance is favourable to profit and a negative variance is adverse. For cost lines a negative variance '
  + 'means costs were HIGHER than the comparison. variance_pct = variance / |comparison| * 100. EBIT % values and their '
  + 'variances are in percent / percentage points.';

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const pct = (num, den) => (num == null || den == null || Math.abs(den) < 1e-9 ? null : r2((num / Math.abs(den)) * 100));

// ---------- building blocks ----------

// Profit impact per account over a set of months: Map(code -> value).
function accountTotals(store, months) {
  const out = new Map();
  for (const a of store.plAccounts) {
    let s = 0;
    for (const m of months) s += a.monthly[m] || 0;
    out.set(a.code, -s);
  }
  return out;
}

function sumOrNull(values) {
  if (values.some((v) => v == null)) return null;
  return values.reduce((a, b) => a + b, 0);
}

// MBR category lines from account totals. Accounts the map could not place ("Unmapped ...")
// still count towards the totals so nothing silently drops out.
function mbrFromAccounts(store, totals) {
  const lines = {};
  for (const l of [...REVENUE_LINES, ...COST_LINES, 'Interest', 'Taxes']) lines[l] = 0;
  for (const a of store.plAccounts) {
    const v = totals.get(a.code) || 0;
    lines[a.category] = (lines[a.category] || 0) + v;
  }
  lines['Total Revenue'] = REVENUE_LINES.reduce((s, l) => s + lines[l], 0) + (lines['Unmapped revenue'] || 0);
  lines['Total Expenses'] = COST_LINES.reduce((s, l) => s + lines[l], 0) + (lines.Unmapped || 0);
  lines.EBIT = lines['Total Revenue'] + lines['Total Expenses'];
  lines['EBIT %'] = lines['Total Revenue'] ? (lines.EBIT / lines['Total Revenue']) * 100 : null;
  lines['Net Income'] = lines.EBIT + lines.Interest + lines.Taxes;
  return lines;
}

function sectionsFromAccounts(store, totals) {
  const out = new Map();
  for (const a of store.plAccounts) {
    const key = a.section || a.category;
    if (!out.has(key)) out.set(key, { value: 0, category: a.category, type: a.type });
    out.get(key).value += totals.get(a.code) || 0;
  }
  return out;
}

// Budget lines (MBR BUDGET sheet) over a set of months, in profit-impact sign.
// Returns { lines, missingMonths, notes }. Lines without budget data are null.
function budgetMbr(store, months) {
  const notes = [];
  const missingMonths = months.filter((m) => !store.budgetMonths[m] || store.budgetMonths[m].revenue == null);
  if (missingMonths.length) {
    const lines = Object.fromEntries(MBR_LINES.map((l) => [l, null]));
    return { lines, missingMonths, notes };
  }
  const recs = months.map((m) => store.budgetMonths[m]);
  const field = (k) => sumOrNull(recs.map((b) => b[k]));
  const lines = {};
  const revenue = field('revenue');
  const split = store.revenueSplit;
  const splitApplies = split && months.every((m) => P.fyOf(m) === split.fy);
  for (const seg of REVENUE_LINES) lines[seg] = splitApplies && split.shares[seg] != null ? revenue * split.shares[seg] : null;
  if (!splitApplies) notes.push('Budget by revenue segment is only available for FY months covered by the BUDGET sheet revenue split.');
  else notes.push(`Segment budget = monthly revenue budget x ${split.fyLabel} split (${split.basis || 'as per BUDGET sheet'}).`);
  lines['Total Revenue'] = revenue;
  const cogs = field('cogs');
  const general = field('general');
  const personnel = field('personnel');
  lines.COGS = cogs == null ? null : -cogs;
  lines.General = general == null ? null : -general;
  lines.Personnel = personnel == null ? null : -personnel;
  lines['Total Expenses'] = sumOrNull([lines.COGS, lines.General, lines.Personnel]);
  const interest = field('interest');
  const taxes = field('taxes');
  lines.Interest = interest == null ? null : -interest;
  lines.Taxes = taxes == null ? null : -taxes;
  if (lines['Total Expenses'] != null) {
    lines.EBIT = revenue + lines['Total Expenses'];
  } else {
    const stated = field('ebitStated');
    lines.EBIT = stated;
    if (stated != null) notes.push('Cost budget not available for these months; EBIT budget taken from the "EBIT - Budget" column.');
  }
  lines['EBIT %'] = lines.EBIT != null && revenue ? (lines.EBIT / revenue) * 100 : null;
  lines['Net Income'] = sumOrNull([lines.EBIT, lines.Interest, lines.Taxes]);
  return { lines, missingMonths, notes };
}

// ---------- period handling ----------

function resolveRange(store, from, to) {
  const latest = store.latestActualMonth;
  const defFrom = P.fyStart(store.currentFy);
  const f = P.isMonthKey(from) ? from : defFrom;
  const t = P.isMonthKey(to) ? to : latest;
  if (f > t) throw new Error(`Invalid period: from ${f} is after to ${t}`);
  const months = P.monthRange(f, t);
  const available = months.filter((m) => store.actualMonthSet.has(m));
  const missing = months.filter((m) => !store.actualMonthSet.has(m));
  return { from: f, to: t, months, available, missing };
}

function periodInfo(range) {
  const info = {
    from: range.from,
    to: range.to,
    label: P.rangeLabel(range.from, range.to),
    months_with_actuals: range.available.length,
    months_requested: range.months.length,
  };
  if (range.missing.length) info.months_without_actuals = range.missing;
  return info;
}

// Pairs each current month with its comparison month; keeps only pairs where both exist.
function comparisonPairs(store, months, compareWith) {
  const shift = compareWith === 'prior_year' ? -12 : -months.length;
  const pairs = [];
  const dropped = [];
  for (const m of months) {
    const c = P.addMonths(m, shift);
    if (store.actualMonthSet.has(c)) pairs.push([m, c]);
    else dropped.push(m);
  }
  return { pairs, dropped };
}

const eur0 = (v) => `€${Math.round(Math.abs(v)).toLocaleString('en-GB')}`;

// Plain-language direction of a change, so "a cost that fell" is never described as "higher".
// cur / comp are profit-impact values (income +, costs -).
function describeChange(type, cur, comp) {
  const isCost = type === 'expense' || type === 'tax';
  const nat = (v) => (isCost ? -v : v);
  const a = nat(cur);
  const c = nat(comp);
  const d = a - c;
  const noun = type === 'revenue' ? 'revenue' : type === 'financial' ? 'net financial income' : type === 'tax' ? 'tax charge' : 'cost';
  if (Math.abs(d) < 0.5) return `${noun} unchanged`;
  const amount = (v) => {
    if (isCost) return v < 0 ? `a net credit (reversal/refund) of ${eur0(v)}` : `a cost of ${eur0(v)}`;
    if (type === 'revenue') return v < 0 ? `a net reduction of revenue of ${eur0(v)}` : `revenue of ${eur0(v)}`;
    return v < 0 ? `-${eur0(v)}` : eur0(v);
  };
  const text = `${noun} ${d > 0 ? 'higher' : 'lower'} by ${eur0(d)} (the change). Comparison period: ${amount(c)}; current period: ${amount(a)}`;
  return `${text}. ${cur - comp > 0 ? 'Favourable' : 'Adverse'} to profit.`;
}

// Data-quality findings whose evidence touches any of these months.
function relatedFindings(store, months) {
  const set = new Set(months);
  const out = [];
  for (const i of store.issues || []) {
    const ev = Array.isArray(i.evidence) ? i.evidence : [];
    const hit = ev.filter((e) => e && typeof e === 'object' && set.has(e.month)).map((e) => e.month);
    if (hit.length) out.push(`${i.id} (${i.severity}): ${i.title} [affects ${[...new Set(hit)].sort().join(', ')}]`);
  }
  return out;
}

function assessment(variance) {
  if (variance == null) return null;
  if (Math.abs(variance) < 0.005) return 'no change';
  return variance > 0 ? 'favourable' : 'adverse';
}

function varianceRow(line, type, actual, comparison, extra = {}) {
  const isMargin = type === 'margin';
  const variance = actual != null && comparison != null ? actual - comparison : null;
  return {
    line,
    type,
    ...extra,
    actual: r2(actual),
    comparison: r2(comparison),
    variance: r2(variance),
    variance_pct: isMargin ? null : pct(variance, comparison),
    assessment: isMargin ? (variance == null ? null : variance >= 0 ? 'favourable' : 'adverse') : assessment(variance),
  };
}

const COMPARE_LABEL = {
  budget: 'Budget (MBR BUDGET sheet)',
  prior_year: 'Prior year actual (same months, 12 months earlier)',
  previous_period: 'Previous period actual (same number of months immediately before)',
};

// ---------- tools ----------

function plStatement(store, { from, to, level = 'mbr', compare_with = 'none' } = {}) {
  const range = resolveRange(store, from, to);
  const warnings = [];
  const notes = [];
  if (range.missing.length) {
    warnings.push(`No actuals for ${range.missing.map(P.monthLabel).join(', ')}; totals cover only the ${range.available.length} month(s) with actuals (missing months are NOT treated as zero).`);
  }
  if (!range.available.length) {
    return { error: `No actual data in ${P.rangeLabel(range.from, range.to)}. Actuals are available ${P.monthLabel(store.actualMonths[0])} – ${P.monthLabel(store.latestActualMonth)}.` };
  }

  let curMonths = range.available;
  let compTotals = null;
  let compBudget = null;
  let compPeriod = null;

  if (compare_with === 'prior_year' || compare_with === 'previous_period') {
    const { pairs, dropped } = comparisonPairs(store, curMonths, compare_with);
    if (dropped.length) warnings.push(`Excluded ${dropped.map(P.monthLabel).join(', ')} because the comparison month has no actuals; figures are like-for-like on ${pairs.length} month(s).`);
    curMonths = pairs.map((p) => p[0]);
    const cm = pairs.map((p) => p[1]);
    compTotals = accountTotals(store, cm);
    compPeriod = cm.length ? { from: cm[0], to: cm[cm.length - 1], label: P.rangeLabel(cm[0], cm[cm.length - 1]) } : null;
  } else if (compare_with === 'budget') {
    compBudget = budgetMbr(store, curMonths);
    notes.push(...compBudget.notes);
    if (compBudget.missingMonths.length) warnings.push(`No budget for ${compBudget.missingMonths.map(P.monthLabel).join(', ')}; budget comparison unavailable for this period.`);
    compPeriod = { from: curMonths[0], to: curMonths[curMonths.length - 1], label: `Budget ${P.rangeLabel(curMonths[0], curMonths[curMonths.length - 1])}` };
    if (level !== 'mbr') notes.push('Budget exists only at MBR category level; section/account lines have no budget, totals do.');
  }

  const curTotals = accountTotals(store, curMonths);
  const curMbr = mbrFromAccounts(store, curTotals);
  const compMbr = compTotals ? mbrFromAccounts(store, compTotals) : compBudget ? compBudget.lines : null;
  const rows = [];

  if (level === 'mbr') {
    for (const l of MBR_LINES) {
      if (!compMbr && l === 'PY Adjustments' && !curMbr[l]) continue;
      rows.push(varianceRow(l, LINE_TYPE[l], curMbr[l], compMbr ? compMbr[l] : null));
    }
  } else {
    const detail = [];
    if (level === 'section') {
      const cur = sectionsFromAccounts(store, curTotals);
      const comp = compTotals ? sectionsFromAccounts(store, compTotals) : null;
      for (const [name, v] of cur) {
        const c = comp ? comp.get(name)?.value ?? 0 : null;
        if (Math.abs(v.value) < 0.005 && (!c || Math.abs(c) < 0.005)) continue;
        detail.push(varianceRow(name, v.type, v.value, c, { mbr_category: v.category }));
      }
    } else {
      for (const a of store.plAccounts) {
        const v = curTotals.get(a.code) || 0;
        const c = compTotals ? compTotals.get(a.code) || 0 : null;
        if (Math.abs(v) < 0.005 && (!c || Math.abs(c) < 0.005)) continue;
        detail.push(varianceRow(`${a.code} - ${a.name}`, a.type, v, c, { mbr_category: a.category, section: a.section }));
      }
    }
    rows.push(...detail);
    for (const l of ['Total Revenue', 'Total Expenses', 'EBIT', 'EBIT %', 'Interest', 'Taxes', 'Net Income']) {
      rows.push(varianceRow(l, LINE_TYPE[l], curMbr[l], compMbr ? compMbr[l] : null, { subtotal: true }));
    }
  }

  // Largest contributors to the change, for "why" questions.
  let drivers;
  if (compTotals) {
    drivers = store.plAccounts
      .map((a) => ({ a, v: (curTotals.get(a.code) || 0) - (compTotals.get(a.code) || 0) }))
      .filter((x) => Math.abs(x.v) >= 0.5)
      .sort((x, y) => Math.abs(y.v) - Math.abs(x.v))
      .slice(0, 10)
      .map(({ a, v }) => ({
        account: `${a.code} - ${a.name}`,
        mbr_category: a.category,
        actual: r2(curTotals.get(a.code) || 0),
        comparison: r2(compTotals.get(a.code) || 0),
        effect_on_profit: r2(v),
        assessment: assessment(v),
        change: describeChange(a.type, curTotals.get(a.code) || 0, compTotals.get(a.code) || 0),
      }));
  } else if (compBudget) {
    drivers = [...REVENUE_LINES, ...COST_LINES, 'Interest', 'Taxes']
      .map((l) => ({ l, v: curMbr[l] != null && compMbr[l] != null ? curMbr[l] - compMbr[l] : null }))
      .filter((x) => x.v != null && Math.abs(x.v) >= 0.5)
      .sort((x, y) => Math.abs(y.v) - Math.abs(x.v))
      .map(({ l, v }) => ({ line: l, effect_on_profit: r2(v), assessment: assessment(v), change: describeChange(LINE_TYPE[l], curMbr[l], compMbr[l]) }));
    notes.push('Budget exists only by MBR category: do not attribute a budget variance to individual accounts.');
  }

  const usedRange = { ...range, available: curMonths };
  const findings = relatedFindings(store, [...curMonths, ...(compPeriod && compPeriod.from && compare_with !== 'budget' ? P.monthRange(compPeriod.from, compPeriod.to) : [])]);
  return {
    period: periodInfo({ ...usedRange, months: range.months, missing: range.missing }),
    comparison: compare_with !== 'none' ? { basis: COMPARE_LABEL[compare_with], ...compPeriod } : null,
    level,
    currency: store.currency,
    sign_convention: SIGN_CONVENTION,
    rows,
    ...(drivers ? { largest_drivers_of_variance: drivers } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(notes.length ? { notes } : {}),
    ...(findings.length ? { related_data_quality_findings: findings } : {}),
    sources: sourcesFor(store, compare_with),
  };
}

function sourcesFor(store, compareWith) {
  const s = [`${store.files.workfile} › sheet "${store.plSheet}" (account-level monthly actuals)`];
  if (compareWith === 'budget') s.push(`${store.files.mbr} › sheet "BUDGET"`);
  return s;
}

// ---------- line resolution (for trends) ----------

const ALIASES = {
  revenue: 'Total Revenue', 'total revenue': 'Total Revenue', turnover: 'Total Revenue', sales: 'Total Revenue',
  expenses: 'Total Expenses', 'total expenses': 'Total Expenses', costs: 'Total Expenses', 'operating expenses': 'Total Expenses', opex: 'Total Expenses',
  ebit: 'EBIT', 'operating profit': 'EBIT', 'ebit %': 'EBIT %', 'ebit margin': 'EBIT %', margin: 'EBIT %',
  'net income': 'Net Income', 'net profit': 'Net Income', profit: 'Net Income', 'net result': 'Net Income',
  interest: 'Interest', 'financial result': 'Interest', taxes: 'Taxes', tax: 'Taxes', 'corporate income tax': 'Taxes',
  cogs: 'COGS', 'cost of sales': 'COGS', general: 'General', 'general expenses': 'General', personnel: 'Personnel', 'personnel expenses': 'Personnel',
  'other revenue': 'Other Revenue', 'py adjustments': 'PY Adjustments',
};

function resolveLine(store, id) {
  const q = String(id || '').trim();
  const lq = q.toLowerCase();
  const mbr = MBR_LINES.find((l) => l.toLowerCase() === lq) || ALIASES[lq];
  if (mbr) return { kind: 'mbr', key: mbr, label: mbr, type: LINE_TYPE[mbr] };
  const sections = [...new Set(store.plAccounts.map((a) => a.section))];
  const sec = sections.find((s) => s && s.toLowerCase() === lq);
  if (sec) {
    const a = store.plAccounts.find((x) => x.section === sec);
    return { kind: 'section', key: sec, label: `${sec} (section)`, type: a.type };
  }
  const code = q.match(/^(\d{3,6})/);
  let acc = code ? store.accountByCode.get(code[1]) : null;
  if (!acc) acc = store.plAccounts.find((a) => a.name.toLowerCase() === lq) || store.plAccounts.find((a) => a.name.toLowerCase().includes(lq));
  if (acc) return { kind: 'account', key: acc.code, label: `${acc.code} - ${acc.name}`, type: acc.type };
  return null;
}

function lineValue(store, resolved, totals) {
  if (resolved.kind === 'account') return totals.get(resolved.key) || 0;
  if (resolved.kind === 'section') {
    let s = 0;
    for (const a of store.plAccounts) if (a.section === resolved.key) s += totals.get(a.code) || 0;
    return s;
  }
  return mbrFromAccounts(store, totals)[resolved.key];
}

function bucketKey(m, granularity) {
  if (granularity === 'fiscal_quarter') return P.fiscalQuarter(m);
  if (granularity === 'fiscal_year') return P.fyLabel(P.fyOf(m));
  if (granularity === 'calendar_year') return m.slice(0, 4);
  return m;
}

function plTrend(store, { lines = ['Total Revenue'], from, to, granularity = 'month', include_budget = true, include_prior_year = true } = {}) {
  const range = resolveRange(store, from || P.addMonths(store.latestActualMonth, -11), to);
  const buckets = new Map();
  for (const m of range.months) {
    const k = bucketKey(m, granularity);
    if (!buckets.has(k)) buckets.set(k, { requested: [], available: [] });
    buckets.get(k).requested.push(m);
    if (store.actualMonthSet.has(m)) buckets.get(k).available.push(m);
  }
  const unresolved = [];
  const series = [];
  for (const id of [].concat(lines)) {
    const res = resolveLine(store, id);
    if (!res) { unresolved.push(id); continue; }
    const points = [];
    let prev = null;
    for (const [period, b] of buckets) {
      if (!b.available.length) {
        const pt = { period, actual: null, note: 'no actuals yet' };
        if (include_budget && res.kind === 'mbr') {
          const bud = budgetMbr(store, b.requested).lines[res.key];
          if (bud != null) pt.budget = r2(bud);
        }
        points.push(pt);
        prev = null;
        continue;
      }
      const full = granularity === 'month' ? true : granularity === 'fiscal_quarter' ? b.available.length === 3 : granularity === 'fiscal_year' || granularity === 'calendar_year' ? b.available.length === 12 : true;
      const actual = lineValue(store, res, accountTotals(store, b.available));
      const pt = { period, actual: r2(actual) };
      if (granularity !== 'month') { pt.months = b.available.length; if (!full) pt.partial = true; }
      if (include_budget && res.kind === 'mbr') {
        const bud = budgetMbr(store, b.available).lines[res.key];
        if (bud != null) {
          pt.budget = r2(bud);
          pt.budget_variance = r2(actual - bud);
          if (res.type !== 'margin') pt.budget_variance_pct = pct(actual - bud, bud);
        }
      }
      if (include_prior_year) {
        const pyMonths = b.available.map((m) => P.addMonths(m, -12));
        if (pyMonths.every((m) => store.actualMonthSet.has(m))) {
          const py = lineValue(store, res, accountTotals(store, pyMonths));
          pt.prior_year = r2(py);
          pt.yoy_change = r2(actual - py);
          if (res.type !== 'margin') pt.yoy_pct = pct(actual - py, py);
        }
      }
      if (prev != null && prev.full && full) {
        pt.change_vs_previous = r2(actual - prev.v);
        if (res.type !== 'margin') pt.change_vs_previous_pct = pct(actual - prev.v, prev.v);
      }
      points.push(pt);
      prev = { v: actual, full };
    }
    series.push({ line: res.label, type: res.type, resolved_as: res.kind, points, highlights: highlights(points, res.type) });
  }
  return {
    period: periodInfo(range),
    granularity,
    currency: store.currency,
    sign_convention: SIGN_CONVENTION,
    series,
    ...(unresolved.length ? { unresolved_lines: unresolved, hint: 'Use MBR lines (Total Revenue, Airline, Forwarder, GSA, Airport, Shipper, Other Revenue, COGS, General, Personnel, Total Expenses, EBIT, EBIT %, Interest, Taxes, Net Income), a workfile section name (e.g. "Sales Expenses") or a G/L account code (e.g. "4720").' } : {}),
    ...(range.missing.length ? { warnings: [`No actuals for ${range.missing.map(P.monthLabel).join(', ')} (not treated as zero).`] } : {}),
    ...(relatedFindings(store, range.available).length ? { related_data_quality_findings: relatedFindings(store, range.available) } : {}),
    sources: [
      `${store.files.workfile} › sheet "${store.plSheet}"`,
      ...(include_budget ? [`${store.files.mbr} › sheet "BUDGET"`] : []),
    ],
  };
}

function highlights(points, type) {
  const valid = points.filter((p) => p.actual != null && !p.partial);
  if (valid.length < 2) return undefined;
  const by = (k, dir) => {
    const c = valid.filter((p) => p[k] != null);
    if (!c.length) return undefined;
    const p = c.reduce((a, b) => (dir * b[k] > dir * a[k] ? b : a));
    return { period: p.period, value: p[k] };
  };
  const h = {
    highest: by('actual', 1),
    lowest: by('actual', -1),
    largest_increase_vs_previous: by('change_vs_previous', 1),
    largest_decrease_vs_previous: by('change_vs_previous', -1),
  };
  if (valid.some((p) => p.budget_variance != null)) {
    h.most_favourable_budget_variance = by('budget_variance', 1);
    h.most_adverse_budget_variance = by('budget_variance', -1);
    const abs = valid.filter((p) => p.budget_variance != null).sort((a, b) => Math.abs(b.budget_variance) - Math.abs(a.budget_variance));
    h.largest_absolute_budget_variances = abs.slice(0, 3).map((p) => ({ period: p.period, variance: p.budget_variance, variance_pct: p.budget_variance_pct }));
  }
  if (type === 'margin') delete h.largest_absolute_budget_variances;
  return h;
}

// Ranked account/section movements between two windows, in natural amounts.
function topMovements(store, { from, to, compare_with = 'prior_year', level = 'account', type = 'expense', direction = 'any', top_n = 10 } = {}) {
  if (compare_with === 'budget') {
    return { error: 'Budget exists only at MBR category level. Use pl_statement with compare_with="budget" for budget variances.' };
  }
  const range = resolveRange(store, from, to);
  if (!range.available.length) return { error: `No actuals in ${P.rangeLabel(range.from, range.to)}.` };
  const { pairs, dropped } = comparisonPairs(store, range.available, compare_with);
  const cur = accountTotals(store, pairs.map((p) => p[0]));
  const comp = accountTotals(store, pairs.map((p) => p[1]));
  const items = [];
  const add = (label, t, cat, section, a, c) => {
    // Natural amounts: revenue and costs both shown as positive amounts.
    const nat = (v) => (t === 'expense' || t === 'tax' ? -v : v);
    const na = nat(a);
    const nc = nat(c);
    items.push({
      line: label, type: t, mbr_category: cat, ...(section ? { section } : {}),
      actual_amount: r2(na), comparison_amount: r2(nc), change: r2(na - nc), change_pct: pct(na - nc, nc),
      effect_on_profit: r2(a - c), assessment: assessment(a - c),
    });
  };
  if (level === 'section') {
    const cs = sectionsFromAccounts(store, cur);
    const ps = sectionsFromAccounts(store, comp);
    for (const [name, v] of cs) add(name, v.type, v.category, null, v.value, ps.get(name)?.value || 0);
  } else {
    for (const a of store.plAccounts) add(`${a.code} - ${a.name}`, a.type, a.category, a.section, cur.get(a.code) || 0, comp.get(a.code) || 0);
  }
  let list = items.filter((x) => Math.abs(x.change) >= 0.5);
  if (type !== 'all') list = list.filter((x) => x.type === type);
  if (direction === 'increase') list = list.filter((x) => x.change > 0);
  if (direction === 'decrease') list = list.filter((x) => x.change < 0);
  if (direction === 'adverse') list = list.filter((x) => x.effect_on_profit < 0);
  if (direction === 'favourable') list = list.filter((x) => x.effect_on_profit > 0);
  list.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  const cm = pairs.map((p) => p[1]);
  return {
    period: periodInfo({ ...range, available: pairs.map((p) => p[0]) }),
    comparison: { basis: COMPARE_LABEL[compare_with], from: cm[0], to: cm[cm.length - 1], label: cm.length ? P.rangeLabel(cm[0], cm[cm.length - 1]) : null },
    level, type_filter: type, direction,
    currency: store.currency,
    sign_convention: 'actual_amount / comparison_amount are natural amounts (revenue and costs both positive). change = actual - comparison in natural terms (a positive change on a cost line = higher cost). effect_on_profit: positive = favourable, negative = adverse.',
    total_items_matching: list.length,
    movements: list.slice(0, top_n),
    ...(dropped.length ? { warnings: [`Excluded ${dropped.map(P.monthLabel).join(', ')}: comparison month has no actuals.`] } : {}),
    sources: [`${store.files.workfile} › sheet "${store.plSheet}"`],
  };
}

// Budget for a financial year from the MBR BUDGET sheet, independent of which months have actuals.
function budgetPlan(store, { fiscal_year } = {}) {
  const fy = P.parseFy(fiscal_year) || store.currentFy;
  const months = P.fyMonths(fy);
  const have = months.filter((m) => store.budgetMonths[m] && store.budgetMonths[m].revenue != null);
  if (!have.length) return { error: `No budget found for ${P.fyLabel(fy)}.` };
  const lines = ['Total Revenue', 'COGS', 'General', 'Personnel', 'Total Expenses', 'EBIT', 'EBIT %', 'Interest', 'Taxes', 'Net Income'];
  const pick = (ms) => { const res = budgetMbr(store, ms); return Object.fromEntries(lines.map((l) => [l, r2(res.lines[l])])); };
  const withActuals = have.filter((m) => store.actualMonthSet.has(m));
  const remaining = have.filter((m) => !store.actualMonthSet.has(m));
  const fullYear = pick(have);
  const split = store.revenueSplit && store.revenueSplit.fy === fy ? store.revenueSplit : null;
  const missing = months.filter((m) => !have.includes(m));
  const related = [...relatedFindings(store, months), ...(store.issues || []).filter((i) => i.area === 'Budget').map((i) => `${i.id} (${i.severity}): ${i.title}`)]
    .filter((x, i, arr) => arr.findIndex((y) => y.split(' ')[0] === x.split(' ')[0]) === i);
  return {
    fiscal_year: P.fyLabel(fy),
    months: P.rangeLabel(months[0], months[11]),
    label_in_offspring_files: 'FY26 / FY 26/27',
    currency: store.currency,
    sign_convention: 'MBR presentation: income positive, costs negative.',
    full_year: fullYear,
    ...(split ? {
      revenue_by_segment_full_year: Object.fromEntries(Object.entries(split.shares).map(([k, v]) => [k, r2(fullYear['Total Revenue'] * v)])),
      segment_split_basis: `${split.fyLabel} shares: ${Object.entries(split.shares).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ')}`,
    } : {}),
    budget_for_months_with_actuals: withActuals.length ? { months: P.rangeLabel(withActuals[0], withActuals[withActuals.length - 1]), ...pick(withActuals) } : null,
    actual_to_date: withActuals.length ? (() => {
      const act = mbrFromAccounts(store, accountTotals(store, withActuals));
      const out = { months: P.rangeLabel(withActuals[0], withActuals[withActuals.length - 1]) };
      for (const l of ['Total Revenue', 'EBIT', 'Net Income']) {
        out[l] = { actual: r2(act[l]), pct_of_full_year_budget: fullYear[l] ? r2((act[l] / fullYear[l]) * 100) : null, still_needed_to_reach_full_year_budget: fullYear[l] != null ? r2(fullYear[l] - act[l]) : null };
      }
      out.remaining_months = remaining.length;
      out.required_monthly_revenue_to_reach_budget = remaining.length ? r2((fullYear['Total Revenue'] - act['Total Revenue']) / remaining.length) : null;
      return out;
    })() : null,
    budget_for_remaining_months: remaining.length ? { months: P.rangeLabel(remaining[0], remaining[remaining.length - 1]), ...pick(remaining) } : null,
    by_month: months.map((m) => (have.includes(m) ? { month: m, has_actuals: store.actualMonthSet.has(m), ...pick([m]) } : { month: m, budget: null })),
    ...(missing.length ? { warnings: [`No budget for ${missing.map(P.monthLabel).join(', ')}.`] } : {}),
    notes: ['EBIT budget = revenue budget minus COGS, General and Personnel budgets (as on the MBR "A to B" page).'],
    ...(related.length ? { related_data_quality_findings: related } : {}),
    sources: [`${store.files.mbr} › sheet "BUDGET"`],
  };
}

module.exports = {
  REVENUE_LINES, COST_LINES, MBR_LINES, LINE_TYPE, SIGN_CONVENTION,
  r2, pct, accountTotals, mbrFromAccounts, budgetMbr, resolveRange,
  plStatement, plTrend, topMovements, budgetPlan, describeChange, relatedFindings,
};
