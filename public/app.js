(() => {
  // ------------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) n.append(c);
    return n;
  };
  // Lucide icon from the subset served at /vendor/icons.js.
  const icon = (name, cls = '') => {
    const s = svgEl('svg', {
      class: `i ${cls}`.trim(), viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    });
    for (const [tag, attrs] of (window.ICONS && window.ICONS[name]) || []) s.append(svgEl(tag, attrs));
    return s;
  };
  const hydrateIcons = (root = document) => root.querySelectorAll('[data-icon]').forEach((n) => n.replaceWith(icon(n.dataset.icon)));

  const eur = (v) => (v == null ? 'n/a' : `${v < 0 ? '−' : ''}€${Math.round(Math.abs(v)).toLocaleString('en-GB')}`);
  const eurShort = (v) => {
    if (v == null) return 'n/a';
    const a = Math.abs(v);
    const s = v < 0 ? '−' : '';
    if (a >= 1e6) return `${s}€${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `${s}€${Math.round(a / 1e3)}k`;
    return `${s}€${Math.round(a)}`;
  };
  const signedPct = (v) => (v == null ? 'n/a' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`);
  const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // ------------------------------------------------------------------ motion helpers
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => motionQuery.matches;

  // Animated number: eases from 0 to the target, formatting every frame.
  function countUp(node, to, fmt, { duration = 1100, delay = 0 } = {}) {
    if (to == null || reduced()) { node.textContent = fmt(to); return; }
    node.textContent = fmt(0);
    const start = performance.now() + delay;
    const tick = (now) => {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      const e = 1 - (1 - t) ** 4;
      node.textContent = fmt(to * e);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Sliding pill behind the active tab / theme option.
  function moveIndicator(container, active, instant) {
    const ind = container.querySelector('.tab-ind, .seg-ind');
    if (!ind || !active) return;
    if (instant) container.classList.add('no-anim');
    ind.style.setProperty('--x', `${active.offsetLeft}px`);
    ind.style.setProperty('--w', `${active.offsetWidth}px`);
    if (instant) requestAnimationFrame(() => requestAnimationFrame(() => container.classList.remove('no-anim')));
  }

  // Cursor spotlight on .spot cards.
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest && e.target.closest('.spot');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });

  // ------------------------------------------------------------------ background effects
  (function backgroundFx() {
    const main = $('main');
    const fx = $('bg-fx');
    const lit = $('bg-grid-lit');
    const canvas = $('bg-waves');
    const ctx = canvas.getContext('2d');

    // Cursor: parallax on the aurora + lit dots around the pointer (one update per frame).
    let pending = null;
    main.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      if (!pending) requestAnimationFrame(() => {
        const r = main.getBoundingClientRect();
        const g = lit.getBoundingClientRect();
        fx.style.setProperty('--px', ((pending.x - r.left) / r.width - 0.5).toFixed(3));
        fx.style.setProperty('--py', ((pending.y - r.top) / r.height - 0.5).toFixed(3));
        lit.style.setProperty('--bx', `${pending.x - g.left}px`);
        lit.style.setProperty('--by', `${pending.y - g.top}px`);
        fx.classList.add('lit');
        pending = null;
      });
      pending = { x: e.clientX, y: e.clientY };
    }, { passive: true });
    main.addEventListener('pointerleave', () => { fx.classList.remove('lit'); fx.style.setProperty('--px', 0); fx.style.setProperty('--py', 0); });

    // Market lines: three layered, gently rising "chart" lines with data points travelling along the front one.
    const LINES = [
      { base: 0.70, trend: 0.10, amp: 0.050, f: [1.7, 4.3, 9.1], s: 0.050, ph: 0.0, width: 1.6, alpha: 0.55, fill: true },
      { base: 0.78, trend: 0.07, amp: 0.040, f: [2.4, 5.9, 11.3], s: 0.035, ph: 2.1, width: 1.2, alpha: 0.32 },
      { base: 0.86, trend: 0.05, amp: 0.030, f: [1.1, 3.7, 7.7], s: 0.025, ph: 4.2, width: 1.0, alpha: 0.22 },
    ];
    let W = 0;
    let H = 0;
    let dpr = 1;
    let colors = null;
    let running = false;
    let raf = 0;
    let last = 0;
    let t = 0;

    const readColors = () => {
      const cs = getComputedStyle(document.documentElement);
      colors = {
        a: cs.getPropertyValue('--series-1').trim() || '#2a78d6',
        b: cs.getPropertyValue('--series-2').trim() || '#eb6834',
        k: parseFloat(cs.getPropertyValue('--wave-alpha')) || 0.6,
      };
    };
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };
    const yAt = (L, xn, time) => {
      const w = Math.sin(xn * L.f[0] * Math.PI + L.ph + time * L.s * 6) * 0.6
        + Math.sin(xn * L.f[1] * Math.PI + L.ph * 1.7 - time * L.s * 9) * 0.28
        + Math.sin(xn * L.f[2] * Math.PI + time * L.s * 14) * 0.12;
      return (L.base - L.trend * xn + L.amp * w) * H;
    };
    const withAlpha = (hex, a) => {
      const h = hex.replace('#', '');
      const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    };
    function draw() {
      if (!W || !H || !colors) return;
      ctx.clearRect(0, 0, W, H);
      const step = Math.max(4, W / 220);
      LINES.forEach((L, li) => {
        const k = L.alpha * colors.k;
        const grad = ctx.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, withAlpha(colors.a, 0));
        grad.addColorStop(0.18, withAlpha(colors.a, k));
        grad.addColorStop(0.7, withAlpha(colors.b, k * 0.9));
        grad.addColorStop(1, withAlpha(colors.b, 0));
        ctx.beginPath();
        for (let x = 0; x <= W + step; x += step) {
          const y = yAt(L, x / W, t);
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.lineWidth = L.width;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = grad;
        ctx.stroke();
        if (L.fill) {
          ctx.lineTo(W, H);
          ctx.lineTo(0, H);
          ctx.closePath();
          const fg = ctx.createLinearGradient(0, H * (L.base - L.trend - L.amp), 0, H);
          fg.addColorStop(0, withAlpha(colors.a, 0.07 * colors.k));
          fg.addColorStop(1, withAlpha(colors.a, 0));
          ctx.fillStyle = fg;
          ctx.fill();
        }
        // Data points travelling along the front line.
        if (li === 0) {
          for (const off of [0, 0.37, 0.71]) {
            const xn = ((t * 0.045 + off) % 1);
            const x = xn * W;
            const y = yAt(L, xn, t);
            const edge = Math.min(1, xn / 0.12, (1 - xn) / 0.12);
            const c = xn < 0.55 ? colors.a : colors.b;
            const glow = ctx.createRadialGradient(x, y, 0, x, y, 14);
            glow.addColorStop(0, withAlpha(c, 0.45 * edge * colors.k));
            glow.addColorStop(1, withAlpha(c, 0));
            ctx.fillStyle = glow;
            ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = withAlpha(c, 0.95 * edge);
            ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
          }
        }
      });
    }
    // ~30 fps is plenty for slow ambient motion.
    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (now - last < 33) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      t += dt;
      draw();
    }
    const start = () => {
      if (running || reduced() || document.hidden) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => { running = false; cancelAnimationFrame(raf); };

    readColors();
    new ResizeObserver(resize).observe(canvas);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    motionQuery.addEventListener('change', () => { stop(); start(); draw(); });
    // Re-read the palette when the theme changes (toggle or OS setting).
    new MutationObserver(() => { readColors(); draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); draw(); });
    start();
  }());

  let toastTimer;
  function toast(text, iconName = 'Check') {
    const t = $('toast');
    t.classList.remove('leaving');
    t.replaceChildren(icon(iconName), el('span', { text }));
    t.hidden = true;
    void t.offsetWidth; // restart the entrance animation
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.add('leaving');
      toastTimer = setTimeout(() => { t.hidden = true; t.classList.remove('leaving'); }, 230);
    }, 1900);
  }

  hydrateIcons();

  // ------------------------------------------------------------------ constants
  const PROMPTS = [
    { cat: 'Performance', icon: 'Gauge', q: 'Give me a summary of the company’s current financial performance.' },
    { cat: 'Revenue', icon: 'TrendingUp', q: 'How much revenue have we generated compared to the forecast?' },
    { cat: 'Budget', icon: 'Target', q: 'Are we on track to achieve our annual forecast?' },
    { cat: 'Profitability', icon: 'Coins', q: 'Why has our profit increased or decreased?' },
    { cat: 'Costs', icon: 'Receipt', q: 'Which expenses are increasing the most?' },
    { cat: 'Balance sheet', icon: 'Landmark', q: 'What are the major changes in our Balance Sheet?' },
    { cat: 'Variance', icon: 'ChartLine', q: 'Which months had the biggest revenue variance?' },
    { cat: 'Trial balance', icon: 'Scale', q: 'Are there any unusual movements in the Trial Balance?' },
    { cat: 'Projection', icon: 'CalendarDays', q: 'What is our projected year-end revenue?' },
    { cat: 'Risk', icon: 'ShieldCheck', q: 'What are the key financial risks or areas requiring attention?' },
  ];

  const PLACEHOLDERS = [
    'Ask about revenue, costs, budget, balance sheet…',
    'Why did EBIT change in August?',
    'Which customers are invoiced in January?',
    'How is GSA revenue doing against budget?',
    'What drove the increase in consulting fees?',
    'Which balance-sheet accounts moved the most?',
  ];

  const TOOLS = {
    pl_statement: { label: 'P&L statement', icon: 'Receipt' },
    pl_trend: { label: 'P&L trend', icon: 'ChartLine' },
    top_movements: { label: 'Ranked account movements', icon: 'ArrowUpDown' },
    trial_balance: { label: 'Trial balance', icon: 'Scale' },
    balance_sheet: { label: 'Balance sheet', icon: 'Landmark' },
    revenue_forecast: { label: 'Invoicing forecast', icon: 'CalendarDays' },
    year_end_projection: { label: 'Year-end projection', icon: 'Target' },
    data_quality_report: { label: 'Data checks', icon: 'ShieldCheck' },
  };

  const SEV_ICON = { high: 'OctagonAlert', medium: 'TriangleAlert', low: 'Info', info: 'Info' };

  // ------------------------------------------------------------------ theme
  const themeToggle = document.querySelector('.theme-toggle');
  const themeButtons = themeToggle.querySelectorAll('[data-theme-choice]');
  function setTheme(choice) {
    const root = document.documentElement;
    if (choice === 'light' || choice === 'dark') root.dataset.theme = choice;
    else delete root.dataset.theme;
    try { localStorage.setItem('wacd-theme', choice); } catch (e) { /* storage unavailable */ }
    let active = null;
    themeButtons.forEach((b) => {
      const on = b.dataset.themeChoice === choice;
      b.setAttribute('aria-checked', String(on));
      if (on) active = b;
    });
    return active;
  }
  // Circular reveal from the clicked button (View Transitions API, where supported).
  function switchTheme(choice, origin) {
    const run = () => moveIndicator(themeToggle, setTheme(choice));
    if (!document.startViewTransition || reduced()) { run(); return; }
    const r = origin.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const transition = document.startViewTransition(run);
    transition.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 650, easing: 'cubic-bezier(.16, 1, .3, 1)', pseudoElement: '::view-transition-new(root)' },
      );
    }).catch(() => {});
  }
  let savedTheme = 'system';
  try { savedTheme = localStorage.getItem('wacd-theme') || 'system'; } catch (e) { /* ignore */ }
  moveIndicator(themeToggle, setTheme(savedTheme), true);
  themeButtons.forEach((b) => b.addEventListener('click', () => switchTheme(b.dataset.themeChoice, b)));

  // ------------------------------------------------------------------ navigation: Home / Reflex AI
  // Two views in the main panel, switched by the URL hash (#/home, #/ai) so refresh and Back work.
  const navItems = document.querySelector('.nav-items');
  const VIEWS = ['home', 'ai'];
  const viewFromHash = () => {
    const v = location.hash.replace(/^#\/?/, '');
    return VIEWS.includes(v) ? v : 'home';
  };
  function moveNavIndicator(active, instant) {
    const ind = navItems.querySelector('.nav-ind');
    if (!ind || !active) return;
    if (instant) navItems.classList.add('no-anim');
    ind.style.setProperty('--y', `${active.offsetTop}px`);
    ind.style.setProperty('--h', `${active.offsetHeight}px`);
    if (instant) requestAnimationFrame(() => requestAnimationFrame(() => navItems.classList.remove('no-anim')));
  }
  let currentView = null;
  function showView(name, instant) {
    if (!VIEWS.includes(name)) name = 'home';
    const changed = currentView !== name;
    currentView = name;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
    let active = null;
    navItems.querySelectorAll('.nav-item').forEach((a) => {
      const on = a.dataset.view === name;
      a.classList.toggle('active', on);
      if (on) { a.setAttribute('aria-current', 'page'); active = a; } else a.removeAttribute('aria-current');
    });
    moveNavIndicator(active, instant);
    document.body.dataset.view = name;
    document.title = name === 'ai' ? 'Reflex AI · WACD Analyst' : 'Home · WACD Analyst';
    // The chart sizes itself to its card, so redraw it when the dashboard becomes visible again.
    if (name === 'home' && changed) {
      requestAnimationFrame(() => {
        if (lastTrend) renderChart(lastTrend, false);
        if (lastCharts) renderDashboard(lastCharts, false);
      });
    }
  }
  window.addEventListener('hashchange', () => showView(viewFromHash()));
  // Open Reflex AI, optionally asking a question straight away (dashboard ask bar, chips, findings).
  function openAi(question) {
    if (location.hash !== '#/ai') location.hash = '#/ai';
    showView('ai');
    if (question) ask(question);
  }
  function openChecks() {
    if (location.hash !== '#/home') location.hash = '#/home';
    showView('home');
    requestAnimationFrame(() => $('checks-card').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  // Indicator positions depend on font metrics and layout.
  const realignIndicators = () => {
    moveNavIndicator(navItems.querySelector('.nav-item.active'), true);
    moveIndicator(themeToggle, themeToggle.querySelector('[aria-checked="true"]'), true);
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(realignIndicators);

  // ------------------------------------------------------------------ overview
  let overviewData = null;

  async function loadOverview() {
    const res = await fetch('/api/overview');
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const o = await res.json();
    overviewData = o;

    $('company').textContent = o.company;
    $('ws-meta').textContent = `Client of Offspring · ${o.currency}`;
    $('fy-label').textContent = `${o.fiscal_year} · Year to date`;
    $('ytd-range').textContent = o.ytd_range;
    $('fy-count').textContent = `${o.fy_progress.months_elapsed} of ${o.fy_progress.months_total} months`;
    const meter = $('fy-meter');
    meter.style.width = '0%';
    requestAnimationFrame(() => requestAnimationFrame(() => { meter.style.width = `${(o.fy_progress.months_elapsed / o.fy_progress.months_total) * 100}%`; }));

    for (const id of ['period-chip', 'home-period-chip']) {
      $(id).replaceChildren(icon('CalendarDays'), el('span', { text: `${o.fiscal_year} · actuals to ${o.latest_month}` }));
    }
    // Parts never break inside, and a separator starts the next line rather than ending the previous one.
    const subParts = [o.company, `${o.fiscal_year} (${o.fiscal_year_range})`, `actuals to ${o.latest_month}`, o.currency];
    $('dash-sub').replaceChildren(...subParts.flatMap((t, i) => (i ? [' ', el('span', { text: `· ${t}` })] : [el('span', { text: t })])));
    $('hero-pill-text').textContent = `Reflex AI · ${o.sources.length} source files · actuals to ${o.latest_month}`;
    $('composer-model').textContent = `${o.model} · ${o.sources.length} source files`;
    $('model-note').textContent = `Online · ${o.model}`;
    $('model-note').title = 'Data loaded; answers by ' + o.model;

    renderKpis(o);
    renderChart(o.revenue_trend, true);
    renderChartTable(o.revenue_trend);
    renderBalance(o.balance);
    renderHealth(o.issues);
    renderSources(o);
    renderDashboard(o.charts, true);
  }

  function renderKpis(o) {
    const names = { 'Total Revenue': 'Revenue', EBIT: 'EBIT', 'Net Income': 'Net income' };
    const delta = (pct, label) => {
      const dir = pct == null ? '' : pct >= 0 ? 'up' : 'down';
      return el('span', { class: `delta ${dir}` },
        pct == null ? null : icon(pct >= 0 ? 'TrendingUp' : 'TrendingDown'),
        el('b', { text: signedPct(pct) }), ` ${label}`);
    };
    $('kpis').replaceChildren(...o.kpis.map((k, i) => {
      const d = 120 + i * 110;
      const value = el('div', { class: 'kpi-value', title: eur(k.actual) });
      countUp(value, k.actual, eurShort, { delay: d + 150 });
      const card = el('div', { class: 'kpi spot', style: `--d:${d}ms` },
        el('div', { class: 'kpi-label', text: names[k.line] || k.line }),
        value,
        el('div', { class: 'kpi-spark' }, sparkline(k.trend, names[k.line] || k.line)),
        el('div', { class: 'kpi-deltas' }, delta(k.vs_budget_pct, 'vs budget'), delta(k.vs_prior_year_pct, 'vs prior year')));
      if (k.line === 'EBIT' && o.ebit_margin.actual != null) {
        card.append(el('div', { class: 'kpi-foot' }, 'Margin ', el('b', { text: `${o.ebit_margin.actual.toFixed(1)}%` }),
          ` · budget ${o.ebit_margin.budget != null ? o.ebit_margin.budget.toFixed(1) + '%' : 'n/a'}`));
      }
      return card;
    }));
  }

  // 12-month trend in the de-emphasis hue; the latest month is marked in the accent with a pulse.
  function sparkline(points, name) {
    const W = 96;
    const H = 36;
    const pad = 5;
    const vals = points.map((p) => p.actual).filter((v) => v != null);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const x = (i) => pad + (i / Math.max(1, points.length - 1)) * (W - pad * 2);
    const y = (v) => (max === min ? H / 2 : pad + (1 - (v - min) / (max - min)) * (H - pad * 2));
    const s = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${name}, last 12 months: ${eurShort(vals[0])} to ${eurShort(vals[vals.length - 1])}` });
    const d = points.map((p, i) => (p.actual == null ? '' : `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.actual).toFixed(1)}`)).join(' ');
    s.append(svgEl('path', { class: 'spark-line', d, pathLength: 1, fill: 'none', stroke: 'var(--spark)', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = points.length - 1;
    const lx = x(last);
    const ly = y(points[last].actual);
    s.append(svgEl('circle', { class: 'spark-pulse', cx: lx, cy: ly, r: 3.5, fill: 'var(--series-1)' }));
    s.append(svgEl('circle', { class: 'spark-dot', cx: lx, cy: ly, r: 3.5, fill: 'var(--series-1)', stroke: 'var(--card)', 'stroke-width': 2 }));
    const hover = svgEl('circle', { r: 3, fill: 'var(--ink)', opacity: 0 });
    s.append(hover);
    const slot = (W - pad * 2) / Math.max(1, points.length - 1);
    points.forEach((p, i) => {
      const hit = svgEl('rect', { x: x(i) - slot / 2, y: 0, width: slot, height: H, fill: 'transparent' });
      hit.addEventListener('pointermove', (ev) => {
        hover.setAttribute('cx', x(i));
        hover.setAttribute('cy', y(p.actual));
        hover.setAttribute('opacity', i === last ? 0 : 1);
        showTooltip([el('div', { class: 'tt-title', text: `${name} · ${p.label}` }), el('div', { class: 'tt-row' }, el('strong', { text: eur(p.actual) }))], ev);
      });
      hit.addEventListener('pointerleave', () => { hover.setAttribute('opacity', 0); hideTooltip(); });
      s.append(hit);
    });
    return s;
  }

  // Columns = actual revenue; short horizontal ticks = budget.
  let lastTrend = null;
  function renderChart(points, animate) {
    lastTrend = points;
    const host = $('chart');
    host.classList.toggle('animate', !!animate);
    host.replaceChildren();
    const W = Math.max(240, host.clientWidth || 290);
    // Fill the card when its row is taller than the chart needs (the card next to it sets the height).
    const H = Math.min(420, Math.max(Number(host.dataset.height) || 168, Math.floor(host.clientHeight)));
    const m = { top: 18, right: 2, bottom: 22, left: 38 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;
    const max = Math.max(...points.flatMap((p) => [p.actual || 0, p.budget || 0]));
    const step = niceStep(max / 3);
    const top = Math.ceil(max / step) * step;
    const y = (v) => m.top + ih - (v / top) * ih;
    const slot = iw / points.length;
    const bw = Math.min(24, slot * 0.58);

    const root = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    for (let v = 0; v <= top + 1e-6; v += step) {
      root.append(svgEl('line', { class: v === 0 ? 'baseline' : 'gridline', x1: m.left, x2: W - m.right, y1: y(v), y2: y(v) }));
      const t = svgEl('text', { class: 'tick', x: m.left - 7, y: y(v) + 3.5, 'text-anchor': 'end' });
      t.textContent = v === 0 ? '€0' : `€${Math.round(v / 1000)}k`;
      root.append(t);
    }
    points.forEach((p, i) => {
      const cx = m.left + slot * i + slot / 2;
      const g = svgEl('g', { class: 'slot', style: `--d:${250 + i * 45}ms` });
      if (p.actual != null) {
        const h = Math.max(0, y(0) - y(p.actual));
        const x0 = cx - bw / 2;
        const r = Math.min(4, h, bw / 2);
        const yt = y(p.actual);
        g.append(svgEl('path', {
          class: 'bar',
          d: `M${x0},${y(0)} V${yt + r} Q${x0},${yt} ${x0 + r},${yt} H${x0 + bw - r} Q${x0 + bw},${yt} ${x0 + bw},${yt + r} V${y(0)} Z`,
        }));
      }
      if (p.budget != null) {
        const half = Math.min(slot * 0.44, bw / 2 + 4);
        g.append(svgEl('line', { class: 'budget', x1: cx - half, x2: cx + half, y1: y(p.budget), y2: y(p.budget) }));
      }
      if (i % 2 === (points.length - 1) % 2) {
        const t = svgEl('text', { class: 'tick', x: cx, y: H - 6, 'text-anchor': 'middle' });
        t.textContent = p.label.slice(0, 3);
        root.append(t);
      }
      if (i === points.length - 1 && p.actual != null) {
        const t = svgEl('text', { class: 'value-label', x: cx + bw / 2, y: Math.min(y(p.actual), p.budget != null ? y(p.budget) : Infinity) - 7, 'text-anchor': 'end' });
        t.textContent = eurShort(p.actual);
        root.append(t);
      }
      const hit = svgEl('rect', { class: 'hit', x: m.left + slot * i, y: m.top, width: slot, height: ih, tabindex: 0, 'aria-label': `${p.label}: actual ${eur(p.actual)}, budget ${eur(p.budget)}` });
      const show = (ev) => {
        g.classList.add('active');
        const rows = [el('div', { class: 'tt-title', text: p.label }), ttRow('var(--series-1)', eur(p.actual), 'Actual')];
        if (p.budget != null) {
          rows.push(ttRow('var(--series-2)', eur(p.budget), 'Budget'));
          const v = p.actual - p.budget;
          rows.push(el('div', { class: 'tt-var', text: `Variance ${v >= 0 ? '+' : '−'}${eur(Math.abs(v))} (${signedPct((v / p.budget) * 100)})` }));
        }
        if (window.Charts) rows.push(window.Charts.askHint());
        showTooltip(rows, ev, hit);
      };
      const hide = () => { g.classList.remove('active'); hideTooltip(); };
      hit.addEventListener('pointermove', show);
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('focus', show);
      hit.addEventListener('blur', hide);
      if (window.Charts) window.Charts.askable(hit, `How did revenue in ${p.label} compare with budget and with the same month last year? What drove the difference?`);
      g.append(hit);
      root.append(g);
    });
    host.append(root);
  }

  const ttRow = (color, value, label) => el('div', { class: 'tt-row' },
    el('span', { class: 'tt-key', style: `background:${color}` }), el('strong', { text: value }), el('span', { text: label, style: 'color:var(--muted)' }));

  function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw || 1));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function showTooltip(children, ev, target) {
    const tt = $('tooltip');
    tt.replaceChildren(...children);
    tt.hidden = false;
    const r = (target || ev.currentTarget || ev.target).getBoundingClientRect();
    const x = ev && ev.clientX ? ev.clientX : r.left + r.width / 2;
    const left = Math.min(window.innerWidth - tt.offsetWidth - 10, Math.max(10, x + 14));
    const top = Math.max(10, (ev && ev.clientY ? ev.clientY : r.top) - tt.offsetHeight - 12);
    tt.style.left = `${left}px`;
    tt.style.top = `${top}px`;
  }
  const hideTooltip = () => { $('tooltip').hidden = true; };

  // ------------------------------------------------------------------ dashboard charts
  // Colours follow the entity: validated categorical slots for part-to-whole charts, and one meaning per colour
  // across the page (actual = blue, budget = orange, last year = grey, invoicing forecast = violet).
  const CAT = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-6)'];
  const COST_SLOT = { Personnel: 0, General: 1, Sales: 2, Housing: 3, Office: 4, 'Other costs': 5 };
  const SERIES_COLOR = { actual: 'var(--series-1)', budget: 'var(--series-2)', prior: 'var(--prior)' };
  let lastCharts = null;

  function lineLegend(host, series) {
    host.replaceChildren(...series.map((sr) => el('span', {}, el('i', { class: 'key key-line', style: `background:${sr.color}` }), sr.name)));
  }
  function slotColors(items, fixed) {
    const used = new Set(items.map((it) => fixed[it.label]).filter((i) => i != null));
    let next = 0;
    return items.map((it) => {
      if (fixed[it.label] != null) return CAT[fixed[it.label]];
      while (used.has(next)) next++;
      used.add(next);
      return CAT[next];
    });
  }

  // Each chart card gets a takeaway line (computed from the same figures as the chart) and an Ask button.
  const B = (t) => el('b', { text: t });
  function decorate(cardId, { insight, ask }) {
    const card = $(cardId);
    if (!card) return;
    const head = card.querySelector('.card-head');
    let actions = head.querySelector('.card-actions');
    if (!actions) {
      const tableBtn = head.querySelector(':scope > button');
      const askBtn = el('button', { class: 'chip-btn ask-btn', type: 'button', title: 'Ask Reflex AI about this chart', 'aria-label': 'Ask Reflex AI about this chart' },
        icon('Sparkles'), el('span', { text: 'Ask' }));
      askBtn.addEventListener('click', () => openAi(askBtn.dataset.question));
      actions = el('div', { class: 'card-actions' }, askBtn, tableBtn);
      head.append(actions);
    }
    actions.querySelector('.ask-btn').dataset.question = ask;
    let p = card.querySelector(':scope > .insight');
    if (!insight) { if (p) p.remove(); return; }
    if (!p) { p = el('p', { class: 'insight' }); head.after(p); }
    p.replaceChildren(icon('Lightbulb'), el('span', {}, ...insight));
  }

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = (m) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  const yearBefore = (m) => `${Number(m.slice(0, 4)) - 1}${m.slice(4)}`;
  // Exact to the cent, for tables that must foot.
  const eur2 = (v) => (v == null ? '' : `${v < 0 ? '−' : ''}€${Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const signed2 = (v) => (v == null ? '' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${eur2(Math.abs(v))}`);
  const upDown = (v) => (v >= 0 ? 'up' : 'down');

  // Full-year budget progress beside the year-to-date meter: the bar is actual to date as a share of the full-year
  // budget; the tick (and "Plan") is where the phased budget expects to be by the latest month.
  function renderPlan(bp, fy, animate) {
    const host = $('plan-progress');
    host.closest('.period-card').classList.toggle('with-plan', !!bp);
    if (!bp) { host.hidden = true; return; }
    host.hidden = false;
    const C = window.Charts;
    host.replaceChildren(...bp.items.map((src) => {
      // Percentages from the euro amounts, so the one-decimal figure is rounded once.
      const it = { ...src, pct_achieved: (100 * src.actual) / src.full_year_budget, pct_planned: (100 * src.budget_to_date) / src.full_year_budget };
      const fill = el('i', { class: 'plan-fill' });
      const row = el('div', {
        class: 'plan-row', tabindex: '0',
        'aria-label': `${it.label}: ${it.pct_achieved.toFixed(1)}% of the full-year budget reached; the phased budget expects ${it.pct_planned.toFixed(1)}% by ${bp.through}`,
      },
      el('div', { class: 'eyebrow', text: `${it.label} · FY budget` }),
      el('div', { class: 'period-row' },
        el('div', { class: 'period-range', text: `${it.pct_achieved.toFixed(1)}%` }),
        el('div', { class: 'period-count', title: `Budget phased to ${bp.through}` }, el('i', { class: 'plan-key' }), `Plan ${it.pct_planned.toFixed(1)}%`)),
      el('div', { class: 'plan-bar' }, fill, el('i', { class: 'plan-mark', style: `left:${Math.min(100, it.pct_planned)}%` })));
      const width = `${Math.min(100, it.pct_achieved)}%`;
      if (animate) requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = width; }));
      else fill.style.width = width;
      const rows = () => [el('div', { class: 'tt-title', text: `${it.label} · ${fy}` }),
        ttRow('var(--series-1)', eur(it.actual), `actual to ${bp.through} (${it.pct_achieved.toFixed(1)}%)`),
        ttRow('var(--ink)', eur(it.budget_to_date), `budget to ${bp.through} (${it.pct_planned.toFixed(1)}%)`),
        el('div', { class: 'tt-var', text: `Full-year budget ${eur(it.full_year_budget)}` }), C.askHint()];
      row.addEventListener('pointermove', (ev) => showTooltip(rows(), ev, row));
      row.addEventListener('pointerleave', hideTooltip);
      row.addEventListener('focus', () => showTooltip(rows(), null, row));
      row.addEventListener('blur', hideTooltip);
      C.askable(row, `Are we on track to reach the full-year ${it.label} budget for ${fy}? How much is still needed per month?`);
      return row;
    }));
  }

  function renderDashboard(c, animate) {
    if (!c || !window.Charts) return;
    lastCharts = c;
    const C = window.Charts;
    C.setAsk(openAi);
    const part = (id, sel) => document.getElementById(id).querySelector(sel);
    const safe = (name, fn) => { try { fn(); } catch (err) { console.error(`Chart "${name}" failed:`, err); } };
    const pctOf = (v, t) => `${((100 * v) / t).toFixed(1)}%`;
    const ytd = c.ytd_label;
    const revenueStep = c.ebit_bridge && c.ebit_bridge.steps.find((s) => s.key === 'revenue');

    safe('budget progress', () => renderPlan(c.budget_progress, c.fiscal_year, animate));

    safe('revenue vs budget', () => {
      const pts = (lastTrend || []).filter((p) => p.actual != null && p.budget);
      if (!pts.length) return;
      const beat = pts.filter((p) => p.actual >= p.budget).length;
      const gap = (p) => (p.actual - p.budget) / p.budget;
      const weakest = pts.reduce((a, p) => (gap(p) < gap(a) ? p : a));
      const span = pts.length === lastTrend.length ? `the last ${pts.length}` : `${pts.length} budgeted`;
      decorate('card-revenue', {
        insight: beat === pts.length
          ? ['Revenue beat budget in ', B(`all ${span}`), ' months.']
          : ['Revenue beat budget in ', B(`${beat} of ${span}`), ' months; the weakest was ', B(weakest.label), ` (${signedPct(gap(weakest) * 100)}).`],
        ask: 'How has monthly revenue compared with budget over the last 12 months? Which months missed budget, and why?',
      });
    });

    safe('revenue mix', () => {
      const items = c.revenue_mix.items.map((x) => ({
        ...x,
        ask: x.key === 'Other'
          ? `How did Other Revenue and PY Adjustments for ${ytd} compare with budget and with the same months last year?`
          : `How did ${x.label} revenue for ${ytd} compare with budget and with the same months last year?`,
      }));
      const d = C.donut(part('card-revenue-mix', '[data-chart]'), { items, colors: CAT, centerLabel: 'revenue YTD', animate });
      C.donutLegend(part('card-revenue-mix', '[data-legend]'), items, CAT, d.total, { onHover: d.highlight });
      part('card-revenue-mix', '[data-sub]').textContent = `${ytd} · by customer segment`;
      C.table(part('card-revenue-mix', '.chart-table'), ['Segment', 'Revenue', 'Share'], items.map((x) => [x.label, C.eur(x.value), pctOf(x.value, d.total)]));
      const [first, second] = [...items].sort((a, b) => b.value - a.value);
      decorate('card-revenue-mix', {
        insight: [B(first.label), ' brings in ', B(pctOf(first.value, d.total)), ' of revenue; ', B(second.label), ` another ${pctOf(second.value, d.total)}.`],
        ask: `Break down revenue by customer segment for ${ytd}. How does each segment compare with budget and with last year?`,
      });
    });

    safe('revenue across the year', () => {
      const r = c.revenue_year;
      const byKey = Object.fromEntries(r.series.map((sr) => [sr.key, { ...sr, color: SERIES_COLOR[sr.key], emphasis: sr.key === 'actual' }]));
      lineLegend(part('card-revenue-year', '[data-legend]'), [byKey.actual, byKey.budget, byKey.prior]);
      // Drawn back to front so this year's actual sits on top.
      C.lines(part('card-revenue-year', '[data-chart]'), {
        labels: r.labels, series: [byKey.prior, byKey.budget, byKey.actual], labelSeries: 2, height: 250, animate,
        ask: (i) => (byKey.actual.values[i] != null
          ? `How did revenue in ${monthName(r.months[i])} compare with budget and with ${monthName(yearBefore(r.months[i]))}? What drove the difference?`
          : `What revenue is budgeted for ${monthName(r.months[i])}, and how does it compare with ${monthName(yearBefore(r.months[i]))}?`),
      });
      C.table(part('card-revenue-year', '.chart-table'), ['Month', byKey.actual.name, byKey.budget.name, byKey.prior.name],
        r.months.map((m, i) => [r.labels[i], C.eur(byKey.actual.values[i]), C.eur(byKey.budget.values[i]), C.eur(byKey.prior.values[i])]));
      const g = c.growth && c.growth.revenue_vs_py_pct;
      if (g == null) return;
      const insight = ['Year-to-date revenue is ', B(`${upDown(g)} ${Math.abs(g).toFixed(1)}%`), ' on the same months last year'];
      if (revenueStep && revenueStep.change_pct != null) insight.push(' and ', B(`${Math.abs(revenueStep.change_pct).toFixed(1)}% ${revenueStep.change_pct >= 0 ? 'above' : 'below'}`), ' budget');
      insight.push('.');
      decorate('card-revenue-year', { insight, ask: `How is revenue for ${c.fiscal_year} tracking against budget and last year, month by month?` });
    });

    safe('segments vs budget', () => {
      const rows = [...c.segments_vs_budget].sort((a, b) => b.variance_pct - a.variance_pct);
      C.diverging(part('card-segments', '[data-chart]'), {
        colors: { good: 'var(--fav)', bad: 'var(--adv)' },
        animate,
        items: rows.map((sg) => ({
          label: sg.label, value: sg.variance_pct, valueText: C.signedPct(sg.variance_pct), good: sg.variance >= 0,
          tip: () => [C.ttTitle(`${sg.label} · ${ytd}`), C.ttRow(sg.variance >= 0 ? 'var(--fav)' : 'var(--adv)', `${C.signed(sg.variance, C.eur)} (${C.signedPct(sg.variance_pct)})`, 'vs budget'),
            C.ttNote(`Actual ${C.eur(sg.actual)} · budget ${C.eur(sg.budget)}`)],
          ask: `Why is ${sg.label} revenue ${Math.abs(sg.variance_pct).toFixed(1)}% ${sg.variance >= 0 ? 'above' : 'below'} budget for ${ytd}?`,
        })),
      });
      C.table(part('card-segments', '.chart-table'), ['Segment', 'Actual', 'Budget', 'Variance', 'Var %'],
        rows.map((sg) => [sg.label, C.eur(sg.actual), C.eur(sg.budget), C.signed(sg.variance, C.eur), C.signedPct(sg.variance_pct)]));
      const above = rows.filter((sg) => sg.variance >= 0).length;
      const worst = rows[rows.length - 1];
      decorate('card-segments', {
        insight: above === rows.length
          ? ['All ', B(String(rows.length)), ' segments are above budget.']
          : [B(`${above} of ${rows.length}`), ' segments are above budget; ', B(worst.label), ` is furthest below (${C.signedPct(worst.variance_pct)}).`],
        ask: `Why are some customer segments above budget and others below for ${ytd}?`,
      });
    });

    safe('EBIT vs budget', () => {
      const e = c.ebit_trend;
      const byKey = Object.fromEntries(e.series.map((sr) => [sr.key, { ...sr, color: SERIES_COLOR[sr.key] }]));
      lineLegend(part('card-ebit', '[data-legend]'), [byKey.actual, byKey.budget]);
      const act = byKey.actual.values;
      const bud = byKey.budget.values;
      C.lines(part('card-ebit', '[data-chart]'), {
        labels: e.labels, series: [byKey.budget, byKey.actual], labelSeries: 1, height: 250, animate,
        ask: (i) => (act[i] != null && bud[i] != null
          ? `Why was EBIT in ${monthName(e.months[i])} ${act[i] >= bud[i] ? 'above' : 'below'} budget?`
          : `Explain EBIT in ${monthName(e.months[i])}.`),
      });
      C.table(part('card-ebit', '.chart-table'), ['Month', 'EBIT actual', 'EBIT budget', 'Variance'],
        e.months.map((m, i) => [e.labels[i] + ' ' + m.slice(0, 4), C.eur(act[i]), C.eur(bud[i]),
          bud[i] == null ? 'n/a' : C.signed(act[i] - bud[i], C.eur)]));
      const idx = e.months.map((m, i) => i).filter((i) => act[i] != null && bud[i] != null);
      const beat = idx.filter((i) => act[i] >= bud[i]).length;
      const last = idx[idx.length - 1];
      if (!idx.length) { decorate('card-ebit', { insight: null, ask: 'Explain EBIT over the last 12 months.' }); return; }
      decorate('card-ebit', {
        insight: ['EBIT beat budget in ', B(`${beat} of ${idx.length === e.months.length ? `the last ${idx.length}` : `${idx.length} budgeted`}`), ' months; ',
          `${monthName(e.months[last])} was `, B(C.signed(act[last] - bud[last], C.eur)), ' against budget.'],
        ask: 'Explain EBIT against budget over the last 12 months. Which months missed budget, and why?',
      });
    });

    safe('EBIT bridge', () => {
      const br = c.ebit_bridge;
      if (!br) return;
      const tone = (v) => (v >= 0 ? 'var(--fav)' : 'var(--adv)');
      const stepAsk = (s) => {
        if (s.key === 'revenue') return `Which customer segments drove the revenue variance to budget for ${ytd}?`;
        if (s.type === 'expense') return `Why are ${s.label} costs ${s.actual > s.budget ? 'over' : 'under'} budget for ${ytd}?`;
        return null;
      };
      C.waterfall(part('card-bridge', '[data-chart]'), {
        colors: { up: 'var(--fav)', down: 'var(--adv)', total: 'var(--total)' }, height: 250, animate,
        start: {
          label: ['Budget', 'EBIT'], value: br.budget,
          tip: () => [C.ttTitle(`EBIT budget · ${ytd}`), C.ttRow('var(--total)', C.eur(br.budget), 'budget')],
          ask: `How is the EBIT budget for ${ytd} built up?`,
        },
        steps: br.steps.map((s) => ({
          label: s.label, value: s.effect, ask: stepAsk(s),
          tip: () => [C.ttTitle(`${s.label} · ${ytd}`), C.ttRow(tone(s.effect), C.signed(s.effect, C.eur), s.effect >= 0 ? 'raises EBIT vs budget' : 'lowers EBIT vs budget'),
            s.actual == null ? null : C.ttNote(`Actual ${C.eur(s.actual)} · budget ${C.eur(s.budget)} (${C.signedPct(s.change_pct)})`)],
        })),
        end: {
          label: ['Actual', 'EBIT'], value: br.actual,
          tip: () => [C.ttTitle(`EBIT actual · ${ytd}`), C.ttRow('var(--total)', C.eur(br.actual), 'actual'), C.ttNote(`${C.signed(br.variance, C.eur)} (${C.signedPct(br.variance_pct)}) vs budget`)],
          ask: `Explain actual EBIT for ${ytd} against budget: what drove the difference?`,
        },
      });
      part('card-bridge', '[data-sub]').textContent = `${ytd} · effect of each line on EBIT`;
      C.table(part('card-bridge', '.chart-table'), ['Line', 'Actual', 'Budget', 'Effect on EBIT'], [
        ['EBIT budget', '', eur2(br.budget), ''],
        ...br.steps.map((s) => [s.label, eur2(s.actual), eur2(s.budget), signed2(s.effect)]),
        ['EBIT actual', eur2(br.actual), '', signed2(br.variance)],
      ]);
      const byEffect = [...br.steps].sort((a, b) => b.effect - a.effect);
      const lift = byEffect[0];
      const drag = byEffect[byEffect.length - 1];
      const insight = ['EBIT is ', B(`${C.eur(Math.abs(br.variance))} ${br.variance >= 0 ? 'above' : 'below'}`), ` budget (${C.signedPct(br.variance_pct)}). `];
      if (lift.effect > 0) insight.push('Biggest lift: ', B(`${lift.label} ${C.signed(lift.effect, C.eur)}`));
      if (drag.effect < 0) insight.push(lift.effect > 0 ? '; biggest drag: ' : 'Biggest drag: ', B(`${drag.label} ${C.signed(drag.effect, C.eur)}`));
      insight.push('.');
      decorate('card-bridge', { insight, ask: `Explain the EBIT variance to budget for ${ytd}, line by line.` });
    });

    safe('cost mix', () => {
      const items = c.cost_mix.items.map((x) => ({
        ...x,
        ask: x.parts
          ? `Which accounts make up the other operating costs (${x.parts.join(', ')}) for ${ytd}?`
          : `Which accounts make up ${x.label} costs for ${ytd}, and how do they compare with last year?`,
      }));
      const colors = slotColors(items, COST_SLOT);
      const d = C.donut(part('card-cost-mix', '[data-chart]'), { items, colors, centerLabel: 'costs YTD', animate });
      C.donutLegend(part('card-cost-mix', '[data-legend]'), items, colors, d.total, { onHover: d.highlight });
      part('card-cost-mix', '[data-sub]').textContent = `${ytd} · operating costs by type`;
      C.table(part('card-cost-mix', '.chart-table'), ['Cost type', 'Amount', 'Share'], items.map((x) => [x.parts ? `${x.label} (${x.parts.join(', ')})` : x.label, C.eur(x.value), pctOf(x.value, d.total)]));
      const [first, second] = [...items].sort((a, b) => b.value - a.value);
      decorate('card-cost-mix', {
        insight: [B(first.label), ' is ', B(pctOf(first.value, d.total)), ' of operating costs; ', B(second.label), ` another ${pctOf(second.value, d.total)}.`],
        ask: `Break down operating costs by type for ${ytd} and compare them with last year.`,
      });
    });

    safe('cost movers', () => {
      const rows = c.cost_movers.items;
      const cmp = c.cost_movers.comparison;
      C.diverging(part('card-cost-movers', '[data-chart]'), {
        colors: { good: 'var(--fav)', bad: 'var(--adv)' },
        animate,
        items: rows.map((mv) => ({
          label: mv.label, value: mv.change, valueText: C.signed(mv.change), good: mv.change < 0,
          tip: () => [C.ttTitle(mv.account), C.ttRow(mv.change < 0 ? 'var(--fav)' : 'var(--adv)', `${C.signed(mv.change, C.eur)}${mv.change_pct == null ? '' : ` (${C.signedPct(mv.change_pct)})`}`, 'vs last year'),
            C.ttNote(`${ytd}: ${C.eur(mv.actual)} · ${cmp}: ${C.eur(mv.prior)}`)],
          ask: `Why did ${mv.account} change by ${C.signed(mv.change, C.eur)} in ${ytd} compared with ${cmp}?`,
        })),
      });
      part('card-cost-movers', '[data-sub]').textContent = `${ytd} vs ${cmp}, largest changes by account`;
      C.table(part('card-cost-movers', '.chart-table'), ['Account', 'This year', 'Last year', 'Change', 'Change %'],
        rows.map((mv) => [mv.label, C.eur(mv.actual), C.eur(mv.prior), C.signed(mv.change, C.eur), C.signedPct(mv.change_pct)]));
      const sorted = [...rows].sort((a, b) => b.change - a.change);
      const up = sorted[0];
      const down = sorted[sorted.length - 1];
      const insight = [];
      if (up && up.change > 0) insight.push(B(up.label), ' rose the most (', B(C.signed(up.change, C.eur)), ')');
      if (down && down.change < 0) insight.push(insight.length ? '; ' : '', B(down.label), ' fell the most (', B(C.signed(down.change, C.eur)), ')');
      if (insight.length) insight.push('.');
      decorate('card-cost-movers', { insight: insight.length ? insight : null, ask: `Which costs changed the most in ${ytd} compared with ${cmp}, and why?` });
    });

    safe('balance-sheet movements', () => {
      if (!c.balance_moves) return;
      const bm = c.balance_moves;
      const sideName = { asset: 'Asset', liability: 'Liability', equity: 'Equity' };
      C.diverging(part('card-bs-moves', '[data-chart]'), {
        animate,
        items: bm.items.map((mv) => ({
          label: mv.label, value: mv.movement, valueText: C.signed(mv.movement), color: mv.side === 'asset' ? 'var(--cat-1)' : 'var(--cat-3)',
          tip: () => [C.ttTitle(mv.account), C.ttRow(mv.side === 'asset' ? 'var(--cat-1)' : 'var(--cat-3)', C.signed(mv.movement, C.eur), `${sideName[mv.side] || mv.side} · ${mv.group}`),
            C.ttNote(`${C.eur(mv.opening)} → ${C.eur(mv.closing)}${mv.movement_pct == null ? '' : ` (${C.signedPct(mv.movement_pct)})`}`)],
          ask: `Why did ${mv.account} move by ${C.signed(mv.movement, C.eur)} between the ${bm.since} and the ${bm.as_of}?`,
        })),
      });
      part('card-bs-moves', '[data-sub]').textContent = `From the ${bm.since} to the ${bm.as_of} · movements of €${Math.round(bm.materiality / 1000)}k or more`;
      C.table(part('card-bs-moves', '.chart-table'), ['Account', 'Side', 'Opening', 'Closing', 'Movement'],
        bm.items.map((mv) => [mv.label, sideName[mv.side] || mv.side, C.eur(mv.opening), C.eur(mv.closing), C.signed(mv.movement, C.eur)]));
      const top = [...bm.items].sort((a, b) => Math.abs(b.movement) - Math.abs(a.movement))[0];
      decorate('card-bs-moves', {
        insight: top ? [B(top.label), ' moved the most: ', B(C.signed(top.movement, C.eur)), ` (${C.eur(top.opening)} → ${C.eur(top.closing)}).`] : null,
        ask: 'Explain the largest balance-sheet movements since the start of the financial year.',
      });
    });

    safe('asset mix', () => {
      if (!c.asset_mix) return;
      const am = c.asset_mix;
      const items = am.items.map((x) => ({ ...x, ask: `What is in ${x.label} at the ${am.as_of}, and how has it moved since the start of the year?` }));
      const d = C.donut(part('card-assets', '[data-chart]'), { items, colors: CAT, centerLabel: 'total assets', animate });
      C.donutLegend(part('card-assets', '[data-legend]'), items, CAT, d.total, { onHover: d.highlight });
      C.table(part('card-assets', '.chart-table'), ['Asset', 'Closing balance', 'Share'], items.map((x) => [x.label, C.eur(x.value), pctOf(x.value, d.total)]));
      const top = [...items].sort((a, b) => b.value - a.value)[0];
      decorate('card-assets', {
        insight: [B(top.label), ' is ', B(pctOf(top.value, d.total)), ` of total assets (${C.eurShort(d.total)}).`],
        ask: `What makes up total assets at the ${am.as_of}, and how has that changed since the start of the year?`,
      });
    });

    safe('invoicing', () => {
      if (!c.invoicing) return;
      const inv = c.invoicing;
      C.columns(part('card-invoicing', '[data-chart]'), {
        color: 'var(--forecast)', height: 240, animate,
        items: inv.items.map((it) => ({
          label: it.label, short: it.label.slice(0, 3), value: it.value,
          tip: () => [C.ttTitle(it.label), C.ttRow('var(--forecast)', C.eur(it.value), 'forecast invoicing'), C.ttNote(`${it.invoices} invoice${it.invoices === 1 ? '' : 's'}`)],
          ask: `Which invoices are in the invoicing forecast for ${it.label}?`,
        })),
      });
      const first = inv.items[0];
      const last = inv.items[inv.items.length - 1];
      part('card-invoicing', '[data-sub]').textContent = `${C.eur(inv.total)} expected, ${first.label} – ${last.label} · billing, not P&L revenue`;
      C.table(part('card-invoicing', '.chart-table'), ['Invoice month', 'Amount', 'Invoices'], inv.items.map((it) => [it.label, C.eur(it.value), String(it.invoices)]));
      const peak = inv.items.reduce((a, it) => (it.value > a.value ? it : a));
      decorate('card-invoicing', {
        insight: [B(peak.label), ' is the peak: ', B(C.eur(peak.value)), ` from ${peak.invoices} invoice${peak.invoices === 1 ? '' : 's'} (${pctOf(peak.value, inv.total)} of the forecast).`],
        ask: 'Summarise the invoicing forecast by month, and explain how it differs from P&L revenue.',
      });
    });

    safe('invoice sizes', () => {
      if (!c.invoice_sizes) return;
      const h = c.invoice_sizes;
      C.histogram(part('card-invoice-sizes', '[data-chart]'), {
        bins: h.bins, color: 'var(--forecast)', height: 240, animate,
        ask: (b) => `Which invoices in the invoicing forecast are between €${b.from / 1000}k and €${b.to / 1000}k?`,
      });
      part('card-invoice-sizes', '[data-sub]').textContent = `${h.invoices} invoices per €10k band · median ${C.eur(h.median)}`;
      C.table(part('card-invoice-sizes', '.chart-table'), ['Invoice size', 'Invoices', 'Total'],
        h.bins.map((b) => [`€${b.from / 1000}k – €${b.to / 1000}k`, String(b.count), C.eur(b.amount)]));
      decorate('card-invoice-sizes', {
        insight: ['Half the invoices are under ', B(C.eur(h.median)), '; the largest is ', B(C.eur(h.largest)), '.'],
        ask: 'Which are the largest invoices in the invoicing forecast, and are there any possible duplicates?',
      });
    });

    // Now that the cards beside it are drawn, let the revenue chart take its row's height.
    if (lastTrend) renderChart(lastTrend, animate);
  }

  // Every chart card has a Table view (the accessible twin of the chart).
  document.querySelectorAll('.chart-block .table-toggle').forEach((btn) => btn.addEventListener('click', () => {
    const t = btn.closest('.chart-block').querySelector('.chart-table');
    t.hidden = !t.hidden;
    btn.setAttribute('aria-expanded', String(!t.hidden));
    btn.classList.toggle('active', !t.hidden);
    btn.lastChild.textContent = t.hidden ? 'Table' : 'Hide';
  }));

  function renderChartTable(points) {
    $('chart-table').replaceChildren(el('table', { class: 'mini' },
      el('thead', {}, el('tr', {}, ['Month', 'Actual', 'Budget', 'Var %'].map((h) => el('th', { text: h })))),
      el('tbody', {}, points.map((p) => el('tr', {},
        el('td', { text: p.label }), el('td', { text: eur(p.actual) }), el('td', { text: eur(p.budget) }),
        el('td', { text: p.budget ? signedPct(((p.actual - p.budget) / p.budget) * 100) : 'n/a' }))))));
  }
  $('chart-table-toggle').addEventListener('click', (e) => {
    const t = $('chart-table');
    const b = e.currentTarget;
    t.hidden = !t.hidden;
    b.setAttribute('aria-expanded', String(!t.hidden));
    b.classList.toggle('active', !t.hidden);
    b.lastChild.textContent = t.hidden ? 'Table' : 'Hide';
  });

  function renderBalance(b) {
    const list = $('balance');
    if (!list) { $('bs-asof').textContent = b ? `As at ${b.as_of}` : 'No trial balance loaded'; return; }
    list.replaceChildren();
    if (!b) { list.append(el('div', { class: 'side-note', text: 'No trial balance loaded.' })); return; }
    $('bs-asof').textContent = `As at ${b.as_of}, vs start of year`;
    const rows = [
      ['Wallet', 'Cash and bank', b.cash],
      ['Clock', 'Deferred income', b.deferred_income],
      ['Building2', 'Receivable from Shanwick B.V.', b.group_receivable],
    ];
    rows.filter((r) => r[2]).forEach(([ic, name, v], i) => {
      const change = v.closing - v.opening;
      const value = el('div', { class: 'bs-value', title: eur(v.closing) });
      countUp(value, v.closing, eurShort, { delay: 500 + i * 90, duration: 1200 });
      list.append(el('div', { class: 'bs-row', style: `--d:${420 + i * 80}ms` },
        el('div', { class: 'bs-icon' }, icon(ic)),
        el('div', { class: 'bs-name' }, name, el('span', { class: 'bs-change', text: `${change >= 0 ? '+' : '−'}${eurShort(Math.abs(change))} since 1 Apr` })),
        value));
    });
  }

  let healthFilter = 'important';
  function renderHealth(issues) {
    const c = issues.counts;
    const high = c.high || 0;
    const medium = c.medium || 0;
    $('health-summary').replaceChildren(
      el('div', { class: `health-icon ${high ? '' : 'ok'}` }, icon(high ? 'ShieldCheck' : 'CircleCheck')),
      el('div', {},
        el('div', { class: 'health-title', text: `${issues.total} findings across your files` }),
        el('div', { class: 'health-counts' }, ['high', 'medium', 'low', 'info'].filter((s) => c[s]).map((s) =>
          el('span', { class: `sev ${s}` }, icon(SEV_ICON[s]), `${c[s]} ${s}`)))));

    const badge = $('health-badge');
    badge.hidden = !high;
    badge.textContent = high;
    for (const id of ['health-chip', 'home-health-chip']) {
      const hc = $(id);
      hc.hidden = !(high || medium);
      hc.replaceChildren(el('span', { class: `sev-dot ${high ? 'high' : 'medium'}` }), el('span', { text: `${high ? `${high} high` : ''}${high && medium ? ' · ' : ''}${medium ? `${medium} medium` : ''} data findings` }));
    }

    const list = issues.list.filter((i) => healthFilter === 'all' || i.severity === 'high' || i.severity === 'medium');
    $('findings').replaceChildren(...list.map((i, n) => el('li', {}, el('button', {
      class: 'finding spot',
      type: 'button',
      style: `--d:${Math.min(n, 12) * 45}ms`,
      onclick: () => openAi(`Explain data-quality finding ${i.id} ("${i.title}"): what is wrong, which reported figures it affects, and what should be done about it.`),
    },
    el('div', { class: 'finding-top' },
      el('span', { class: `sev ${i.severity}` }, icon(SEV_ICON[i.severity]), i.severity),
      el('span', { class: 'finding-area', text: i.area })),
    el('div', { class: 'finding-title', text: i.title }),
    el('span', { class: 'finding-ask' }, icon('Sparkles'), 'Ask Reflex AI')))));
  }
  document.querySelectorAll('#health-filter .chip-btn').forEach((b) => b.addEventListener('click', () => {
    healthFilter = b.dataset.filter;
    document.querySelectorAll('#health-filter .chip-btn').forEach((x) => x.classList.toggle('active', x === b));
    if (overviewData) renderHealth(overviewData.issues);
  }));
  $('health-chip').addEventListener('click', openChecks);
  $('home-health-chip').addEventListener('click', openChecks);

  function renderSources(o) {
    $('sources').replaceChildren(...o.sources.map((s, i) => el('li', { class: 'source', style: `--d:${i * 60}ms` },
      el('div', { class: 'source-icon' }, icon('FileSpreadsheet')),
      el('div', {},
        el('div', { class: 'source-label', text: s.label }),
        el('div', { class: 'source-file', text: s.file.split('/').pop() }),
        el('div', { class: 'source-role', text: `${s.role}${s.role ? ' · ' : ''}modified ${new Date(s.modified).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` })))));
    $('loaded-at').textContent = `Last loaded ${new Date(o.loaded_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  }

  $('reload').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.firstChild.classList.add('spin');
    try {
      const r = await fetch('/api/reload', { method: 'POST' });
      if (!r.ok) throw new Error((await r.json()).error);
      await loadOverview();
      toast('Data reloaded from the Data folder');
    } catch (err) {
      toast(`Reload failed: ${err.message}`, 'TriangleAlert');
    } finally {
      b.disabled = false;
      b.firstChild.classList.remove('spin');
    }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastTrend) renderChart(lastTrend, false);
      if (lastCharts && currentView === 'home') renderDashboard(lastCharts, false);
      realignIndicators();
    }, 120);
  });

  // ------------------------------------------------------------------ hero
  function renderGreeting() {
    const hour = new Date().getHours();
    const text = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
    const g = $('greeting');
    g.replaceChildren(...text.split(' ').map((w, i, arr) => el('span', { class: 'word', style: `--d:${120 + i * 110}ms`, text: i < arr.length - 1 ? `${w} ` : w })));
    g.setAttribute('aria-label', text);
  }
  function renderPrompts() {
    $('prompts').replaceChildren(...PROMPTS.map((p, i) => el('button', {
      class: 'prompt spot', type: 'button', style: `animation-delay:${420 + i * 45}ms`, onclick: () => ask(p.q),
    }, el('div', { class: 'prompt-icon' }, icon(p.icon)), el('div', {}, el('div', { class: 'prompt-cat', text: p.cat }), el('div', { class: 'prompt-q', text: p.q })))));
  }
  renderGreeting();
  renderPrompts();

  // Dashboard: greeting, "Ask Reflex AI" bar and quick questions that open the chat.
  {
    const hour = new Date().getHours();
    $('dash-greeting').textContent = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const quick = [PROMPTS[0], PROMPTS[2], PROMPTS[4], PROMPTS[9]];
    $('dash-chips').replaceChildren(...quick.map((p) => el('button', { class: 'dash-chip', type: 'button', onclick: () => openAi(p.q) }, icon(p.icon), p.cat)));
    $('dash-ask').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('dash-ask-input').value.trim();
      if (!q) { openAi(); return; }
      $('dash-ask-input').value = '';
      openAi(q);
    });
  }

  // Typewriter placeholder cycling through example questions while the box is empty.
  const input = $('input');
  (function typewriter() {
    if (reduced()) return;
    let idx = 0;
    let pos = PLACEHOLDERS[0].length;
    let deleting = false;
    const loop = () => {
      const active = !input.value && document.activeElement !== input && !document.hidden;
      let delay = 60;
      if (active) {
        const target = PLACEHOLDERS[idx];
        if (!deleting && pos >= target.length) { deleting = true; delay = 2600; }
        else if (deleting && pos <= 0) { deleting = false; idx = (idx + 1) % PLACEHOLDERS.length; delay = 350; }
        else { pos += deleting ? -1 : 1; delay = deleting ? 16 : 38; }
        input.placeholder = PLACEHOLDERS[idx].slice(0, Math.max(0, pos)) || '​';
      } else {
        input.placeholder = PLACEHOLDERS[0];
        idx = 0; pos = PLACEHOLDERS[0].length; deleting = false; delay = 800;
      }
      setTimeout(loop, delay);
    };
    setTimeout(loop, 2400);
  }());

  // ------------------------------------------------------------------ chat
  const history = [];
  let busy = false;
  let controller = null;
  const thread = $('thread');

  const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
  const scrollDown = (force) => { if (force || nearBottom()) thread.scrollTop = thread.scrollHeight; };

  function renderMarkdown(target, md, { streaming = false, final = false } = {}) {
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      // Markdown/sanitiser scripts failed to load: show the text as-is (textContent is always safe).
      target.replaceChildren(...md.split(/\n{2,}/).map((para) => el('p', { style: 'white-space:pre-wrap', text: para })));
      if (!renderMarkdown.warned) { renderMarkdown.warned = true; console.error('Markdown libraries not loaded (/vendor/marked.js, /vendor/purify.js); showing plain text.'); }
      return;
    }
    target.innerHTML = DOMPurify.sanitize(marked.parse(md, { gfm: true, breaks: false }));
    for (const t of target.querySelectorAll('table')) {
      const wrap = el('div', { class: 'table-wrap' });
      t.replaceWith(wrap);
      wrap.append(t);
      const rows = [...t.rows];
      if (!rows.length) continue;
      for (let c = 1; c < rows[0].cells.length; c++) {
        const body = rows.slice(1).map((r) => (r.cells[c] ? r.cells[c].textContent.trim() : ''));
        if (body.length && body.every((s) => !s || /^[-−+]?\s?[€$£]?\s?[-−+]?[\d.,]+\s?(%|pp|[kKmM])?$|^n\/a$|^[–—-]$/.test(s))) {
          for (const r of rows) if (r.cells[c]) r.cells[c].classList.add('num');
        }
      }
      for (const r of rows.slice(1)) {
        const first = r.cells[0] ? r.cells[0].textContent.trim() : '';
        if (/^(\*\*)?(total|net income|net result|ebit$)/i.test(first)) r.classList.add('total');
        for (const cell of r.cells) {
          const txt = cell.textContent.trim();
          const m = txt.match(/^(favou?rable|adverse)$/i);
          if (m) cell.replaceChildren(el('span', { class: `pill ${/^fav/i.test(m[1]) ? 'fav' : 'adv'}`, text: txt }));
        }
      }
    }
    // Trailing "Source: …" line becomes a quiet footer chip.
    const paras = target.querySelectorAll(':scope > p');
    const last = paras[paras.length - 1];
    if (last && /^source[s]?:/i.test(last.textContent.trim()) && last === target.lastElementChild) {
      last.replaceWith(el('div', { class: `answer-source${final ? ' appear' : ''}` }, icon('FileText'), el('span', { text: last.textContent.trim().replace(/^sources?:\s*/i, 'Source: ') })));
    }
    // Blinking caret at the end of the text while it streams in.
    if (streaming) {
      const blocks = target.querySelectorAll('p, li, h1, h2, h3, h4, td, th, blockquote');
      (blocks[blocks.length - 1] || target).append(el('span', { class: 'caret', 'aria-hidden': 'true' }));
    }
  }

  // Verification panel: one line per layer (figures, items/months/directions, independent review).
  function renderVerification(v) {
    const layers = v.layers || [];
    const issues = layers.flatMap((l) => (l.ok ? [] : l.issues.map((t) => `${l.label}: ${t}`)));
    const passed = layers.filter((l) => l.ok && !l.skipped).length;
    const head = v.ok
      ? `Verified in ${passed} layer${passed === 1 ? '' : 's'}${v.corrected ? ' · corrected automatically before display' : ''}`
      : 'Verification found problems · check before using this answer';
    return el('div', { class: `verify ${v.ok ? 'ok' : 'warn'}` },
      el('div', { class: 'verify-head' }, icon(v.ok ? 'ShieldCheck' : 'TriangleAlert'), el('span', { text: head })),
      el('div', { class: 'verify-layers' }, layers.map((l, i) => el('span', {
        class: `vl ${l.skipped ? (l.ok ? 'skip' : 'warn') : l.ok ? 'ok' : 'warn'}`, title: l.detail,
      }, icon(l.skipped ? (l.ok ? 'Minus' : 'TriangleAlert') : l.ok ? 'Check' : 'TriangleAlert'), el('b', { text: `${i + 1}` }), ` ${l.label}`))),
      el('div', { class: 'verify-detail' }, layers.map((l, i) => el('div', { text: `${i + 1}. ${l.label}: ${l.detail}` }))),
      issues.length ? el('ul', { class: 'verify-issues' }, issues.map((t) => el('li', { text: t }))) : null);
  }

  function srcChip(s) {
    // "Data/…/File.xlsx › sheet "P&L WACD" (…)" -> "File.xlsx · P&L WACD"
    const [path, rest = ''] = s.split(' › ');
    const file = path.split('/').pop();
    const sheet = (rest.match(/"([^"]+)"/) || [])[1];
    return el('span', { class: 'src-chip', title: s }, icon('FileSpreadsheet'), el('span', { text: sheet ? `${file} · ${sheet}` : file }));
  }

  function argsText(a) {
    const parts = [];
    const mon = (k) => {
      if (!k) return null;
      const [yy, mm] = k.split('-');
      return new Date(Date.UTC(+yy, +mm - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    };
    if (a.from || a.to) parts.push(`${mon(a.from) || 'FY start'} → ${mon(a.to) || 'latest'}`);
    if (a.compare_with && a.compare_with !== 'none') parts.push(`vs ${a.compare_with.replace(/_/g, ' ')}`);
    if (a.level && a.level !== 'mbr') parts.push(`${a.level} level`);
    if (a.lines) parts.push(a.lines.join(', '));
    if (a.granularity && a.granularity !== 'month') parts.push(a.granularity.replace(/_/g, ' '));
    if (a.group_by) parts.push(`by ${a.group_by.replace(/_/g, ' ')}`);
    if (a.type && a.type !== 'all') parts.push(a.type);
    if (a.direction && a.direction !== 'any') parts.push(a.direction);
    if (a.search) parts.push(`“${a.search}”`);
    if (a.only_flagged) parts.push('flagged only');
    if (a.fiscal_year) parts.push(a.fiscal_year);
    if (a.severity) parts.push(a.severity);
    if (a.include_recognition) parts.push('with recognition estimate');
    return parts.join(' · ');
  }

  function addUser(text) {
    $('hero').hidden = true;
    $('main').classList.add('chatting');
    const node = el('div', { class: 'msg user' }, el('div', { class: 'bubble', text }));
    $('messages').append(node);
    scrollDown(true);
    return node;
  }

  // ------------------------------------------------------------------ server connection
  // Shown in the sidebar footer. When a request can't reach the server (stopped, or restarting under
  // `npm run dev`), poll /api/health until it answers again.
  let online = true;
  let healthTimer = null;
  function setOnline(value) {
    if (online === value) return;
    online = value;
    document.querySelector('.status-dot').classList.toggle('offline', !value);
    const note = $('model-note');
    note.parentElement.classList.toggle('offline', !value);
    note.textContent = value ? `Online · ${overviewData ? overviewData.model : 'AI analyst'}` : 'Offline · retrying…';
    if (value) {
      clearInterval(healthTimer);
      healthTimer = null;
      toast('Reconnected to the server', 'CircleCheck');
      if (!overviewData) loadOverview().catch(() => {});
    } else if (!healthTimer) {
      healthTimer = setInterval(async () => {
        try {
          const r = await fetch('/api/health', { cache: 'no-store' });
          if (r.ok) setOnline(true);
        } catch (e) { /* still down */ }
      }, 3000);
    }
  }

  function addAssistant() {
    const thinkingText = el('span', { class: 'thinking-text', text: 'Reading the question…' });
    const thinking = el('div', { class: 'thinking' }, el('span', { class: 'dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')), thinkingText);
    const answer = el('div', { class: 'answer' });
    const workTitle = el('span', {}, el('b', { text: 'Working' }));
    const steps = el('ul', { class: 'steps' });
    const work = el('div', { class: 'work open', hidden: true },
      el('button', { class: 'work-head', type: 'button', 'aria-expanded': 'true', onclick: (e) => {
        work.classList.toggle('open');
        e.currentTarget.setAttribute('aria-expanded', String(work.classList.contains('open')));
      } }, icon('Workflow'), workTitle, icon('ChevronDown', 'chev')),
      el('div', { class: 'work-collapse' }, el('div', { class: 'work-inner' }, steps)));
    const actions = el('div', { class: 'msg-actions', hidden: true });
    const avatar = el('div', { class: 'avatar working' }, icon('Sparkles'));
    const body = el('div', { class: 'msg-body' },
      el('div', { class: 'msg-meta' }, el('span', { class: 'msg-name', text: 'Reflex AI' }), el('span', { class: 'msg-time', text: nowTime() })),
      thinking, work, answer, actions);
    const node = el('div', { class: 'msg assistant' }, avatar, body);
    $('messages').append(node);
    scrollDown(true);
    return { node, avatar, thinking, thinkingText, answer, work, workTitle, steps, actions };
  }

  async function ask(question) {
    question = (question || '').trim();
    if (!question || busy) return;
    busy = true;
    setComposer(true);
    if (!history.length) $('chat-title').textContent = question.length > 60 ? `${question.slice(0, 57)}…` : question;
    const userNode = addUser(question);
    history.push({ role: 'user', content: question });
    const ui = addAssistant();
    let md = '';
    let failed = false;
    let aborted = false;
    let connected = false;
    let verification = null;
    // Error with a Retry button that removes this failed exchange and asks again.
    const showError = (message) => {
      failed = true;
      ui.thinking.hidden = true;
      ui.answer.append(el('div', { class: 'error-box' }, icon('TriangleAlert'), el('span', { text: message }),
        el('button', { class: 'act retry', type: 'button', onclick: () => {
          if (busy) return;
          userNode.remove();
          ui.node.remove();
          ask(question);
        } }, icon('RefreshCw'), 'Retry')));
    };
    let raf = 0;
    const paint = () => {
      raf = 0;
      const stick = nearBottom();
      try { renderMarkdown(ui.answer, md, { streaming: true }); } catch (err) { console.error(err); }
      if (stick) scrollDown(true);
    };
    const stepItems = {};
    const sources = new Set();
    let stepCount = 0;

    controller = new AbortController();
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: controller.signal,
      });
      connected = true;
      setOnline(true);
      if (!res.ok || !res.body) {
        let msg = `Server error ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch (e) { /* not JSON */ }
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!line.startsWith('data:')) continue;
          const ev = JSON.parse(line.slice(5));
          if (ev.type === 'delta') {
            if (!md) {
              ui.thinking.hidden = true;
              if (stepCount) ui.work.classList.remove('open');
            }
            md += ev.text;
            if (!raf) raf = requestAnimationFrame(paint);
          } else if (ev.type === 'discard') {
            md = '';
            ui.answer.replaceChildren();
            ui.thinking.hidden = false;
          } else if (ev.type === 'tool_start') {
            stepCount++;
            const meta = TOOLS[ev.name] || { label: ev.name, icon: 'Database' };
            ui.work.hidden = false;
            ui.work.classList.add('open');
            ui.workTitle.replaceChildren(el('b', { text: 'Working' }), ` · ${stepCount} step${stepCount > 1 ? 's' : ''}`);
            ui.thinkingText.textContent = `Running ${meta.label.toLowerCase()}…`;
            const li = el('li', { class: 'step running' },
              el('div', { class: 'step-icon' }, icon('LoaderCircle', 'spin')),
              el('div', {}, el('div', { class: 'step-name' }, meta.label, el('span', { class: 'step-args', text: argsText(ev.args || {}) }))));
            li.dataset.icon = meta.icon;
            stepItems[ev.id] = li;
            ui.steps.append(li);
            scrollDown();
          } else if (ev.type === 'tool_end') {
            const li = stepItems[ev.id];
            if (!li) continue;
            li.classList.replace('running', 'done');
            li.firstChild.replaceChildren(icon(ev.error ? 'TriangleAlert' : li.dataset.icon));
            const detail = li.lastChild;
            if ((ev.sources || []).length) detail.append(el('div', { class: 'step-src' }, ev.sources.map((s) => { sources.add(s.split(' › ')[0]); return srcChip(s); })));
            if (ev.error) detail.append(el('div', { class: 'step-warn' }, icon('TriangleAlert'), el('span', { text: ev.error })));
            for (const w of ev.warnings || []) detail.append(el('div', { class: 'step-warn' }, icon('Info'), el('span', { text: w })));
            ui.thinkingText.textContent = 'Composing the answer…';
          } else if (ev.type === 'status') {
            if (!md) { ui.thinking.hidden = false; ui.thinkingText.textContent = ev.text; }
          } else if (ev.type === 'verification') {
            verification = ev;
          } else if (ev.type === 'error') {
            showError(ev.message);
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        aborted = true;
        if (md) md += '\n\n_(stopped)_';
      } else if (e instanceof TypeError) {
        // Network-level failure: the server was down, restarting, or dropped the connection.
        setOnline(false);
        showError(connected
          ? 'The connection to the server was lost before the answer finished (the server may have restarted). Please retry.'
          : 'Couldn’t reach the analyst server. It may be restarting or stopped. Start it with npm start, then retry.');
      } else {
        showError(e.message);
      }
    } finally {
      if (raf) cancelAnimationFrame(raf);
      if (md) {
        try { renderMarkdown(ui.answer, md, { final: true }); } catch (err) {
          console.error(err);
          ui.answer.replaceChildren(el('p', { style: 'white-space:pre-wrap', text: md }));
        }
      }
      // Result of the three verification layers run on the server before the answer was shown.
      if (md && verification && verification.checked > 0) {
        const stick = nearBottom();
        ui.answer.append(renderVerification(verification));
        if (stick) requestAnimationFrame(() => scrollDown(true));
      }
      if (!md && !failed && !aborted) showError('The analyst returned no answer. Please retry.');
      ui.thinking.hidden = true;
      ui.avatar.classList.remove('working');
      if (stepCount) {
        ui.workTitle.replaceChildren('Analysed with ', el('b', { text: `${stepCount} step${stepCount > 1 ? 's' : ''}` }), ` · ${sources.size} source file${sources.size === 1 ? '' : 's'}`);
        if (md) ui.work.classList.remove('open');
      }
      if (md && !failed) {
        history.push({ role: 'assistant', content: md });
        const copyBtn = el('button', { class: 'act', type: 'button', onclick: async (ev) => {
          const btn = ev.currentTarget;
          try {
            await navigator.clipboard.writeText(md);
            btn.replaceChildren(icon('Check'), 'Copied');
            setTimeout(() => btn.replaceChildren(icon('Copy'), 'Copy'), 1600);
          } catch (err) { toast('Copy failed', 'TriangleAlert'); }
        } }, icon('Copy'), 'Copy');
        ui.actions.replaceChildren(copyBtn);
        ui.actions.classList.add('appear');
        ui.actions.hidden = false;
      } else {
        history.pop();
      }
      busy = false;
      controller = null;
      setComposer(false);
      scrollDown();
    }
  }

  function setComposer(running) {
    const b = $('send');
    b.classList.toggle('stop', running);
    b.type = running ? 'button' : 'submit';
    b.setAttribute('aria-label', running ? 'Stop' : 'Send');
    b.replaceChildren(icon(running ? 'Square' : 'ArrowUp'));
    updateSendState();
  }

  const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(200, input.scrollHeight)}px`; };
  const updateSendState = () => { $('send').disabled = !busy && !input.value.trim(); };
  input.addEventListener('input', () => { autosize(); updateSendState(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('send').addEventListener('click', (e) => {
    if (busy && controller) { e.preventDefault(); controller.abort(); }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value;
    input.value = '';
    autosize();
    updateSendState();
    ask(q);
  });
  updateSendState();

  $('newchat').addEventListener('click', () => {
    if (controller) controller.abort();
    history.length = 0;
    $('messages').replaceChildren();
    renderGreeting();
    renderPrompts();
    $('hero').hidden = false;
    $('main').classList.remove('chatting');
    $('chat-title').textContent = 'New analysis';
    thread.scrollTop = 0;
    input.focus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); }
  });

  showView(viewFromHash(), true);

  loadOverview().catch((e) => {
    $('ws-meta').textContent = 'Data failed to load';
    if (e instanceof TypeError) setOnline(false);
    else toast(`Could not load data: ${e.message}`, 'TriangleAlert');
  });
})();
