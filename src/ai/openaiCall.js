// One place for model-specific request parameters, so any model can be set in .env (gpt-4.1, gpt-5.1, ...).
// Reasoning models (GPT-5.x, o-series) take `reasoning_effort` and, depending on the model and effort,
// may reject `temperature`. If the API rejects a parameter, the request is retried once without it.
const isReasoningModel = (model) => /^(gpt-5|o\d)/i.test(String(model || ''));

function modelParams(model, reasoningEffort) {
  const p = { temperature: 0 };
  if (isReasoningModel(model) && reasoningEffort) {
    p.reasoning_effort = reasoningEffort;
    if (reasoningEffort !== 'none') delete p.temperature; // sampling settings are only accepted with reasoning off
  }
  return p;
}

async function createCompletion(openai, params, options) {
  try {
    return await openai.chat.completions.create(params, options);
  } catch (e) {
    const msg = String(e?.message || '');
    const bad = ['temperature', 'reasoning_effort', 'parallel_tool_calls'].find((k) => k in params && e?.status === 400 && msg.includes(k));
    if (!bad) throw e;
    const { [bad]: _dropped, ...rest } = params;
    console.warn(`[openai] ${params.model} rejected "${bad}"; retrying without it.`);
    return openai.chat.completions.create(rest, options);
  }
}

module.exports = { modelParams, createCompletion, isReasoningModel };
