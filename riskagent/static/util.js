// Shared labels, formatting and a tiny DOM builder. Every user- or server-supplied string goes
// into the DOM as a text node; only renderMarkdown() output (escaped first) is set as HTML.

export const STATE_LABELS = {
  lead: 'Lead',
  candidate: 'Candidate (below top five)',
  related: 'Related tag of a lead',
  no_reported_signal: 'No reported historical signal',
  too_little_evidence: 'Too little evidence',
  could_not_assess: 'Could not assess',
};

export const STATE_HINTS = {
  lead: 'Ranked 1–5 for staff verification. A lead is not a finding.',
  candidate: 'Has a historical signal but ranked below the top five.',
  related: 'Rests only on the same findings as a lead, so it is shown as a related compliance tag of that lead, not a separate lead. It needs its own distinct check.',
  no_reported_signal: 'Enough same-program history and no reported finding in the areas checked. This is not a low-risk conclusion.',
  too_little_evidence: 'No own history for the program and fewer same-program reports than the minimum.',
  could_not_assess: 'The program could not be matched (for example an unidentified Assistance Listing) or a lookup failed.',
};

export const STATE_ORDER = ['lead', 'related', 'candidate', 'no_reported_signal', 'too_little_evidence', 'could_not_assess'];

export const GROUP_LABELS = {
  own_latest: 'Own latest audit',
  own_older: 'Own older audit',
  peer_only: 'Same-program pattern only',
};

export const REQUIREMENTS = {
  A: 'Activities allowed or unallowed', B: 'Allowable costs/cost principles', C: 'Cash management',
  E: 'Eligibility', F: 'Equipment and real property management', G: 'Matching, level of effort, earmarking',
  H: 'Period of performance', I: 'Procurement and suspension & debarment', J: 'Program income',
  L: 'Reporting', M: 'Subrecipient monitoring', N: 'Special tests and provisions', P: 'Other',
};

export const PROGRAM_SOURCE_LABELS = {
  filed_sefa_proxy: 'Proxy: filed SEFA identities & amounts',
  last_public_programs: 'Provisional: last public programs',
  manager_supplied: 'Manager-supplied',
};

export const STATUS_LABELS = { proxy: 'Proxy', provisional: 'Provisional', manager: 'Manager-supplied' };

export const CHECK_LABELS = {
  supported: 'Evidence supports',
  weak_match: 'Weak match',
  conflict: 'Conflicting evidence',
  not_checked: 'Not checked',
};

export const DISPOSITIONS = [
  { value: 'include', label: 'Include' },
  { value: 'investigate', label: 'Investigate' },
  { value: 'set_aside', label: 'Set aside' },
];
export const DISPOSITION_LABELS = Object.fromEntries(DISPOSITIONS.map(d => [d.value, d.label]));

export const MODE_LABELS = { historical: 'Replay of a filed audit', live: 'Upcoming audit' };

