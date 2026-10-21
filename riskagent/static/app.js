// Single Audit Risk Brief: shell (sidebar of engagement folders and threads), header, chat, and view wiring.
// The grid, detail panel, evaluation view, export and new-engagement dialog are separate modules
// sharing `ctx` (state, prefs, api, decisions, actions).

import { api } from './api.js';
import { renderMarkdown } from './markdown.js';
import {
  el, $, $$, fill, fmtDate, fmtDateTime, fmtShortDateTime, fmtTime, plural, shortName, unavailableLines,
  MODE_LABELS, PROGRAM_SOURCE_LABELS, IDENTITY_FLAG_LABELS, toolLabel, loadPrefs, savePrefs, idMethodLabel, fmtInt,
} from './util.js';
import { icon } from './icons.js';
import { openPopover, closePopover, infoButton } from './popover.js';
import { DecisionStore } from './decisions.js';
import { createGrid } from './grid.js';
import { createPanel } from './panel.js';
import { createEvaluation } from './evaluation.js';
import { createExport } from './export.js';
import { createNewEngagement } from './new-engagement.js';
import { createTrace } from './trace.js';
import { createRecommendation } from './recommend.js';

const state = {
  meta: null,
  engagements: [],
  engId: null,
  detail: null,
  messages: [],
  selectedAid: null,
  progress: new Map(),
  assessment: null,
  assessments: new Map(),
  reveal: null,
  view: 'review',
  selectedRow: null,
  filter: { state: 'all', program: 'all' },
  pending: new Map(),     // engagement_id -> {text, startedAt, kind, ctrl}
  chatError: new Map(),
  openSteps: new Set(),   // message ids with the steps box open
  expandedMsgs: new Set(),
  workingOpen: true,
  loadToken: 0,
  threadId: null,          // current conversation thread in the open engagement
  threads: [],             // threads of the open engagement (most recent first)
  threadsSupported: true,  // false when the backend has no thread endpoints yet
  openFolders: new Set(),  // engagement ids expanded in the sidebar
  renaming: null,          // thread id being renamed inline
};

const ctx = {
  state, api, toast, isPostReveal, actions: {},
  prefs: loadPrefs({ cols: {}, showCheck: false, wrap: false, group: false, chatCollapsed: false, sidebarCollapsed: false, topOn: true, topN: 5, unrankedOpen: true }),
  savePrefs: () => savePrefs(ctx.prefs),
};
ctx.decisions = new DecisionStore(api, (aid, rowId, e) => { grid.updateDecision(aid, rowId, e); panel.updateDecision(aid, rowId, e); if (e.status !== 'saving') recommendation?.render(); });
const grid = createGrid(ctx);
ctx.grid = grid;
const panel = createPanel(ctx);
const evaluation = createEvaluation(ctx);
const exporter = createExport(ctx);
const newEngagement = createNewEngagement(ctx);
const recommendation = createRecommendation(ctx, document.getElementById('brief-body'));
const tracer = createTrace(ctx);

const dom = {
  indexView: $('#index-view'),
  engView: $('#eng-view'),
  header: $('#eng-header'),
  engBody: $('#eng-body'),
  chatList: $('#chat-list'),
  chatForm: $('#chat-form'),
  chatInput: $('#chat-input'),
  chatSend: $('#chat-send'),
  chatStop: $('#chat-stop'),
  prompts: $('#prompt-list'),
  reviewView: $('#review-view'),
  evalView: $('#eval-view'),
  chatHead: $('#chat-head'),
};

let ticker = null;

// ------------------------------------------------------------------ helpers
function isPostReveal(a) {
  if (!a) return false;
  if (a.post_reveal) return true;
  const rv = state.reveal;
  return !!(rv && a.engagement_id === state.engId && a.version > rv.version);
}

function toast(message, kind = 'info') {
  const t = el('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 7000 : 3800);
}

const latestAid = () => state.detail?.latest_assessment_id || state.detail?.assessments?.at(-1)?.assessment_id || null;
const assessmentInfo = aid => (state.detail?.assessments || []).find(x => x.assessment_id === aid) || null;

async function ensureAssessment(aid) {
  if (!aid) return null;
  if (state.assessments.has(aid)) return state.assessments.get(aid);
  const rec = await api.getAssessment(aid);
  if (rec) state.assessments.set(aid, rec);
  return rec;
}

function parseHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { eng: p.get('eng'), asm: p.get('asm'), view: p.get('view'), thread: p.get('thread') };
}

function writeHash() {
  let h = '';
  if (state.engId) {
    h = `#eng=${encodeURIComponent(state.engId)}`;
    if (state.selectedAid && state.selectedAid !== latestAid()) h += `&asm=${encodeURIComponent(state.selectedAid)}`;
    if (state.view === 'eval') h += '&view=eval';
    if (state.threadId) h += `&thread=${encodeURIComponent(state.threadId)}`;
  }
  if (location.hash !== h) history.replaceState(null, '', h || `${location.pathname}${location.search}`);
}

function rowCount(a) {
  return (a?.program_assessments || []).reduce((n, p) => n + Math.max(1, (p.requirements || []).length), 0);
}

// ------------------------------------------------------------------ engagements (index + slide-out)
async function refreshEngagements() {
  try {
    state.engagements = (await api.listEngagements()) || [];
  } catch (e) {
    state.engagements = [];
    toast(`Could not load engagements: ${e.message}`, 'error');
  }
  renderSidebar();
  if (!state.engId) renderIndex();
}

function engMeta(e) {
  return [String(e.audit_year ?? ''), MODE_LABELS[e.mode] || e.mode || '', e.latest_version ? `v${e.latest_version}` : 'not assessed'].filter(Boolean).join(' · ');
}

const FALLBACK_THREAD = { thread_id: null, title: 'Conversation' };
const SMALL_WORDS = new Set(['of', 'and', 'the', 'for', 'in', 'on', 'at', 'to', 'a', 'an', 'de']);
const ACRONYMS = /^(INC|LLC|YMCA|YWCA|USA|II|III|IV|NC|NY|CA|TX|DBA|CDC|HIV|AIDS|FIP|HHS|HUD|WIC|SNAP|TANF|HRSA|UDS|COVID-19|ARP|CARES|ESG)\.?,?$/;

