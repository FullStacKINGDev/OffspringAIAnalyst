// Layer 2 - meaning check. Layer 1 proves each figure exists in the tool results; this layer checks that
// each figure is attached to the right ITEM (line / account / balance-sheet group), the right MONTH and the
// right DIRECTION (higher/lower, favourable/adverse). Deterministic, and it flags only on positive evidence
// of a mismatch, never because context is missing.
const { numbersInText } = require('./verify');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d\d)\b/gi;
const RANGE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(\s+20\d\d)?\s*(–|-|to)\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+20\d\d/i;
const UP = /\b(higher|increased?|increasing|rose|risen|grew|grown|up|more|above|over)\b/i;
const DOWN = /\b(lower|decreased?|decreasing|fell|fallen|dropped|down|less|below|under|declined?)\b/i;
const FAV = /\bfavou?rable\b/i;
const ADV = /\badverse\b/i;
const SEGMENTS = ['Airline', 'Forwarder', 'GSA', 'Airport', 'Shipper', 'PY Adjustments', 'Other Revenue'];
// Fields that describe a difference between two periods, so they belong to no single month.
const DIFF_FIELDS = /variance|change|effect_on_profit|yoy|gap|still_needed|movement/i;

// ---------- vocabulary: which words name which item ----------

// strong = names one specific item; weak = too generic to judge (revenue, costs, profit).
// cs = match case-sensitively, for words that are also ordinary English ("in general", "of interest").
const MBR_ALIASES = {
  'Total Revenue': { strong: ['total revenue', 'total turnover'], weak: ['revenue', 'turnover', 'sales'] },
  Airline: { strong: ['airline'] },
  Forwarder: { strong: ['forwarder'] },
  GSA: { strong: ['gsa'] },
  Airport: { strong: ['airport'] },
  Shipper: { strong: ['shipper'] },
  'PY Adjustments': { strong: ['py adjustments', 'prior-year adjustments', 'prior year adjustments', 'turnover adjustments prior financial year'] },
  'Other Revenue': { strong: ['other revenue', 'turnover other'] },
  COGS: { strong: ['cogs', 'cost of sales', 'cost of goods sold'] },
  General: { strong: ['general expenses', 'general costs'], cs: ['General'] },
  Personnel: { strong: ['personnel costs', 'personnel expenses', 'personnel', 'staff costs'] },
  'Total Expenses': { strong: ['total expenses', 'total costs', 'total operating costs'], weak: ['expenses', 'costs', 'operating costs'] },
  EBIT: { strong: ['ebit', 'operating profit'] },
  'EBIT %': { strong: ['ebit %', 'ebit margin'], weak: ['margin'] },
  Interest: { strong: ['net financial income', 'financial result'], cs: ['Interest'] },
  Taxes: { strong: ['taxes', 'corporate income tax', 'tax charge'], weak: ['tax'] },
  'Net Income': { strong: ['net income', 'net profit', 'net result'], weak: ['profit', 'result'] },
};

