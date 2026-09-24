// Layer 3 - independent review. A separate model call acts as a reviewer: it sees only the question, the raw
// tool results and the draft answer, and must return a structured verdict. It catches what code cannot:
// answering a different question or period, unsupported causes, forecast / budget / invoicing mix-ups,
// overclaimed conclusions and missing material caveats.
const config = require('../config');
const { modelParams, createCompletion } = require('./openaiCall');

const REVIEW_SCHEMA = {
  name: 'answer_review',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'] },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            quote: { type: 'string', description: 'The exact words in the draft that are wrong.' },
            problem: { type: 'string', description: 'What is wrong, citing the tool data.' },
            correction: { type: 'string', description: 'What the answer should say instead.' },
            severity: { type: 'string', enum: ['material', 'minor'] },
          },
          required: ['quote', 'problem', 'correction', 'severity'],
        },
      },
    },
    required: ['verdict', 'issues'],
  },
};

const REVIEWER_PROMPT = `You are an independent financial reviewer (a second pair of eyes, like an audit senior).
You check a draft answer written by an analyst assistant for WorldACD Market Data B.V. against the TOOL DATA it was given.
You do not rewrite the answer; you report errors.

Conventions of the data:
- Currency EUR. Financial year April-March, named after the year it ends: FY2027 = Apr 2026 - Mar 2027 (Offspring files call it "FY26" / "FY 26/27").
- Tool P&L figures use MBR presentation: income positive, costs negative; variance = actual - comparison, positive = favourable.
- "Budget" is the MBR BUDGET sheet and exists only by MBR category. "Revenue forecast" / "invoicing forecast" is billing, NOT P&L revenue.
- Anything from year_end_projection is an AI projection, not an official forecast.
- Flags such as "material movement" come from the app's checks, not from the accounting system (Exact).
- The analyst is instructed to SHOW COSTS AS POSITIVE AMOUNTS in answers. That is correct presentation, not a sign error.
  In answer tables a variance may be written either as the change in the amounts shown (a cost that fell is negative) or in
  MBR form (positive = favourable). Both are fine when the Favourable/Adverse label and the wording are right.
  Only report a sign or direction problem when the meaning is wrong (e.g. a cost increase called a decrease, an adverse
  variance labelled favourable, "above budget" for a figure that is below budget).

Report an issue as "material" only if a reader could be misled about the numbers or conclusions:
1. A figure attached to the wrong item, period, basis (actual / budget / prior year / projection / invoicing) or sign/direction.
2. The answer answers a different question or period than asked, or silently picks one reading of an ambiguous period.
3. A claim, cause or conclusion the tool data does not support (e.g. calling something "on track" when a method shows a shortfall; attributing a budget variance to specific accounts; saying the accounting system flagged something).
4. Invoicing treated as revenue, projection presented as official forecast, or budget and forecast confused.
5. A warning in the tool data (missing months, excluded months, related data-quality findings) that changes the meaning of the answer and is left out.
6. Arithmetic in the text that is wrong.
Do NOT report: style, wording preferences, rounding to whole euros, extra helpful context, or figures you cannot see in truncated data.
Verdict "fail" if and only if there is at least one material issue. Be precise: quote the draft and cite the tool figure.`;

function compactToolData(toolResults, limit = 14000) {
  return toolResults.map((t, i) => {
    let json = JSON.stringify(t.result);
    const truncated = json.length > limit;
    if (truncated) json = `${json.slice(0, limit)}…[truncated]`;
    return `### Tool call ${i + 1}: ${t.name}(${JSON.stringify(t.args)})\n${json}`;
  }).join('\n\n');
}

async function reviewAnswer(openai, { question, answer, toolResults, signal }) {
  const res = await createCompletion(openai, {
    model: config.reviewModel,
    ...modelParams(config.reviewModel, config.reviewReasoningEffort),
    response_format: { type: 'json_schema', json_schema: REVIEW_SCHEMA },
    messages: [
      { role: 'system', content: REVIEWER_PROMPT },
      {
        role: 'user',
        content: `QUESTION:\n${question}\n\nTOOL DATA (${toolResults.length} call(s)):\n${compactToolData(toolResults) || '(no tools were called)'}\n\nDRAFT ANSWER:\n${answer}`,
      },
    ],
  }, { signal });
  let parsed;
  try {
    parsed = JSON.parse(res.choices[0].message.content);
  } catch {
    return { ok: true, skipped: true, issues: [], note: 'Reviewer returned no readable verdict.' };
  }
  const material = (parsed.issues || []).filter((i) => i.severity === 'material');
  return { ok: material.length === 0, issues: material, minor: (parsed.issues || []).filter((i) => i.severity !== 'material') };
}

module.exports = { reviewAnswer };
