// Accuracy regression test: asks the live assistant benchmark questions and checks the answers against
// figures computed directly by the deterministic engine. Uses the OpenAI API (costs a few cents).
//   npm run eval            all cases
//   npm run eval -- 3 7     only cases 3 and 7
const { getStore } = require('../src/state');
const { runAgent } = require('../src/ai/agent');
const pl = require('../src/analysis/pl');
const { balanceSheet } = require('../src/analysis/balance');
const P = require('../src/lib/periods');

const whole = (v) => Math.round(Math.abs(v)).toLocaleString('en-GB');
const cents = (v) => Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Accepted spellings of one amount: whole euros (3,216,893) or with cents (3,216,892.99).
const fmt = (v) => [whole(v), cents(v)];

function buildCases(s) {
  const ytd = pl.plStatement(s, { compare_with: 'budget' }).rows;
  const line = (rows, l) => rows.find((r) => r.line === l);
  const month = (m) => pl.mbrFromAccounts(s, pl.accountTotals(s, [m]));
  const fyBudget = pl.budgetPlan(s, {}).full_year['Total Revenue'];
  const revYtd = line(ytd, 'Total Revenue').actual;
  const byMonth = s.actualMonths.map((m) => [m, month(m)['Total Revenue']]).sort((a, b) => b[1] - a[1]);
  const lastTwo = s.actualMonths.slice(-2);
  const cal2023 = pl.mbrFromAccounts(s, pl.accountTotals(s, P.monthRange('2023-01', '2023-12')));
  const cash = balanceSheet(s).key_metrics.cash_and_bank.closing;
  const dq10 = (s.issues || []).find((i) => /subtotal/.test(i.title));

  return [
    { q: 'What is our total revenue for the current financial year so far?', expect: [fmt(revYtd)] },
    { q: 'What is the total revenue budget for FY 26/27?', expect: [fmt(fyBudget)], forbid: [/7,167,000/] },
    { q: 'What was Airport revenue in June 2026?', expect: [[fmt(month('2026-06').Airport), '25,988.5']], forbid: [/34,057/] },
    { q: 'How much revenue have we generated so far compared to the annual budget? What percentage is that?', expect: [fmt(revYtd), fmt(fyBudget), (100 * revYtd / fyBudget).toFixed(1) + '%'], forbid: [/7,167,000/, /44\.9%/] },
    { q: 'Which expense categories are over budget this financial year to date?', expect: [fmt(line(ytd, 'General').actual), fmt(line(ytd, 'General').comparison)], forbid: [/502,983/, /1,065,410/] },
    { q: 'Which months had the highest and the lowest total revenue across all the data?', expect: [fmt(byMonth[0][1]), fmt(byMonth[byMonth.length - 1][1])] },
    { q: `Why did profit change in ${P.monthLabel(lastTwo[1])} compared with ${P.monthLabel(lastTwo[0])}?`, expect: [[fmt(month(lastTwo[1]).EBIT), fmt(month(lastTwo[1])['Net Income'])]], forbid: [/licensing fees?\s*(?:\([^)]*\)\s*)?(?:were|was|:|-)?\s*(?:€\s?[\d,.]+k?\s*)?(?:higher|increased|rose)\b/i] },
    { q: `Explain data-quality finding ${dq10 ? dq10.id : 'DQ10'} in detail.`, expect: dq10 ? ['300', '3,000'] : [], skip: !dq10 },
    { q: 'What was our net profit in calendar year 2023?', expect: [fmt(cal2023['Net Income'])] },
    { q: `How much cash and bank did we have at the end of ${P.monthLabel(s.latestActualMonth)}?`, expect: [fmt(cash)] },
    { q: 'Are there any unusual balances in the trial balance?', expect: [['1321', 'Advances']], forbid: [/accumulated depreciation[^.\n|]{0,80}(unusual|unexpected|not expected)/i] },
    { q: 'Is the invoicing forecast enough to reach the full-year revenue budget?', expect: [], forbid: [/would (also )?be sufficient/i, /is sufficient to (meet|reach)/i, /enough to (meet|reach) the (full-year )?budget/i] },
  ];
}

async function ask(store, question) {
  let text = '';
  let verification = null;
  const tools = [];
  for await (const ev of runAgent(store, [{ role: 'user', content: question }])) {
    if (ev.type === 'delta') text += ev.text;
    if (ev.type === 'tool_start') tools.push(ev.name);
    if (ev.type === 'verification') verification = ev;
    if (ev.type === 'error') throw new Error(ev.message);
  }
  return { text, verification, tools };
}

(async () => {
  const store = await getStore();
  const only = process.argv.slice(2).map(Number).filter(Boolean);
  const cases = buildCases(store);
  let pass = 0;
  let run = 0;
  for (const [i, c] of cases.entries()) {
    const n = i + 1;
    if ((only.length && !only.includes(n)) || c.skip) continue;
    run++;
    const t0 = Date.now();
    try {
      const { text, verification, tools } = await ask(store, c.q);
      const flat = text.replace(/ /g, ' ');
      const missing = c.expect.filter((e) => ![].concat(e).flat().some((alt) => flat.includes(alt)));
      const forbidden = (c.forbid || []).filter((re) => re.test(flat));
      const verified = !verification || verification.ok;
      const ok = !missing.length && !forbidden.length && verified;
      if (ok) pass++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  #${n}  ${c.q}  (${((Date.now() - t0) / 1000).toFixed(1)}s; tools: ${tools.join(', ') || 'none'}; figures checked: ${verification ? verification.checked : 0}${verification && verification.corrected ? ', auto-corrected' : ''})`);
      if (missing.length) console.log(`      missing expected: ${missing.map((m) => [].concat(m).flat().join(' | ')).join('; ')}`);
      if (forbidden.length) console.log(`      contains forbidden: ${forbidden.join('; ')}`);
      if (verification && verification.layers) {
        console.log(`      layers: ${verification.layers.map((l, k) => `${k + 1}.${l.label} ${l.skipped ? (l.ok ? '(not needed)' : '(NOT RUN)') : l.ok ? '✓' : '✗'}`).join('  ')}`);
      }
      if (!verified) console.log(`      verification issues: ${(verification.layers || []).flatMap((l) => l.issues).join(' | ') || verification.unverified.join(', ')}`);
      if (!ok || process.env.EVAL_VERBOSE) console.log(`      answer: ${flat.replace(/\n+/g, ' ⏎ ').slice(0, 900)}`);
    } catch (e) {
      console.log(`FAIL  #${n}  ${c.q}  -> ${e.message}`);
    }
  }
  console.log(`\n${pass}/${run} passed`);
  process.exit(pass === run ? 0 : 1);
})();