function buildVocab(store) {
  if (store._vocab) return store._vocab;
  const aliases = [];
  const add = (entity, text, strong, cs = false) => {
    const t = cs ? String(text).trim() : String(text).toLowerCase().trim();
    if (t.length >= 3) aliases.push({ text: t, entity, strong, cs });
  };
  for (const [entity, a] of Object.entries(MBR_ALIASES)) {
    for (const t of a.strong || []) add(entity, t, true);
    for (const t of a.weak || []) add(entity, t, false);
    for (const t of a.cs || []) add(entity, t, true, true);
  }
  const tbAccounts = store.trialBalance ? store.trialBalance.accounts : [];
  const seen = new Set();
  for (const a of [...store.plAccounts, ...tbAccounts]) {
    if (seen.has(a.code)) continue;
    seen.add(a.code);
    add(`acct:${a.code}`, `${a.code} - ${a.name}`, true);
    add(`acct:${a.code}`, a.name, true);
  }
  for (const g of new Set(tbAccounts.map((a) => a.bsGroup).filter(Boolean))) add(`grp:${g}`, g, true);
  add('grp:Cash and bank', 'cash and bank', true);
  add('grp:Cash and bank', 'cash', false);
  aliases.sort((a, b) => b.text.length - a.text.length); // longest first: "general expenses" before "General"
  store._vocab = {
    aliases,
    categoryOf: new Map(store.plAccounts.map((a) => [`acct:${a.code}`, a.category])),
    groupOf: new Map(tbAccounts.filter((a) => a.bsGroup).map((a) => [`acct:${a.code}`, `grp:${a.bsGroup}`])),
  };
  return store._vocab;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Items named in a piece of text, with positions. Longer aliases claim their characters first.
function findEntities(text, vocab) {
  const original = String(text).replace(/_/g, ' ');
  const lower = original.toLowerCase();
  const taken = new Array(original.length).fill(false);
  const found = [];
  for (const a of vocab.aliases) {
    const hay = a.cs ? original : lower;
    const re = new RegExp(`(^|[^A-Za-z0-9])(${escapeRe(a.text)})(?=$|[^A-Za-z0-9])`, 'g');
    let m;
    while ((m = re.exec(hay))) {
      const start = m.index + m[1].length;
      const end = start + a.text.length;
      if (taken.slice(start, end).some(Boolean)) continue;
      for (let i = start; i < end; i++) taken[i] = true;
      found.push({ entity: a.entity, strong: a.strong, start, end });
    }
  }
  return found;
}

// Everything an item implies: account 4720 is also "General"; a bank account is also "Cash and bank";
// a revenue segment is also part of "Total Revenue".
function expand(entities, vocab) {
  const out = new Set(entities);
  for (const e of entities) {
    if (vocab.categoryOf.has(e)) out.add(vocab.categoryOf.get(e));
    if (vocab.groupOf.has(e)) out.add(vocab.groupOf.get(e));
  }
  if ([...out].some((e) => SEGMENTS.includes(e))) out.add('Total Revenue');
  return out;
}

// ---------- index of tool figures with their context ----------

const LABEL_KEYS = ['line', 'account', 'group', 'category', 'mbr_category', 'section', 'label'];

function monthKeyFrom(value) {
  const s = String(value || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}`;
  m = s.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})$/i);
  if (m) return `${m[2]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}`;
  return null;
}
const shiftYear = (month, n) => (month ? `${Number(month.slice(0, 4)) + n}${month.slice(4)}` : null);

function indexToolResults(results, vocab) {
  const entries = [];
  const push = (value, ctx, field, extra = {}) => {
    let month = ctx.month || null;
    if (DIFF_FIELDS.test(field)) month = null;
    else if (field === 'comparison') month = ctx.compMonth || null;
    else if (field === 'prior_year') month = shiftYear(ctx.month, -1);
    entries.push({ value: Math.abs(value), entities: ctx.entities, month, assessment: ctx.assessment || null, direction: null, ...extra });
  };
  const walk = (node, ctx) => {
    if (node == null) return;
    if (Array.isArray(node)) { for (const x of node) walk(x, ctx); return; }
    if (typeof node !== 'object') return;
    const local = { ...ctx, entities: new Set(ctx.entities) };
    for (const k of LABEL_KEYS) {
      if (typeof node[k] === 'string') for (const e of findEntities(node[k], vocab)) if (e.strong) local.entities.add(e.entity);
    }
    const month = monthKeyFrom(node.period) || monthKeyFrom(node.month) || monthKeyFrom(node.key);
    if (month) local.month = month;
    if (typeof node.assessment === 'string') local.assessment = node.assessment;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'period' || k === 'comparison' && v && typeof v === 'object') continue;
      const keyEntities = findEntities(k, vocab).filter((e) => e.strong).map((e) => e.entity);
      const c = keyEntities.length ? { ...local, entities: new Set([...local.entities, ...keyEntities]) } : local;
      if (typeof v === 'number') {
        push(v, c, k);
      } else if (typeof v === 'string' && /\d/.test(v) && k !== 'month' && k !== 'key') {
        const direction = /\bhigher\b/i.test(v) ? 'up' : /\blower\b/i.test(v) ? 'down' : null;
        const assessment = c.assessment || (/favourable/.test(v) ? 'favourable' : /adverse/.test(v) ? 'adverse' : null);
        for (const n of numbersInText(v)) {
          entries.push({ value: Math.abs(n), entities: c.entities, month: null, assessment, direction });
        }
      } else if (v && typeof v === 'object') {
        walk(v, c);
      }
    }
  };
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    const single = (p) => (p && typeof p === 'object' && p.from && p.from === p.to ? p.from : null);
    walk(r, { entities: new Set(), month: single(r.period), compMonth: single(r.comparison) });
  }
  return entries;
}

// ---------- answer side: what each figure is written next to ----------

function tableContext(lines, lineNo, pos) {
  if (!/^\s*\|/.test(lines[lineNo])) return null;
  let start = lineNo;
  while (start > 0 && /^\s*\|/.test(lines[start - 1])) start--;
  if (lineNo <= start + 1) return null; // header or separator row
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
  const col = (lines[lineNo].slice(0, pos).match(/\|/g) || []).length - 1;
  return { rowLabel: cells(lines[lineNo])[0] || '', header: cells(lines[start])[col] || '', rowText: lines[lineNo] };
}

function clauseAround(line, pos) {
  const breaks = /(\.\s|;\s|\s[–—]\s|•)/g;
  let from = 0;
  let to = line.length;
  let m;
  while ((m = breaks.exec(line))) {
    if (m.index + m[0].length <= pos) from = m.index + m[0].length;
    else if (m.index > pos) { to = m.index; break; }
  }
  return { text: line.slice(from, to), offset: pos - from };
}

// The specific item a figure is written next to: nearest before it, else nearest after it.
function nearestStrongEntity(text, offset, vocab) {
  const ents = findEntities(text, vocab).filter((e) => e.strong);
  if (!ents.length) return null;
  const before = ents.filter((e) => e.end <= offset).sort((a, b) => b.end - a.end)[0];
  const after = ents.filter((e) => e.start >= offset).sort((a, b) => a.start - b.start)[0];
  if (before && after) return offset - before.end <= after.start - offset + 25 ? before.entity : after.entity;
  return (before || after).entity;
}

function singleMonth(text) {
  if (RANGE_RE.test(text)) return null;
  const months = [...String(text).matchAll(MONTH_RE)].map((m) => `${m[2]}-${String(MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1).padStart(2, '0')}`);
  const unique = [...new Set(months)];
  return unique.length === 1 ? unique[0] : null;
}

const itemName = (e) => e.replace(/^acct:/, 'account ').replace(/^grp:/, '');

function checkMeaning(answer, { directClaims, toolResults, store }) {
  const vocab = buildVocab(store);
  const index = indexToolResults(toolResults, vocab);
  const lines = String(answer).split('\n');
  const issues = [];
  let checked = 0;

  for (const c of directClaims) {
    let candidates = index.filter((e) => Math.abs(e.value - c.value) <= c.tol || (c.isPct && Math.abs(e.value - c.value / 100) <= c.tol / 100));
    if (!candidates.length) continue;
    checked++;
    const table = tableContext(lines, c.lineNo, c.pos);
    let entity;
    let windowText;
    let monthText;
    if (table) {
      entity = nearestStrongEntity(table.rowLabel, table.rowLabel.length, vocab) || nearestStrongEntity(table.header, 0, vocab);
      windowText = table.rowText;
      monthText = `${table.rowLabel} ${table.header}`;
    } else {
      const cl = clauseAround(c.line, c.pos);
      entity = nearestStrongEntity(cl.text, cl.offset, vocab);
      windowText = cl.text;
      monthText = cl.text;
    }

    // 1) Item: the figure must belong to the item it is written next to. In lists ("Airline, Shipper and GSA
    //    rose by €7,007, €4,663 and €3,579") the nearest name is not always the right one, so a mismatch is
    //    reported only when the figure's real item is named nowhere in that clause or table row.
    if (entity) {
      let same = candidates.filter((e) => e.entities.size === 0 || expand(e.entities, vocab).has(entity));
      if (!same.length) {
        const named = new Set(findEntities(table ? `${table.rowLabel} ${table.header}` : windowText, vocab).filter((e) => e.strong).map((e) => e.entity));
        same = candidates.filter((e) => [...expand(e.entities, vocab)].some((x) => named.has(x)));
      }
      if (!same.length) {
        const others = [...new Set(candidates.flatMap((e) => [...e.entities]))].slice(0, 3).map((x) => `"${itemName(x)}"`).join(' / ');
        issues.push({ figure: c.raw, problem: `${c.raw} is attached to "${itemName(entity)}", but in the source data this figure belongs to ${others}.`, context: c.context });
        continue;
      }
      candidates = same;
    }

    // 2) Month: a figure written next to exactly one month must be that month's figure.
    const month = singleMonth(monthText);
    if (month) {
      const dated = candidates.filter((e) => e.month);
      if (dated.length === candidates.length && !dated.some((e) => e.month === month)) {
        issues.push({ figure: c.raw, problem: `${c.raw} is presented as the ${month} figure, but in the source data it is the figure for ${[...new Set(dated.map((e) => e.month))].join(' / ')}.`, context: c.context });
        continue;
      }
    }

    // 3) Assessment and direction written next to the figure.
    const assessed = candidates.filter((e) => e.assessment);
    if (assessed.length) {
      if (FAV.test(windowText) && !ADV.test(windowText) && assessed.every((e) => e.assessment === 'adverse')) {
        issues.push({ figure: c.raw, problem: `${c.raw} is described as favourable, but the source data marks it adverse.`, context: c.context });
        continue;
      }
      if (ADV.test(windowText) && !FAV.test(windowText) && assessed.every((e) => e.assessment === 'favourable')) {
        issues.push({ figure: c.raw, problem: `${c.raw} is described as adverse, but the source data marks it favourable.`, context: c.context });
        continue;
      }
    }
    const directed = candidates.filter((e) => e.direction);
    if (directed.length) {
      const saysUp = UP.test(windowText) && !DOWN.test(windowText);
      const saysDown = DOWN.test(windowText) && !UP.test(windowText);
      if (saysUp && directed.every((e) => e.direction === 'down')) {
        issues.push({ figure: c.raw, problem: `${c.raw} is described as higher / an increase, but in the source data it is lower (a decrease).`, context: c.context });
      } else if (saysDown && directed.every((e) => e.direction === 'up')) {
        issues.push({ figure: c.raw, problem: `${c.raw} is described as lower / a decrease, but in the source data it is higher (an increase).`, context: c.context });
      }
    }
  }
  return { ok: issues.length === 0, checked, issues };
}

module.exports = { checkMeaning, buildVocab, findEntities, indexToolResults };