// ---------------------------------------------------------------- DOM
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'value') node.value = v;
    else if (k === 'trustedHtml') node.innerHTML = v; // only renderMarkdown() output
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const c of [children].flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** replaceChildren() that skips null/false/'' (the native method would print "null"). */
export function fill(node, ...children) {
  node.replaceChildren();
  return append(node, children);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const cssEscape = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

export function badge(state, extra) {
  return el('span', { class: `badge state-${state || 'unknown'}`, title: STATE_HINTS[state] || null },
    STATE_LABELS[state] || state || 'Unknown', extra ? el('span', { class: 'badge-extra' }, extra) : null);
}

export function checkBadge(status) {
  const s = status || 'not_checked';
  return el('span', { class: `badge check-${s}`, title: 'Agent evidence check of the source narratives' },
    CHECK_LABELS[s] || s);
}

export function label(text, attrs = {}) {
  return el('span', { class: 'eyebrow', ...attrs }, text);
}

// ---------------------------------------------------------------- formatting
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(s) {
  if (!s) return '—';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtShortDateTime(s) {
  const d = s ? new Date(s) : null;
  if (!d || Number.isNaN(d.getTime())) return s ? String(s) : '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtTime(s) {
  const d = s ? new Date(s) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const ints = new Intl.NumberFormat('en-US');
export const fmtMoney = n => (n == null || Number.isNaN(Number(n)) ? '—' : money.format(Number(n)));
export const fmtInt = n => (n == null || Number.isNaN(Number(n)) ? '—' : ints.format(Number(n)));

/** Reported-finding share among comparable audits, as a percentage string. Never a probability. */
export function fmtShare(k, n) {
  if (!n || k == null) return null;
  return `${((Number(k) / Number(n)) * 100).toFixed(1)}%`;
}

/** [2017, 2018, 2019, 2021] -> "2017–2019, 2021" */
export function fmtYears(years) {
  const ys = [...new Set((years || []).map(Number))].filter(Number.isFinite).sort((a, b) => a - b);
  if (!ys.length) return '';
  const parts = [];
  let start = ys[0];
  let prev = ys[0];
  for (const y of ys.slice(1).concat([NaN])) {
    if (y === prev + 1) { prev = y; continue; }
    parts.push(start === prev ? String(start) : prev === start + 1 ? `${start}, ${prev}` : `${start}–${prev}`);
    start = prev = y;
  }
  return parts.join(', ');
}

/** Year list as a node whose ranges never break mid-range ("2017–2019, 2021"). */
export function yearsNode(years, empty = '') {
  const text = fmtYears(years);
  if (!text) return empty;
  const parts = text.split(', ');
  return el('span', { class: 'years' }, ...parts.flatMap((t, i) => [i ? ', ' : null, el('span', { class: 'nw' }, t)]));
}

export function idMethodLabel(m) {
  if (!m) return '';
  return String(m).replace(/_/g, ' ').toLowerCase().replace(/\b(uei|ein)\b/g, x => x.toUpperCase());
}

export const plural = (n, one, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

export function requirementName(letter, fallback) {
  return fallback || REQUIREMENTS[letter] || letter || '';
}

export function shortName(name, n = 64) {
  const s = String(name || '');
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

export function isPlaceholderText(t) {
  return !t || /^\s*(GSA_MIGRATION|\(no narrative on file\))\s*$/i.test(String(t));
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// ---------------------------------------------------------------- findings & rows
/** Normalize finding flags from either a row's own-finding item or a finding-detail `flags` object. */
export function normFlags(x) {
  const src = x || {};
  const f = { ...src };
  if (src.flags && typeof src.flags === 'object' && !Array.isArray(src.flags)) Object.assign(f, src.flags);
  if (Array.isArray(src.flags)) for (const k of src.flags) f[k] = true;
  const pick = (...keys) => keys.some(k => f[k] === true || f[k] === 'true' || f[k] === 'Y');
  return {
    repeat: pick('is_repeat', 'repeat_finding', 'is_repeat_finding', 'repeat'),
    mw: pick('material_weakness', 'is_material_weakness'),
    sd: pick('significant_deficiency', 'is_significant_deficiency'),
    qc: pick('questioned_costs', 'is_questioned_costs'),
    blanket: pick('is_blanket', 'blanket'),
    conflict: pick('conflicting_rows', 'has_conflicting_rows'),
    modified: pick('modified_opinion', 'is_modified_opinion'),
    priorRefs: f.prior_finding_refs || null,
  };
}

const FLAG_TEXT = {
  repeat: ['Repeat', 'Marked as a repeat of a prior-year finding'],
  mw: ['MW', 'Material weakness'],
  sd: ['SD', 'Significant deficiency'],
  qc: ['QC', 'Questioned costs reported'],
  blanket: ['Blanket', 'Finding lists 5 or more requirements; the link to any one requirement is weak'],
  conflict: ['Conflicting rows', 'Source finding rows disagree; merged flags are less certain'],
  modified: ['Modified opinion', 'Modified opinion on compliance'],
};

/** Flag tags. `long` spells out abbreviations (drawer); short form uses <abbr> titles (table). */
export function flagTags(flags, { long = false } = {}) {
  const wrap = el('span', { class: 'flags' });
  for (const [k, [short, full]] of Object.entries(FLAG_TEXT)) {
    if (!flags[k]) continue;
    wrap.append(el('span', { class: `flag flag-${k}` }, long ? full : (short === full ? short : el('abbr', { title: full }, short))));
  }
  return wrap.childElementCount ? wrap : null;
}

export function findRow(a, rowId) {
  for (const p of a?.program_assessments || []) {
    if (p.row_id === rowId) return { prog: p, req: null };
    for (const r of p.requirements || []) if (r.row_id === rowId) return { prog: p, req: r };
  }
  return { prog: null, req: null };
}

export function leadForRow(a, rowId) {
  return (a?.risks || []).find(r => r.requirement_row_id === rowId) || null;
}

export function groupLabel(x) {
  return x?.group_label || GROUP_LABELS[x?.group] || '';
}

export function unavailableLines(list) {
  // Contract: entries are {audit_year, reason}; never show a later acceptance date before reveal.
  const byReason = new Map();
  for (const r of list || []) {
    const reason = /public|cutoff/i.test(r.reason || '') || !r.reason ? 'no public report by the cutoff' : r.reason;
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(r.audit_year);
  }
  return [...byReason].map(([reason, years]) => `${fmtYears(years)}: ${reason}`);
}

export const IDENTITY_FLAG_LABELS = {
  ein_ambiguous: 'EIN maps to more than one organization',
  ein_only: 'history linked by EIN only',
  multiple_reports_in_year: 'more than one report filed for an audit year',
};

// ---------------------------------------------------------------- grid labels & prefs
export const STATE_SHORT = {
  lead: 'Lead',
  candidate: 'Candidate',
  related: 'Related tag',
  no_reported_signal: 'No reported signal',
  too_little_evidence: 'Too little evidence',
  could_not_assess: 'Could not assess',
};

export const GROUP_SHORT = { own_latest: 'Own latest audit', own_older: 'Own older audit', peer_only: 'Same-program pattern', audit_wide_only: 'Audit-wide filing only' };

/** Compact state badge for grid cells; the full contract label stays in the tooltip. */
export function stateBadgeShort(state, rank) {
  const txt = state === 'lead' && rank ? `Lead ${rank}` : state === 'candidate' && rank ? `Candidate ${rank}` : state === 'related' && rank ? `Related to ${rank}` : (STATE_SHORT[state] || state || '—');
  return el('span', { class: `badge badge-sm state-${state || 'unknown'}`, title: `${STATE_LABELS[state] || state}. ${STATE_HINTS[state] || ''}`.trim() }, txt);
}

const TOOL_LABELS = {
  run_assessment: 'Building the assessment (identity, cutoff, programs, history, peers, evidence check)',
  resolve_case: 'Confirming the nonprofit and the data cutoff',
  get_program_context: 'Listing the programs to assess',
  get_own_history: "Reading this nonprofit's earlier public reports",
  get_peer_evidence: 'Counting comparable audits at other nonprofits',
  propose_candidates: 'Ranking program × requirement candidates',
  inspect_candidate: 'Checking finding narratives for the top leads',
  finalize_review_order: 'Finalizing the top five from the checked pool',
  explain_and_check: 'Writing and checking the explanations',
  save_assessment: 'Saving the assessment version',
  read_finding: 'Reading a finding narrative',
  get_row_evidence: 'Reading the evidence for a row',
  get_assessment: 'Reading the saved assessment',
  get_peer_examples: "Reading other nonprofits' findings",
  revise_assessment: 'Saving a corrected version',
  answer_followup: 'Answering from saved evidence',
  draft_focus_note: 'Drafting the focus note from your decisions',
  get_decisions: 'Reading your decisions',
};

export function toolLabel(tool) {
  if (TOOL_LABELS[tool]) return TOOL_LABELS[tool];
  const s = String(tool || 'step').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const PREFS_KEY = 'srb-prefs-v2';
export function loadPrefs(defaults) {
  try { return { ...defaults, ...(JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')) }; } catch { return { ...defaults }; }
}
export function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}
