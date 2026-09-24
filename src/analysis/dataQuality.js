// Cross-source reconciliation. Surfaces conflicts instead of silently choosing a value.
const config = require('../config');
const P = require('../lib/periods');
const { r2, accountTotals, mbrFromAccounts, budgetMbr, REVENUE_LINES, COST_LINES } = require('./pl');
const { tbVsWorkfile } = require('./balance');
const { forecastQualityFlags } = require('./forecast');

const TOL = 0.5;
const eur = (v) => `EUR ${Number(v).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function severityFor(amount) {
  const a = Math.abs(amount);
  if (a >= config.materiality) return 'high';
  if (a >= 1000) return 'medium';
  return 'low';
}

function runChecks(store) {
  const issues = [];
  const add = (i) => issues.push({ id: `DQ${String(issues.length + 1).padStart(2, '0')}`, ...i });
  const wfSrc = `${store.files.workfile} › "${store.plSheet}"`;
  const mbrSrc = (s) => `${store.files.mbr} › "${s}"`;
  const fy = store.currentFy;
  const fyMonthsActual = P.fyMonths(fy).filter((m) => store.actualMonthSet.has(m));

  // 1. Trial balance vs P&L workfile (P&L accounts, same months).
  if (store.trialBalance) {
    const tb = store.trialBalance;
    const recon = tbVsWorkfile(store);
    const diffs = [];
    for (const a of tb.accounts.filter((x) => x.statement === 'profit_and_loss')) {
      const r = recon.get(a.code);
      if (r.workfile == null) diffs.push({ account: `${a.code} - ${a.name}`, tb: r2(a.closing), workfile: null, difference: null });
      else if (Math.abs(r.diff) >= TOL) diffs.push({ account: `${a.code} - ${a.name}`, tb: r2(a.closing), workfile: r2(r.workfile), difference: r2(r.diff) });
    }
    const tbNet = -tb.accounts.filter((x) => x.statement === 'profit_and_loss').reduce((s, a) => s + a.closing, 0);
    const wfNet = mbrFromAccounts(store, accountTotals(store, tb.meta.months))['Net Income'];
    if (diffs.length) {
      add({
        severity: severityFor(tbNet - wfNet),
        area: 'Trial balance vs P&L workfile',
        title: `${diffs.length} P&L account(s) differ between the Exact trial balance and the P&L workfile`,
        detail: `Net result ${tb.meta.periodText ? `for periods ${tb.meta.periodText}` : ''} (${P.rangeLabel(tb.meta.months[0], tb.meta.months[tb.meta.months.length - 1])}): trial balance ${eur(tbNet)} vs workfile ${eur(wfNet)} (difference ${eur(tbNet - wfNet)}). The workfile may pre-date late postings in Exact.`,
        evidence: diffs,
        sources: [`${tb.file}`, wfSrc],
      });
    }
    const td = tb.accounts.reduce((s, a) => s + a.debit, 0);
    const tc = tb.accounts.reduce((s, a) => s + a.credit, 0);
    if (Math.abs(td - tc) >= 0.01) {
      add({ severity: 'high', area: 'Trial balance', title: 'Trial balance debits and credits do not agree', detail: `Debit ${eur(td)} vs credit ${eur(tc)}.`, sources: [tb.file] });
    }
    const bad = tb.accounts.filter((a) => Math.abs(a.opening + a.debit - a.credit - a.closing) > 0.01);
    if (bad.length) {
      add({ severity: 'medium', area: 'Trial balance', title: 'Opening + debit - credit does not equal closing for some accounts', evidence: bad.map((a) => `${a.code} - ${a.name}`), sources: [tb.file] });
    }
    const suspense = tb.accounts.filter((a) => a.side === 'suspense' && Math.abs(a.closing) > 1);
    for (const a of suspense) {
      add({ severity: severityFor(a.closing) === 'low' ? 'medium' : severityFor(a.closing), area: 'Trial balance', title: `Suspense account ${a.code} not cleared`, detail: `Closing balance ${eur(a.closing)} (opening ${eur(a.opening)}). Unallocated items should be cleared to their proper accounts before reporting.`, sources: [tb.file] });
    }
    const wrongSide = tb.accounts.filter((a) => (a.side === 'asset' && !a.contra && a.closing < -1) || (a.contra && a.closing > 1) || (a.side === 'liability' && a.closing > 1));
    if (wrongSide.length) {
      add({
        severity: 'low',
        area: 'Trial balance',
        title: 'Balances on an unexpected side',
        detail: 'Accounts whose closing balance is on the opposite side to their balance-sheet classification. Contra accounts (accumulated depreciation, bad-debt provision) are excluded because their credit balances are normal.',
        evidence: wrongSide.map((a) => ({ account: `${a.code} - ${a.name}`, classification: a.side, closing: r2(a.closing) })),
        sources: [tb.file],
      });
    }
  }

  // 2. Workfile vs MBR ACTUAL sheet (category x month).
  if (store.mbrActual) {
    const mbrByMonth = new Map();
    for (const r of store.mbrActual.rows) {
      if (!mbrByMonth.has(r.month)) mbrByMonth.set(r.month, {});
      mbrByMonth.get(r.month)[r.category] = (mbrByMonth.get(r.month)[r.category] || 0) + r.amount;
    }
    const mbrMonths = [...mbrByMonth.keys()].sort();
    const inRange = store.actualMonths.filter((m) => m >= mbrMonths[0] && m <= mbrMonths[mbrMonths.length - 1]);
    const missing = inRange.filter((m) => !mbrByMonth.has(m));
    if (missing.length) {
      add({
        severity: 'medium',
        area: 'MBR ACTUAL sheet',
        title: `MBR ACTUAL sheet is missing ${missing.length} month(s) that exist in the workfile`,
        detail: `Missing: ${missing.map(P.monthLabel).join(', ')}. Any MBR figure built on this sheet for those months (e.g. prior-year comparisons, trend charts) would be understated. The assistant uses the account-level workfile, which has these months.`,
        sources: [mbrSrc('ACTUAL'), wfSrc],
      });
    }
    // Other Revenue and PY Adjustments are compared both separately (classification) and
    // combined (amount), so a pure reclassification is not reported as a missing amount.
    const OTHER = 'Other Revenue';
    const PYADJ = 'PY Adjustments';
    const reclass = [];
    const diffs = [];
    for (const m of store.actualMonths.filter((x) => mbrByMonth.has(x))) {
      const wf = {};
      for (const a of store.plAccounts) wf[a.category] = (wf[a.category] || 0) + (a.monthly[m] || 0);
      const mb = mbrByMonth.get(m);
      const d = (cat) => (mb[cat] ?? 0) - (wf[cat] ?? 0);
      if (Math.abs(d(OTHER)) >= TOL || Math.abs(d(PYADJ)) >= TOL) {
        const combined = d(OTHER) + d(PYADJ);
        if (Math.abs(d(PYADJ)) >= TOL && Math.abs(combined) < Math.abs(d(PYADJ))) {
          reclass.push({ month: m, py_adjustments_in_workfile: r2(-(wf[PYADJ] || 0)), shown_in_mbr_as_other_revenue: r2(-(mb[OTHER] || 0) + (wf[OTHER] || 0)) });
        }
        if (Math.abs(combined) >= TOL) diffs.push({ month: m, category: `${OTHER} + ${PYADJ}`, mbr_actual: r2((mb[OTHER] ?? 0) + (mb[PYADJ] ?? 0)), workfile: r2((wf[OTHER] ?? 0) + (wf[PYADJ] ?? 0)), difference: r2(combined) });
      }
      for (const cat of new Set([...Object.keys(wf), ...Object.keys(mb)])) {
        if (cat === OTHER || cat === PYADJ) continue;
        if (Math.abs(d(cat)) >= TOL) diffs.push({ month: m, category: cat, mbr_actual: r2(mb[cat] ?? null), workfile: r2(wf[cat] ?? null), difference: r2(d(cat)) });
      }
    }
    if (reclass.length) {
      add({
        severity: 'medium',
        area: 'MBR ACTUAL sheet vs workfile',
        title: `Prior-year adjustments (account 8500) are presented as "Other Revenue" in the MBR ACTUAL sheet in ${reclass.length} month(s)`,
        detail: `Affects ${P.monthLabel(reclass[0].month)} – ${P.monthLabel(reclass[reclass.length - 1].month)}. Total revenue is unaffected, but "Other Revenue" is overstated in those months, so prior-year comparisons of Other Revenue on the MBR pages are distorted. The assistant keeps PY adjustments separate, as the workfile does.`,
        evidence: reclass,
        sources: [mbrSrc('ACTUAL'), wfSrc],
      });
    }
    if (diffs.length) {
      const worst = diffs.reduce((a, b) => (Math.abs(b.difference) > Math.abs(a.difference) ? b : a));
      add({
        severity: severityFor(worst.difference),
        area: 'MBR ACTUAL sheet vs workfile',
        title: `${diffs.length} amount difference(s) between the MBR ACTUAL sheet and the workfile`,
        detail: 'Raw ledger sign (debit positive): a negative difference on a revenue line means more revenue in the MBR sheet. Largest difference first.',
        evidence: diffs.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)).slice(0, 15),
        sources: [mbrSrc('ACTUAL'), wfSrc],
      });
    }
  }

  // 3. MBR report pages vs recomputed figures.
  const reportChecks = (rep, name, compKind) => {
    if (!rep) return;
    const asOf = rep.asOf || store.latestActualMonth;
    const ytdMonths = P.monthRange(P.fyStart(P.fyOf(asOf)), asOf).filter((m) => store.actualMonthSet.has(m));
    const mtd = mbrFromAccounts(store, accountTotals(store, [asOf]));
    const ytd = mbrFromAccounts(store, accountTotals(store, ytdMonths));
    let compYtd;
    let compMtd;
    if (compKind === 'budget') {
      compYtd = budgetMbr(store, ytdMonths).lines;
      compMtd = budgetMbr(store, [asOf]).lines;
    } else {
      compYtd = mbrFromAccounts(store, accountTotals(store, ytdMonths.map((m) => P.addMonths(m, -12))));
      compMtd = mbrFromAccounts(store, accountTotals(store, [P.addMonths(asOf, -12)]));
    }
    const fullYear = compKind === 'budget' ? budgetMbr(store, P.fyMonths(P.fyOf(asOf))).lines : null;
    const diffs = [];
    const uncomputed = [];
    for (const line of rep.lines) {
      const key = line.line;
      if (!(key in ytd)) continue;
      const scale = key === 'EBIT %' ? 100 : 1;
      const cmp = (label, reported, computed) => {
        if (reported == null || computed == null) return;
        const d = reported * scale - computed;
        const tol = key === 'EBIT %' ? 0.05 : TOL;
        if (Math.abs(d) >= tol) diffs.push({ line: key, figure: label, reported: r2(reported * scale), recomputed: r2(computed), difference: r2(d) });
      };
      cmp('MTD actual', line.mtd?.actual, mtd[key]);
      cmp('YTD actual', line.ytd?.actual, ytd[key]);
      cmp(`MTD ${compKind}`, line.mtd?.comparison, compMtd[key]);
      cmp(`YTD ${compKind}`, line.ytd?.comparison, compYtd[key]);
      if (fullYear) cmp('Full-year budget', line.fullYear?.comparison, fullYear[key]);
      if (line.uncomputed.length) uncomputed.push(`${key}: ${line.uncomputed.join(', ')}`);
    }
    if (diffs.length) {
      const pyAdj = diffs.find((d) => d.line === 'Other Revenue' && /prior_year/.test(d.figure));
      add({
        severity: severityFor(Math.max(...diffs.map((d) => Math.abs(d.difference)))),
        area: `MBR "${name}" report`,
        title: `${diffs.length} figure(s) on the MBR "${name}" page differ from the recomputed values`,
        detail: pyAdj
          ? 'The prior-year "PY Adjustments" cells hold formulas with no calculated value, and the prior-year PY adjustments appear to be included in "Other Revenue". Other Revenue growth vs prior year is therefore understated on the report.'
          : 'Recomputed from the account-level workfile and the BUDGET sheet.',
        evidence: diffs,
        sources: [mbrSrc(name), wfSrc],
      });
    }
    if (uncomputed.length) {
      add({ severity: 'low', area: `MBR "${name}" report`, title: `Formula cells without a calculated value on "${name}"`, detail: 'These cells show no value when read (formula never recalculated or saved without results). They are treated as missing, not zero.', evidence: uncomputed, sources: [mbrSrc(name)] });
    }
    const fyNow = P.fyOf(asOf);
    if (rep.fullYearLabel && P.parseFy(rep.fullYearLabel) !== fyNow) {
      add({
        severity: 'low',
        area: `MBR "${name}" report`,
        title: `Column label "${rep.fullYearLabel}" does not match the financial year of the data`,
        detail: `The report is as of ${P.monthLabel(asOf)}, which falls in ${P.fyLabel(fyNow)} (${P.rangeLabel(P.fyStart(fyNow), P.fyEnd(fyNow))}; Exact Online "Financial year ${fyNow}").${compKind === 'prior_year' ? ' The column also holds prior-year YTD figures rather than a full-year total.' : ''}`,
        sources: [mbrSrc(name)],
      });
    }
  };
  reportChecks(store.mbrReports.aToB, 'A to B', 'budget');
  reportChecks(store.mbrReports.aToPy, 'A to PY', 'prior_year');

  // 4. BUDGET sheet: stated EBIT column vs EBIT from its own line items.
  const ebitDiffs = [];
  for (const [m, b] of Object.entries(store.budgetMonths)) {
    if ([b.revenue, b.cogs, b.general, b.personnel, b.ebitStated].some((v) => v == null)) continue;
    const computed = b.revenue - b.cogs - b.general - b.personnel;
    if (Math.abs(b.ebitStated - computed) >= TOL) ebitDiffs.push({ month: m, stated_ebit_budget: r2(b.ebitStated), revenue_minus_costs: r2(computed), difference: r2(b.ebitStated - computed) });
  }
  if (ebitDiffs.length) {
    const tot = ebitDiffs.reduce((s, d) => s + d.difference, 0);
    add({
      severity: severityFor(Math.max(...ebitDiffs.map((d) => Math.abs(d.difference)))),
      area: 'Budget',
      title: `"EBIT - Budget" column on the BUDGET sheet disagrees with its own revenue and cost budget in ${ebitDiffs.length} month(s)`,
      detail: `Net difference ${eur(tot)} over these months (largest single month ${eur(Math.max(...ebitDiffs.map((d) => Math.abs(d.difference))))}). The MBR "A to B" page uses revenue minus costs; the assistant does the same.`,
      evidence: ebitDiffs,
      sources: [mbrSrc('BUDGET')],
    });
  }

  // 5. Budget versions: workfile "Budget - Overview" vs MBR BUDGET sheet; mislabelled actuals.
  if (store.budgetOverview) {
    const bo = store.budgetOverview.rows;
    const boRev = bo.find((r) => r.block === 'Revenue' && /budget/i.test(r.kind));
    if (boRev) {
      const diffs = [];
      for (const [m, v] of Object.entries(boRev.values)) {
        const b = store.budgetMonths[m]?.revenue;
        if (b != null && Math.abs(b - v) >= TOL) diffs.push({ month: m, workfile_budget_overview: r2(v), mbr_budget_sheet: r2(b), difference: r2(v - b) });
      }
      if (diffs.length) {
        add({
          severity: 'medium',
          area: 'Budget',
          title: 'Two different monthly revenue budgets for the same year',
          detail: `The workfile "Budget - Overview" and the MBR "BUDGET" sheet phase the ${boRev.fyLabel} revenue budget differently in ${diffs.length} month(s). The assistant uses the MBR BUDGET sheet (the one behind the reported MBR). A hidden "Budget - Ken" sheet holds a third version.`,
          evidence: diffs,
          sources: [`${store.files.workfile} › "Budget - Overview"`, mbrSrc('BUDGET')],
        });
      }
    }
    // "Actual" rows: do they hold this year's actuals, or something else?
    const month = (m) => mbrFromAccounts(store, accountTotals(store, [m]));
    const pick = {
      Revenue: (t) => t['Total Revenue'],
      Cost: (t) => -t['Total Expenses'],
      EBIT: (t) => t.EBIT,
    };
    const actualRow = (block) => bo.find((r) => r.block === block && /actual/i.test(r.kind));
    const check = (block) => {
      const row = actualRow(block);
      if (!row) return null;
      const ms = Object.keys(row.values).sort();
      if (!ms.length || !ms.every((m) => store.actualMonthSet.has(m) && store.actualMonthSet.has(P.addMonths(m, -12)))) return null;
      const vals = ms.map((m) => row.values[m]);
      const same = ms.map((m) => pick[block](month(m)));
      const py = ms.map((m) => pick[block](month(P.addMonths(m, -12))));
      const off = (arr) => arr.reduce((s, v, i) => s + Math.abs(v - vals[i]), 0);
      return { row, ms, vals, same, py, ok: off(same) < 1, matchesPy: off(py) < 1 };
    };
    const cost = check('Cost');
    const ebit = check('EBIT');
    const rev = check('Revenue');
    // EBIT row = this year's revenue - prior-year cost?
    const ebitMixed = ebit && cost && !ebit.ok && ebit.ms.every((m, i) => Math.abs(ebit.vals[i] - (pick.Revenue(month(m)) - pick.Cost(month(P.addMonths(m, -12))))) < 1);
    if (cost && !cost.ok) {
      const overstated = ebit ? ebit.vals.reduce((s, v, i) => s + v - ebit.same[i], 0) : null;
      add({
        severity: 'high',
        area: 'Workfile "Budget - Overview"',
        title: `"Actual ${cost.row.fyLabel}" costs on "Budget - Overview" are ${cost.matchesPy ? 'prior-year costs' : 'not this year\'s costs'}${ebitMixed ? ', so the EBIT actuals on that sheet are overstated' : ''}`,
        detail: [
          cost.matchesPy ? `The Cost "Actual ${cost.row.fyLabel}" row equals the costs of the same months one year earlier.` : 'The Cost "Actual" row does not match the workfile.',
          ebitMixed ? `The EBIT "Actual" row is this year's revenue minus those prior-year costs, overstating EBIT by ${eur(overstated)} over ${P.rangeLabel(ebit.ms[0], ebit.ms[ebit.ms.length - 1])}; its "Actual vs Budget %" (EBIT) figures are wrong too.` : '',
          'The MBR "A to B" page is not affected (it matches the workfile).',
        ].filter(Boolean).join(' '),
        evidence: cost.ms.map((m, i) => ({
          month: m,
          sheet_cost_actual: r2(cost.vals[i]), true_cost_actual: r2(cost.same[i]), prior_year_cost: r2(cost.py[i]),
          ...(ebit ? { sheet_ebit_actual: r2(ebit.vals[i]), true_ebit_actual: r2(ebit.same[i]) } : {}),
        })),
        sources: [`${store.files.workfile} › "Budget - Overview" ${cost.row.ref}`, wfSrc],
      });
    } else if (ebit && !ebit.ok) {
      add({ severity: 'high', area: 'Workfile "Budget - Overview"', title: `"Actual ${ebit.row.fyLabel}" EBIT on "Budget - Overview" does not match the workfile`, evidence: ebit.ms.map((m, i) => ({ month: m, sheet: r2(ebit.vals[i]), workfile: r2(ebit.same[i]) })), sources: [`${store.files.workfile} › "Budget - Overview"`, wfSrc] });
    }
    if (rev && !rev.ok) {
      add({ severity: 'high', area: 'Workfile "Budget - Overview"', title: `"Actual ${rev.row.fyLabel}" revenue on "Budget - Overview" does not match the workfile`, evidence: rev.ms.map((m, i) => ({ month: m, sheet: r2(rev.vals[i]), workfile: r2(rev.same[i]) })), sources: [`${store.files.workfile} › "Budget - Overview"`, wfSrc] });
    }
  }

  // 6. Workfile stated subtotals vs sum of accounts.
  const stDiffs = [];
  for (const t of store.plSectionTotals) {
    const accs = store.plAccounts.filter((a) => a.section === t.section);
    if (!accs.length) continue;
    for (const [m, v] of Object.entries(t.monthly)) {
      const s = accs.reduce((x, a) => x + (a.monthly[m] || 0), 0);
      if (Math.abs(s - v) >= TOL) stDiffs.push({ subtotal: `Total: ${t.section}`, month: m, stated: r2(v), sum_of_accounts: r2(s), difference: r2(v - s) });
    }
  }
  const stated = store.plStated;
  for (const [label, key] of [['Result', 'Net Income'], ['EBIT', 'EBIT']]) {
    if (!stated[label]) continue;
    for (const [m, v] of Object.entries(stated[label].monthly)) {
      if (!store.actualMonthSet.has(m)) continue;
      const t = mbrFromAccounts(store, accountTotals(store, [m]));
      const c = label === 'Result' ? t['Net Income'] : t.EBIT;
      if (Math.abs(v - c) >= TOL) stDiffs.push({ subtotal: label, month: m, stated: r2(v), recomputed: r2(c), difference: r2(v - c) });
    }
  }
  if (stDiffs.length) {
    add({
      severity: severityFor(Math.max(...stDiffs.map((d) => Math.abs(d.difference)))),
      area: 'P&L workfile',
      title: `${stDiffs.length} subtotal(s) in the workfile do not equal the sum of their accounts`,
      evidence: stDiffs.slice(0, 20),
      sources: [wfSrc],
    });
  }
  if (store.plUncomputedMonthCells) {
    add({ severity: 'info', area: 'P&L workfile', title: `${store.plUncomputedMonthCells} monthly formula cells in the workfile have no calculated value`, detail: 'Mostly subtotal rows for dormant accounts. The assistant recomputes subtotals from the account rows.', sources: [wfSrc] });
  }

  // 7. Revenue forecast checks.
  if (store.forecast) {
    const flags = forecastQualityFlags(store.forecast.rows);
    const dup = flags.filter((f) => f.type === 'possible_duplicate');
    const ovl = flags.filter((f) => f.type === 'overlapping_subscriptions');
    const late = flags.filter((f) => f.type === 'late_invoice');
    if (dup.length) {
      const amt = dup.reduce((s, f) => s + (store.forecast.rows.find((r) => r.ref === f.rows[1])?.amountEur || 0), 0);
      add({ severity: severityFor(amt), area: 'Revenue forecast', title: `${dup.length} possible duplicate invoice(s) in the revenue forecast (${eur(amt)})`, detail: 'Same customer, same amount, overlapping subscription periods. Either a duplicate or a change of billing cycle (e.g. moving to calendar-year subscriptions); confirm whether both invoices are expected.', evidence: dup.map((f) => `${f.customer}: ${f.detail}`), sources: [store.forecast.file] });
    }
    if (ovl.length) {
      add({ severity: 'low', area: 'Revenue forecast', title: `${ovl.length} customer(s) with overlapping subscription periods at different amounts`, detail: 'May be separate products or upgrades; worth confirming.', evidence: ovl.map((f) => `${f.customer}: ${f.detail}`), sources: [store.forecast.file] });
    }
    if (late.length) {
      add({ severity: 'info', area: 'Revenue forecast', title: `${late.length} invoice(s) planned more than a month after the subscription starts`, detail: 'Revenue recognition would start before invoicing for these.', evidence: late.map((f) => `${f.customer}: ${f.detail}`), sources: [store.forecast.file] });
    }
    const fxByCur = {};
    for (const r of store.forecast.rows) {
      if (r.currency === 'EUR' || !r.amountFc || r.amountEur == null) continue;
      (fxByCur[r.currency] ||= new Set()).add((r.amountEur / r.amountFc).toFixed(4));
    }
    const inconsistent = Object.entries(fxByCur).filter(([, s]) => s.size > 1);
    if (inconsistent.length) {
      add({ severity: 'low', area: 'Revenue forecast', title: 'Different FX rates used for the same currency', evidence: inconsistent.map(([c, s]) => `${c}: ${[...s].join(', ')}`), sources: [store.forecast.file] });
    }
  }

  // 8. Financial-year naming across sources.
  const tbFy = store.trialBalance?.meta.financialYear;
  const names = [store.files.workfile, store.files.mbr].filter(Boolean).join(' | ');
  if (tbFy && /FY\s?26/i.test(names)) {
    add({
      severity: 'info',
      area: 'Conventions',
      title: 'Financial-year naming differs between sources',
      detail: `Exact Online calls Apr ${tbFy - 1} – Mar ${tbFy} "Financial year ${tbFy}", while Offspring files and MBR labels use "FY26" / "FY 26/27" for the same year. The assistant labels it ${P.fyLabel(tbFy)} (${P.rangeLabel(P.fyStart(tbFy), P.fyEnd(tbFy))}).`,
      sources: [store.files.trialBalance, store.files.workfile, store.files.mbr],
    });
  }

  for (const e of store.loadErrors) add({ severity: 'high', area: 'Loading', title: e, sources: [] });

  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  issues.forEach((i, n) => { i.id = `DQ${String(n + 1).padStart(2, '0')}`; });
  return issues;
}

function dataQualityReport(store, { id, severity, area } = {}) {
  const all = store.issues || [];
  let list = all;
  const ids = [].concat(id || []).concat(String(area || '').match(/DQ\d{2}/gi) || []).map((x) => String(x).toUpperCase());
  if (ids.length) list = list.filter((i) => ids.includes(i.id));
  if (severity) list = list.filter((i) => i.severity === severity);
  if (area && !ids.length) {
    const q = String(area).toLowerCase();
    list = list.filter((i) => i.area.toLowerCase().includes(q) || i.title.toLowerCase().includes(q));
  }
  const counts = {};
  for (const i of all) counts[i.severity] = (counts[i.severity] || 0) + 1;
  return {
    summary: counts,
    issues: list,
    ...(list.length ? {} : { note: 'No finding matched the filter. Available findings:', available: all.map((i) => `${i.id} (${i.severity}): ${i.title}`) }),
  };
}

module.exports = { runChecks, dataQualityReport };
