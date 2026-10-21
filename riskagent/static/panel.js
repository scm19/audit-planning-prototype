// Row detail panel, docked to the right of the grid (non-modal). Level 2 and 3 of the review:
// full lead text, decision + note, uncertainties, evidence check, sources, this nonprofit's
// findings vs other nonprofits' reports, and the full finding text with corrective action.

import {
  el, $, $$, fill, cssEscape, badge, checkBadge, label, fmtDate, fmtTime, fmtInt, fmtShare, fmtYears, fmtMoney, plural,
  requirementName, shortName, normFlags, flagTags, unavailableLines, isPlaceholderText, DISPOSITIONS,
  PROGRAM_SOURCE_LABELS, STATUS_LABELS, GROUP_SHORT, CHECK_LABELS, STATE_LABELS,
} from './util.js';
import { icon } from './icons.js';
import { openPopover } from './popover.js';
import { claimItem } from './claims.js';

export function createPanel(ctx) {
  let lastTab = 0;
  const panel = document.getElementById('panel');
  const body = $('.panel-body', panel);
  // Decision is anchored to the bottom of the drawer so it is reachable from every tab.
  const foot = el('footer', { class: 'panel-foot' });
  panel.append(foot);
  const tabsHost = el('div', { class: 'ptabs-host' });
  body.before(tabsHost);
  const titleEl = $('#panel-title', panel);
  const eyebrowEl = $('#panel-eyebrow', panel);
  const subEl = $('#panel-sub', panel);
  let rowToken = 0;   // evidence load for the open row
  let token = 0;      // finding sub-view
  let current = null;
  let saved = null;

  $('#panel-close', panel).addEventListener('click', () => close());
  $('#panel-prev', panel).addEventListener('click', () => ctx.grid.moveSelection(-1, { open: true }));
  $('#panel-next', panel).addEventListener('click', () => ctx.grid.moveSelection(1, { open: true }));
  document.addEventListener('keydown', e => {
    // Escape closes the row panel from anywhere, unless a dialog or popover is handling it.
    if (e.key !== 'Escape' || panel.hidden || e.defaultPrevented) return;
    if (document.querySelector('dialog[open], .popover')) return;
    e.preventDefault();
    close({ restoreFocus: panel.contains(document.activeElement) });
  });
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') return;
    if (isEditable(e.target)) return;
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); ctx.grid.moveSelection(1, { open: true }); }
    if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); ctx.grid.moveSelection(-1, { open: true }); }
  });

  const isEditable = t => !!t?.closest?.('input, textarea, select, [contenteditable="true"]');
  const isOpen = () => !panel.hidden;

  function place() {
    const pane = panel.parentElement;
    const area = document.getElementById('grid-area');
    if (!pane || !area) return;
    panel.style.top = `${Math.max(0, area.getBoundingClientRect().top - pane.getBoundingClientRect().top)}px`;
  }

  function close({ restoreFocus = true } = {}) {
    if (panel.hidden) return;
    token++;
    rowToken++;
    const rowId = current;
    panel.hidden = true;
    current = null;
    saved = null;
    document.body.classList.remove('panel-open');
    if (restoreFocus && rowId) ctx.grid.rowNode(rowId)?.focus({ preventScroll: true });
    ctx.grid.clearSelection();
  }

  // ------------------------------------------------------------------ open a row
  function open(rowId, { focusNote = false, focusPanel = false } = {}) {
    const a = ctx.state.assessment;
    const row = ctx.grid.findRowModel(rowId);
    if (!a || !row) return;
    token++;
    const t = ++rowToken;
    current = rowId;
    saved = null;
    place();
    panel.hidden = false;
    document.body.classList.add('panel-open');
    const { index, total } = ctx.grid.position(rowId);
    const { prog, req, lead } = row;
    eyebrowEl.textContent = index >= 0 ? `Row ${index + 1} of ${total} · ${rowId}` : rowId;
    titleEl.textContent = lead?.short_title || (req ? `${req.letter} · ${requirementName(req.letter, req.requirement)}` : (prog.program_name || prog.aln));
    subEl.textContent = req
      ? `${prog.aln} ${prog.program_name || ''}${lead?.short_title ? ` · ${req.letter} ${requirementName(req.letter, req.requirement)}` : ''}`
      : `${prog.aln} · ${fmtMoney(prog.amount)}`;
    $('#panel-prev', panel).disabled = index <= 0;
    $('#panel-next', panel).disabled = index < 0 || index >= total - 1;
    const loading = () => el('div', { class: 'loading-block small', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading evidence…');
    const panes = [el('div', { class: 'tab-pane' }, summary(row, a)), el('div', { class: 'tab-pane' }, loading()), el('div', { class: 'tab-pane' }, loading())];
    const names = ['Overview', 'This nonprofit’s history', 'Same-program audits'];
    const tabBtns = names.map((n, i) => el('button', { type: 'button', role: 'tab', class: 'ptab', onclick: () => showTab(i) }, n));
    const showTab = i => {
      lastTab = i;
      if (!panes[0].isConnected) fill(body, ...panes);  // returning from the full-finding view
      tabBtns.forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
      panes.forEach((p, j) => { p.hidden = i !== j; });
      body.scrollTop = 0;
    };
    const evSlot = { set: ev => { const parts = renderEvidence(ev, a, row); fill(panes[1], parts.own); fill(panes[2], parts.peer); },
      error: node => { fill(panes[1], node); fill(panes[2], node.cloneNode(true)); } };
    fill(tabsHost, el('div', { class: 'ptabs', role: 'tablist', 'aria-label': 'Row detail' }, ...tabBtns));
    fill(body, ...panes);
    fill(foot, decisionBlock(rowId, a, row.req ? 'Decision' : 'Decision for this program'));
    showTab(lastTab || 0);
    body.scrollTop = 0;
    if (focusNote) $('.pd-decision textarea', panel)?.focus();
    else if (focusPanel) titleEl.focus({ preventScroll: true });
    ctx.api.evidence(a.assessment_id, rowId).then(ev => {
      if (t !== rowToken) return;
      evSlot.set(ev || {});
    }).catch(e => {
      if (t !== rowToken) return;
      evSlot.error(el('p', { class: 'muted small' }, e.status === 404
        ? 'No row-level evidence is available for this row.'
        : `Could not load the evidence: ${e.message}`));
    });
  }

  function summary(row, a) {
    const { prog, req, lead } = row;
    const rank = row.state === 'lead' ? (req?.rank ?? lead?.rank) : req?.candidate_rank;
    const rankText = row.state === 'lead' && rank ? `${lead?.lead_id || `L${rank}`} · rank ${rank}` : row.state === 'candidate' && rank ? `rank ${rank}` : null;
    const unc = [...new Set([...(lead?.uncertainties || []), ...(req?.limits || lead?.limits || [])])];
    const chk = lead?.evidence_check;
    const lede = lead?.plain_language_risk || req?.conclusion || prog.state_reason || '';
    const byId = new Map((a.brief?.claims || []).map(c => [c.claim_id, c]));
    const notes = (req?.note_claim_ids || []).map(id => byId.get(id)).filter(Boolean);
    return el('div', { class: 'pd' },
      el('div', { class: 'pd-badges' },
        badge(row.state, rankText),
        req?.group ? el('span', { class: 'tag' }, GROUP_SHORT[req.group] || req.group_label || req.group) : null,
        lead ? checkBadge(chk?.status) : null,
        lead?.explanation_source === 'template' ? el('span', { class: 'tag tag-sand', title: 'The model explanation was not available; this wording comes from a deterministic template built from the same evidence.' }, 'Template wording') : null),
      el('p', { class: 'pd-lede' }, lede),
      lead?.conditional ? el('p', { class: 'pd-cond' }, el('span', { class: 'tag tag-sand tag-xs' }, 'Conditional'), ' ', lead.conditional) : null,
      lead?.order_note ? el('p', { class: 'small muted' }, lead.order_note) : null,
      req?.review_note ? el('p', { class: 'pd-cond' }, req.review_note) : null,
      relatedOf(row, a),
      alsoTagged(lead),
      (req?.audit_wide || []).length ? el('p', { class: 'pd-cond' }, el('span', { class: 'tag tag-sand tag-xs' }, 'Audit-wide finding linked'), ' ',
        `${req.audit_wide.map(f => `${f.reference_number} (${f.audit_year})`).join(', ')} concerns late filing of the overall audit package with the FAC. It stays listed as a source but is not counted as evidence about this program`,
        req.group === 'peer_only' ? '; this row rests on other nonprofits’ audits of the program.' : '.') : null,
      dataAge(a),
      notes.length ? el('div', { class: 'pd-sec' }, secHead('Why it’s flagged', notes.map(c => c.sentence).join(' '), row),
        el('ul', { class: 'pd-claims' }, ...notes.map(c => claimItem(ctx, a, c))),
        el('button', { type: 'button', class: 'btn-link small', onclick: () => ctx.actions.inspectTrace({ rowId: row.rowId }) }, 'Inspect trace'))
        : lead?.why_this_client ? el('div', { class: 'pd-sec' }, secHead('Why it’s flagged', lead.why_this_client, row), el('p', { class: 'cited' }, ...citedWhy(lead, row, a))) : null,
      unc.length ? el('div', { class: 'pd-counter' }, secHead('What could make this wrong', unc.join(' '), row),
        el('ul', { class: 'pd-list' }, el('li', {}, unc[0])),
        unc.length > 1 ? el('details', { class: 'pd-more-inline' }, el('summary', {}, `Show ${unc.length - 1} more`), el('ul', { class: 'pd-list' }, ...unc.slice(1).map(u => el('li', {}, u)))) : null) : null,
      lead?.verification_question ? el('div', { class: 'pd-ask' }, secHead('Ask staff to verify', lead.verification_question, row), el('p', {}, lead.verification_question)) : null,
      !req && prog.state !== 'lead' ? el('p', { class: 'small muted' }, 'This program has no requirement rows. ', STATE_LABELS[prog.state] === 'No reported historical signal' ? 'That is not a low-risk conclusion; the audit may still need to test it.' : '') : null,
      factsBlock(row, a),
      req ? el('details', { class: 'pd-more' }, el('summary', {}, `Your note on the whole program (${prog.aln})`), noteEditor(prog.row_id, a)) : null);
  }

  // One issue, several compliance tags: the lead lists its related tags; a related row points home.
  function alsoTagged(lead) {
    const rel = lead?.related || [];
    if (!rel.length) return null;
    return el('div', { class: 'pd-sec' }, el('h3', { class: 'pd-h' }, 'Also tagged on the same findings'),
      el('ul', { class: 'pd-rel' }, ...rel.map(x => el('li', {},
        el('button', { type: 'button', class: 'cite-link', onclick: () => ctx.actions.gotoRef(x.row_id) }, `${x.requirement_code} ${x.requirement_name}`), ' ',
        checkBadge(x.status), el('div', { class: 'small' }, x.distinct_check)))));
  }

  function relatedOf(row, a) {
    if (row.state !== 'related' || !row.req) return null;
    const home = (a.risks || []).find(x => x.requirement_row_id === row.req.issue_of);
    const x = (home?.related || []).find(y => y.row_id === row.rowId);
    const fids = (row.req.own?.findings || []).map(f => f.reference_number);
    return el('div', { class: 'pd-sec pd-related' },
      el('p', {}, 'Related tag of ', el('button', { type: 'button', class: 'cite-link', onclick: () => ctx.actions.gotoRef(row.req.issue_of) },
        home ? `${home.lead_id} · ${home.short_title || home.requirement_name}` : row.req.issue_of),
        `. This row rests only on the same findings (${[...new Set(fids)].join(', ')}), so it is not a separate lead. Its findings stay listed under This nonprofit’s history.`),
      x ? el('p', {}, checkBadge(x.status), ' ', x.distinct_check) : null);
  }

  // Section header with an "Ask" affordance that hands the quoted text to the chat.
  function secHead(title, quote, row) {
    return el('div', { class: 'sec-head' }, el('h3', { class: 'pd-h' }, title),
      el('button', { type: 'button', class: 'ask-btn', title: 'Ask the agent about this', onclick: () => ctx.actions.askAbout?.(title, quote, row.rowId) }, icon('ask', { size: 13 }), 'Ask'));
  }

  function dataAge(a) {
    const latest = a.own_history?.reports?.[0]?.audit_year;
    if (!latest) return el('p', { class: 'pd-age' }, icon('clock', { size: 13 }), 'No earlier public audit of this nonprofit · same-program audits only');
    const gap = a.target_year - latest;
    return el('p', { class: 'pd-age' }, icon('clock', { size: 13 }), `Latest usable audit: ${latest}`, gap > 1 ? el('span', { class: 'muted' }, ` · ${gap} years before this audit`) : null);
  }

  // PROTOTYPE: inline citations faked from the lead's existing sources. Each sentence gets a
  // numbered marker for the finding it names (by reference number or year) or for the peer cohort.
  function citedWhy(lead, row, a) {
    const srcs = lead.sources || [];
    const nums = new Map();
    const num = key => { if (!nums.has(key)) nums.set(key, nums.size + 1); return nums.get(key); };
    const out = [];
    const sentences = lead.why_this_client.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
    const used = new Set();
    for (const sent of sentences) {
      const cites = [];
      for (const ref of sent.match(/\b(19|20)\d{2}-\d{3}\b/g) || []) {
        const s = srcs.find(x => x.reference_number === ref && x.kind === 'own') || srcs.find(x => x.reference_number === ref);
        if (s && !cites.includes(s)) cites.push(s);
      }
      if (!cites.length) for (const y of sent.match(/\b(19|20)\d{2}\b/g) || []) {
        const s = srcs.find(x => x.kind === 'own' && String(x.audit_year) === y);
        if (s && !cites.includes(s)) cites.push(s);
      }
      const marks = cites.map(s => { used.add(s); return citeBtn(num(s.report_id + s.reference_number), { kind: 'own', s, sent }, lead, row, a); });
      if (/comparable|other nonprofit|peer/i.test(sent)) marks.push(citeBtn(num('peer'), { kind: 'peer', sent }, lead, row, a));
      const cut = sent.lastIndexOf(' ');
      // Keep the markers on the same line as the sentence's last word.
      out.push(sent.slice(0, cut + 1), el('span', { class: 'nowrap' }, sent.slice(cut + 1), ...marks), ' ');
    }
    srcs.filter(s => s.kind === 'own' && !used.has(s)).forEach(s => out.push(citeBtn(num(s.report_id + s.reference_number), { kind: 'own', s, sent: '' }, lead, row, a)));
    return out;
  }

  function citeBtn(n, c, lead, row, a) {
    const label_ = c.kind === 'peer' ? 'Same-program audits' : `${c.s.audit_year} · ${c.s.reference_number}`;
    return el('sup', {}, el('button', {
      type: 'button', class: `cite cite-${c.kind}`, 'aria-label': `Source ${n}: ${label_}`, title: label_,
      onclick: e => openPopover(e.currentTarget, close => citePopover(c, lead, row, a, close), { label: `Source ${n}`, cls: 'cite-pop' }),
    }, String(n)));
  }

  // Pull the "Condition" (what went wrong) out of a finding narrative; fall back to the first
  // sentences after the boilerplate.
  function conditionOf(text) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    const m = t.match(/Condition[^:]{0,20}:\s*(.+?)(?=\s(?:Cause|Effect|Context|Questioned costs|Recommendation|Criteria)[^:]{0,20}:|$)/i);
    const body = m ? m[1] : t.replace(/^.*?(?:Criteria[^:]*:.*?\.\s)/i, '');
    const parts = body.split(/(?<=\.)\s+/).slice(0, 2).join(' ');
    return parts.length > 340 ? `${parts.slice(0, 340)}…` : parts;
  }

  function highlight(text, claim) {
    const words = [...new Set((claim || '').toLowerCase().match(/[a-z][a-z-]{4,}/g) || [])]
      .filter(w => !['which', 'there', 'their', 'about', 'audit', 'reported', 'finding', 'latest', 'available', 'comparable', 'audits'].includes(w));
    if (!words.length) return [text];
    const rx = new RegExp(`\\b(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\w*`, 'gi');
    const out = [];
    let last = 0;
    for (const m of text.matchAll(rx)) { out.push(text.slice(last, m.index), el('mark', {}, m[0])); last = m.index + m[0].length; }
    out.push(text.slice(last));
    return out;
  }

  function citePopover(c, lead, row, a, close) {
    const chk = lead.evidence_check || {};
    const head = (left, right) => el('div', { class: 'cite-head' }, el('span', { class: 'cite-k' }, left), right ? el('span', { class: 'cite-date' }, right) : null);
    const foot = (text, fn) => el('button', { type: 'button', class: 'cite-link', onclick: () => { close(); fn(); } }, text, ' →');
    if (c.kind === 'peer') {
      const pv = row.req?.peer || {};
      return el('div', { class: 'cite-body' },
        head('Other nonprofits · context only', null),
        el('p', { class: 'cite-q' }, `${fmtInt(pv.k)} of ${fmtInt(pv.n)} other nonprofits’ audits of ${row.prog.aln} reported a ${requirementName(row.req.letter, row.req.requirement)} finding.`),
        foot('See same-program reports', () => $$('.ptab', panel)[2]?.click()));
    }
    const s = c.s;
    const org = shortName(a.target_org?.name || 'This nonprofit', 28);
    const quote = el('p', { class: 'cite-q' }, el('span', { class: 'muted' }, 'Loading…'));
    const tags = el('div', { class: 'cite-tags' });
    const read = (chk.narratives_read || []).some(n => n.startsWith(s.report_id) && n.endsWith(`#${s.reference_number}`));
    const verdict = !read ? ['–', 'Not read by the agent', 'v-none'] : chk.status === 'supported' ? ['✓', 'Supports the claim', 'v-ok']
      : chk.status === 'weak_match' ? ['~', 'Partly matches the claim', 'v-weak'] : chk.status === 'conflict' ? ['!', 'Conflicts with the claim', 'v-bad'] : ['–', 'Not checked', 'v-none'];
    ctx.api.finding(a.assessment_id, s.report_id, s.reference_number).then(d => {
      const cond = conditionOf(d?.narrative);
      fill(quote, cond ? highlight(cond, c.sent) : el('span', { class: 'muted' }, 'No narrative text on file for this finding.'));
      const f = d?.flags || {};
      fill(tags, ...[f.material_weakness ? 'Material weakness' : f.significant_deficiency ? 'Significant deficiency' : null,
        f.repeat_finding ? (f.prior_finding_refs ? `Repeat of ${String(f.prior_finding_refs).split(/[,\s]+/)[0]}` : 'Repeat finding') : null,
        f.questioned_costs ? 'Questioned costs' : null].filter(Boolean).map(t => el('span', { class: 'tag' }, t)));
    }).catch(() => fill(quote, el('span', { class: 'muted' }, 'Could not load the finding.')));
    return el('div', { class: 'cite-body' },
      head(`${org} · ${s.audit_year} audit · ${s.reference_number}`, `Public ${fmtDate(s.fac_accepted_date)}`),
      quote, tags,
      el('p', { class: `cite-verdict ${verdict[2]}` }, el('span', { class: 'v-ic', 'aria-hidden': 'true' }, verdict[0]), verdict[1]),
      foot('Open full finding', () => openFinding(s.report_id, s.reference_number, { fromRow: true })));
  }

  // ------------------------------------------------------------------ facts + decisions
  function factsBlock({ prog, req }, a) {
    const cov = prog.own_coverage || {};
    const pv = req?.peer;
    const rows = [
      ['Program', el('span', {}, el('span', { class: 'mono-num' }, prog.aln), ' ', prog.program_name || '')],
      ['Amount spent', fmtMoney(prog.amount)],
      ['Program list', PROGRAM_SOURCE_LABELS[prog.program_source] || prog.program_source || '—'],
      ['On award schedule', fmtYears(cov.years_present) || 'Not in earlier public reports'],
      ['Tested as major', fmtYears(cov.years_audited_major) || 'Never'],
      ['Years with findings', fmtYears(cov.years_with_findings) || 'None'],
      ['Same-program audits', pv?.n ? `${fmtInt(pv.k)} of ${fmtInt(pv.n)} reported a finding in this area` : prog.peer?.n_reports ? `${fmtInt(prog.peer.n_reports)} same-program reports` : 'None'],
      !req ? ['Why this state', prog.state_reason || '—'] : null,
    ].filter(Boolean);
    return el('section', { class: 'pd-sec pd-details' }, el('h3', { class: 'pd-h' }, 'Program details'),
      el('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
  }

  function statusNode(e, aid, rowId) {
    if (e.status === 'saving') return 'Saving…';
    if (e.status === 'unsaved') return 'Unsaved';
    if (e.status === 'error') return el('span', { class: 'err' }, 'Not saved. ',
      el('button', { type: 'button', class: 'btn-link small', onclick: () => ctx.decisions.flush(aid, rowId) }, 'Retry'));
    if (e.updated_at) return `Saved ${fmtTime(e.updated_at)}`;
    return '';
  }

  function noteArea(aid, rowId, d, placeholder) {
    const ta = el('textarea', { class: 'input', rows: '2', placeholder, 'aria-label': placeholder, dataset: { noteArea: rowId } });
    ta.value = d.note || '';
    ta.addEventListener('input', () => ctx.decisions.setNote(aid, rowId, ta.value));
    ta.addEventListener('blur', () => ctx.decisions.flush(aid, rowId));
    return ta;
  }

  function decisionBlock(rowId, a, title) {
    const aid = a.assessment_id;
    const d = ctx.decisions.get(aid, rowId);
    return el('div', { class: 'pd-decision', dataset: { decisionFor: rowId } },
      el('div', { class: 'pd-dec-head' }, label(title), el('span', { class: 'save-status', 'aria-live': 'polite' }, statusNode(d, aid, rowId))),
      el('div', { class: 'seg', role: 'group', 'aria-label': `Decision for ${rowId}` },
        ...DISPOSITIONS.map(o => el('button', {
          type: 'button', class: `seg-btn disp-${o.value}`, 'aria-pressed': String(d.disposition === o.value), dataset: { disp: o.value },
          onclick: () => ctx.decisions.setDisposition(aid, rowId, ctx.decisions.get(aid, rowId).disposition === o.value ? null : o.value),
        }, o.label))),
      noteArea(aid, rowId, d, 'Note for staff (optional)'));
  }

  function noteEditor(rowId, a) {
    const aid = a.assessment_id;
    const d = ctx.decisions.get(aid, rowId);
    return el('div', { class: 'pd-note', dataset: { decisionFor: rowId } },
      noteArea(aid, rowId, d, 'Why this program matters, or what staff should know'),
      el('span', { class: 'save-status small muted', 'aria-live': 'polite' }, statusNode(d, aid, rowId)));
  }

  function updateDecision(aid, rowId, e) {
    if (ctx.state.assessment?.assessment_id !== aid) return;
    for (const w of $$(`[data-decision-for="${cssEscape(rowId)}"]`, panel)) {
      for (const b of $$('.seg-btn', w)) b.setAttribute('aria-pressed', String(b.dataset.disp === e.disposition));
      const st = $('.save-status', w);
      if (st) fill(st, statusNode(e, aid, rowId));
      const ta = $(`textarea[data-note-area="${cssEscape(rowId)}"]`, w);
      if (ta && document.activeElement !== ta && ta.value !== (e.note || '')) ta.value = e.note || '';
    }
  }

  // ------------------------------------------------------------------ evidence (level 3)
  function renderEvidence(ev, a, { prog, req }) {
    const own = ev.own || [];
    const ownSec = el('section', { class: 'ev-section ev-own', 'aria-label': "This nonprofit's own reports" },
      el('h3', { class: 'ev-h' }, "This nonprofit's own reports"),
      el('p', { class: 'ev-sub' }, `Admissible reports only: FAC accepted before ${fmtDate(a.prediction_date)} and audit year before ${a.target_year}.`));
    if (own.length) {
      ownSec.append(...own.map(f => ownFindingCard(f)));
    } else {
      const cov = ev.own_coverage || prog.own_coverage || {};
      ownSec.append(el('p', { class: 'ev-none' },
        req ? `No ${requirementName(req.letter, req.requirement)} finding for ${prog.aln} in these reports. ` : 'No own findings for this program in these reports. ',
        el('span', { class: 'muted' }, (cov.years_audited_major || []).length
          ? `Audited as major in ${fmtYears(cov.years_audited_major)}. A missing reported finding is not evidence the area is free of issues.`
          : 'Never audited as a major program in these reports, so its own history does not test this area.')));
    }
    const unav = ev.unavailable_reports || a.own_history?.unavailable_reports || [];
    if (unav.length) ownSec.append(el('p', { class: 'small muted' }, 'Not available at the cutoff: ', unavailableLines(unav).join('; '), '.'));

    const pv = ev.peer || {};
    const n = pv.n ?? req?.peer?.n ?? prog.peer?.n_reports;
    const k = pv.k ?? req?.peer?.k;
    const years = peerYears(pv, prog);
    const share = fmtShare(k, n);
    const sample = pv.sample || [];
    const peerSec = el('section', { class: 'ev-section ev-peer', 'aria-label': "Other nonprofits' reports" },
      el('h3', { class: 'ev-h' }, "Other nonprofits' reports"),
      el('p', { class: 'ev-sub' }, 'Other nonprofits’ audits of the same program: a broad pool, not verified peers. Context, not evidence about this nonprofit.'),
      el('dl', { class: 'facts' },
        el('dt', {}, 'Cohort rule'), el('dd', {}, pv.rule || prog.peer?.rule || '—'),
        el('dt', {}, 'Counts'), el('dd', {}, n
          ? (k != null ? [el('strong', {}, fmtInt(k)), ` of ${fmtInt(n)} same-program reports`, share ? el('span', { class: 'muted' }, ` · ${share} reported-finding share`) : null] : `${fmtInt(n)} same-program reports`)
          : 'No same-program reports'),
        years ? el('dt', {}, 'Audit years') : null, years ? el('dd', {}, years) : null,
        pv.k_excluding_blanket != null && k != null && pv.k_excluding_blanket < k ? el('dt', {}, 'Blanket') : null,
        pv.k_excluding_blanket != null && k != null && pv.k_excluding_blanket < k ? el('dd', {}, `${fmtInt(k - pv.k_excluding_blanket)} of ${fmtInt(k)} count only through findings listing 5+ requirements`) : null));
    if (sample.length) {
      peerSec.append(el('ul', { class: 'peer-sample' }, ...sample.map(s => {
        const ref = s.reference_number || (s.reference_numbers || [])[0];
        return el('li', {}, el('button', {
          type: 'button', class: 'peer-item', title: `Open finding ${ref} in report ${s.report_id}`,
          onclick: () => openFinding(s.report_id, ref, { fromRow: true }),
        },
        el('span', { class: 'peer-name' }, s.auditee_name || 'Unnamed nonprofit'),
        el('span', { class: 'small muted' }, `${s.audit_year} · ${ref || '—'} · accepted ${fmtDate(s.fac_accepted_date)}`)));
      })));
    }
    return { own: el('div', { class: 'ev' }, ownSec), peer: el('div', { class: 'ev' }, peerSec) };
  }

  function peerYears(pv, prog) {
    if (Array.isArray(pv.years) && pv.years.length) {
      const ys = pv.years.filter(y => y != null);
      if (ys.length === 2 && ys[1] - ys[0] > 1) return `${ys[0]}–${ys[1]}`;
      return fmtYears(ys);
    }
    if (pv.years && typeof pv.years === 'object') return `${pv.years.first_year ?? pv.years.first}–${pv.years.last_year ?? pv.years.last}`;
    const f = pv.first_year ?? prog?.peer?.first_year;
    const l = pv.last_year ?? prog?.peer?.last_year;
    if (f && l) return f === l ? String(f) : `${f}–${l}`;
    return null;
  }

  function ownFindingCard(f) {
    const text = f.narrative_excerpt ?? f.excerpt ?? f.narrative ?? null;
    const noText = f.has_text === false || isPlaceholderText(text);
    return el('article', { class: 'ev-finding' },
      el('header', {}, el('span', { class: 'ref mono' }, f.reference_number), el('span', {}, String(f.audit_year)),
        el('span', { class: 'muted' }, `accepted ${fmtDate(f.fac_accepted_date)}`), flagTags(normFlags(f)),
        f.audit_wide ? el('span', { class: 'tag tag-sand tag-xs', title: f.scope_reason || '' }, 'Audit-wide filing · not counted for this program') : null),
      noText ? el('p', { class: 'small muted' }, 'No narrative text on file (older Census-era record).') : el('p', { class: 'excerpt' }, text),
      el('button', { type: 'button', class: 'btn-link small open-finding', onclick: () => openFinding(f.report_id, f.reference_number, { fromRow: true }) }, 'Full finding and corrective action'));
  }

  // ------------------------------------------------------------------ finding text
  async function openFinding(reportId, ref, { fromRow = true } = {}) {
    const a = ctx.state.assessment;
    if (!a || !reportId) return;
    const t = ++token;
    if (fromRow && !saved) saved = { nodes: [...body.childNodes], eyebrow: eyebrowEl.textContent, title: titleEl.textContent, sub: subEl.textContent, scroll: body.scrollTop };
    if (panel.hidden) { place(); panel.hidden = false; }
    eyebrowEl.textContent = 'Finding';
    titleEl.textContent = `Finding ${ref || ''}`;
    subEl.textContent = reportId;
    fill(body, backButton(), el('div', { class: 'loading-block small', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading finding text…'));
    let d;
    try {
      d = await ctx.api.finding(a.assessment_id, reportId, ref);
    } catch (e) {
      if (t !== token) return;
      fill(body, backButton(), el('div', { class: e.status === 403 ? 'notice notice-warn' : 'error-block', role: 'alert' }, e.status === 403
        ? 'This report is not available for this assessment: it was not public before the cutoff, or it is the audit being predicted.'
        : e.message));
      return;
    }
    if (t !== token) return;
    fill(body, renderFinding(d || {}, reportId, ref, a));
    body.scrollTop = 0;
    $('.back-btn', body)?.focus();
  }

  function backButton() {
    if (!saved) return null;
    return el('button', {
      type: 'button', class: 'btn btn-ghost btn-sm back-btn',
      onclick: () => {
        const s = saved;
        saved = null;
        token++;
        eyebrowEl.textContent = s.eyebrow;
        titleEl.textContent = s.title;
        subEl.textContent = s.sub;
        fill(body, ...s.nodes);
        body.scrollTop = s.scroll;
        titleEl.focus({ preventScroll: true });
      },
    }, icon('arrowLeft', { size: 14 }), 'Back to row');
  }

  function renderFinding(d, reportId, ref, a) {
    const flags = normFlags(d);
    const own = d.own_report ?? (d.auditee_name && a.target_org?.name ? d.auditee_name.toLowerCase() === a.target_org.name.toLowerCase() : null);
    const narrative = isPlaceholderText(d.narrative) ? null : d.narrative;
    const cap = isPlaceholderText(d.corrective_action) ? null : d.corrective_action;
    return el('div', { class: 'finding-detail' },
      backButton(),
      el('span', { class: `whose ${own ? 'whose-own' : 'whose-peer'}` }, own ? "This nonprofit's report" : own === false ? "Another nonprofit's report" : 'Source report'),
      el('dl', { class: 'facts' },
        el('dt', {}, 'Nonprofit'), el('dd', {}, d.auditee_name || '—'),
        el('dt', {}, 'Report'), el('dd', { class: 'mono' }, d.report_id || reportId),
        el('dt', {}, 'Audit year'), el('dd', {}, d.audit_year ?? '—'),
        el('dt', {}, 'FAC accepted'), el('dd', {}, fmtDate(d.fac_accepted_date)),
        d.requirement_letters ? el('dt', {}, 'Requirements') : null, d.requirement_letters ? el('dd', { class: 'mono' }, d.requirement_letters) : null,
        (d.programs || []).length ? el('dt', {}, 'Programs') : null, (d.programs || []).length ? el('dd', { class: 'mono' }, d.programs.join(', ')) : null,
        flags.priorRefs ? el('dt', {}, 'Prior finding') : null, flags.priorRefs ? el('dd', { class: 'mono' }, flags.priorRefs) : null),
      flagTags(flags, { long: true }),
      el('h3', { class: 'ev-h' }, 'Finding narrative'),
      narrative ? el('div', { class: 'narrative' }, narrative) : el('p', { class: 'muted' }, 'No narrative text on file. Older records migrated from the Census system often carry the placeholder GSA_MIGRATION.'),
      el('h3', { class: 'ev-h' }, 'Corrective action plan (as reported)'),
      cap ? el('div', { class: 'narrative' }, cap) : el('p', { class: 'muted' }, 'No corrective action text on file.'),
      el('p', { class: 'small muted' }, 'A corrective action plan says what management intended to do. It does not show that the fix worked.'));
  }

  return { open, close, isOpen, updateDecision, openFinding, current: () => current, place };
}
