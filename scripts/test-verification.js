// Self-test of the three verification layers against known-good and known-wrong answers.
//   npm run test:verify              layers 1 and 2 (no API calls)
//   npm run test:verify -- --review  also layer 3, the independent reviewer (uses the OpenAI API)
const OpenAI = require('openai');
const config = require('../src/config');
const { getStore } = require('../src/state');
const { runTool } = require('../src/ai/tools');
const { verifyAnswer, collectValues } = require('../src/ai/verify');
const { checkMeaning } = require('../src/ai/meaning');
const { reviewAnswer } = require('../src/ai/review');

const YTD_BUDGET = [['pl_statement', { compare_with: 'budget' }]];
const AUG_VS_JUL = [['pl_statement', { from: '2026-08', to: '2026-08', compare_with: 'previous_period', level: 'account' }]];

// expect: 'pass' or the layer that must catch it (1, 2 or 3)
const CASES = [
  // ---------- correct answers: must pass every layer ----------
  { name: 'expenses vs budget (correct)', expect: 'pass', calls: YTD_BUDGET, q: 'Which expenses are over budget?', a:
`For FY2027 YTD (Apr–Aug 2026), only General expenses are over budget.

| Expense Line | Actual (€) | Budget (€) | Variance (€) | Var % | Assessment |
|---|---|---|---|---|---|
| General | 549,872 | 499,573 | -50,298 | -10.1 | Adverse |
| Personnel | 1,082,147 | 1,147,557 | +65,411 | +5.7 | Favourable |
| COGS | 22,484 | 66,930 | +44,447 | +66.4 | Favourable |

- General expenses are €50,298 (10.1%) over budget, which is adverse.
- Personnel costs are €65,411 (5.7%) below budget, and COGS are €44,447 (66.4%) below budget, both favourable.` },
  { name: 'profit drivers Aug vs Jul (correct)', expect: 'pass', calls: AUG_VS_JUL, q: 'Why did profit change in August 2026?', a:
`Net income rose to €261,362 in Aug 2026 from €214,963 in Jul 2026 (+€46,399, +21.6%).

- Social insurance premiums were €19,392 lower (favourable).
- Consulting fees were €9,754 lower (favourable).
- Licensing fees were €6,843 lower: a credit of €6,629 in Aug 2026 (favourable).
- Gross salary was €5,727 higher (adverse).` },
  { name: 'cash and bank (correct)', expect: 'pass', calls: [['balance_sheet', { detail: 'account' }]], q: 'How much cash do we have?', a:
`At the end of Aug 2026 cash and bank was €2,243,854.

| Account | Closing (€) |
|---|---|
| NL37 INGB 0390 7457 15 | 1,567,369 |
| NL49 INGB 0020 2524 47 | 676,485 |
| **Total Cash and Bank** | 2,243,854 |` },
  { name: 'progress vs annual budget with calculation (correct)', expect: 'pass', calls: [...YTD_BUDGET, ['budget_plan', {}]], q: 'How much of the annual budget have we achieved?', a:
`FY2027 YTD revenue is €3,216,893, which is 41.3% of the full-year revenue budget of €7,786,925.
Calculation: €3,216,893 ÷ €7,786,925 × 100 = 41.3%. €4,570,032 is still needed, €652,862 a month over the remaining 7 months.` },
  { name: 'performance summary (correct, large)', expect: 'pass', calls: [...YTD_BUDGET, ['year_end_projection', {}], ['balance_sheet', {}]], q: 'Summarise our performance', a:
`| Line | Actual (€) | Budget (€) | Variance (€) | Var % |
|---|---|---|---|---|
| Total Revenue | 3,216,893 | 3,050,807 | +166,086 | +5.4% |
| Total Expenses | 1,654,502 | 1,714,061 | +59,559 | +3.5% |
| EBIT | 1,562,391 | 1,336,746 | +225,645 | +16.9% |
| Net Income | 1,283,784 | 1,033,951 | +249,832 | +24.2% |

| Method | Revenue (€) | EBIT (€) | Net Income (€) |
|---|---|---|---|
| Budget for remaining months | 7,953,011 | 3,729,761 | 2,966,792 |
| Run-rate | 7,765,908 | 3,720,168 | 3,039,455 |
| Prior-year pattern | 8,343,803 | 4,016,175 | 3,309,562 |

| Group | Opening (€) | Closing (€) | Change (€) |
|---|---|---|---|
| Receivable from group company (Shanwick B.V.) | 7,275,680 | 9,674,084 | +2,398,404 |
| Cash and bank | 2,768,823 | 2,243,854 | -524,969 |
| Deferred income | 3,077,557 | 3,253,508 | +175,951 |` },

  // ---------- wrong answers: must be caught ----------
  { name: 'invented budget €7,167,000', expect: 1, calls: YTD_BUDGET, q: 'What is the annual budget?', a: 'The full-year revenue budget is €7,167,000, so you still need €3,950,107.' },
  { name: 'General and Personnel figures swapped', expect: 2, calls: YTD_BUDGET, q: 'Which expenses are over budget?', a:
`| Expense Line | Actual (€) | Budget (€) |
|---|---|---|
| General | 1,082,147 | 1,147,557 |
| Personnel | 549,872 | 499,573 |` },
  { name: 'licensing fees called "higher"', expect: 2, calls: AUG_VS_JUL, q: 'Why did profit change in August 2026?', a: '- Licensing fees: €6,843 higher (favourable).' },
  { name: 'August figure presented as June', expect: 2, calls: [['pl_trend', { lines: ['Airport'], from: '2026-06', to: '2026-08', include_prior_year: false }]], q: 'Airport revenue in June 2026?', a: 'Airport revenue in June 2026 was €21,082.' },
  { name: 'adverse variance called favourable', expect: 2, calls: YTD_BUDGET, q: 'Which expenses are over budget?', a:
`| Expense Line | Actual (€) | Budget (€) | Variance (€) | Assessment |
|---|---|---|---|---|
| General | 549,872 | 499,573 | -50,298 | Favourable |` },
  { name: 'overclaims "on track" (numbers correct)', expect: 3, review: true, calls: [['year_end_projection', {}]], q: 'Are we on track to achieve the annual revenue budget?', a:
`Yes. Every projection method shows revenue exceeding the full-year budget of €7,786,925: budget method €7,953,011, run-rate €7,765,908 and prior-year pattern €8,343,803. No shortfall is expected under any method.` },
  { name: 'invoicing treated as revenue (numbers correct)', expect: 3, review: true, calls: [['budget_plan', {}], ['revenue_forecast', {}]], q: 'Is the invoicing forecast enough to reach the revenue budget?', a:
`Yes. Revenue so far is €3,216,893 and the invoicing forecast for Sep 2026 – Mar 2027 is €4,116,399, so total revenue will be well above the full-year budget of €7,786,925.` },
  { name: 'budget variance blamed on accounts (numbers correct)', expect: 3, review: true, calls: YTD_BUDGET, q: 'Why are General expenses over budget?', a:
`General expenses are €50,298 over budget because the budget for consulting fees and automation expenses was exceeded.` },
];

