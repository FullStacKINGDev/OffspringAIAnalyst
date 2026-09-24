// Tool-calling loop over the OpenAI Chat Completions API, streamed as events:
//   { type: 'status', text }             what the analyst is doing (shown while it works)
//   { type: 'tool_start', id, name, args }
//   { type: 'tool_end', id, name, ms, sources, warnings, error }
//   { type: 'delta', text }              answer text (sent only after verification)
//   { type: 'verification', ok, corrected, checked, unverified, layers: [...] }
//   { type: 'done' } | { type: 'error', message }
//
// Accuracy gate: the final answer is held back and checked in three layers before it is shown.
//   1. Figures  (verify.js)  every amount / % exists in this turn's tool results
//   2. Meaning  (meaning.js) each figure sits next to the right item, month and direction
//   3. Review   (review.js)  an independent reviewer model checks the draft against the raw tool data
// Any failure sends the draft back for correction (up to MAX_CORRECTIONS), and all layers run again.
const OpenAI = require('openai');
const config = require('../config');
const { TOOL_SCHEMAS, runTool } = require('./tools');
const { buildSystemPrompt } = require('./systemPrompt');
const { verifyAnswer, collectValues } = require('./verify');
const { checkMeaning } = require('./meaning');
const { reviewAnswer } = require('./review');

let client = null;
function getClient() {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not set. Add it to the .env file.');
  if (!client) client = new OpenAI({ apiKey: config.openaiApiKey });
  return client;
}

const MAX_HISTORY = 12;
const MAX_CORRECTIONS = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitizeHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 20000) }));
}

function correctionPrompt(problems) {
  return '[Automatic verification - not from the user]\n'
    + `${problems.join('\n\n')}\n\n`
    + 'Fix every problem before the answer is shown. Call the relevant tools if needed; copy figures exactly from the tool results '
    + '(rounded to whole euros), attach each figure to the item, period and direction the tool data gives it, and show any '
    + 'calculation you make. Never reuse figures from earlier answers. Keep everything that was already correct unchanged. '
    + 'Reply with the complete corrected answer only, without mentioning this check.';
}

