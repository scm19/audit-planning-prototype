// Review grid: one row per program × requirement, plus one row for each program with no
// requirement rows, so every program considered appears. Leads first (rank 1–5), then
// candidates by candidate rank, then evidence-state rows. Cells are single-line and truncated;
// the row detail panel holds the full text.

import {
  el, $, $$, fill, cssEscape, checkBadge, stateBadgeShort, fmtMoney, fmtInt, fmtShare, fmtYears, plural,
  shortName, requirementName, STATE_LABELS, STATE_ORDER, GROUP_SHORT, DISPOSITIONS, DISPOSITION_LABELS, badge,
} from './util.js';
import { icon } from './icons.js';
import { openPopover, infoButton } from './popover.js';
import { claimItem } from './claims.js';
import { programDecision, syncProgramDecision } from './program-decision.js';

const COLS = [
  { id: 'n', label: 'Rank', w: 82, fixed: true, optional: true, cls: 'c-n' },
  { id: 'program', label: 'Program', icon: 'doc', w: 214, fixed: true },
  { id: 'req', label: 'Compliance area', icon: 'list', w: 176, fixed: true },
  { id: 'decision', label: 'Decision', icon: 'check', w: 136, pinned: true },
  { id: 'lead', label: 'Lead', icon: 'flag', w: 236, optional: true },
  { id: 'basis', label: 'Basis', icon: 'building', w: 136, optional: true },
  { id: 'own', label: 'Own history', icon: 'clock', w: 188, optional: true },
  { id: 'peers', label: 'Same-program', icon: 'people', w: 124, optional: true },
  { id: 'amount', label: 'Amount', icon: 'hash', w: 116, optional: true, num: true },
  { id: 'check', label: 'Evidence check', icon: 'shield', w: 142, optional: true },
  { id: 'why', label: 'Why it’s flagged', icon: 'text', w: 330, optional: true },
  { id: 'ask', label: 'Ask staff', icon: 'text', w: 330, optional: true },
  { id: 'note', label: 'Note', icon: 'note', w: 230, optional: true },
];

const STATE_FILTERS = [['all', 'All rows'], ['top', 'Top 5 (reviewed by the agent)'], ['ranked', 'Ranked'], ['unranked', 'Not ranked']];
// What each column shows, where it comes from, and how to read it (column "about" cards).
const COL_INFO = {
  n: { shows: 'The order to review rows in. 1 is the strongest historical signal.',
    source: 'A fixed, auditable ranking: a finding in this nonprofit’s latest public audit of the program comes first, then its older findings, then patterns at other nonprofits (a smoothed share of same-program audits, with a minimum number of them).',
    read: 'Bold ranks 1–5 were reviewed by the agent against the source text. “—” means not ranked: tested before with nothing reported, too little same-program history, or a program number that isn’t recognized. None of these means low risk.',
    limits: 'Rank orders the review. It is not a likelihood of a finding.' },
  program: { shows: 'The federal program, by Assistance Listing number and name.',
    source: 'The engagement’s program list: the filed award schedule used as a stand-in for a draft, the last public report’s programs (provisional), or your corrections.',
    read: 'A program appears on several rows, one per compliance area with history.' },
  req: { shows: 'The compliance requirement within the program, using the Compliance Supplement letters (A–N, P).',
    source: 'The requirement letters tagged on past findings, this nonprofit’s or other nonprofits’.',
    read: 'Only areas with some history get a row. The audit may still need to test areas that don’t appear.' },
  decision: { shows: 'Your call on the row: Include, Investigate or Set aside.',
    source: 'You. Saved to this assessment version.',
    read: 'Include and Investigate rows go into the staff note. Set aside is recorded with your note so the reasoning is kept.' },
  lead: { shows: 'A short name for the issue to check.',
    source: 'Written by the agent after reading the source findings for the top five rows.',
    read: 'Rows below the top five say “Not reviewed by the agent”: they are ranked from the numbers only.' },
  basis: { shows: 'Why the row is ranked where it is.',
    source: 'The ranking tier the row falls in.',
    values: [['Own latest audit', 'a finding in this nonprofit’s most recent public audit of the program'], ['Own older audit', 'an older own finding only'], ['Same-program pattern', 'only other nonprofits reported it']],
    read: 'Own findings are the strongest signal. In the backtest, own-latest leads matched a later finding about 1 in 4 times; peer-only leads about 1 in 50.' },
  own: { shows: 'This nonprofit’s past findings in this program and area: the audit years and how many findings.',
    source: 'Its own reports that were public in the Federal Audit Clearinghouse before the cutoff.',
    read: 'Several years means a repeat problem. “None reported” is not a clean result: the area may not have been tested.' },
  peers: { shows: 'How many other nonprofits’ audits of this program reported a finding in this area, out of how many.',
    source: 'Other nonprofits’ audits where this program was tested as a major program and the report was public before the cutoff.',
    read: '“410 of 3,120” means 410 same-program audits reported one. Context for how common the issue is, not evidence about this client.' },
  amount: { shows: 'How much the nonprofit spent on the program.',
    source: 'The program list (filed award schedule, last public report, or your correction), summed across the program’s award lines.',
    read: 'Larger programs are more likely to be tested as major programs.',
    limits: 'Not used in the ranking.' },
  check: { shows: 'Whether the agent found that the source text supports the lead.',
    source: 'The agent reads the narratives of the findings behind each top-five row.',
    read: 'Treat weak matches and conflicts with more care before including the row.',
    values: [['Supports', 'the findings match the program and area'], ['Weak match', 'related, but not quite this requirement'], ['Conflict', 'the evidence points the other way'], ['Not checked', 'not a top-five row, or no narrative on file']],
    limits: 'Top five rows only.' },
  why: { shows: 'Why this row was flagged for this nonprofit.',
    source: 'For the top five, the agent’s explanation from the source findings, with citations in the row detail. For other rows, the ranking’s own reason.',
    read: 'Open the row to see the cited findings.' },
  ask: { shows: 'A question or record request for staff to check against current-year records.',
    source: 'Written by the agent for the top five rows.',
    read: 'Goes into the staff note for rows you Include or Investigate.' },
  note: { shows: 'Your note on the row.', source: 'You.', read: 'Goes into the staff note with the row.' },
};

