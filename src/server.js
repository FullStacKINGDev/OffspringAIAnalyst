const path = require('path');
const express = require('express');
const config = require('./config');
const { getStore, reload } = require('./state');
const { runAgent } = require('./ai/agent');
const { overview } = require('./analysis/overview');
const { dataQualityReport } = require('./analysis/dataQuality');

const app = express();

// ─── ngrok whitelist ────────────────────────────────────────────────────────
// When NGROK_ENABLED=true, only requests that arrive through an ngrok tunnel
// are accepted. Requests from localhost (direct access) still work so that
// local development is unaffected. Optionally restrict to specific hostnames
// via NGROK_ALLOWED_HOSTS in .env.
if (config.ngrokEnabled) {
  app.use((req, res, next) => {
    // ngrok sets x-forwarded-host to the public *.ngrok-free.app / *.ngrok.io hostname.
    const tunnelHost = req.headers['x-forwarded-host'] || '';
    const isNgrok = /\.ngrok[-.]/.test(tunnelHost) || /\.ngrok\.io$/.test(tunnelHost);

    // Always let through requests that originate locally (non-tunneled).
    const localOrigins = ['localhost', '127.0.0.1', '::1'];
    const reqHost = (req.headers.host || '').split(':')[0];
    if (localOrigins.includes(reqHost) && !tunnelHost) return next();

    if (!isNgrok) {
      return res.status(403).json({ error: 'Forbidden: requests must arrive through the ngrok tunnel.' });
    }

    // Optional hostname whitelist.
    if (config.ngrokAllowedHosts.length > 0 && !config.ngrokAllowedHosts.includes(tunnelHost)) {
      return res.status(403).json({ error: `Forbidden: ngrok hostname "${tunnelHost}" is not whitelisted.` });
    }

    next();
  });
  console.log(`[ngrok] Whitelist ENABLED${config.ngrokAllowedHosts.length ? ` — allowed hosts: ${config.ngrokAllowedHosts.join(', ')}` : ' — all ngrok hostnames accepted'}`);
}
// ────────────────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(config.root, 'public')));
const vendor = (file) => (req, res) => res.sendFile(path.join(config.root, 'node_modules', file));
app.get('/vendor/marked.js', vendor('marked/lib/marked.umd.js'));
app.get('/vendor/purify.js', vendor('dompurify/dist/purify.min.js'));
app.get('/fonts/geist-sans.woff2', vendor('geist/dist/fonts/geist-sans/Geist-Variable.woff2'));
app.get('/fonts/geist-mono.woff2', vendor('geist/dist/fonts/geist-mono/GeistMono-Variable.woff2'));

// Only the Lucide icons the UI uses, instead of the full icon bundle.
const UI_ICONS = [
  'ArrowUp', 'Square', 'RefreshCw', 'Plus', 'Copy', 'Check', 'ChevronDown', 'ChevronRight', 'Sparkles', 'Sun', 'Moon', 'Monitor',
  'PanelLeft', 'X', 'Receipt', 'ChartLine', 'ArrowUpDown', 'Scale', 'Landmark', 'CalendarDays', 'Target', 'ShieldCheck',
  'FileSpreadsheet', 'FileText', 'TriangleAlert', 'OctagonAlert', 'Info', 'Wallet', 'Clock', 'Building2', 'Workflow',
  'TrendingUp', 'TrendingDown', 'Coins', 'Gauge', 'Lightbulb', 'LayoutDashboard', 'Database', 'CircleCheck', 'Table2', 'LoaderCircle', 'Minus',
];
const iconsJs = (() => {
  const { icons } = require('lucide');
  const subset = Object.fromEntries(UI_ICONS.filter((n) => icons[n]).map((n) => [n, icons[n]]));
  return `window.ICONS=${JSON.stringify(subset)};`;
})();
app.get('/vendor/icons.js', (req, res) => res.type('application/javascript').send(iconsJs));

// Cheap liveness check; the UI polls it to detect when the server is back after a restart.
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/overview', async (req, res, next) => {
  try {
    res.json(overview(await getStore()));
  } catch (e) { next(e); }
});

app.get('/api/issues', async (req, res, next) => {
  try {
    res.json(dataQualityReport(await getStore(), req.query));
  } catch (e) { next(e); }
});

app.post('/api/reload', async (req, res, next) => {
  try {
    const store = await reload();
    res.json({ ok: true, loaded_at: store.loadedAt, sources: store.sources, errors: store.loadErrors });
  } catch (e) { next(e); }
});

function friendlyError(e) {
  if (e?.status === 404) return `OpenAI model error: ${e.message || 'Model not found'}. Check OPENAI_MODEL in environment variables.`;
  if (e?.status === 429 && /credit|quota/i.test(e.message)) return 'The OpenAI account has no credits left. Add credits at platform.openai.com → Settings → Billing, then try again.';
  if (e?.status === 401) return 'The OpenAI API key was rejected. Check OPENAI_API_KEY in Vercel environment variables.';
  if (e?.status === 429) return 'OpenAI rate limit reached. Wait a moment and try again.';
  return e?.message || 'Unexpected error';
}


// Streams the answer as Server-Sent Events (see src/ai/agent.js for the event types).
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body || {};
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  if (!last || last.role !== 'user' || typeof last.content !== 'string' || !last.content.trim()) {
    res.status(400).json({ error: 'The request must end with a user question.' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const send = (ev) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });

  try {
    const store = await getStore();
    for await (const ev of runAgent(store, messages, { signal: abort.signal })) {
      if (abort.signal.aborted) break;
      send(ev);
    }
  } catch (e) {
    if (!abort.signal.aborted) {
      console.error('[chat]', e.status || '', e.message);
      send({ type: 'error', message: friendlyError(e) });
    }
  }
  res.end();
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

if (require.main === module) {
  (async () => {
    const store = await getStore();
    app.listen(config.port, () => {
      console.log(`WACD Financial Assistant on http://localhost:${config.port}`);
      console.log(`Data: ${store.sources.length} source files, actuals to ${store.latestActualMonth}, ${store.issues.length} data-quality findings`);
      if (store.loadErrors.length) console.warn('Load errors:', store.loadErrors);
      if (!config.openaiApiKey) console.warn('OPENAI_API_KEY is not set: chat will not work until it is added to .env');
    });
  })();
}

module.exports = app;