/** FAC names are often ALL CAPS; show them in title case. Mixed-case names are left alone. */
function niceName(name) {
  if (!name || name !== name.toUpperCase()) return name || '';
  return name.toLowerCase().split(/(\s+)/).map((w, i) => {
    if (/^\s+$/.test(w)) return w;
    const up = w.toUpperCase();
    if (ACRONYMS.test(up) && !/^INC/.test(up)) return up;
    if (i > 0 && SMALL_WORDS.has(w)) return w;
    return w.replace(/^([("']?)([a-z])/, (m, p1, c) => p1 + c.toUpperCase());
  }).join('');
}

function engThreads(e) {
  if (e.engagement_id === state.engId && state.threads.length) return state.threads;
  return e.threads?.length ? e.threads : [FALLBACK_THREAD];
}

// One conversation per engagement: there is no chat list to render.
function renderSidebar() {}

function applySidebarCollapsed() {}

// ------------------------------------------------------------------ threads
async function openThread(engId, threadId) {
  if (engId !== state.engId) return selectEngagement(engId, { thread: threadId });
  return selectThread(threadId);
}

async function selectThread(threadId) {
  if ((threadId ?? null) === (state.threadId ?? null)) { dom.chatInput.focus(); return; }
  const engId = state.engId;
  const prevLatest = latestAid();
  state.threadId = threadId;
  renderSidebar();
  renderChatHead();
  fill(dom.chatList, el('div', { class: 'loading-inline' }, 'Loading thread…'));
  let detail;
  try { detail = await api.getEngagement(engId, threadId); } catch (e) { toast(`Could not open the thread: ${e.message}`, 'error'); return; }
  if (state.engId !== engId) return;
  applyDetail(detail);
  renderChat();
  renderSidebar();
  writeHash();
  const latest = latestAid();
  if (latest && latest !== prevLatest) await loadAssessment(latest);
  dom.chatInput.focus();
}

async function newThread(engId) {
  if (engId !== state.engId) await selectEngagement(engId);
  if (!state.threadsSupported) {
    toast('Threads are not in this backend yet. Use the UX sandbox (port 8765) to try them.', 'error');
    return;
  }
  let t;
  try { t = await api.createThread(engId); } catch (e) {
    if (e.status === 404 || e.status === 405) { state.threadsSupported = false; renderSidebar(); }
    toast(e.status === 404 || e.status === 405 ? 'Threads are not in this backend yet. Use the UX sandbox (port 8765) to try them.' : `Could not create a thread: ${e.message}`, 'error');
    return;
  }
  state.threads = [{ ...t, n_messages: 0 }, ...state.threads.filter(x => x.thread_id !== t.thread_id)];
  const e = state.engagements.find(x => x.engagement_id === engId);
  if (e) e.threads = state.threads;
  await selectThread(t.thread_id);
}

async function renameThread(t, title) {
  title = (title || '').trim();
  if (!title || title === t.title) { renderSidebar(); return; }
  const old = t.title;
  t.title = title;
  renderSidebar();
  renderChatHead();
  try { await api.renameThread(t.thread_id, title); } catch (e) {
    t.title = old;
    renderSidebar();
    renderChatHead();
    toast(`Could not rename the thread: ${e.message}`, 'error');
  }
}

function currentThread() {
  return state.threads.find(t => (t.thread_id ?? null) === (state.threadId ?? null)) || state.threads[0] || FALLBACK_THREAD;
}

function renderChatHead() {
  const eng = state.detail?.engagement || {};
  const a = state.assessment;
  const name = niceName(a?.target_org?.name || eng.org_name) || 'Engagement';
  const year = a?.target_year ?? eng.audit_year;
  fill(dom.chatHead,
    el('nav', { class: 'ch-crumbs', 'aria-label': 'Breadcrumb' },
      el('button', { type: 'button', class: 'ch-back', 'aria-label': 'Back to engagements', title: 'Back to engagements', onclick: () => showIndex() }, icon('arrowLeft', { size: 15 })),
      el('button', { type: 'button', class: 'ch-crumb', onclick: () => showIndex() }, 'Engagements'),
      el('span', { class: 'ch-sep', 'aria-hidden': 'true' }, '›'),
      el('span', { class: 'ch-cur', title: `${name} · ${year ?? ''}` }, name, el('span', { class: 'ch-year' }, ` · ${year ?? ''}`))));
}

function showIndex() {
  state.engId = null;
  state.detail = null;
  state.assessment = null;
  state.selectedAid = null;
  panel.close({ restoreFocus: false });
  dom.engView.hidden = true;
  dom.indexView.hidden = false;
  writeHash();
  renderIndex();
  renderSidebar();
}

function renderIndex() {
  const list = state.engagements;
  const head = el('header', { class: 'page-head' },
    el('div', { class: 'ph-main' },
      el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, el('span', {}, 'Engagements'), el('span', { class: 'crumb-sep' }, '/')),
      el('h1', { class: 'ph-title' }, 'Engagements'),
      el('div', { class: 'ph-meta' },
        el('span', {}, plural(list.length, 'engagement')),
        el('span', {}, `FAC snapshot ${fmtDate(state.meta?.fac_snapshot_date)}`),
        el('span', {}, 'Areas to investigate, never findings'))),
    el('div', { class: 'ph-actions' }, el('button', { type: 'button', class: 'btn btn-primary', id: 'welcome-new', onclick: () => newEngagement.open() }, icon('plus', { size: 14 }), 'New engagement')));
  if (!list.length) {
    fill(dom.indexView, head, el('div', { class: 'empty-state' },
      el('div', { class: 'empty-icon' }, icon('list', { size: 22 })),
      el('h2', {}, 'No engagements yet'),
      el('p', {}, 'Create one for a nonprofit and audit year. The agent ranks up to five program × requirement areas to investigate from public reports filed before a system-set cutoff, and shows the evidence for each.')));
    return;
  }
  const rows = list.map((e, i) => el('tr', {
    class: 'grid-row', tabindex: '0', dataset: { engId: e.engagement_id },
    onclick: () => selectEngagement(e.engagement_id),
    onkeydown: ev => { if (ev.key === 'Enter') selectEngagement(e.engagement_id); },
  },
  el('td', { class: 'c-n' }, el('span', { class: 'rn' }, String(i + 1))),
  el('td', {}, el('div', { class: 'cv' }, icon('folder', { size: 14, cls: 'cell-ic' }), niceName(e.org_name) || e.engagement_id)),
  el('td', {}, el('div', { class: 'cv' }, String(e.audit_year ?? ''))),
  el('td', {}, el('div', { class: 'cv' }, MODE_LABELS[e.mode] || e.mode || '')),
  el('td', {}, el('div', { class: 'cv' }, e.latest_version ? `v${e.latest_version}` : el('span', { class: 'muted' }, 'Not assessed'))),
  el('td', {}, el('div', { class: 'cv' }, e.revealed ? 'Revealed' : el('span', { class: 'dash' }, '—'))),
  el('td', {}, el('div', { class: 'cv muted' }, fmtDateTime(e.created_at)))));
  fill(dom.indexView, head, el('div', { class: 'index-body' }, el('div', { class: 'grid-wrap static' }, el('table', { class: 'grid', 'aria-label': 'Engagements' },
    el('thead', {}, el('tr', {}, ...[['#'], ['Nonprofit', 'doc'], ['Audit year', 'clock'], ['Mode', 'tag'], ['Version', 'list'], ['Outcomes', 'scale'], ['Created', 'clock']]
      .map(([t, ic]) => el('th', { scope: 'col' }, el('span', { class: 'th-in' }, ic ? icon(ic, { size: 13 }) : null, t))))),
    el('tbody', {}, ...rows)))));
}

function renderMetaFoot() {
  const m = state.meta;
  $('#sb-about').title = m ? `FAC snapshot ${fmtDate(m.fac_snapshot_date)} · ${m.model || ''}` : 'About';
}

function aboutPopover() {
  const m = state.meta || {};
  return el('div', { class: 'pop-body' },
    el('h3', {}, 'Single Audit Risk Brief'),
    el('p', {}, 'Ranks up to five program × compliance-requirement areas to investigate for one nonprofit and audit year, from public Federal Audit Clearinghouse reports filed before a system-set cutoff. It recommends areas for staff verification; it never declares findings.'),
    el('dl', { class: 'facts' },
      el('dt', {}, 'FAC data snapshot'), el('dd', {}, `${fmtDate(m.fac_snapshot_date)} (local copy; nothing updates live)`),
      el('dt', {}, 'Model'), el('dd', {}, m.model || '—', m.model_available === false ? el('span', { class: 'err' }, ' · not available on the server') : null)));
}

// ------------------------------------------------------------------ engagement selection
async function selectEngagement(id, { aid = null, view = null, thread = null } = {}) {
  const token = ++state.loadToken;
  if (state.engId !== id) {
    state.view = view === 'eval' ? 'eval' : 'review';
    state.assessment = null;
    state.selectedAid = null;
    state.reveal = null;
    state.selectedRow = null;
    state.filter = { state: 'all', program: 'all' };
    state.threads = [];
    state.threadId = null;
    panel.close({ restoreFocus: false });
  }
  state.engId = id;
  state.openFolders.add(id);
  renderSidebar();
  dom.indexView.hidden = true;
  dom.engView.hidden = false;
  fill(dom.header, el('div', { class: 'loading-inline' }, 'Loading engagement…'));
  fill(dom.chatHead);
  fill(dom.chatList);
  grid.renderLoading('Loading engagement…');
  let detail;
  try {
    detail = await api.getEngagement(id, thread || (state.engId === id ? state.threadId : null));
  } catch (e) {
    if (token !== state.loadToken) return;
    if (e.status === 404) { showIndex(); return; }  // stale link (e.g. the sandbox was reset)
    fill(dom.header, el('div', { class: 'error-block', role: 'alert' }, el('strong', {}, 'Could not open this engagement. '), e.message, ' ',
      el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => selectEngagement(id) }, 'Try again')));
    grid.renderError(e.message);
    return;
  }
  if (token !== state.loadToken) return;
  applyDetail(detail);
  if (detail.reveal === undefined && detail.engagement?.mode === 'historical') state.reveal = await api.getReveal(id).catch(() => null);
  const list = detail.assessments || [];
  const target = aid && list.some(x => x.assessment_id === aid) ? aid : latestAid();
  renderChat();
  applyView();
  if (target) await loadAssessment(target, { token });
  else { renderHeader(); grid.renderEmpty(); evaluation.render(); writeHash(); }
  renderSidebar();
}

function applyDetail(detail) {
  state.detail = detail;
  state.threadsSupported = Array.isArray(detail.threads);
  state.threads = state.threadsSupported && detail.threads.length ? detail.threads : [{ ...FALLBACK_THREAD }];
  state.threadId = state.threadsSupported ? (detail.thread_id ?? state.threads[0]?.thread_id ?? null) : null;
  const ent = state.engagements.find(e => e.engagement_id === state.engId);
  if (ent && state.threadsSupported) ent.threads = state.threads;
  state.messages = (detail.messages || []).filter(m => m.role === 'user' || m.role === 'assistant');
  if (detail.reveal !== undefined) state.reveal = detail.reveal;
}

async function refreshDetail() {
  const id = state.engId;
  const detail = await api.getEngagement(id, state.threadId);
  if (state.engId !== id) return null;
  applyDetail(detail);
  return detail;
}

async function loadAssessment(aid, { token = state.loadToken } = {}) {
  state.selectedAid = aid;
  renderHeader();
  if (state.assessment?.assessment_id !== aid) { panel.close({ restoreFocus: false }); grid.renderLoading(); }
  try {
    const [rec, dec] = await Promise.all([
      ensureAssessment(aid),
      api.decisions(aid).catch(e => { toast(`Could not load saved decisions: ${e.message}`, 'error'); return {}; }),
    ]);
    if (token !== state.loadToken || state.selectedAid !== aid) return;
    ctx.decisions.load(aid, dec || {});
    state.assessment = rec;
  } catch (e) {
    if (token !== state.loadToken) return;
    grid.renderError(e.message, () => loadAssessment(aid));
    return;
  }
  renderHeader();
  grid.render({ keepScroll: false });
  recommendation.clearUndo();
  recommendation.render();
  tracer.render();
  evaluation.render();
  renderChat();
  writeHash();
}

async function selectAssessment(aid) {
  if (!aid || aid === state.selectedAid) return;
  await loadAssessment(aid);
}

// ------------------------------------------------------------------ header
function renderHeader() {
  const d = state.detail;
  if (!d) { fill(dom.header); return; }
  const eng = d.engagement || {};
  const a = state.assessment && state.assessment.assessment_id === state.selectedAid ? state.assessment : null;
  const mode = a?.mode || eng.mode;
  const name = niceName(a?.target_org?.name || eng.org_name) || 'Engagement';
  const year = a?.target_year ?? eng.audit_year;
  const cutoff = a?.prediction_date || eng.prediction_date || (mode === 'historical' ? eng.fy_end_date : null);
  const list = d.assessments || [];
  const info = assessmentInfo(state.selectedAid);
  const rv = state.reveal;

  const versionCtl = list.length
    ? el('button', {
      type: 'button', class: 'menu-btn', id: 'version-btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', dataset: { aid: state.selectedAid || '' },
      title: 'Assessment version', onclick: e => openPopover(e.currentTarget, versionMenu, { label: 'Assessment versions', cls: 'menu-pop' }),
    }, `v${info?.version ?? a?.version ?? '?'}`, icon('chevronDown', { size: 12 }))
    : el('span', { class: 'muted' }, 'Not assessed');

  const historical = mode === 'historical';
  fill(dom.header,
    el('div', { class: 'ph-main' },
      el('h1', { class: 'ph-title' }, 'Review table'),
      el('div', { class: 'ph-meta' },
        el('span', {}, MODE_LABELS[mode] || mode || ''),
        a ? el('span', {}, plural((a.program_assessments || []).length, 'program')) : null,
        a ? el('span', {}, plural(rowCount(a), 'row')) : null,
        a ? el('span', {}, plural((a.risks || []).length, 'lead')) : null,
        el('span', { class: 'ph-cutoff' }, cutoff ? `Public reports as of ${fmtDate(cutoff)}` : 'Cutoff set at first assessment',
          infoButton('Cutoff, data snapshot, program source and limitations', () => cutoffPopover(a, eng, cutoff), { cls: 'pop-wide' })),
        el('span', {}, versionCtl),
        rv ? el('span', {}, el('span', { class: 'tag tag-sand', title: `Reported outcomes revealed; v${rv.version} is the frozen prediction` }, 'Revealed')) : null)));
}

function versionMenu(close) {
  const list = state.detail?.assessments || [];
  const latest = latestAid();
  return el('div', { class: 'menu', role: 'menu', 'aria-label': 'Assessment versions' },
    el('div', { class: 'menu-h' }, 'Versions'),
    ...[...list].reverse().map(x => el('button', {
      type: 'button', class: 'menu-item version-item', role: 'menuitemradio', 'aria-checked': String(x.assessment_id === state.selectedAid), dataset: { aid: x.assessment_id },
      onclick: () => { close(); selectAssessment(x.assessment_id); },
    },
    el('span', { class: 'menu-check', 'aria-hidden': 'true' }, x.assessment_id === state.selectedAid ? icon('check', { size: 14 }) : null),
    el('span', { class: 'menu-text' },
      el('span', {}, `v${x.version}`, x.assessment_id === latest ? el('span', { class: 'muted' }, ' · latest') : null,
        isPostReveal({ ...x, engagement_id: state.engId }) ? el('span', { class: 'warn-text' }, ' · post-reveal') : null),
      el('span', { class: 'menu-sub' }, `${fmtShortDateTime(x.created_at)}${x.change_summary ? ` · ${shortName(x.change_summary, 60)}` : ''}`)))));
}

function cutoffPopover(a, eng, cutoff) {
  const src = a?.program_source || (eng.program_mode === 'proxy' && eng.mode === 'historical' ? 'filed_sefa_proxy' : 'last_public_programs');
  const srcNote = {
    filed_sefa_proxy: 'Program identities and amounts from the filed award schedule, used as a labeled stand-in for a draft. No audit outcome fields.',
    last_public_programs: 'Programs from the latest public prior report, marked provisional. New or discontinued programs may be missed.',
    manager_supplied: 'Program list corrected by the manager in chat.',
  }[src] || '';
  const oh = a?.own_history || {};
  const unav = oh.unavailable_reports || [];
  const lim = a?.limitations || [];
  const flags = a?.target_org?.identity_flags || [];
  const prov = a?.provisional_source_report;
  return el('div', { class: 'pop-body' },
    el('h3', {}, 'Evidence boundary'),
    el('dl', { class: 'facts' },
      el('dt', {}, 'Data cutoff'), el('dd', {}, cutoff ? fmtDate(cutoff) : '—',
        el('div', { class: 'small muted' }, a?.data_cutoff?.rule ? `${a.data_cutoff.rule}. ` : '', 'Set by the system (fiscal year-end for historical engagements, run date for live). You don’t choose it.')),
      el('dt', {}, 'FAC snapshot'), el('dd', {}, fmtDate(a?.data_cutoff?.fac_snapshot_date || state.meta?.fac_snapshot_date),
        el('div', { class: 'small muted' }, 'Local copy of public FAC data. It does not update live; reports accepted after the snapshot are missing.')),
      el('dt', {}, 'Program list'), el('dd', {}, PROGRAM_SOURCE_LABELS[src] || src,
        el('div', { class: 'small muted' }, srcNote, prov ? ` From the ${prov.audit_year} report${prov.fac_accepted_date ? `, accepted ${fmtDate(prov.fac_accepted_date)}` : ''}.` : '')),
      el('dt', {}, 'Organization'), el('dd', {}, [a?.target_org?.org_id || eng.org_id, a?.target_org?.state || eng.org_state].filter(Boolean).join(' · '),
        a?.target_org?.org_id_method ? el('div', { class: 'small muted' }, `Matched by ${idMethodLabel(a.target_org.org_id_method)}`) : null,
        flags.length ? el('div', { class: 'small warn-text' }, flags.map(f => IDENTITY_FLAG_LABELS[f] || f).join('; ')) : null)),
    lim.length ? el('h4', {}, `Limitations (${lim.length})`) : null,
    lim.length ? el('ul', {}, ...lim.map(l => el('li', {}, l))) : null,
    a ? el('details', { class: 'pop-more' }, el('summary', {}, `Own reports used (${(oh.reports || []).length})${unav.length ? ` · ${unav.length} not public at the cutoff` : ''}`),
      (oh.reports || []).length ? el('table', { class: 'mini-table' },
        el('thead', {}, el('tr', {}, ...['Year', 'Report', 'Accepted', 'Findings'].map(h => el('th', {}, h)))),
        el('tbody', {}, ...(oh.reports || []).map(r => el('tr', {}, el('td', {}, r.audit_year), el('td', { class: 'mono' }, r.report_id), el('td', {}, fmtDate(r.fac_accepted_date)), el('td', { class: 'num' }, fmtInt(r.n_findings))))))
        : el('p', { class: 'small muted' }, 'No earlier public report was available at the cutoff.'),
      unav.length ? el('p', { class: 'small' }, 'Not public at the cutoff: ', unavailableLines(unav).join('; '), '. These years are missing, not clean.') : null) : null,
    a ? el('details', { class: 'pop-more' }, el('summary', {}, 'Method and agent trace'),
      el('p', { class: 'small' }, `Ranker ${a.versions?.ranker || '—'} · agent ${a.versions?.agent || '—'} · model ${a.versions?.model || state.meta?.model || '—'}`,
        a.params ? ` · peer-only rows need ${a.params.min_peer_reports}+ comparable reports · smoothing ${a.params.smoothing_strength}` : ''),
      el('ol', { class: 'small trace-list' }, ...(a.tool_trace || []).map(t => el('li', {}, toolLabel(t.tool), t.result_summary ? el('span', { class: 'muted' }, ` — ${t.result_summary}`) : null)))) : null);
}

// ------------------------------------------------------------------ views
function setView(view) {
  if (view === 'eval' && state.detail?.engagement?.mode !== 'historical') view = 'review';
  state.view = view;
  applyView();
  writeHash();
  if (view === 'eval') $('#eval-back')?.focus(); else $('#eval-btn')?.focus();
}

function applyView() {
  const isEval = state.view === 'eval';
  dom.reviewView.hidden = isEval;
  dom.evalView.hidden = !isEval;
  if (isEval) { panel.close({ restoreFocus: false }); evaluation.render(); }
  $('#eval-btn')?.setAttribute('aria-pressed', String(isEval));
}

function toggleChat() {
  ctx.prefs.chatCollapsed = !ctx.prefs.chatCollapsed;
  ctx.savePrefs();
  dom.engBody.classList.toggle('chat-collapsed', ctx.prefs.chatCollapsed);
  if (!ctx.prefs.chatCollapsed) state.chatUnread = false;
  grid.render();
  if (ctx.prefs.chatCollapsed) $('#chat-show')?.focus();
  else dom.chatInput.focus();
}

// ------------------------------------------------------------------ chat
function promptsFor() {
  const a = state.assessment;
  if (!a) return ['Assess likely risk areas for this engagement'];
  const n = (a.risks || []).length;
  return [n >= 1 ? 'Why is L1 ranked first?' : null, n >= 2 ? 'What argues against L2?' : null, 'Draft the staff focus note from my decisions'].filter(Boolean).slice(0, 3);
}

function renderPrompts() {
  const show = !!state.engId && !state.messages.length && !pendingHere() && !dom.chatInput.value.trim();
  dom.prompts.hidden = !show;
  if (show) {
    fill(dom.prompts, ...promptsFor().map(p => el('button', {
      type: 'button', class: 'prompt-chip', onclick: () => { dom.chatInput.value = p; updateComposer(); dom.chatInput.focus(); },
    }, p)));
  }
}

function pendingHere() {
  const p = state.pending.get(state.engId);
  return p && (p.threadId ?? null) === (state.threadId ?? null) ? p : null;
}

function renderChat() {
  const engId = state.engId;
  const nodes = [];
  renderChatHead();
  const p = pendingHere();
  const elsewhere = !p && state.pending.get(engId);
  if (!state.messages.length && !p) nodes.push(chatWelcome());
  for (const m of state.messages) nodes.push(renderMessage(m));
  if (elsewhere) {
    const t = state.threads.find(x => x.thread_id === elsewhere.threadId);
    nodes.push(el('p', { class: 'notice notice-plain small' }, `The agent is still working in “${t?.title || 'another thread'}”.`));
  }
  if (p) {
    if (p.kind === 'chat') nodes.push(renderMessage({ id: 'pending', role: 'user', text: p.text, pending: true }));
    nodes.push(workingBlock(p));
  }
  const err = state.chatError.get(engId);
  if (err) nodes.push(err.stopped ? stoppedBlock() : chatErrorBlock(err));
  fill(dom.chatList, ...nodes);
  updateComposer();
  requestAnimationFrame(() => { clampLong(); dom.chatList.scrollTop = dom.chatList.scrollHeight; });
}

function chatWelcome() {
  const a = state.assessment;
  if (a) {
    return el('div', { class: 'chat-welcome' },
      el('p', { class: 'cw-title' }, `New thread on v${a.version}`),
      el('p', { class: 'muted' }, 'Ask about any lead, challenge the evidence, correct the program list, or draft the staff note. Every thread shares this engagement’s review table and decisions.'));
  }
  return el('div', { class: 'chat-welcome' },
    el('p', { class: 'cw-title' }, 'Ask about this engagement'),
    el('p', { class: 'muted' }, 'The agent ranks up to five program × requirement areas for staff to verify, explains its evidence, and saves a new version when you correct the case.'));
}

function avatar(role) {
  return role === 'user'
    ? el('span', { class: 'av av-user', 'aria-hidden': 'true' }, icon('user', { size: 14 }))
    : el('span', { class: 'av av-agent', 'aria-hidden': 'true' }, 'SA');
}

function stepsList(calls, { live = false } = {}) {
  return el('ul', { class: `steps${live ? ' live' : ''}` }, ...calls.map(c => el('li', { class: 'step' },
    live ? el('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon('check', { size: 13, cls: 'step-ic' }),
    el('span', { class: 'step-t' }, c.label || toolLabel(c.tool), c.summary ? el('span', { class: 'step-s' }, c.summary) : null),
    c.elapsed ? el('span', { class: 'elapsed', 'aria-hidden': 'true' }, c.elapsed) : null)));
}

function renderMessage(m) {
  const isUser = m.role === 'user';
  const info = m.assessment_id ? assessmentInfo(m.assessment_id) : null;
  const calls = m.tool_calls || [];
  const body = isUser
    ? el('div', { class: 'msg-body plain' }, m.text || '')
    : el('div', { class: 'msg-body md', dataset: { msgId: m.id || '' }, trustedHtml: renderMarkdown(m.text || '', { refs: true }) });
  const stepsOpen = state.openSteps.has(m.id);
  const steps = !isUser && calls.length ? el('div', { class: 'steps-wrap', hidden: !stepsOpen || null }, stepsList(calls)) : null;
  const foot = isUser ? null : el('div', { class: 'msg-foot' },
    m.created_at ? el('span', {}, fmtTime(m.created_at)) : null,
    info ? el('button', { type: 'button', class: `foot-link${info.assessment_id === state.selectedAid ? ' current' : ''}`, title: 'Show this version in the review table', onclick: () => selectAssessment(info.assessment_id) }, `Based on v${info.version}`) : null,
    calls.length ? el('button', {
      type: 'button', class: 'foot-link steps-toggle', 'aria-expanded': String(stepsOpen),
      onclick: e => {
        const open = !state.openSteps.has(m.id);
        if (open) state.openSteps.add(m.id); else state.openSteps.delete(m.id);
        e.currentTarget.setAttribute('aria-expanded', String(open));
        e.currentTarget.lastChild.textContent = open ? '▾' : '▸';
        if (steps) steps.hidden = !open;
      },
    }, `${plural(calls.length, 'step')} `, el('span', { 'aria-hidden': 'true' }, stepsOpen ? '▾' : '▸')) : null,
    m.turn ? el('button', { type: 'button', class: 'foot-link', title: 'Which version this answer read, and every lookup it made', onclick: () => ctx.actions.inspectTrace({ turn: m.turn }) }, 'Inspect trace') : null);
  return el('article', { class: `msg msg-${isUser ? 'user' : 'agent'}${m.pending ? ' pending' : ''}`, dataset: { aid: m.assessment_id || '', id: m.id || '' } },
    avatar(m.role), el('div', { class: 'msg-main' }, body, foot, steps));
}

function clampLong() {
  for (const b of $$('.msg-agent .msg-body.md', dom.chatList)) {
    const id = b.dataset.msgId;
    if (state.expandedMsgs.has(id) || b.dataset.clampChecked) continue;
    b.dataset.clampChecked = '1';
    if (b.scrollHeight <= 400) continue; // roughly 18 lines; short first answers never clamp
    b.classList.add('clamped');
    const setOpen = open => {
      b.classList.toggle('clamped', !open);
      b.scrollTop = 0;
      more.setAttribute('aria-expanded', String(open));
      more.textContent = open ? 'Show less' : 'Show more';
      if (open) state.expandedMsgs.add(id); else state.expandedMsgs.delete(id);
    };
    const more = el('button', { type: 'button', class: 'show-more', 'aria-expanded': 'false', onclick: () => setOpen(b.classList.contains('clamped')) }, 'Show more');
    // Keyboard focus must never land on clipped content: expand when focus enters the message.
    b.addEventListener('focusin', () => { if (b.classList.contains('clamped')) setOpen(true); });
    b.after(more);
  }
}

function workingLabel(p) {
  if (p.kind === 'assess' || !state.assessment) return toolLabel('run_assessment');
  if (/no longer|stopped receiving|remove|update the list|correct|added/i.test(p.text)) return 'Revising the assessment with your correction';
  if (/focus note|draft/i.test(p.text)) return toolLabel('draft_focus_note');
  return toolLabel('answer_followup');
}

function workingBlock(p) {
  const secs = Math.max(0, Math.round((Date.now() - p.startedAt) / 1000));
  const steps = (state.progress.get(state.engId) || []).filter(x => x.label);
  const list = steps.length
    ? el('ul', { class: 'steps live' }, ...steps.map((x, i) => el('li', { class: `step${x.done ? '' : ' step-now'}` },
      x.done ? icon('check', { size: 13, cls: 'step-ic' }) : el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      el('span', { class: 'step-t' }, x.label, x.summary ? el('span', { class: 'step-s' }, x.summary) : null),
      i === steps.length - 1 ? el('span', { class: 'elapsed', 'aria-hidden': 'true' }, `${secs} s`) : null)))
    : stepsList([{ label: workingLabel(p), elapsed: `${secs} s` }], { live: true });
  const fresh = p.kind === 'assess' || !state.assessment;
  const box = el('div', { class: 'steps-wrap', hidden: !state.workingOpen || null }, list,
    el('p', { class: 'steps-note' }, fresh ? 'A new assessment usually takes 1–3 minutes: ranking is instant, reading narratives and writing and checking the brief take the time.' : 'Follow-ups usually take under a minute.'));
  return el('div', { class: 'msg msg-agent working', role: 'status' },
    avatar('assistant'),
    el('div', { class: 'msg-main' },
      el('button', {
        type: 'button', class: 'working-toggle', 'aria-expanded': String(state.workingOpen),
        onclick: e => { state.workingOpen = !state.workingOpen; e.currentTarget.setAttribute('aria-expanded', String(state.workingOpen)); box.hidden = !state.workingOpen; },
      }, 'Working…', icon('chevronDown', { size: 13 })),
      box));
}

function chatErrorBlock(err) {
  return el('div', { class: 'chat-error error-block', role: 'alert' },
    el('strong', {}, 'The agent could not answer. '), err.message,
    err.text ? el('p', { class: 'small' }, 'Your message is back in the box below; nothing was changed.') : null,
    el('div', { class: 'err-actions' },
      el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => { state.chatError.delete(state.engId); sendChat(err.text); } }, 'Retry'),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { state.chatError.delete(state.engId); renderChat(); } }, 'Dismiss')));
}