(async () => {
  const withReview = process.argv.includes('--review');
  const store = await getStore();
  const openai = withReview ? new OpenAI({ apiKey: config.openaiApiKey }) : null;
  let pass = 0;
  let run = 0;
  for (const c of CASES) {
    if (c.review && !withReview) continue;
    run++;
    const toolResults = c.calls.map(([name, args]) => ({ name, args, result: runTool(store, name, args) }));
    const values = [];
    for (const t of toolResults) collectValues(t.result, values);
    const l1 = verifyAnswer(c.a, { toolValues: values, allowedText: c.q });
    const l2 = checkMeaning(c.a, { directClaims: l1.direct, toolResults: toolResults.map((t) => t.result), store });
    let l3 = null;
    if (withReview && (c.expect === 'pass' || c.expect === 3)) l3 = await reviewAnswer(openai, { question: c.q, answer: c.a, toolResults });
    const caughtBy = !l1.ok ? 1 : !l2.ok ? 2 : l3 && !l3.ok ? 3 : 'pass';
    const ok = c.expect === 'pass' ? caughtBy === 'pass' : caughtBy !== 'pass' && caughtBy <= c.expect;
    if (ok) pass++;
    const why = [
      ...l1.unverified.map((u) => `L1: ${u.raw} not in source data`),
      ...l2.issues.map((i) => `L2: ${i.problem}`),
      ...(l3 ? l3.issues.map((i) => `L3: "${i.quote}" - ${i.problem}`) : []),
    ];
    const expectText = c.expect === 'pass' ? 'should pass' : `should be caught by layer ${c.expect}`;
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${c.name}  [${expectText}; result: ${caughtBy === 'pass' ? 'passed all layers' : `caught by layer ${caughtBy}`}]`);
    for (const w of why) console.log(`        ${w}`);
  }
  console.log(`\n${pass}/${run} behaved as expected${withReview ? '' : ' (run with --review to include layer 3)'}`);
  process.exit(pass === run ? 0 : 1);
})();
