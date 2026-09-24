// Figure verification: every amount / percentage in an answer must match a number the tools
// returned in the same turn (or the user's own question, or the generated data context).
// Rounded figures are accepted within their display precision (€3.22M, €166k, 5.4%).

const NUM_RE = /([+\-−–]?)(\s?)(€\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s?%|\s?pp|[kKM](?![a-zA-Z])|bn(?![a-zA-Z]))?/g;

// Numbers from free text (tool strings, user question, data context). Permissive: keeps every number.
function numbersInText(text) {
  const out = [];
  for (const m of String(text).matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
    const v = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

// Every number inside a tool result (including numbers written inside strings).
function collectValues(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'number') { if (Number.isFinite(value)) out.push(value); return out; }
  if (typeof value === 'string') { out.push(...numbersInText(value)); return out; }
  if (Array.isArray(value)) { for (const v of value) collectValues(v, out); return out; }
  if (typeof value === 'object') { for (const v of Object.values(value)) collectValues(v, out); }
  return out;
}

// Figures stated in an answer, skipping things that are not financial claims
// (years, dates, account codes, counts, list numbers, the Source line).
function extractClaims(markdown) {
  const claims = [];
  const lines = String(markdown).split('\n');
  for (const [lineNo, rawLine] of lines.entries()) {
    const line = rawLine.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length));
    if (/^\s*[*_]*\s*sources?\s*:/i.test(line)) continue;
    for (const m of line.matchAll(NUM_RE)) {
      const [whole, , , euro, digits, suffixRaw] = m;
      const start = m.index + whole.indexOf(digits);
      const before = line[start - 1] || '';
      const before2 = line[start - 2] || '';
      const after = line[start + digits.length] || '';
      const after2 = line[start + digits.length + 1] || '';
      const suffix = (suffixRaw || '').trim();
      // Part of a word or code: FY2027, DQ01, Q1, NL37, 26/27, 2026-06, 12:43, 01-06-2026
      if (/[A-Za-z_]/.test(before) && !euro) continue;
      if ((/[/:]/.test(after) && /\d/.test(after2)) || (/[/:]/.test(before) && /\d/.test(before2))) continue;
      if (after === '-' && /\d/.test(after2)) continue;
      if (before === '-' && /\d/.test(before2)) continue;
      if (/^[A-Za-z]/.test(after) && !suffix) continue;
      const hasSep = digits.includes(',');
      const decimals = (digits.split('.')[1] || '').length;
      let value = Number(digits.replace(/,/g, ''));
      const isPct = suffix === '%' || suffix === 'pp';
      const scale = suffix === 'k' || suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'bn' ? 1e9 : 1;
      // Plain integers without €, %, k/M or thousands separators are counts, codes, years or list numbers.
      if (!euro && !isPct && scale === 1 && !hasSep && (decimals === 0 || value < 10)) continue;
      if (isPct && (value === 0 || value === 100)) continue;
      value *= scale;
      const tol = 0.5 * 10 ** -decimals * scale;
      claims.push({ raw: whole.trim(), value: Math.abs(value), tol, isPct, context: line.trim().slice(0, 160), lineNo, pos: start, line });
    }
  }
  return claims;
}

function verifyAnswer(answer, { toolValues = [], allowedText = '' } = {}) {
  const pool = [...toolValues, ...numbersInText(allowedText)].map(Math.abs);
  const sorted = Float64Array.from(pool).sort();
  const EPS = 1e-7;
  const firstAtLeast = (x) => {
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < x) lo = mid + 1; else hi = mid - 1;
    }
    return lo;
  };
  const near = (v, tol) => {
    const i = firstAtLeast(v - tol - EPS);
    return i < sorted.length && sorted[i] < v + tol - EPS;
  };
  // Closest tool figure, used to tell the model how a figure should have been written.
  const closest = (v) => {
    const i = firstAtLeast(v);
    const opts = [sorted[i - 1], sorted[i]].filter((x) => x != null);
    return opts.sort((a, b) => Math.abs(a - v) - Math.abs(b - v))[0];
  };
  // Exact-euro figures may be the sum or difference of two tool figures (e.g. two drivers added up).
  const pairMatch = (v, tol) => {
    if (tol > 1 || pool.length > 4000) return false;
    const set = pool.filter((x) => x > 0.5 && x < v * 2 + 1);
    for (let i = 0; i < set.length; i++) {
      if (near(v - set[i], tol) || near(v + set[i], tol)) {
        // near() above checks against the whole pool; make sure the partner is a real value, not v itself
        if (Math.abs(set[i] - v) > tol) return true;
      }
    }
    return false;
  };
  const claims = extractClaims(answer);
  const derived = shownCalculations(answer, (v) => near(Math.abs(v), Math.max(0.5, Math.abs(v) * 1e-6)));
  const unverified = [];
  const direct = [];
  for (const c of claims) {
    if (near(c.value, c.tol) || (c.isPct && (near(c.value / 100, c.tol / 100) || near(c.value * 100, c.tol * 100)))) {
      direct.push(c); // taken straight from a tool figure: layer 2 checks what it is attached to
      continue;
    }
    const ok = (!c.isPct && pairMatch(c.value, c.tol)) || derived.some((d) => Math.abs(d - c.value) <= c.tol);
    if (!ok) {
      const t = closest(c.value);
      const scale = c.tol >= 500 ? (c.tol >= 5e5 ? 1e6 : 1e3) : 1;
      const hint = t != null && Math.abs(t - c.value) <= Math.max(1, c.value * 0.001)
        ? `the source figure is ${t.toLocaleString('en-GB', { maximumFractionDigits: 2 })}, which rounds (half up) to ${(Math.round((t / scale) / (c.tol * 2 / scale)) * (c.tol * 2 / scale)).toLocaleString('en-GB', { maximumFractionDigits: 2 })}${scale === 1e6 ? 'M' : scale === 1e3 ? 'k' : ''}`
        : null;
      unverified.push({ ...c, hint });
    }
  }
  return { ok: unverified.length === 0, checked: claims.length, unverified, direct };
}

// Results of calculations written out in the answer ("A ÷ B × 100 = C%", "A − B = C").
// A result counts as verified only when both inputs are tool figures and the arithmetic is right.
function shownCalculations(answer, isToolFigure) {
  const results = [];
  const num = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?([kKM](?![a-zA-Z]))?/g;
  const parse = (m) => Number(m[1].replace(/,/g, '')) * (m[2] === 'M' ? 1e6 : m[2] ? 1e3 : 1);
  for (const line of String(answer).split('\n')) {
    const eq = line.lastIndexOf('=');
    if (eq < 0) continue;
    const left = [...line.slice(0, eq).matchAll(num)].map(parse).filter((v) => v !== 100);
    const rightMatch = [...line.slice(eq + 1).matchAll(num)][0];
    if (left.length < 2 || !rightMatch) continue;
    const [x, y] = left.slice(-2);
    if (!isToolFigure(x) || !isToolFigure(y)) continue;
    const z = parse(rightMatch);
    const candidates = [x + y, Math.abs(x - y), x * y, y ? x / y : NaN, y ? (x / y) * 100 : NaN, y ? ((x - y) / y) * 100 : NaN];
    const tol = Math.max(0.051, Math.abs(z) * 0.0006);
    if (candidates.some((c) => Number.isFinite(c) && Math.abs(Math.abs(c) - z) <= tol)) results.push(z);
  }
  return results;
}

module.exports = { verifyAnswer, extractClaims, collectValues, numbersInText };