async function* runAgent(store, history, { signal } = {}) {
  const openai = getClient();
  const systemPrompt = buildSystemPrompt(store);
  const clean = sanitizeHistory(history);
  const lastUser = [...clean].reverse().find((m) => m.role === 'user');
  const question = lastUser ? lastUser.content : '';
  const messages = [{ role: 'system', content: systemPrompt }, ...clean];

  const toolValues = [];
  const toolResults = [];
  const toolsUsed = new Set();
  const allowedText = `${question}\n${systemPrompt}`;
  let corrections = 0;

  yield { type: 'status', text: 'Analysing the question…' };

  for (let round = 0; round < config.maxToolRounds + MAX_CORRECTIONS; round++) {
    const stream = await openai.chat.completions.create({
      model: config.model,
      messages,
      tools: TOOL_SCHEMAS,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      temperature: 0,
      stream: true,
    }, { signal });

    let content = '';
    const calls = [];
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) content += delta.content;
      for (const tc of delta.tool_calls || []) {
        const c = (calls[tc.index] ||= { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
    }

    if (calls.length) {
      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
      });
      for (const c of calls) {
        let args = {};
        try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = {}; }
        yield { type: 'tool_start', id: c.id, name: c.name, args };
        const t0 = Date.now();
        const result = runTool(store, c.name, args);
        toolsUsed.add(c.name);
        toolResults.push({ name: c.name, args, result });
        collectValues(result, toolValues);
        yield {
          type: 'tool_end', id: c.id, name: c.name, ms: Date.now() - t0,
          sources: result.sources || [], warnings: result.warnings || [], error: result.error || null,
        };
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
      }
      yield { type: 'status', text: 'Writing the answer…' };
      continue;
    }

    // ---- Verification of the final draft ----
    yield { type: 'status', text: 'Check 1 of 3 · matching every figure to the source data…' };
    const l1 = verifyAnswer(content, { toolValues, allowedText });
    const dqWithoutEvidence = /\bDQ\d{2}\b/.test(content) && !toolsUsed.has('data_quality_report');

    yield { type: 'status', text: 'Check 2 of 3 · checking each figure’s item, month and direction…' };
    const l2 = checkMeaning(content, { directClaims: l1.direct, toolResults: toolResults.map((t) => t.result), store });

    let l3 = { ok: true, skipped: true, note: 'Not needed: the answer contains no figures', issues: [] };
    const needsReview = l1.checked > 0 || toolResults.length > 0;
    if (!config.reviewEnabled) {
      l3 = { ok: true, skipped: true, note: 'Independent review switched off (REVIEW_ENABLED=false)', issues: [] };
    } else if (needsReview && l1.ok && l2.ok && !dqWithoutEvidence) {
      yield { type: 'status', text: 'Check 3 of 3 · independent review of the answer…' };
      try {
        l3 = await reviewAnswer(openai, { question, answer: content, toolResults, signal });
      } catch (e) {
        if (signal?.aborted) throw e;
        l3 = { ok: false, skipped: true, note: `Independent review unavailable: ${e.message}`, issues: [] };
      }
    } else if (needsReview) {
      l3 = { ok: false, skipped: true, note: 'Not run: the draft failed an earlier check', issues: [] };
    }

    const problems = [];
    if (!l1.ok) {
      problems.push('CHECK 1 - these figures do not match any number returned by the tools in this turn:\n'
        + l1.unverified.map((u) => `- ${u.raw}   (in: "${u.context}")${u.hint ? ` -> ${u.hint}` : ''}`).join('\n'));
    }
    if (dqWithoutEvidence) {
      problems.push('CHECK 1 - the answer discusses a data-quality finding without calling data_quality_report. Call it and explain from its evidence (sheet, cells, months, amounts).');
    }
    if (!l2.ok) {
      problems.push('CHECK 2 - these figures are attached to the wrong item, month or direction:\n'
        + l2.issues.map((i) => `- ${i.problem}   (in: "${i.context}")`).join('\n'));
    }
    if (!l3.ok && !l3.skipped) {
      problems.push('CHECK 3 - an independent reviewer found these problems:\n'
        + l3.issues.map((i) => `- "${i.quote}": ${i.problem} Should be: ${i.correction}`).join('\n'));
    }

    if (problems.length && corrections < MAX_CORRECTIONS) {
      corrections++;
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: correctionPrompt(problems) });
      yield { type: 'status', text: `Correcting the answer (round ${corrections}) after verification…` };
      continue;
    }

    // Replay the verified text in small pieces so the UI still types it out.
    for (const piece of content.match(/[\s\S]{1,28}/g) || []) {
      if (signal?.aborted) return;
      yield { type: 'delta', text: piece };
      await sleep(6);
    }
    const figuresOk = l1.ok && !dqWithoutEvidence;
    yield {
      type: 'verification',
      ok: figuresOk && l2.ok && l3.ok,
      corrected: corrections > 0,
      checked: l1.checked,
      unverified: l1.unverified.map((u) => u.raw),
      layers: [
        {
          id: 'figures', label: 'Figures', ok: figuresOk,
          detail: `${l1.checked - l1.unverified.length} of ${l1.checked} figures match the source data`,
          issues: [...l1.unverified.map((u) => `${u.raw} could not be matched to the source data`), ...(dqWithoutEvidence ? ['Data-quality finding discussed without its evidence'] : [])],
        },
        {
          id: 'meaning', label: 'Items, months & directions', ok: l2.ok,
          detail: l2.ok ? `${l2.checked} figure${l2.checked === 1 ? '' : 's'} sit next to the right item, month and direction` : `${l2.issues.length} figure(s) attached to the wrong item, month or direction`,
          issues: l2.issues.map((i) => i.problem),
        },
        {
          id: 'review', label: 'Independent review', ok: l3.ok, skipped: !!l3.skipped,
          detail: l3.skipped ? l3.note : l3.ok ? 'No material issues found by the reviewer' : `${l3.issues.length} material issue(s)`,
          issues: (l3.issues || []).map((i) => `"${i.quote}": ${i.problem}`),
        },
      ],
    };
    yield { type: 'done' };
    return;
  }
  yield { type: 'delta', text: '_Stopped after too many analysis steps. Please narrow the question._' };
  yield { type: 'done' };
}

module.exports = { runAgent };