function stoppedBlock() {
  return el('div', { class: 'notice notice-plain', role: 'status' }, 'Stopped waiting. The agent may still finish on the server; reopen the engagement later to see its reply. ',
    el('button', { type: 'button', class: 'btn-link', onclick: () => { state.chatError.delete(state.engId); renderChat(); } }, 'Dismiss'));
}

function updateComposer() {
  const busy = state.pending.has(state.engId);
  dom.chatSend.disabled = busy || !state.engId || !dom.chatInput.value.trim();
  dom.chatSend.hidden = busy;
  dom.chatStop.hidden = !busy;
  dom.chatInput.setAttribute('aria-busy', String(busy));
  renderPrompts();
}

let progressBusy = false;
function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (!state.pending.size) { clearInterval(ticker); ticker = null; return; }
    const engId = state.engId;
    const p = state.pending.get(engId);
    const node = $('.working .elapsed', dom.chatList);
    if (p && node) node.textContent = `${Math.round((Date.now() - p.startedAt) / 1000)} s`;
    if (p && !progressBusy) {
      progressBusy = true;
      api.progress(engId).then(r => {
        const prev = JSON.stringify(state.progress.get(engId) || []);
        state.progress.set(engId, r.steps || []);
        if (JSON.stringify(r.steps || []) !== prev && state.pending.get(engId) && engId === state.engId) {
          const w = $('.working', dom.chatList);
          if (w) { w.replaceWith(workingBlock(state.pending.get(engId))); dom.chatList.scrollTop = dom.chatList.scrollHeight; }
        }
      }).catch(() => {}).finally(() => { progressBusy = false; });
    }
  }, 1000);
}

