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

  // ------------------------------------------------------------------ sidebar: tabs & drawer
  const tabs = document.querySelector('.tabs');
  function selectTab(name, instant) {
    let active = null;
    tabs.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
      if (on) active = t;
    });
    document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    moveIndicator(tabs, active, instant);
  }
  tabs.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  selectTab('overview', true);

  const openDrawer = () => {
    $('sidebar').classList.add('open');
    $('scrim').hidden = false;
    requestAnimationFrame(() => { moveIndicator(tabs, tabs.querySelector('.tab.active'), true); moveIndicator(themeToggle, themeToggle.querySelector('[aria-checked="true"]'), true); });
  };
  const closeDrawer = () => { $('sidebar').classList.remove('open'); $('scrim').hidden = true; };
  $('open-sidebar').addEventListener('click', openDrawer);
  $('close-sidebar').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);

  // Indicator positions depend on font metrics and layout.
  const realignIndicators = () => {
    moveIndicator(tabs, tabs.querySelector('.tab.active'), true);
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
    $('ws-meta').textContent = `Client of Offspring · reporting in ${o.currency}`;
    $('fy-label').textContent = `${o.fiscal_year} · Year to date`;
    $('ytd-range').textContent = o.ytd_range;
    $('fy-count').textContent = `${o.fy_progress.months_elapsed} of ${o.fy_progress.months_total} months`;
    const meter = $('fy-meter');
    meter.style.width = '0%';
    requestAnimationFrame(() => requestAnimationFrame(() => { meter.style.width = `${(o.fy_progress.months_elapsed / o.fy_progress.months_total) * 100}%`; }));

    $('period-chip').replaceChildren(icon('CalendarDays'), el('span', { text: `${o.fiscal_year} · actuals to ${o.latest_month}` }));
    $('hero-pill-text').textContent = `Grounded in ${o.sources.length} source files · actuals to ${o.latest_month}`;
    $('composer-model').textContent = `${o.model} · ${o.sources.length} source files`;
    $('model-note').textContent = `Data loaded · ${o.model}`;

    renderKpis(o);
    renderChart(o.revenue_trend, true);
    renderChartTable(o.revenue_trend);
    renderBalance(o.balance);
    renderHealth(o.issues);
    renderSources(o);
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
    const H = 168;
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
        showTooltip(rows, ev, hit);
      };
      const hide = () => { g.classList.remove('active'); hideTooltip(); };
      hit.addEventListener('pointermove', show);
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('focus', show);
      hit.addEventListener('blur', hide);
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
    const hc = $('health-chip');
    hc.hidden = !(high || medium);
    hc.replaceChildren(el('span', { class: `sev-dot ${high ? 'high' : 'medium'}` }), el('span', { text: `${high ? `${high} high` : ''}${high && medium ? ' · ' : ''}${medium ? `${medium} medium` : ''} data findings` }));

    const list = issues.list.filter((i) => healthFilter === 'all' || i.severity === 'high' || i.severity === 'medium');
    $('findings').replaceChildren(...list.map((i, n) => el('li', {}, el('button', {
      class: 'finding spot',
      type: 'button',
      style: `--d:${Math.min(n, 12) * 45}ms`,
      onclick: () => { closeDrawer(); ask(`Explain data-quality finding ${i.id} ("${i.title}"): what is wrong, which reported figures it affects, and what should be done about it.`); },
    },
    el('div', { class: 'finding-top' },
      el('span', { class: `sev ${i.severity}` }, icon(SEV_ICON[i.severity]), i.severity),
      el('span', { class: 'finding-area', text: i.area })),
    el('div', { class: 'finding-title', text: i.title }),
    el('span', { class: 'finding-ask' }, icon('Sparkles'), 'Ask the analyst')))));
  }
  document.querySelectorAll('#health-filter .chip-btn').forEach((b) => b.addEventListener('click', () => {
    healthFilter = b.dataset.filter;
    document.querySelectorAll('#health-filter .chip-btn').forEach((x) => x.classList.toggle('active', x === b));
    if (overviewData) renderHealth(overviewData.issues);
  }));
  $('health-chip').addEventListener('click', () => { selectTab('health'); openDrawer(); });

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
    note.textContent = value ? `Data loaded · ${overviewData ? overviewData.model : 'AI analyst'}` : 'Server unreachable · retrying…';
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
      el('div', { class: 'msg-meta' }, el('span', { class: 'msg-name', text: 'WACD Analyst' }), el('span', { class: 'msg-time', text: nowTime() })),
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
      renderMarkdown(ui.answer, md, { streaming: true });
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
      if (md) renderMarkdown(ui.answer, md, { final: true });
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
    if (e.key === 'Escape') closeDrawer();
    if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); }
  });

  loadOverview().catch((e) => {
    $('ws-meta').textContent = 'Data failed to load';
    if (e instanceof TypeError) setOnline(false);
    else toast(`Could not load data: ${e.message}`, 'TriangleAlert');
  });
})();
