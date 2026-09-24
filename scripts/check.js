// Loads the Data folder and prints coverage, headline figures and reconciliation results.
// No AI calls:  npm run check
const { getStore } = require('../src/state');
const { plStatement } = require('../src/analysis/pl');
const P = require('../src/lib/periods');

const eur = (v) => (v == null ? 'n/a' : `€${Math.round(v).toLocaleString('en')}`);

(async () => {
  const s = await getStore();
  console.log(`\n${s.company}  (currency ${s.currency})`);
  console.log('\nSources:');
  for (const src of s.sources) console.log(`  - ${src.label}: ${src.file}`);
  console.log(`\nActuals: ${P.monthLabel(s.actualMonths[0])} – ${P.monthLabel(s.latestActualMonth)} | current FY ${P.fyLabel(s.currentFy)} (${P.rangeLabel(P.fyStart(s.currentFy), P.fyEnd(s.currentFy))})`);

  const ytd = plStatement(s, { compare_with: 'budget' });
  console.log(`\n${P.fyLabel(s.currentFy)} YTD (${ytd.period.label}) vs budget:`);
  for (const r of ytd.rows.filter((x) => ['Total Revenue', 'Total Expenses', 'EBIT', 'Net Income'].includes(x.line))) {
    console.log(`  ${r.line.padEnd(15)} actual ${eur(r.actual).padStart(12)}  budget ${eur(r.comparison).padStart(12)}  variance ${eur(r.variance).padStart(10)} (${r.variance_pct}%)`);
  }

  console.log(`\nData quality (${s.issues.length} findings):`);
  for (const i of s.issues) console.log(`  [${i.id}] ${i.severity.toUpperCase().padEnd(6)} ${i.area}: ${i.title}`);
  console.log('');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