async function sendChat(text) {
  const engId = state.engId;
  text = (text || '').trim();
  if (!engId || !text || state.pending.has(engId)) return;
  state.chatError.delete(engId);
  const ctrl = new AbortController();
  const threadId = state.threadId;
  state.pending.set(engId, { text, startedAt: Date.now(), kind: 'chat', ctrl, threadId });
  state.progress.delete(engId);
  if (dom.chatInput.value.trim() === text) dom.chatInput.value = '';
  renderChat();
  renderSidebar();
  if (!state.assessment) grid.renderEmpty();
  startTicker();
  const prevLatest = latestAid();
  let res = null;
  let error = null;
  try { res = await api.chat(engId, text, ctrl.signal, threadId, state.selectedAid); } catch (e) { error = e; }
  state.pending.delete(engId);
  await afterAgentCall(engId, { res, error, text, prevLatest });
}

async function runAssess(trigger) {
  const engId = state.engId;
  if (!engId || state.pending.has(engId)) return;
  const ctrl = new AbortController();
  state.pending.set(engId, { text: '', startedAt: Date.now(), kind: 'assess', ctrl, threadId: state.threadId });
  renderChat();
  renderSidebar();
  state.progress.delete(state.engId);
  grid.renderLoading('Building the assessment. Usually 1–3 minutes; steps show in the chat…');
  startTicker();
  const prevLatest = latestAid();
  let res = null;
  let error = null;
  try { res = await api.assess(engId, ctrl.signal); } catch (e) { error = e; }
  state.pending.delete(engId);
  if (error && !error.stopped && state.engId === engId) toast(`Assessment failed: ${error.message}`, 'error');
  await afterAgentCall(engId, { res, error: error?.stopped ? error : null, text: '', prevLatest });
  if (state.engId === engId && !state.assessment) grid.renderEmpty();
  trigger?.focus?.();
}