const rankOf = r => (r.req ? (r.req.rank ?? r.req.candidate_rank ?? r.lead?.rank) : null);
const isRanked = r => !!r.req && (r.state === 'lead' || r.state === 'candidate' || r.state === 'related');

export function createGrid(ctx) {
  const root = document.getElementById('review-view');
  let rows = [];
  let visible = [];

  // ------------------------------------------------------------------ model
  function buildRows(a) {
    const leadByRow = new Map((a.risks || []).map(r => [r.requirement_row_id, r]));
    const out = [];
    for (const p of a.program_assessments || []) {
      const reqs = p.requirements || [];
      if (reqs.length) for (const r of reqs) out.push({ rowId: r.row_id, prog: p, req: r, lead: leadByRow.get(r.row_id) || null, state: r.state });
      else out.push({ rowId: p.row_id, prog: p, req: null, lead: null, state: p.state });
    }
    // A related tag sorts directly under the issue it belongs to.
    const byId = new Map(out.map(r => [r.rowId, r]));
    const home = r => (r.state === 'related' && byId.get(r.req.issue_of)) || r;
    const rank = r => (r.state === 'lead' ? (r.req?.rank ?? r.lead?.rank) : r.req?.candidate_rank) ?? 1e9;
    const key = r => { const h = home(r); return [STATE_ORDER.indexOf(h.state), rank(h) + (h === r ? 0 : 0.5)]; };
    out.sort((x, y) => (key(x)[0] - key(y)[0]) || (key(x)[1] - key(y)[1])
      || ((y.prog.amount || 0) - (x.prog.amount || 0)) || String(x.req?.letter || '').localeCompare(String(y.req?.letter || '')));
    return out;
  }

  const allRows = () => rows;
  const findRowModel = rowId => rows.find(r => r.rowId === rowId) || null;

  const ROW_TEST = { all: () => true, top: r => r.state === 'lead' || (r.state === 'related' && !!r.req.related_to_lead), ranked: isRanked, unranked: r => !isRanked(r) };

  function applyFilter() {
    const f = ctx.state.filter;
    const test = ROW_TEST[f.state] || ROW_TEST.all;
    return rows.filter(r => test(r) && (f.program === 'all' || r.prog.row_id === f.program));
  }

  function visibleCols() {
    const p = ctx.prefs;
    const base = COLS.filter(c => !c.optional || p.cols[c.id] !== false);
    const ai = aiCols().map(c => ({ id: `ai:${c.id}`, label: c.name, icon: 'sparkle', w: 250, ai: c }));
    return [...base, ...ai, { id: 'add', label: '', w: 48, add: true }];
  }

  // ------------------------------------------------------------------ AI columns (front-end showcase)
  // A manager adds a column by asking a question of every row. In this prototype the answers are
  // simulated in the browser from each row's existing evidence; no model is called.
  const aiCols = () => (ctx.prefs.aiCols ||= []);
  const generating = new Map(); // ai column id -> number of rows revealed so far

  const AI_SUGGESTIONS = [
    ['Repeat finding?', 'Has this nonprofit reported this finding in more than one audit?'],
    ['Most serious past severity', 'What was the most serious severity of this nonprofit’s past findings here?'],
    ['Questioned costs before?', 'Did any of this nonprofit’s past findings here involve questioned costs?'],
    ['Record to request', 'What one record should staff request first to verify this?'],
  ];

  function addAiColumn(name, prompt) {
    const id = Math.random().toString(36).slice(2, 8);
    aiCols().push({ id, name: name.trim() || prompt.trim().replace(/\?$/, '').slice(0, 32), prompt: prompt.trim() });
    ctx.savePrefs();
    generating.set(id, 0);
    render();
    const total = rows.length;
    const tick = () => {
      const n = (generating.get(id) ?? total) + 1;
      if (n >= total || !generating.has(id)) { generating.delete(id); render(); return; }
      generating.set(id, n);
      render();
      setTimeout(tick, 110);
    };
    setTimeout(tick, 500);
    ctx.toast('Column added. Answers are simulated in this prototype.');
  }

  function removeAiColumn(id) {
    ctx.prefs.aiCols = aiCols().filter(c => c.id !== id);
    generating.delete(id);
    ctx.savePrefs();
    render();
  }

  function keepOnScreen(node) {
    const pop = node.closest('.popover');
    if (!pop) return;
    const r = pop.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) pop.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
    if (r.bottom > window.innerHeight - 8) pop.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;
  }

  function aiForm(close, back) {
    const name = el('input', { class: 'input input-sm', id: 'ai-col-name', placeholder: 'Column name (optional)', maxlength: '40', autocomplete: 'off' });
    const prompt = el('textarea', { class: 'input input-sm', id: 'ai-col-prompt', rows: '3', placeholder: 'Ask a question of every row, e.g. “Has this finding repeated?”' });
    const create = el('button', { type: 'button', class: 'btn btn-primary btn-sm', disabled: true, onclick: () => { close(); addAiColumn(name.value, prompt.value); } }, icon('sparkle', { size: 13 }), 'Create column');
    prompt.addEventListener('input', () => { create.disabled = !prompt.value.trim(); });
    prompt.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.value.trim()) create.click(); });
    requestAnimationFrame(() => prompt.focus());
    return el('div', { class: 'ai-form' },
      el('div', { class: 'ai-form-h' }, el('button', { type: 'button', class: 'tb-icon', 'aria-label': 'Back to columns', onclick: back }, icon('chevronLeft', { size: 15 })), el('span', {}, 'New AI column')),
      el('label', { class: 'sr-only', for: 'ai-col-prompt' }, 'Prompt'), prompt,
      el('div', { class: 'ai-sugs', 'aria-label': 'Suggestions' }, ...AI_SUGGESTIONS.map(([t, q]) => el('button', {
        type: 'button', class: 'ai-sug', onclick: () => { prompt.value = q; if (!name.value) name.value = t; create.disabled = false; prompt.focus(); },
      }, t))),
      el('label', { class: 'sr-only', for: 'ai-col-name' }, 'Column name'), name,
      el('p', { class: 'menu-note' }, 'The agent answers your question for every row from the evidence already gathered. Prototype: answers are simulated.'),
      el('div', { class: 'ai-form-foot' }, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: close }, 'Cancel'), create));
  }

  function colCard(title, parts, extra = []) {
    return el('div', { class: 'colinfo' }, el('h3', {}, title),
      ...parts.filter(([, v]) => v).map(([k, v]) => el('div', { class: 'ci-row' }, el('div', { class: 'ci-k' }, k), el('div', { class: 'ci-v' }, v))),
      ...extra);
  }

  function colInfoBtn(c) {
    return el('button', {
      type: 'button', class: 'th-info', 'aria-label': `About the ${c.label} column`, title: `About ${c.label}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      onclick: e => {
        e.stopPropagation();
        const info = COL_INFO[c.id] || {};
        const values = info.values ? el('ul', { class: 'ci-values' }, ...info.values.map(([k, v]) => el('li', {}, el('strong', {}, k), ` · ${v}`))) : null;
        openPopover(e.currentTarget, () => colCard(c.label, [['What it shows', info.shows], ['Where it comes from', info.source], ['Values', values], ['How to read it', info.read], ['Limits', info.limits]]),
          { label: `About ${c.label}`, cls: 'pop-col' });
      },
    }, icon('info', { size: 12 }));
  }

  function aiHeaderPopover(c) {
    return close => colCard(c.name, [
      ['Question asked of every row', c.prompt],
      ['Where it comes from', 'The agent answers the question for each row from the evidence already gathered for that row.'],
      ['How to read it', 'Short answers per row; open a row to see the evidence behind it.'],
      ['Limits', 'Prototype: answers are simulated from each row’s data, not generated by the model.'],
    ], [el('button', { type: 'button', class: 'ci-remove', onclick: () => { close(); removeAiColumn(c.id); } }, icon('x', { size: 13 }), 'Remove column')]);
  }

  function simulateAi(c, r) {
    const q = c.prompt.toLowerCase();
    const { prog, req, lead } = r;
    const fs = req?.own?.findings || [];
    const years = [...new Set(fs.map(f => f.audit_year))].sort();
    const pv = req?.peer;
    if (/repeat|recur|again|more than one/.test(q)) {
      if (!req) return 'Not applicable (program row)';
      return years.length > 1 ? `Yes · ${years.join(', ')}` : years.length === 1 ? `Once · ${years[0]}` : 'No own finding';
    }
    if (/severity|serious|material weakness|deficien/.test(q)) {
      if (!fs.length) return req ? 'No own finding' : '—';
      const mw = fs.filter(f => f.material_weakness).map(f => f.audit_year);
      const sd = fs.filter(f => f.significant_deficiency).map(f => f.audit_year);
      return mw.length ? `Material weakness (${[...new Set(mw)].join(', ')})` : sd.length ? `Significant deficiency (${[...new Set(sd)].join(', ')})` : 'Other finding';
    }
    if (/questioned cost/.test(q)) {
      if (!fs.length) return req ? 'No own finding' : '—';
      const qc = fs.filter(f => f.questioned_costs).map(f => f.audit_year);
      return qc.length ? `Yes · ${[...new Set(qc)].join(', ')}` : 'No';
    }
    if (/record|document|request|evidence|ask|prove/.test(q)) {
      if (lead?.verification_question) return lead.verification_question;
      return req ? `${requirementName(req.letter, req.requirement)} support for a sample of this year’s transactions` : '—';
    }
    if (/peer|other nonprofit|common|typical/.test(q)) {
      return pv?.n ? `${fmtInt(pv.k)} of ${fmtInt(pv.n)} comparable audits` : prog.peer?.n_reports ? `${fmtInt(prog.peer.n_reports)} comparable audits, none here` : 'No comparable audits';
    }
    if (/narrative|support|match|trust|confiden/.test(q)) {
      const s = lead?.evidence_check?.status;
      return s ? ({ supported: 'Supported by the source text', weak_match: 'Weak match to the requirement', conflict: 'Evidence conflicts' }[s] || 'Not checked') : 'Not checked (not a top-five lead)';
    }
    if (lead) return `${lead.short_title || requirementName(req.letter, req.requirement)}: ${GROUP_SHORT[req.group] || 'see evidence'}`;
    return req ? (req.conclusion || '—') : (prog.state_reason || '—');
  }

  function aiCell(c, r, idx) {
    const done = generating.get(c.ai.id);
    if (done != null && idx >= done) return el('div', { class: 'cv ai-pending', 'aria-label': 'Generating' }, el('span', { class: 'ai-shimmer' }));
    const t = simulateAi(c.ai, r);
    return el('div', { class: 'cv', title: ctx.prefs.wrap ? null : t }, t);
  }

  // ------------------------------------------------------------------ render
  function render({ keepScroll = true } = {}) {
    const a = ctx.state.assessment;
    if (!a) return renderEmpty();
    const wrapOld = $('#grid-wrap', root);
    const scroll = keepScroll && wrapOld ? [wrapOld.scrollLeft, wrapOld.scrollTop] : null;
    rows = buildRows(a);
    visible = applyFilter();
    fill(root, banners(a), toolbar(a), programFocus(a), el('div', { class: 'grid-area', id: 'grid-area' }, gridWrap(a), footLine()));
    if (scroll) { const w = $('#grid-wrap', root); w.scrollLeft = scroll[0]; w.scrollTop = scroll[1]; }
    ctx.actions.afterGridRender?.();
  }

  function renderEmpty() {
    const busy = ctx.state.pending.has(ctx.state.engId);
    fill(root, el('div', { class: 'empty-state' },
      el('div', { class: 'empty-icon' }, icon('list', { size: 22 })),
      el('h2', {}, 'No assessment yet'),
      el('p', {}, 'The agent ranks the areas most worth checking from public audit history, and every program it considered appears here with its evidence. Takes about a minute.'),
      el('div', { class: 'empty-actions' },
        el('button', { type: 'button', class: 'btn btn-primary', disabled: busy || null, onclick: () => (ctx.state.meta?.model_available === false ? ctx.actions.runAssess() : ctx.actions.sendPrompt('Assess likely risk areas for this engagement')) }, 'Assess this engagement'),
        ctx.state.meta?.model_available === false ? el('p', { class: 'small muted' }, 'No API key is set on the server, so this builds the ranking with source-based sentences. The model-written brief and chat need ANTHROPIC_API_KEY.') : null)));
  }

  function renderLoading(text = 'Loading assessment…') {
    fill(root, el('div', { class: 'loading-block', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), text));
  }

  function renderError(message, retry) {
    fill(root, el('div', { class: 'empty-state' }, el('div', { class: 'error-block', role: 'alert' },
      el('strong', {}, 'Could not load the assessment. '), message,
      retry ? el('div', {}, el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: retry }, 'Try again')) : null)));
  }

  function banners(a) {
    const items = [];
    const latest = ctx.state.detail?.latest_assessment_id;
    if (latest && latest !== a.assessment_id) {
      items.push(banner('Earlier version', `You are viewing v${a.version}. Decisions you record here are saved to v${a.version}.`,
        el('button', { type: 'button', class: 'btn btn-secondary btn-xs', onclick: () => ctx.actions.selectAssessment(latest) }, 'View latest')));
    }
    const changed = (a.version > 1 || a.parent_assessment_id) && a.change_summary;
    if (ctx.isPostReveal(a)) {
      items.push(banner(`v${a.version} · Post-reveal`, `${changed ? `${a.change_summary.replace(/\.$/, '')}. ` : ''}Created after reported outcomes were revealed, so it is not part of the frozen prediction.`));
    } else if (changed) {
      items.push(banner(`v${a.version}`, a.change_summary));
    }
    return items.length ? el('div', { class: 'banners' }, ...items) : null;
  }

  function banner(tag, text, action) {
    return el('div', { class: 'banner' }, el('span', { class: 'banner-tag' }, tag), el('span', { class: 'banner-text' }, text), action || null);
  }

  // ------------------------------------------------------------------ program review
  // When the table is filtered to a program in the plan, the plan's context for that program sits
  // above its evidence rows: the plan sentence, its areas and decisions, and prev/next through the plan.
  function planPrograms(a) {
    const order = [];
    for (const r of [...(a?.risks || [])].sort((x, y) => x.rank - y.rank)) if (!order.includes(r.program_row_id)) order.push(r.program_row_id);
    return order;
  }

  function programFocus(a) {
    const pid = ctx.state.filter.program;
    const plan = planPrograms(a);
    const i = plan.indexOf(pid);
    if (pid === 'all' || i < 0) return null;
    const prog = a.program_assessments.find(p => p.row_id === pid);
    const leads = a.risks.filter(r => r.program_row_id === pid).sort((x, y) => x.rank - y.rank);
    const claims = a.brief?.claims || [];
    const ofProg = c => c.row_ids.length && c.row_ids.every(r => r.split(':')[1] === prog.aln);
    const planClaims = claims.filter(c => c.kind === 'program_focus' && ofProg(c));
    const shown = planClaims.length ? planClaims : claims.filter(c => c.section === 'focus' && c.display_in !== 'row_note' && ofProg(c)).slice(0, 1);
    const dec = r => ctx.decisions.get(a.assessment_id, r.requirement_row_id).disposition;
    const nDecided = leads.filter(dec).length;
    const go = j => setFilter({ program: plan[j], state: 'all' });
    const name = ctx.actions.displayName(prog.program_name) || prog.program_name;
    return el('section', { class: 'pfocus', 'aria-label': `Program review: ${prog.aln}` },
      el('div', { class: 'pfocus-top' },
        el('span', { class: 'pfocus-k' }, `Program ${i + 1} of ${plan.length} in the plan`),
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn-link small', onclick: () => ctx.actions.openBrief() }, '← Back to brief'),
        el('button', { type: 'button', class: 'tb-btn', disabled: i === 0 || null, onclick: () => go(i - 1) }, '‹ Previous'),
        el('button', { type: 'button', class: 'tb-btn', disabled: i === plan.length - 1 || null, onclick: () => go(i + 1) }, 'Next program ›'),
        el('button', { type: 'button', class: 'btn-link small', onclick: () => setFilter({ program: 'all' }) }, 'All programs')),
      el('h3', { class: 'pfocus-h' }, `${prog.aln} ${name}`, el('span', { class: 'pfocus-amt' }, fmtMoney(prog.amount))),
      shown.length ? el('ul', { class: 'pfocus-why' }, ...shown.map(c => claimItem(ctx, a, c))) : null,
      el('div', { class: 'pfocus-areas' },
        ...leads.map(r => el('button', { type: 'button', class: `rec-area${dec(r) ? ' is-decided' : ''}`, title: `Open ${r.requirement_row_id}`, onclick: () => ctx.actions.gotoRef(r.requirement_row_id) },
          el('span', { class: 'rec-area-id' }, r.lead_id), ` ${r.short_title || r.requirement_name}`,
          el('span', { class: 'rec-area-basis' }, ` · ${dec(r) ? DISPOSITION_LABELS[dec(r)] : 'no decision'}`))),
        el('span', { class: 'pfocus-count' }, `${nDecided} of ${leads.length} areas decided`)),
      programDecision(ctx, a, pid),
      el('p', { class: 'pdec-hint' }, 'Your planning focus for this program. It does not replace the major-program selection required under 2 CFR 200.518.'));
  }

  // ------------------------------------------------------------------ toolbar
  function filterLabel() {
    const f = ctx.state.filter;
    const parts = [];
    if (f.state !== 'all') parts.push(STATE_FILTERS.find(x => x[0] === f.state)?.[1]);
    if (f.program !== 'all') parts.push(f.program.replace(/^P:/, ''));
    return parts.length ? `Filter · ${parts.join(', ')}` : 'Filter';
  }

  function toolbar(a) {
    const p = ctx.prefs;
    const collapsed = !!p.chatCollapsed;
    const sw = (id, text, on, onToggle) => el('button', { type: 'button', class: 'switch', id, role: 'switch', 'aria-checked': String(!!on), onclick: onToggle },
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-thumb' })), el('span', { class: 'switch-label' }, text));
    const filtered = ctx.state.filter.state !== 'all' || ctx.state.filter.program !== 'all';
    const historical = ctx.state.detail?.engagement?.mode === 'historical';
    const iconBtn = (id, ic, label, onclick) => el('button', { type: 'button', class: 'tb-icon tb-icon-lg', id, 'aria-label': label, title: label, 'aria-haspopup': id === 'export-btn' ? null : 'dialog', 'aria-expanded': 'false', onclick }, icon(ic, { size: 16 }));
    return el('div', { class: 'toolbar tb-main', role: 'toolbar', 'aria-label': 'Review table tools' },
      (a?.risks || []).length ? el('button', { type: 'button', class: 'btn btn-primary btn-sm', id: 'brief-btn', title: 'The overall recommendation: which programs and areas to focus on, early client requests, and where history can’t help', onclick: () => ctx.actions.openBrief() },
        icon('sparkle', { size: 14 }), 'Planning brief') : null,
      historical ? el('button', { type: 'button', class: 'tb-btn', id: 'eval-btn', title: 'Replay only: reveal what the filed audit reported and compare it with the saved prediction', onclick: () => ctx.actions.openEval() },
        icon('scale', { size: 14 }), 'Compare with outcomes') : null,
      filtered ? el('button', { type: 'button', class: 'tb-chip', title: 'Clear filter', onclick: () => setFilter({ state: 'all', program: 'all' }) },
        filterLabel().replace(/^Filter · /, ''), ` · ${visible.length} of ${rows.length}`, icon('x', { size: 12 })) : null,
      el('span', { class: 'spacer' }),
      iconBtn('about-btn', 'info', 'About this review', e => openPopover(e.currentTarget, ctx.actions.aboutReview, { label: 'About this review', cls: 'pop-wide', placement: 'below-end' })),
      iconBtn('display-btn', 'text', 'Display options', e => openPopover(e.currentTarget, displayMenu, { label: 'Display options', cls: 'menu-pop', placement: 'below-end' })),
      iconBtn('columns-btn', 'columns', 'Columns', e => openPopover(e.currentTarget, columnsMenu, { label: 'Columns', cls: 'menu-pop', placement: 'below-end' })),
      iconBtn('export-btn', 'download', 'Export staff note', () => ctx.actions.openExport()));
  }

  function setPref(key, value) {
    ctx.prefs[key] = value;
    ctx.savePrefs();
    render();
    $(`#${{ showCheck: 'sw-check', wrap: 'sw-wrap', group: 'sw-group' }[key]}`, root)?.focus();
  }

  function setFilter(patch) {
    Object.assign(ctx.state.filter, patch);
    render({ keepScroll: false });
  }

  function menuItem(text, { checked, count, onclick, role = 'menuitemradio' }) {
    return el('button', { type: 'button', class: 'menu-item', role, 'aria-checked': String(!!checked), onclick },
      el('span', { class: 'menu-check', 'aria-hidden': 'true' }, checked ? icon('check', { size: 14 }) : null),
      el('span', { class: 'menu-text' }, text),
      count != null ? el('span', { class: 'menu-count' }, String(count)) : null);
  }

  function rankFilterMenu(close) {
    const f = ctx.state.filter;
    return el('div', { class: 'menu', role: 'menu', 'aria-label': 'Filter by rank' },
      el('div', { class: 'menu-h' }, 'Show'),
      ...STATE_FILTERS.map(([v, t]) => menuItem(t, {
        checked: f.state === v, count: rows.filter(ROW_TEST[v]).length,
        onclick: () => { close(); setFilter({ state: v }); },
      })));
  }

  function programFilterMenu(close) {
    const f = ctx.state.filter;
    const progs = ctx.state.assessment?.program_assessments || [];
    return el('div', { class: 'menu', role: 'menu', 'aria-label': 'Filter by program' },
      el('div', { class: 'menu-h' }, 'Program'),
      menuItem('All programs', { checked: f.program === 'all', onclick: () => { close(); setFilter({ program: 'all' }); } }),
      ...progs.map(p => menuItem(`${p.aln} ${shortName(p.program_name, 34)}`, {
        checked: f.program === p.row_id, count: rows.filter(r => r.prog.row_id === p.row_id).length,
        onclick: () => { close(); setFilter({ program: p.row_id }); },
      })));
  }

  function displayMenu(close) {
    const p = ctx.prefs;
    return el('div', { class: 'menu', role: 'menu', 'aria-label': 'Display options' },
      el('div', { class: 'menu-h' }, 'Display'),
      menuItem('Text wrapping', { checked: p.wrap, role: 'menuitemcheckbox', onclick: () => { close(); setPref('wrap', !p.wrap); } }),
      menuItem('Group by program', { checked: p.group, role: 'menuitemcheckbox', onclick: () => { close(); setPref('group', !p.group); } }));
  }

  function filterMenu(close) {
    const f = ctx.state.filter;
    const progs = ctx.state.assessment?.program_assessments || [];
    return el('div', { class: 'menu', role: 'menu', 'aria-label': 'Filter rows' },
      el('div', { class: 'menu-h' }, 'Rows'),
      ...STATE_FILTERS.map(([v, t]) => menuItem(t, {
        checked: f.state === v, count: rows.filter(ROW_TEST[v]).length,
        onclick: () => { close(); setFilter({ state: v }); },
      })),
      el('div', { class: 'menu-sep' }),
      el('div', { class: 'menu-h' }, 'Program'),
      menuItem('All programs', { checked: f.program === 'all', onclick: () => { close(); setFilter({ program: 'all' }); } }),
      ...progs.map(p => menuItem(`${p.aln} ${shortName(p.program_name, 34)}`, {
        checked: f.program === p.row_id, count: rows.filter(r => r.prog.row_id === p.row_id).length,
        onclick: () => { close(); setFilter({ program: p.row_id }); },
      })));
  }

  function columnsMenu(close) {
    const p = ctx.prefs;
    const wrap = el('div', { class: 'menu', role: 'menu', 'aria-label': 'Columns' }, el('div', { class: 'menu-h' }, 'Columns'));
    const draw = () => {
      fill(wrap,
        el('button', { type: 'button', class: 'menu-item ai-new', onclick: () => { fill(wrap, aiForm(close, draw)); keepOnScreen(wrap); } },
          el('span', { class: 'menu-check', 'aria-hidden': 'true' }, icon('sparkle', { size: 14 })),
          el('span', { class: 'menu-text' }, el('strong', {}, 'New AI column…'), el('span', { class: 'menu-sub' }, 'Ask a question of every row'))),
        ...(aiCols().length ? [el('div', { class: 'menu-sep' }), el('div', { class: 'menu-h' }, 'AI columns'),
          ...aiCols().map(c => el('div', { class: 'menu-ai-row' },
            el('span', { class: 'menu-check', 'aria-hidden': 'true' }, icon('sparkle', { size: 13 })),
            el('span', { class: 'menu-text', title: c.prompt }, c.name),
            el('button', { type: 'button', class: 'tb-icon', 'aria-label': `Remove ${c.name}`, onclick: () => { removeAiColumn(c.id); draw(); } }, icon('x', { size: 13 }))))] : []),
        el('div', { class: 'menu-sep' }),
        el('div', { class: 'menu-h' }, 'Columns'),
        ...COLS.filter(c => (c.fixed && !c.optional) || c.pinned).map(c => { const m = menuItem(c.label, { checked: true, role: 'menuitemcheckbox', onclick: () => {} }); m.disabled = true; return m; }),
        ...COLS.filter(c => c.optional).map(c => menuItem(c.label, {
          checked: p.cols[c.id] !== false, role: 'menuitemcheckbox',
          onclick: () => { p.cols[c.id] = p.cols[c.id] === false; ctx.savePrefs(); render(); draw(); },
        })),
        el('div', { class: 'menu-sep' }),
        el('p', { class: 'menu-note' }, 'Evidence check: whether the agent found the source text supports the lead (top five only).'));
    };
    draw();
    return wrap;
  }

  // ------------------------------------------------------------------ table
  function gridWrap(a) {
    const cols = visibleCols();
    let left = 0;
    const fixedLeft = {};
    for (const c of cols) if (c.fixed) { fixedLeft[c.id] = left; left += c.w; }
    const lastFixed = cols.filter(c => c.fixed).at(-1)?.id;
    const width = cols.reduce((s, c) => s + c.w, 0);
    const cellAttrs = (c, extra = '') => ({
      class: `${c.cls || ''} ${c.num ? 'num' : ''} ${c.fixed ? 'fx' : ''} ${c.id === lastFixed ? 'fx-last' : ''} ${extra}`.replace(/\s+/g, ' ').trim(),
      style: c.fixed ? `left:${fixedLeft[c.id]}px` : null,
    });
    const head = el('tr', {}, ...cols.map(c => {
      if (c.add) return el('th', { scope: 'col', class: 'th-add-cell' }, el('button', {
        type: 'button', class: 'th-add', id: 'add-col-btn', 'aria-label': 'Add a column', title: 'Add a column', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
        onclick: e => openPopover(e.currentTarget, columnsMenu, { label: 'Add a column', cls: 'menu-pop', placement: 'below-end' }),
      }, icon('plus', { size: 15 })));
      if (c.ai) return el('th', { scope: 'col', ...cellAttrs(c, 'th-ai') }, el('button', {
        type: 'button', class: 'th-ai-btn', title: c.ai.prompt, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
        onclick: e => openPopover(e.currentTarget, aiHeaderPopover(c.ai), { label: `AI column ${c.label}`, cls: 'menu-pop' }),
      }, el('span', { class: 'th-in' }, icon('sparkle', { size: 13 }), el('span', {}, c.label))));
      const f = ctx.state.filter;
      const funnel = c.id === 'n' || c.id === 'program' ? el('button', {
        type: 'button', class: `th-filter${(c.id === 'n' ? f.state !== 'all' : f.program !== 'all') ? ' on' : ''}`,
        'aria-label': `Filter by ${c.label.toLowerCase()}`, title: `Filter by ${c.label.toLowerCase()}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
        onclick: e => { e.stopPropagation(); openPopover(e.currentTarget, c.id === 'n' ? rankFilterMenu : programFilterMenu, { label: 'Filter', cls: 'menu-pop' }); },
      }, icon('filter', { size: 12 })) : null;
      return el('th', { scope: 'col', ...cellAttrs(c) },
        el('span', { class: 'th-in' }, c.icon ? icon(c.icon, { size: 13 }) : null, el('span', {}, c.label), funnel, colInfoBtn(c)));
    }));
    const body = el('tbody', {});
    if (!visible.length) {
      body.append(el('tr', {}, el('td', { colspan: String(cols.length), class: 'grid-empty' },
        'No rows match this filter. ', el('button', { type: 'button', class: 'btn-link', onclick: () => setFilter({ state: 'all', program: 'all' }) }, 'Clear filter'))));
    } else if (ctx.prefs.group) {
      let n = 0;
      const order = [];
      for (const r of visible) if (!order.includes(r.prog)) order.push(r.prog);
      for (const p of order) {
        const members = visible.filter(r => r.prog === p);
        body.append(el('tr', { class: 'group-row' }, el('th', { scope: 'rowgroup', colspan: String(cols.length) },
          el('div', { class: 'group-head' }, icon('doc', { size: 14 }),
            el('span', { class: 'gh-name' }, `${p.aln} ${p.program_name || ''}`),
            badge(p.state), el('span', { class: 'gh-meta' }, `${fmtMoney(p.amount)} · ${plural(members.length, 'row')}`)))));
        for (const r of members) body.append(rowEl(r, ++n, cols, cellAttrs, a));
      }
    } else {
      visible.forEach((r, i) => body.append(rowEl(r, i + 1, cols, cellAttrs, a)));
    }
    body.addEventListener('click', onBodyClick);
    body.addEventListener('keydown', onBodyKey);
    const table = el('table', { class: `grid${ctx.prefs.wrap ? ' wrap' : ''}`, style: `width:100%;min-width:${width}px`, 'aria-label': 'Program × requirement review rows', 'aria-rowcount': String(visible.length + 1) },
      el('colgroup', {}, ...cols.map(c => el('col', { style: c.add ? null : `width:${c.w}px` }))),
      el('thead', {}, head), body);
    return el('div', { class: 'grid-wrap', id: 'grid-wrap' }, table);
  }

  function rowEl(r, n, cols, cellAttrs, a) {
    const sel = ctx.state.selectedRow === r.rowId;
    const tr = el('tr', {
      class: `grid-row st-${r.state}${r.lead ? ' is-lead' : ''}${sel ? ' selected' : ''}`,
      dataset: { rowId: r.rowId, progId: r.prog.row_id }, tabindex: sel || (!ctx.state.selectedRow && n === 1) ? '0' : '-1', 'aria-selected': String(sel),
    });
    for (const c of cols) tr.append(el('td', cellAttrs(c, c.ai ? 'c-ai' : c.add ? 'c-add' : `c-${c.id}`), c.ai ? aiCell(c, r, rows.indexOf(r)) : c.add ? '' : cell(c, r, n, a)));
    return tr;
  }

  const dash = () => el('span', { class: 'dash' }, '—');
  const cv = (content, title) => el('div', { class: 'cv', title: title || null }, content);

  function cell(c, r, n, a) {
    const { prog, req, lead } = r;
    switch (c.id) {
      case 'n': return r.state === 'related' ? el('span', { class: 'rn rn-related', title: `Related tag of ${req.related_to_lead || req.issue_of}: same findings` }, '↳')
        : isRanked(r) ? el('span', { class: `rn${r.lead ? ' rn-reviewed' : ''}` }, String(rankOf(r)))
        : el('span', { class: 'rn dash', title: 'Not ranked: see Why it’s flagged for the reason' }, '—');
      case 'program': return cv([icon('doc', { size: 14, cls: 'cell-ic' }), el('span', { class: 'mono-num' }, prog.aln), ' ', prog.program_name || ''], `${prog.aln} ${prog.program_name || ''}`);
      case 'req': return req ? cv([el('span', { class: 'req-l' }, req.letter), ' ', requirementName(req.letter, req.requirement)], `${req.row_id}: ${requirementName(req.letter, req.requirement)}`) : cv(dash(), 'No requirement rows for this program');
      case 'state': return cv(stateBadgeShort(r.state, r.state === 'lead' ? (req?.rank ?? lead?.rank) : r.state === 'related' ? (req?.related_to_lead || '') : req?.candidate_rank));
      // Older records have no short_title; the risk sentence is more useful here than repeating the requirement.
      case 'lead': {
        if (r.state === 'related') { const pl = (a.risks || []).find(x => x.requirement_row_id === req.issue_of); const t = pl ? `Related tag of ${pl.lead_id} · ${pl.short_title || pl.requirement_name}` : `Related tag of ${req.issue_of}`; return cv(el('span', { class: 'muted' }, t), t); }
        if (!lead) return cv(isRanked(r) ? el('span', { class: 'muted small' }, req?.review_note ? 'Checked; moved below the top five' : 'Not reviewed by the agent') : dash(), req?.review_note || null); const t = lead.short_title || lead.plain_language_risk || lead.requirement_name || requirementName(lead.requirement_code);
        return cv([el('span', { class: 'lead-t' }, t), lead.conditional ? el('span', { class: 'tag tag-sand tag-xs', title: lead.conditional }, 'Conditional') : null,
          (lead.related || []).length ? el('span', { class: 'tag tag-xs', title: `Also tagged: ${lead.related.map(x => x.requirement_name).join(', ')}` }, `+${lead.related.length} related`) : null], ctx.prefs.wrap ? null : t); }
      case 'basis': return req?.group ? cv(GROUP_SHORT[req.group] || req.group_label || req.group) : cv(dash());
      case 'own': return ownCell(r);
      case 'peers': return peersCell(r, a);
      case 'amount': return cv(fmtMoney(prog.amount));
      case 'check': return lead ? cv(checkBadge(lead.evidence_check?.status)) : cv(dash());
      case 'sources': return lead ? sourcesCell(lead) : cv(dash());
      case 'why': {
        const t = lead ? lead.why_this_client : req ? req.conclusion : prog.state_reason;
        return t ? cv(t, ctx.prefs.wrap ? null : t) : cv(dash());
      }
      case 'ask': return lead?.verification_question ? cv(lead.verification_question, ctx.prefs.wrap ? null : lead.verification_question) : cv(dash());
      case 'decision': return decisionSelect(r.rowId, a);
      case 'note': return noteCell(r.rowId, a);
      default: return cv(dash());
    }
  }

  function ownCell({ prog, req }) {
    if (req) {
      const own = req.own;
      const fs = own?.findings || [];
      if (!own || !(own.n_reports_with_finding || fs.length)) {
        return cv(el('span', { class: 'muted' }, 'None reported'), 'No own finding in this requirement in admissible reports. Not evidence that the area is free of issues.');
      }
      const years = own.years || [...new Set(fs.map(f => f.audit_year))];
      return cv(`${fmtYears(years)} · ${plural(fs.length || own.n_reports_with_finding, 'finding')}`);
    }
    const c = prog.own_coverage || {};
    if (!(c.years_present || []).length) return cv(el('span', { class: 'muted' }, 'Not in own reports'));
    return cv(`Present ${fmtYears(c.years_present)} · major ${fmtYears(c.years_audited_major) || 'never'}`);
  }

  function peersCell({ prog, req }, a) {
    const min = a.params?.min_peer_reports;
    if (req?.peer?.n) {
      const share = fmtShare(req.peer.k, req.peer.n);
      return cv(`${fmtInt(req.peer.k)} of ${fmtInt(req.peer.n)}`, share ? `${share} reported-finding share among comparable audits (not a probability)` : null);
    }
    const n = prog.peer?.n_reports;
    if (!n) return cv(dash(), 'No same-program reports');
    return cv([`${fmtInt(n)} reports`, min && n < min ? el('span', { class: 'muted' }, ` · min ${min}`) : null], prog.peer?.rule || null);
  }

  function sourcesCell(lead) {
    const s = lead.sources || [];
    if (!s.length) return cv(dash());
    const first = s.slice(0, 2).map(x => el('span', { class: `mini-chip src-${x.kind}` }, `${x.kind === 'own' ? 'Own' : 'Peer'} ${x.reference_number || x.audit_year || ''}`));
    return cv([...first, s.length > 2 ? el('span', { class: 'muted' }, ` +${s.length - 2}`) : null]);
  }

  function decisionSelect(rowId, a) {
    const d = ctx.decisions.get(a.assessment_id, rowId);
    const sel = el('select', {
      class: `dec-select disp-${d.disposition || 'none'}`, 'aria-label': `Decision for ${rowId}`, dataset: { decisionSelect: rowId },
      onchange: e => ctx.decisions.setDisposition(a.assessment_id, rowId, e.target.value || null),
    }, el('option', { value: '' }, '—'), ...DISPOSITIONS.map(o => el('option', { value: o.value }, o.label)));
    sel.value = d.disposition || '';
    return sel;
  }

  function noteCell(rowId, a) {
    const d = ctx.decisions.get(a.assessment_id, rowId);
    return el('button', {
      type: 'button', class: 'note-cell', dataset: { noteFor: rowId }, title: d.note ? d.note : 'Add a note',
      'aria-label': d.note ? `Edit note for ${rowId}` : `Add a note for ${rowId}`,
      onclick: () => { select(rowId, { open: false }); ctx.actions.openPanel(rowId, { focusNote: true }); },
    }, d.note ? el('span', { class: 'cv' }, d.note) : el('span', { class: 'dash' }, '—'));
  }

  function footLine() {
    return el('p', { class: 'grid-foot' },
      'Ranks order the review; they don’t estimate likelihood. No reported finding ≠ low risk. ',
      infoButton('About ranks, peer counts and missing findings', () => el('div', { class: 'pop-body' },
        el('h3', {}, 'Reading this table'),
        el('ul', {},
          el('li', {}, 'Rows are areas to investigate, drawn from public history. None is a current-year finding.'),
          el('li', {}, 'Rank orders areas for staff review. It is not a calibrated chance of a finding, and no Low/Medium/High label is implied.'),
          el('li', {}, 'Same-program counts read “k of n audits reported a finding” (other nonprofits, not verified peers). The share is a reported-finding share, not a probability.'),
          el('li', {}, 'A missing reported finding is not a clean result: auditors test only selected major programs and report only what they find.'),
          el('li', {}, 'Rows cover requirements with some historical signal, not every compliance requirement the audit must test.'))), { placement: 'below-start' }));
  }

  // ------------------------------------------------------------------ selection
  function onBodyClick(e) {
    if (e.target.closest('select, button, a, input, textarea, label')) return;
    const tr = e.target.closest('tr.grid-row');
    if (tr) select(tr.dataset.rowId, { open: true, focus: true });
  }

  function onBodyKey(e) {
    const tr = e.target.closest?.('tr.grid-row');
    if (!tr || e.target !== tr) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(tr.dataset.rowId, { open: true }); }
    else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); moveSelection(1, { fromRow: tr.dataset.rowId }); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); moveSelection(-1, { fromRow: tr.dataset.rowId }); }
  }

  function rowNode(rowId) {
    return $(`tr.grid-row[data-row-id="${cssEscape(rowId)}"]`, root);
  }

  function select(rowId, { open = true, scroll = true, focus = false } = {}) {
    ctx.state.selectedRow = rowId;
    for (const tr of $$('tr.grid-row', root)) {
      const on = tr.dataset.rowId === rowId;
      tr.classList.toggle('selected', on);
      tr.setAttribute('aria-selected', String(on));
      tr.tabIndex = on ? 0 : -1;
    }
    const tr = rowNode(rowId);
    if (tr && scroll) tr.scrollIntoView({ block: 'nearest' });
    if (tr && focus) tr.focus({ preventScroll: true });
    if (open) ctx.actions.openPanel(rowId);
  }

  function clearSelection() {
    ctx.state.selectedRow = null;
    for (const tr of $$('tr.grid-row.selected', root)) { tr.classList.remove('selected'); tr.setAttribute('aria-selected', 'false'); }
  }

  function moveSelection(delta, { fromRow = ctx.state.selectedRow, open = null } = {}) {
    if (!visible.length) return null;
    const i = visible.findIndex(r => r.rowId === fromRow);
    const next = visible[Math.min(visible.length - 1, Math.max(0, (i < 0 ? 0 : i + delta)))];
    const panelOpen = open ?? ctx.actions.isPanelOpen();
    select(next.rowId, { open: panelOpen, focus: true });
    return next.rowId;
  }

  function position(rowId) {
    const i = visible.findIndex(r => r.rowId === rowId);
    return { index: i, total: visible.length };
  }

  function flash(node) {
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 2400);
  }

  /** Select and reveal a row (requirement row id, program row id). Returns false if absent. */
  function gotoRow(rowId) {
    let target = findRowModel(rowId);
    if (!target && rowId.startsWith('P:')) target = rows.find(r => r.prog.row_id === rowId) || null;
    if (!target) return false;
    if (!visible.includes(target)) {
      ctx.state.filter = { state: 'all', program: 'all' };
      render({ keepScroll: false });
      ctx.toast('Filter cleared to show that row.');
    }
    select(target.rowId, { open: true, focus: true });
    const tr = rowNode(target.rowId);
    if (tr) {
      tr.scrollIntoView({ block: 'center' });
      if (rowId.startsWith('P:')) for (const x of $$(`tr.grid-row[data-prog-id="${cssEscape(rowId)}"]`, root)) flash(x);
      else flash(tr);
    }
    return true;
  }

  function updateDecision(aid, rowId, e) {
    if (ctx.state.assessment?.assessment_id !== aid) return;
    syncProgramDecision(root, rowId, e);
    for (const s of $$(`select[data-decision-select="${cssEscape(rowId)}"]`, root)) {
      if (s.value !== (e.disposition || '')) s.value = e.disposition || '';
      s.className = `dec-select disp-${e.disposition || 'none'}`;
    }
    for (const b of $$(`[data-note-for="${cssEscape(rowId)}"]`, root)) {
      fill(b, e.note ? el('span', { class: 'cv' }, e.note) : el('span', { class: 'dash' }, '—'));
      b.title = e.note || 'Add a note';
    }
  }

  return { setFilter, render, renderEmpty, renderLoading, renderError, select, clearSelection, moveSelection, gotoRow, updateDecision, position, findRowModel, allRows, rowNode };
}
