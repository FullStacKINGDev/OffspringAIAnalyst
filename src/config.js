const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const root = path.join(__dirname, '..');

// Comma-separated list of allowed ngrok hostnames, e.g. "abc123.ngrok-free.app,xyz.ngrok.io".
// Leave blank to allow ALL ngrok hostnames (still requires NGROK_ENABLED=true).
const rawNgrokHosts = process.env.NGROK_ALLOWED_HOSTS || '';

module.exports = {
  root,
  port: Number(process.env.PORT) || 3000,
  dataDir: path.resolve(root, process.env.DATA_DIR || './Data'),
  openaiApiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4.1',
  // Layer 3 of answer verification: an independent reviewer model (can be set to a different / stronger model).
  // Defaults to the main model: in the verification self-test (npm run test:verify -- --review) gpt-4o-mini
  // raised false alarms on every correct answer and missed an invoicing-vs-revenue error; gpt-5.1 scored 13/13.
  reviewModel: process.env.REVIEW_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1',
  reviewEnabled: process.env.REVIEW_ENABLED !== 'false',
  // Optional, for reasoning models (gpt-5.x, o-series): none | minimal | low | medium | high. Unset = the model's default.
  // Higher effort can improve answer quality but is slower (mind the 60 s Vercel limit in vercel.json).
  reasoningEffort: process.env.OPENAI_REASONING_EFFORT || null,
  reviewReasoningEffort: process.env.REVIEW_REASONING_EFFORT || null,
  // WACD's financial year runs April-March and is named after the calendar year it ends in
  // (Exact Online "Financial year 2027" = Apr 2026 - Mar 2027).
  fyStartMonth: Number(process.env.FY_START_MONTH) || 4,
  materiality: Number(process.env.MATERIALITY_EUR) || 50000,
  currency: 'EUR',
  maxToolRounds: 8,
  // ngrok whitelist ─────────────────────────────────────────────────────────
  // Set NGROK_ENABLED=true to restrict access to requests arriving via ngrok.
  ngrokEnabled: process.env.NGROK_ENABLED === 'true',
  // Optional: restrict further to a specific set of ngrok hostnames.
  ngrokAllowedHosts: rawNgrokHosts ? rawNgrokHosts.split(',').map((h) => h.trim()).filter(Boolean) : [],
};