function stopWaiting() {
  state.pending.get(state.engId)?.ctrl?.abort();
}

async function afterAgentCall(engId, { res, error, text, prevLatest }) {
  let detail = null;
  try { detail = await api.getEngagement(engId, state.engId === engId ? state.threadId : null); } catch { /* fall back to the response */ }
  if (state.engId !== engId) {
    refreshEngagements();
    const name = state.engagements.find(e => e.engagement_id === engId)?.org_name || 'another engagement';
    toast(error ? `The agent could not answer in ${shortName(name, 40)}.` : `The agent replied in ${shortName(name, 40)}.`, error ? 'error' : 'info');
    return;
  }
  if (detail) applyDetail(detail);
  else if (res?.messages) {
    const ids = new Set(state.messages.map(m => m.id));
    const fresh = res.messages.filter(m => !ids.has(m.id));
    if (text && !fresh.some(m => m.role === 'user')) state.messages.push({ id: `local-${Date.now()}`, role: 'user', text, created_at: new Date().toISOString() });
    state.messages.push(...fresh);
  }
  if (error) {
    state.chatError.set(engId, { message: error.message, text, stopped: !!error.stopped });
    if (!dom.chatInput.value.trim() && text && !error.stopped) dom.chatInput.value = text;
  }
  if (ctx.prefs.chatCollapsed && !error) state.chatUnread = true;
  renderChat();
  refreshEngagements();
  if (ctx.prefs.chatCollapsed && state.assessment) grid.render();
  const newLatest = res?.latest_assessment_id || latestAid();
  if (newLatest && newLatest !== prevLatest) {
    if (!assessmentInfo(newLatest)) await refreshDetail().catch(() => null);
    await loadAssessment(newLatest);
    const info = assessmentInfo(newLatest) || state.assessment;
    toast(`Saved assessment v${info?.version ?? ''}${info?.change_summary ? `: ${info.change_summary}` : ''}`);
  } else {
    renderHeader();
    if (!state.assessment) grid.renderEmpty();
  }
}

