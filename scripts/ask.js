// Ask the assistant a question from the command line:  npm run ask -- "What is our current revenue?"
const { getStore } = require('../src/state');
const { runAgent } = require('../src/ai/agent');

(async () => {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('Usage: npm run ask -- "your question"');
    process.exit(1);
  }
  const store = await getStore();
  let answer = '';
  for await (const ev of runAgent(store, [{ role: 'user', content: question }])) {
    if (ev.type === 'delta') { answer += ev.text; process.stdout.write(ev.text); }
    if (ev.type === 'discard') { process.stdout.write('\n'); answer = ''; }
    if (ev.type === 'tool_start') process.stderr.write(`\x1b[2m→ ${ev.name} ${JSON.stringify(ev.args)}\x1b[0m\n`);
    if (ev.type === 'tool_end' && ev.error) process.stderr.write(`\x1b[31m  ${ev.name} error: ${ev.error}\x1b[0m\n`);
  }
  process.stdout.write('\n');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
