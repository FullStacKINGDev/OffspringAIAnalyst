// Small SVG chart kit for the Home dashboard: donut, lines, diverging bars, columns, histogram, waterfall.
// Any mark given an `ask` question opens Reflex AI with it on click (see setAsk).
// Conventions (dataviz guidance): thin marks, 4px rounded data-ends, 2px surface gaps, hairline grid,
// hover tooltips on every mark, text in ink colours (never the series colour), a table view for every chart.
window.Charts = (() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    return n;
  };
  const html = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') n.style.cssText = v;
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c);
    return n;
  };
  const text = (x, y, content, attrs = {}) => { const t = svg('text', { x, y, ...attrs }); t.textContent = content; return t; };

  const eur = (v) => (v == null ? 'n/a' : `${v < 0 ? '−' : ''}€${Math.round(Math.abs(v)).toLocaleString('en-GB')}`);
  const eurShort = (v) => {
    if (v == null) return 'n/a';
    const a = Math.abs(v);
    const s = v < 0 ? '−' : '';
    if (a >= 1e6) return `${s}€${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `${s}€${Math.round(a / 1e3)}k`;
    return `${s}€${Math.round(a)}`;
  };
  const signed = (v, f = eurShort) => (v == null ? 'n/a' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${f(Math.abs(v))}`);
  const signedPct = (v) => (v == null ? 'n/a' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`);
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- tooltip (shared #tooltip element) ----------
  const tipEl = () => document.getElementById('tooltip');
  function tip(children, ev, target) {
    const tt = tipEl();
    tt.replaceChildren(...children.filter(Boolean));
    tt.hidden = false;
    const r = (target || ev.currentTarget).getBoundingClientRect();
    const x = ev && ev.clientX ? ev.clientX : r.left + r.width / 2;
    const y = ev && ev.clientY ? ev.clientY : r.top;
    tt.style.left = `${Math.min(window.innerWidth - tt.offsetWidth - 10, Math.max(10, x + 14))}px`;
    tt.style.top = `${Math.max(10, y - tt.offsetHeight - 12)}px`;
  }
  const hideTip = () => { tipEl().hidden = true; };
  const ttTitle = (t) => html('div', { class: 'tt-title', text: t });
  const ttRow = (color, value, label) => html('div', { class: 'tt-row' },
    color ? html('span', { class: 'tt-key', style: `background:${color}` }) : null,
    html('strong', { text: value }), label ? html('span', { class: 'tt-lab', text: label }) : null);
  const ttNote = (t) => html('div', { class: 'tt-var', text: t });

  // ---------- click a mark to ask Reflex AI about it ----------
  // Mouse: one click asks. Touch: the first tap shows the value, a second tap on the same mark asks.
  let askHandler = null;
  let pointerKind = 'mouse';
  let armed = null;
  document.addEventListener('pointerdown', (ev) => { pointerKind = ev.pointerType || 'mouse'; }, true);
  const askHint = () => html('div', { class: 'tt-ask', text: pointerKind === 'touch' ? 'Tap again to ask Reflex AI' : 'Click to ask Reflex AI' });
  function runAsk(question) {
    hideTip();
    armed = null;
    const q = typeof question === 'function' ? question() : question;
    if (q && askHandler) askHandler(q);
  }
  // key identifies the mark (or the month under a crosshair) so a touch tap arms the right one.
  function tapOrAsk(key, question) {
    if (pointerKind === 'touch' && armed !== key) { armed = key; return; }
    runAsk(question);
  }
  function askable(el, question) {
    if (!question) return;
    el.classList.add('askable');
    el.addEventListener('click', () => tapOrAsk(el, question));
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); runAsk(question); } });
  }

  function hoverable(el, content, onEnter, onLeave, ask) {
    el.setAttribute('tabindex', '0');
    const show = (ev) => { if (onEnter) onEnter(); tip([...content(), ask ? askHint() : null], ev, el); };
    const hide = () => { if (onLeave) onLeave(); hideTip(); };
    el.addEventListener('pointermove', show);
    el.addEventListener('pointerleave', hide);
    el.addEventListener('focus', show);
    el.addEventListener('blur', hide);
    askable(el, ask);
  }

  // ---------- scales ----------
  function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw || 1));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function niceScale(min, max, ticks = 4) {
    if (max === min) max = min + 1;
    const step = niceStep((max - min) / ticks);
    return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step, step };
  }
  // Rounded data-end, square at the baseline (vertical bar growing up from y0).
  const colPath = (x, yTop, w, y0) => {
    const h = Math.max(0, y0 - yTop);
    const r = Math.min(4, h, w / 2);
    return `M${x},${y0} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${y0} Z`;
  };
  // Horizontal bar from x0 to x1 (x1 may be left of x0), rounded only at the data end.
  const rowPath = (x0, x1, y, h) => {
    const len = Math.abs(x1 - x0);
    const r = Math.min(4, len, h / 2);
    if (x1 >= x0) return `M${x0},${y} H${x1 - r} Q${x1},${y} ${x1},${y + r} V${y + h - r} Q${x1},${y + h} ${x1 - r},${y + h} H${x0} Z`;
    return `M${x0},${y} H${x1 + r} Q${x1},${y} ${x1},${y + r} V${y + h - r} Q${x1},${y + h} ${x1 + r},${y + h} H${x0} Z`;
  };
  function prep(host, animate) {
    host.replaceChildren();
    host.classList.add('chart');
    host.classList.toggle('animate', !!animate && !reduced());
    return Math.max(260, host.clientWidth || 320);
  }

  // ---------- donut (part-to-whole, <= 6 slices) ----------
  function donut(host, { items, colors, centerLabel, format = eurShort, animate }) {
    host.replaceChildren();
    const total = items.reduce((s, x) => s + x.value, 0);
    const size = 164;
    const stroke = 22;
    const r = (size - stroke) / 2 - 4;
    const c = 2 * Math.PI * r;
    const cx = size / 2;
    const root = svg('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'donut', role: 'img', 'aria-label': `${centerLabel}: ${items.map((x) => `${x.label} ${(100 * x.value / total).toFixed(1)}%`).join(', ')}` });
    root.append(svg('circle', { cx, cy: cx, r, fill: 'none', 'stroke-width': stroke, class: 'donut-track' }));
    const g = svg('g', { transform: `rotate(-90 ${cx} ${cx})` });
    const gap = items.length > 1 ? 2 : 0;
    let acc = 0;
    const segs = items.map((it, i) => {
      const len = (it.value / total) * c;
      const dash = Math.max(0.5, len - gap);
      const seg = svg('circle', {
        cx, cy: cx, r, fill: 'none', 'stroke-width': stroke, class: 'donut-seg',
        style: `stroke:${colors[i]}`, 'stroke-dasharray': `${dash} ${c - dash}`, 'stroke-dashoffset': -acc,
      });
      if (animate && !reduced()) {
        seg.animate([{ strokeDasharray: `0 ${c}` }, { strokeDasharray: `${dash} ${c - dash}` }], { duration: 750, delay: 150 + i * 90, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
      }
      acc += len;
      g.append(seg);
      return seg;
    });
    root.append(g);
    const center = svg('g', { class: 'donut-center' });
    center.append(text(cx, cx - 2, format(total), { 'text-anchor': 'middle', class: 'donut-total' }));
    center.append(text(cx, cx + 16, centerLabel, { 'text-anchor': 'middle', class: 'donut-label' }));
    root.append(center);
    const highlight = (i) => segs.forEach((s, k) => { s.classList.toggle('dim', i != null && k !== i); s.classList.toggle('hot', k === i); });
    segs.forEach((s, i) => hoverable(s, () => [ttTitle(items[i].label), ttRow(colors[i], eur(items[i].value), `${(100 * items[i].value / total).toFixed(1)}% of ${format(total)}`),
      items[i].parts ? ttNote(`Includes ${items[i].parts.join(', ')}`) : null], () => highlight(i), () => highlight(null), items[i].ask));
    host.append(root);
    return { highlight, total };
  }

  // Legend with values and shares: the direct labels for a donut (and the relief for low-contrast colours).
  function donutLegend(host, items, colors, total, { onHover } = {}) {
    host.replaceChildren(...items.map((it, i) => {
      const row = html('li', { class: 'lg-row', tabindex: '0' },
        html('span', { class: 'lg-key', style: `background:${colors[i]}` }),
        html('span', { class: 'lg-label', text: it.label, title: it.parts ? `Includes ${it.parts.join(', ')}` : it.label }),
        html('span', { class: 'lg-value', text: eurShort(it.value) }),
        html('span', { class: 'lg-pct', text: `${(100 * it.value / total).toFixed(1)}%` }));
      if (onHover) {
        row.addEventListener('pointerenter', () => onHover(i));
        row.addEventListener('pointerleave', () => onHover(null));
        row.addEventListener('focus', () => onHover(i));
        row.addEventListener('blur', () => onHover(null));
      }
      if (it.ask) {
        row.title = `${row.title || it.label} · click to ask Reflex AI`;
        askable(row, it.ask);
      }
      return row;
    }));
  }

  // ---------- lines (trend over time, one axis, several series) ----------
  // series: [{ name, color, values: [...], emphasis? }]; nulls break the line.
  // ask: (monthIndex) => question, optional; clicking the plot asks about the month under the crosshair.
  function lines(host, { labels, series, height = 230, format = eurShort, labelSeries = 0, animate, ask }) {
    const W = prep(host, animate);
    const H = height;
    const m = { top: 16, right: 58, bottom: 24, left: 46 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;
    const vals = series.flatMap((s) => s.values.filter((v) => v != null));
    const { lo, hi, step } = niceScale(Math.min(...vals) * 0.96, Math.max(...vals) * 1.02);
    const floor = Math.max(0, lo);
    const x = (i) => m.left + (labels.length === 1 ? iw / 2 : (i * iw) / (labels.length - 1));
    const y = (v) => m.top + ih - ((v - floor) / (hi - floor)) * ih;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    for (let v = floor; v <= hi + 1e-6; v += step) {
      root.append(svg('line', { class: v === floor ? 'baseline' : 'gridline', x1: m.left, x2: W - m.right + 8, y1: y(v), y2: y(v) }));
      root.append(text(m.left - 7, y(v) + 3.5, format(v), { class: 'tick', 'text-anchor': 'end' }));
    }
    const every = iw / labels.length < 34 ? 2 : 1;
    labels.forEach((l, i) => { if ((labels.length - 1 - i) % every === 0) root.append(text(x(i), H - 6, l, { class: 'tick', 'text-anchor': 'middle' })); });

    series.forEach((s, si) => {
      let d = '';
      let pen = false;
      s.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
        pen = true;
      });
      root.append(svg('path', { d, class: 'ln', pathLength: 1, fill: 'none', style: `stroke:${s.color};--d:${200 + si * 150}ms`, 'stroke-width': s.emphasis === false ? 1.75 : 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    });
    // End markers (8px, 2px surface ring) and one direct label on the series that is the story.
    series.forEach((s, si) => {
      const last = s.values.reduce((a, v, i) => (v != null ? i : a), -1);
      if (last < 0) return;
      root.append(svg('circle', { cx: x(last), cy: y(s.values[last]), r: 4, class: 'end-dot', style: `fill:${s.color}` }));
      if (si === labelSeries) root.append(text(x(last) + 8, y(s.values[last]) + 4, format(s.values[last]), { class: 'value-label' }));
    });
    // Crosshair: snaps to the nearest month and lists every series there.
    const cross = svg('line', { class: 'crosshair', y1: m.top, y2: m.top + ih, opacity: 0 });
    const dots = series.map((s) => svg('circle', { r: 4.5, class: 'cross-dot', style: `fill:${s.color}`, opacity: 0 }));
    root.append(cross, ...dots);
    const overlay = svg('rect', { x: m.left - 10, y: m.top, width: iw + 20, height: ih, fill: 'transparent', tabindex: 0, class: 'hit', 'aria-label': `${series.map((s) => s.name).join(', ')} by month` });
    const at = (i) => {
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 1);
      dots.forEach((dot, si) => {
        const v = series[si].values[i];
        dot.setAttribute('opacity', v == null ? 0 : 1);
        if (v != null) { dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(v)); }
      });
      return [ttTitle(labels[i]), ...series.filter((s) => s.values[i] != null).map((s) => ttRow(s.color, eur(s.values[i]), s.name)), ask ? askHint() : null];
    };
    let focusIdx = labels.length - 1;
    const indexAt = (ev) => {
      const r = overlay.getBoundingClientRect();
      const rel = ((ev.clientX - r.left) / r.width) * (iw + 20) - 10;
      return Math.max(0, Math.min(labels.length - 1, Math.round((rel / iw) * (labels.length - 1))));
    };
    overlay.addEventListener('pointermove', (ev) => tip(at(indexAt(ev)), ev, overlay));
    if (ask) {
      overlay.classList.add('askable');
      overlay.addEventListener('click', (ev) => {
        const i = indexAt(ev);
        if (pointerKind === 'touch') tip(at(i), ev, overlay);
        tapOrAsk(`${host.id || series[0].name}:${i}`, () => ask(i));
      });
    }
    const off = () => { cross.setAttribute('opacity', 0); dots.forEach((d) => d.setAttribute('opacity', 0)); hideTip(); };
    overlay.addEventListener('pointerleave', off);
    overlay.addEventListener('focus', () => tip(at(focusIdx), null, overlay));
    overlay.addEventListener('blur', off);
    overlay.addEventListener('keydown', (ev) => {
      if (ask && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); runAsk(() => ask(focusIdx)); return; }
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      focusIdx = Math.max(0, Math.min(labels.length - 1, focusIdx + (ev.key === 'ArrowRight' ? 1 : -1)));
      tip(at(focusIdx), null, overlay);
    });
    root.append(overlay);
    host.append(root);
  }

  // ---------- diverging horizontal bars (above / below a baseline) ----------
  // items: [{ label, value, valueText, good (bool) | color, tip: () => [nodes] }]
  // The zero line sits where zero falls in the data's own range, so one-sided data uses the full width.
  function diverging(host, { items, rowH = 32, colors = {}, animate }) {
    const W = prep(host, animate);
    const longest = Math.max(...items.map((it) => it.label.length));
    const labelW = Math.min(Math.round(W * 0.36), Math.max(72, Math.round(longest * 6.6) + 12));
    const valW = 58;
    const H = items.length * rowH + 8;
    const plotL = labelW + valW;
    const plotR = W - valW;
    const lo = Math.min(0, ...items.map((it) => it.value));
    const hi = Math.max(0, ...items.map((it) => it.value));
    const span = hi - lo || 1;
    const sx = (v) => plotL + ((v - lo) / span) * (plotR - plotL);
    const zero = sx(0);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    root.append(svg('line', { class: 'baseline', x1: zero, x2: zero, y1: 2, y2: H - 2 }));
    const maxChars = Math.floor((labelW - 8) / 6.6);
    items.forEach((it, i) => {
      const yMid = 4 + i * rowH + rowH / 2;
      const g = svg('g', { class: 'drow', style: `--d:${150 + i * 55}ms` });
      const label = it.label.length > maxChars ? `${it.label.slice(0, maxChars - 1)}…` : it.label;
      g.append(text(labelW - 4, yMid + 4, label, { class: 'row-label', 'text-anchor': 'end' }));
      const x1 = sx(it.value);
      const fill = it.color || (it.good ? colors.good : colors.bad);
      const bar = svg('path', { d: rowPath(zero, x1, yMid - 7, 14), class: 'hbar', style: `fill:${fill};transform-origin:${it.value >= 0 ? 'left' : 'right'} center` });
      g.append(bar);
      g.append(text(it.value >= 0 ? x1 + 6 : x1 - 6, yMid + 4, it.valueText, { class: 'value-label', 'text-anchor': it.value >= 0 ? 'start' : 'end' }));
      const hit = svg('rect', { x: 0, y: yMid - rowH / 2, width: W, height: rowH, fill: 'transparent', class: 'hit' });
      hoverable(hit, it.tip, () => g.classList.add('active'), () => g.classList.remove('active'), it.ask);
      g.append(hit);
      root.append(g);
    });
    host.append(root);
  }

  // ---------- columns (one series) ----------
  // items: [{ label, value, tip: () => [nodes] }]; the tallest column gets a direct label.
  function columns(host, { items, color, height = 220, format = eurShort, animate }) {
    const W = prep(host, animate);
    const H = height;
    const m = { top: 20, right: 4, bottom: 24, left: 46 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;
    const { hi, step } = niceScale(0, Math.max(...items.map((it) => it.value)));
    const y = (v) => m.top + ih - (v / hi) * ih;
    const slot = iw / items.length;
    const bw = Math.min(24, slot * 0.58);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    for (let v = 0; v <= hi + 1e-6; v += step) {
      root.append(svg('line', { class: v === 0 ? 'baseline' : 'gridline', x1: m.left, x2: W - m.right, y1: y(v), y2: y(v) }));
      root.append(text(m.left - 7, y(v) + 3.5, format(v), { class: 'tick', 'text-anchor': 'end' }));
    }
    const maxI = items.reduce((a, it, i) => (it.value > items[a].value ? i : a), 0);
    items.forEach((it, i) => {
      const cx = m.left + slot * i + slot / 2;
      const g = svg('g', { class: 'slot', style: `--d:${200 + i * 60}ms` });
      g.append(svg('path', { class: 'bar', d: colPath(cx - bw / 2, y(it.value), bw, y(0)), style: `fill:${color}` }));
      root.append(text(cx, H - 6, it.short || it.label, { class: 'tick', 'text-anchor': 'middle' }));
      if (i === maxI) g.append(text(cx, y(it.value) - 7, format(it.value), { class: 'value-label', 'text-anchor': 'middle' }));
      const hit = svg('rect', { class: 'hit', x: m.left + slot * i, y: m.top, width: slot, height: ih });
      hoverable(hit, it.tip, () => g.classList.add('active'), () => g.classList.remove('active'), it.ask);
      g.append(hit);
      root.append(g);
    });
    host.append(root);
  }

  // ---------- histogram (distribution: adjacent bins with a 2px surface gap) ----------
  // bins: [{ from, to, count, amount }]
  function histogram(host, { bins, color, height = 220, animate, ask }) {
    const W = prep(host, animate);
    const H = height;
    const m = { top: 20, right: 8, bottom: 24, left: 34 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;
    const { hi, step } = niceScale(0, Math.max(...bins.map((b) => b.count)), 4);
    const tickStep = Math.max(1, Math.round(step));
    const y = (v) => m.top + ih - (v / hi) * ih;
    const bw = iw / bins.length;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    for (let v = 0; v <= hi + 1e-6; v += tickStep) {
      root.append(svg('line', { class: v === 0 ? 'baseline' : 'gridline', x1: m.left, x2: W - m.right, y1: y(v), y2: y(v) }));
      root.append(text(m.left - 7, y(v) + 3.5, String(v), { class: 'tick', 'text-anchor': 'end' }));
    }
    const maxI = bins.reduce((a, b, i) => (b.count > bins[a].count ? i : a), 0);
    const edgeEvery = bins.length > 8 ? 2 : 1;
    bins.forEach((b, i) => {
      const x0 = m.left + i * bw;
      const g = svg('g', { class: 'slot', style: `--d:${200 + i * 45}ms` });
      if (b.count > 0) g.append(svg('path', { class: 'bar', d: colPath(x0 + 1, y(b.count), bw - 2, y(0)), style: `fill:${color}` }));
      if (i % edgeEvery === 0) root.append(text(x0, H - 6, `€${b.from / 1000}k`, { class: 'tick', 'text-anchor': i === 0 ? 'start' : 'middle' }));
      if (i === maxI) g.append(text(x0 + bw / 2, y(b.count) - 7, `${b.count}`, { class: 'value-label', 'text-anchor': 'middle' }));
      const hit = svg('rect', { class: 'hit', x: x0, y: m.top, width: bw, height: ih });
      hoverable(hit, () => [ttTitle(`€${(b.from / 1000).toLocaleString('en-GB')}k – €${(b.to / 1000).toLocaleString('en-GB')}k per invoice`),
        ttRow(color, `${b.count} invoice${b.count === 1 ? '' : 's'}`, ''), ttNote(`${eur(b.amount)} in total`)],
      () => g.classList.add('active'), () => g.classList.remove('active'), ask && b.count ? () => ask(b) : null);
      g.append(hit);
      root.append(g);
    });
    host.append(root);
  }

  // ---------- waterfall (bridge from one total to another) ----------
  // start/end: { label, value, tip, ask }; steps: [{ label, value (effect on the total), tip, ask }].
  // A label may be an array of two lines. Rises use colors.up, falls colors.down, totals colors.total.
  // When the steps are slivers next to the totals, the axis starts above zero and the total bars carry a break mark.
  function waterfall(host, { start, steps, end, colors, height = 250, format = eurShort, animate }) {
    const W = prep(host, animate);
    const H = height;
    const m = { top: 22, right: 4, bottom: 34, left: 48 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;
    let level = start.value;
    const bars = [{ ...start, kind: 'total', from: 0, to: start.value }];
    for (const s of steps) { bars.push({ ...s, kind: 'step', from: level, to: level + s.value }); level += s.value; }
    bars.push({ ...end, kind: 'total', from: 0, to: end.value });
    const levels = bars.flatMap((b) => (b.kind === 'total' ? [b.to] : [b.from, b.to]));
    const min = Math.min(...levels);
    const max = Math.max(...levels);
    const zoomFrom = min - (max - min) * 0.6;
    const zoom = zoomFrom > max * 0.3;
    const sc = niceScale(zoom ? zoomFrom : 0, max + (max - (zoom ? zoomFrom : 0)) * 0.04, 4);
    const floor = zoom ? sc.lo : 0;
    const y = (v) => m.top + ih - ((v - floor) / (sc.hi - floor)) * ih;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
      'aria-label': `${[].concat(start.label).join(' ')} ${eur(start.value)}, ${steps.map((s) => `${[].concat(s.label).join(' ')} ${signed(s.value, eur)}`).join(', ')}, ${[].concat(end.label).join(' ')} ${eur(end.value)}` });
    for (let v = floor; v <= sc.hi + 1e-6; v += sc.step) {
      root.append(svg('line', { class: v === 0 ? 'baseline' : 'gridline', x1: m.left, x2: W - m.right, y1: y(v), y2: y(v) }));
      root.append(text(m.left - 7, y(v) + 3.5, format(v), { class: 'tick', 'text-anchor': 'end' }));
    }
    const slot = iw / bars.length;
    const bw = Math.min(44, slot * 0.62);
    // Rounded at the data end only: the top for totals and rises, the bottom for falls.
    const barPath = (x, yTop, w, yBot, roundTop) => {
      const r = Math.min(4, yBot - yTop, w / 2);
      if (roundTop) return `M${x},${yBot} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${yBot} Z`;
      return `M${x},${yTop} V${yBot - r} Q${x},${yBot} ${x + r},${yBot} H${x + w - r} Q${x + w},${yBot} ${x + w},${yBot - r} V${yTop} Z`;
    };
    bars.forEach((b, i) => {
      const cx = m.left + slot * i + slot / 2;
      const x0 = cx - bw / 2;
      const g = svg('g', { class: 'slot', style: `--d:${200 + i * 80}ms` });
      const rise = b.kind === 'total' || b.value >= 0;
      const color = b.kind === 'total' ? colors.total : b.value >= 0 ? colors.up : colors.down;
      const yTop = y(Math.max(b.from, b.to));
      const yBot = Math.max(yTop + 1.5, b.kind === 'total' ? y(floor) : y(Math.min(b.from, b.to)));
      g.append(svg('path', { class: 'bar', d: barPath(x0, yTop, bw, yBot, rise), style: `fill:${color}${rise ? '' : ';transform-origin:50% 0%'}` }));
      if (b.kind === 'total' && zoom) {
        for (const off of [0, 5]) g.append(svg('line', { class: 'axis-break', x1: x0 - 3, x2: x0 + bw + 3, y1: yBot - 10 - off + 3, y2: yBot - 10 - off - 3 }));
      }
      if (i < bars.length - 1) {
        const nextX = m.left + slot * (i + 1) + slot / 2 - bw / 2;
        root.append(svg('line', { class: 'connector', x1: x0 + bw, x2: nextX, y1: y(b.to), y2: y(b.to) }));
      }
      g.append(text(cx, rise ? yTop - 7 : yBot + 14, b.kind === 'total' ? format(b.value) : signed(b.value, format), { class: 'value-label', 'text-anchor': 'middle' }));
      const hit = svg('rect', { class: 'hit', x: m.left + slot * i, y: m.top, width: slot, height: ih });
      hoverable(hit, b.tip, () => g.classList.add('active'), () => g.classList.remove('active'), b.ask);
      g.append(hit);
      root.append(g);
    });
    host.append(root);
    // Category labels (one or two lines). If two neighbours would touch, use the first line only, on two staggered rows.
    const labelX = (i) => m.left + slot * i + slot / 2;
    const width = (t) => { let w = 0; try { w = t.getComputedTextLength(); } catch { /* not rendered */ } return w || t.textContent.length * 5.4; };
    const perBar = bars.map((b, i) => [].concat(b.label).map((ln, k) => root.appendChild(text(labelX(i), H - 20 + k * 12, ln, { class: 'tick', 'text-anchor': 'middle' }))));
    const widest = perBar.map((ts) => Math.max(...ts.map(width)));
    if (widest.some((w, i) => i > 0 && (w + widest[i - 1]) / 2 + 6 > slot)) {
      perBar.flat().forEach((t) => t.remove());
      bars.forEach((b, i) => root.append(text(labelX(i), H - 20 + (i % 2) * 12, [].concat(b.label)[0], { class: 'tick', 'text-anchor': 'middle' })));
    }
  }

  // ---------- table view (every chart has one) ----------
  function table(host, headers, rows) {
    host.replaceChildren(html('table', { class: 'mini' },
      html('thead', {}, html('tr', {}, headers.map((h) => html('th', { text: h })))),
      html('tbody', {}, rows.map((r) => html('tr', {}, r.map((c) => html('td', { text: c })))))));
  }

  const setAsk = (fn) => { askHandler = fn; };
  return { donut, donutLegend, lines, diverging, columns, histogram, waterfall, table, tip, hideTip, ttTitle, ttRow, ttNote, askable, askHint, setAsk, eur, eurShort, signed, signedPct };
})();