/** L1 / R:… / P:… tokens in chat: switch to the message's version if needed, then select the row. */
async function gotoRef(ref, messageAid) {
  if (messageAid && messageAid !== state.selectedAid && assessmentInfo(messageAid)) {
    await loadAssessment(messageAid);
    toast(`Showing v${state.assessment?.version}, the version this answer refers to.`);
  }
  if (state.view !== 'review') setView('review');
  const a = state.assessment;
  if (!a) { toast('No assessment is loaded yet.'); return; }
  let rowId = ref;
  if (/^L\d+$/.test(ref)) {
    const r = (a.risks || []).find(x => x.lead_id === ref);
    if (!r) { toast(`${ref} is not a lead in v${a.version}.`); return; }
    rowId = r.requirement_row_id;
  }
  if (!grid.gotoRow(rowId)) toast(`${rowId} is not in v${a.version}.`);
}

// ------------------------------------------------------------------ actions for modules
Object.assign(ctx.actions, {
  selectAssessment,
  setView,
  toggleChat,
  sendPrompt: text => sendChat(text),
  gotoRef: ref => gotoRef(ref, null),
  openBrief: () => recommendation.open(),
  closeBrief: () => recommendation.close(),
  inspectTrace: focus => tracer.open(focus),
  filterRows: patch => { if (state.view !== 'review') setView('review'); grid.setFilter(patch); },
  displayName: n => niceName(n),
  openExport: () => exporter.open(),
  aboutReview: close => {
    const d = state.detail || {};
    const eng = d.engagement || {};
    const a = state.assessment;
    const mode = a?.mode || eng.mode;
    const cutoff = a?.prediction_date || eng.prediction_date || (mode === 'historical' ? eng.fy_end_date : null);
    const name = niceName(a?.target_org?.name || eng.org_name) || 'this nonprofit';
    const list = d.assessments || [];
    return el('div', { class: 'pop-body about-pop' },
      el('h3', {}, 'About this review'),
      el('p', {}, [MODE_LABELS[mode] || mode, a ? plural((a.program_assessments || []).length, 'program') : null, a ? plural(rowCount(a), 'row') : null,
        a ? plural((a.risks || []).length, 'lead') : null, cutoff ? `public reports as of ${fmtDate(cutoff)}` : null].filter(Boolean).join(' · ')),
      el('p', { class: 'muted' }, `Each row is one federal program × compliance area for ${name}. Open a row to see why it was flagged and the evidence. Rows you mark Include or Investigate go into the staff note.`),
      list.length ? el('div', { class: 'about-versions' }, el('h4', {}, 'Assessment version'),
        ...list.slice().reverse().map(x => el('button', {
          type: 'button', class: `ver-item${x.assessment_id === state.selectedAid ? ' cur' : ''}`,
          onclick: () => { close(); if (x.assessment_id !== state.selectedAid) selectAssessment(x.assessment_id); },
        }, el('strong', {}, `v${x.version}`), ` · ${fmtShortDateTime(x.created_at)}`, x.change_summary ? el('span', { class: 'muted' }, ` · ${x.change_summary}`) : null,
          isPostReveal(x) ? el('span', { class: 'tag tag-sand' }, 'post-reveal') : null))) : null,
      state.reveal ? el('p', {}, el('span', { class: 'tag tag-sand' }, 'Revealed'), ` v${state.reveal.version} is the frozen prediction.`) : null,
      cutoffPopover(a, eng, cutoff));
  },
  openEval: () => setView('eval'),
  // "Ask about this": open the chat with the quoted section ready; the manager types the question.
  askAbout: (section, quote, rowId) => {
    if (ctx.prefs.chatCollapsed) toggleChat();
    const q = (quote || '').replace(/\s+/g, ' ').trim();
    dom.chatInput.value = `About ${rowId} · ${section}: “${q.length > 220 ? `${q.slice(0, 220)}…` : q}”\n\n`;
    updateComposer();
    dom.chatInput.focus();
    dom.chatInput.setSelectionRange(dom.chatInput.value.length, dom.chatInput.value.length);
  },
  runAssess,
  openPanel: (rowId, opts) => panel.open(rowId, opts),
  isPanelOpen: () => panel.isOpen(),
  afterGridRender: () => {
    if (!panel.isOpen()) return;
    const cur = panel.current();
    if (!cur || !grid.findRowModel(cur)) panel.close({ restoreFocus: false });
    else { panel.place(); grid.select(cur, { open: false, scroll: false }); }
  },
  ensureAssessment: aid => ensureAssessment(aid).catch(() => null),
  engagementCreated: async eng => {
    await refreshEngagements();
    const id = eng?.engagement_id || eng?.engagement?.engagement_id;
    if (id) await selectEngagement(id);
    dom.chatInput.focus();
  },
  afterReveal: async rec => {
    state.reveal = rec;
    await refreshDetail().catch(() => null);
    if (rec && !state.reveal) state.reveal = rec;
    renderHeader();
    evaluation.render();
    if (state.assessment) grid.render();
    refreshEngagements();
  },
});

// ------------------------------------------------------------------ wiring
function bind() {
  $('#sb-new-eng').append(icon('plus', { size: 18 }));
  $('#sb-list').append(icon('list', { size: 18 }));
  $('#sb-about').append(icon('help', { size: 18 }));
  $('#sb-list').addEventListener('click', () => showIndex());
  $('#sb-new-eng').addEventListener('click', () => newEngagement.open());
  $('#sb-home').addEventListener('click', () => showIndex());
  $('#sb-about').addEventListener('click', e => openPopover(e.currentTarget, aboutPopover, { label: 'About this tool', placement: 'right' }));
  applySidebarCollapsed();

  dom.chatForm.addEventListener('submit', e => { e.preventDefault(); sendChat(dom.chatInput.value); });
  dom.chatInput.addEventListener('input', updateComposer);
  dom.chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(dom.chatInput.value); }
  });
  dom.chatStop.addEventListener('click', stopWaiting);
  dom.chatList.addEventListener('click', e => {
    const ref = e.target.closest('.ref-link');
    if (!ref) return;
    gotoRef(ref.dataset.ref, ref.closest('.msg')?.dataset.aid || null);
  });
  ctx.prefs.chatCollapsed = false;  // chat pane is always available
  dom.engBody.classList.remove('chat-collapsed');
  window.addEventListener('hashchange', () => {
    const { eng, asm, view, thread } = parseHash();
    if (!eng) { if (state.engId) showIndex(); return; }
    if (eng !== state.engId) selectEngagement(eng, { aid: asm, view, thread });
    else if (thread && thread !== state.threadId) selectThread(thread);
    else if (asm && asm !== state.selectedAid) selectAssessment(asm);
  });
  window.addEventListener('pagehide', () => ctx.decisions.flushOnUnload());
  window.addEventListener('resize', () => panel.place());
}

async function boot() {
  bind();
  updateComposer();
  state.meta = await api.meta().catch(() => null);
  renderMetaFoot();
  await refreshEngagements();
  const { eng, asm, view, thread } = parseHash();
  if (eng) await selectEngagement(eng, { aid: asm, view, thread });
  else { dom.indexView.hidden = false; dom.engView.hidden = true; renderIndex(); }
}

boot();
