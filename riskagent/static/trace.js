// Inspect trace: a read-only drawer showing how a saved assessment version (or one chat answer)
// was produced. Opened from brief claims, table rows and chat answers. Nothing here can change
// the record; manager decisions are never set by the agent.

import { el, fill, fmtInt, fmtDate, shortName } from './util.js';

const STAGE_LABEL = {
  case: 'Case', own_history: 'Own history', comparisons: 'Same-program audits', rank: 'Rank', write: 'Write',
  fact_check: 'Fact check', quality_check: 'Quality check', save: 'Save', chat_lookup: 'Chat lookup',
};
const QUALITY = { pass: 'Passed', repaired: 'Repaired once', fallback: 'Fallback' };

export function createTrace(ctx) {
  const drawer = document.getElementById('trace-drawer');
  const body = document.getElementById('trace-body');
  let focus = null;

  const isOpen = () => !drawer.hidden;
  function open(f = {}) {
    focus = f;
    drawer.hidden = false;
    render();
    document.getElementById('trace-title').focus();
  }
  function close() { if (drawer.hidden) return; drawer.hidden = true; focus = null; }

  // Records a trace event touches: claims, rows, findings, assessment.
  const touches = (ev, ids) => ids.some(id => (ev.input_record_ids || []).includes(id) || (ev.output_record_ids || []).includes(id));

  function render() {
    if (!isOpen()) return;
    const a = ctx.state.assessment;
    if (!a) { fill(body, el('p', { class: 'muted' }, 'No saved assessment.')); return; }
    const b = a.brief || {};
    const claims = new Map((b.claims || []).map(c => [c.claim_id, c]));
    const checks = new Map((b.checks || []).map(c => [c.claim_id, c]));
    const turn = focus?.turn;
    const claim = focus?.claimId ? claims.get(focus.claimId) : null;
    const rowClaims = focus?.rowId ? (b.claims || []).filter(c => c.row_ids.includes(focus.rowId)) : [];
    document.getElementById('trace-sub').textContent = `${shortName(ctx.actions.displayName(a.target_org?.name) || '', 40)} · v${a.version} · ${a.assessment_id}`;
    document.getElementById('trace-title').textContent = turn ? 'Inspect trace: chat answer' : claim ? `Inspect trace: claim ${claim.claim_id}` : focus?.rowId ? `Inspect trace: ${focus.rowId}` : 'Inspect trace';

    const ids = claim ? [claim.claim_id, ...claim.row_ids, ...claim.evidence_refs]
      : focus?.rowId ? [focus.rowId, ...rowClaims.map(c => c.claim_id)] : [];
    const events = turn ? (turn.trace || []) : (a.tool_trace || []);

    fill(body,
      el('div', { class: 'tr-cutoff' },
        el('div', { class: 'tr-k' }, 'Evidence boundary'),
        el('p', {}, a.data_cutoff?.rule || '', '. ', el('span', { class: 'muted' }, `Cutoff basis: ${a.data_cutoff?.basis || ''}.`)),
        el('p', { class: 'muted' }, 'The agent writes and checks; the manager decides. Decisions are never set by the agent.')),
      turn ? turnCard(turn, a) : null,
      claim ? claimCard(claim, checks.get(claim.claim_id), b, a, claims) : null,
      focus?.rowId && !claim ? rowCard(focus.rowId, rowClaims, checks, b, a) : null,
      !turn && !claim && !focus?.rowId && b.claims ? briefSummary(b) : null,
      el('div', { class: 'tr-sec' },
        el('div', { class: 'tr-k' }, turn ? 'Steps for this answer' : 'Steps for this version'),
        el('ol', { class: 'tr-steps' }, ...events.map(ev => step(ev, ids.length && touches(ev, ids))))));
  }

  function briefSummary(b) {
    const n = q => (b.checks || []).filter(c => c.quality_result === q).length;
    return el('div', { class: 'tr-sec' },
      el('div', { class: 'tr-k' }, 'Brief'),
      el('p', {}, b.status === 'model' ? 'Written by the model from this version’s evidence record' : 'Model unavailable: source-based fallback sentences',
        b.reused_from_version ? `, reused from v${b.reused_from_version} (evidence unchanged)` : '', '. ',
        `${fmtInt((b.claims || []).length)} claims shown: ${n('pass')} passed, ${n('repaired')} repaired once, ${n('fallback')} fallback`,
        (b.withheld || []).length ? `, ${b.withheld.length} withheld` : '', '.'),
      el('p', { class: 'muted' }, `Peer set: ${b.peer_status?.status}. ${b.peer_status?.reason || ''}`),
      el('p', { class: 'muted small' }, `${b.writer_version} · ${b.judge_version} · ${b.check_version} · evidence view ${b.view_hash}`));
  }

  function claimCard(c, chk, b, a, claims) {
    return el('div', { class: 'tr-sec' },
      el('div', { class: 'tr-k' }, `Claim ${c.claim_id} · ${c.kind.replace('_', ' ')}`),
      el('p', { class: 'tr-claim' }, c.sentence),
      chk ? el('p', { class: 'tr-checks' },
        el('span', { class: `tr-v tr-v-${chk.hard_result}` }, `Fact check: ${chk.hard_result === 'pass' ? 'passed' : 'failed'}`),
        el('span', { class: `tr-v tr-v-${chk.quality_result}` }, `Quality: ${QUALITY[chk.quality_result] || chk.quality_result}`),
        el('span', { class: 'muted' }, ` revision ${chk.final_claim_revision}`)) : null,
      chk?.reasons?.length ? el('details', { class: 'tr-reasons' }, el('summary', {}, `What the checks found (${chk.reasons.length})`),
        el('ul', {}, ...chk.reasons.map(r => el('li', {}, r)))) : null,
      c.derived_from_claim_ids?.length ? el('p', { class: 'muted' }, 'Motivated by: ',
        ...c.derived_from_claim_ids.map(id => el('button', { type: 'button', class: 'cite-link', onclick: () => open({ claimId: id }) }, id)), '.') : null,
      el('div', { class: 'tr-k tr-k2' }, 'Claim → evidence row → source'),
      ...c.row_ids.map(rid => rowLine(rid, a)),
      ...c.evidence_refs.map(ref => sourceCard(ref, b, a)),
      !c.evidence_refs.length ? el('p', { class: 'muted' }, c.kind === 'client_question' ? 'A question cites no evidence; it is tied to the fact claim(s) above.' : 'No evidence cited (forward-looking).') : null);
  }

  function rowCard(rowId, rowClaims, checks, b, a) {
    return el('div', { class: 'tr-sec' },
      el('div', { class: 'tr-k' }, 'Row'),
      rowLine(rowId, a),
      el('div', { class: 'tr-k tr-k2' }, `Claims about this row (${rowClaims.length})`),
      rowClaims.length ? el('ul', { class: 'tr-claims' }, ...rowClaims.map(c => el('li', {},
        el('button', { type: 'button', class: 'cite-link', onclick: () => open({ claimId: c.claim_id }) }, c.claim_id), ' ', c.sentence,
        el('span', { class: 'muted' }, ` · ${QUALITY[checks.get(c.claim_id)?.quality_result] || ''}`))))
        : el('p', { class: 'muted' }, 'The brief makes no claim about this row.'));
  }

  function rowLine(rid, a) {
    const p = (a.program_assessments || []).find(x => x.row_id === rid || (x.requirements || []).some(r => r.row_id === rid));
    const r = p && (p.requirements || []).find(x => x.row_id === rid);
    const text = r ? `${p.aln} · ${r.letter} ${r.requirement} · ${r.rank ? `rank ${r.rank}` : r.state} · ${r.group_label}` : p ? `${p.aln} ${p.program_name}` : rid;
    return el('p', { class: 'tr-row' }, el('button', { type: 'button', class: 'cite-link', onclick: () => { close(); ctx.actions.closeBrief?.(); ctx.actions.gotoRef(rid); } }, rid), ' ', el('span', { class: 'muted' }, text));
  }

  function sourceCard(ref, b, a) {
    const src = b.sources || {};
    if (src.findings?.[ref]) {
      const f = src.findings[ref];
      return el('div', { class: 'tr-src' },
        el('div', { class: 'cite-head' }, el('span', { class: 'cite-k' }, `Finding ${ref.split('#')[1]} · ${f.audit_year} audit`), el('span', { class: 'cite-date' }, `public ${fmtDate(f.public_acceptance_date)}`)),
        el('p', { class: 'muted small' }, `Report ${ref.split('#')[0]} · codes ${f.requirement_codes} · ${f.flags.join(', ').replace(/_/g, ' ') || 'no flags'}`),
        f.condition ? el('p', { class: 'cite-q' }, f.condition) : el('p', { class: 'muted' }, 'No narrative text on file.'),
        f.corrective_action ? el('p', { class: 'muted small' }, 'Corrective action: ', f.corrective_action) : null);
    }
    if (src.benchmarks?.[ref]) {
      const x = src.benchmarks[ref];
      return el('div', { class: 'tr-src' },
        el('div', { class: 'cite-head' }, el('span', { class: 'cite-k' }, `Same-program audits · ${x.program_id} ${x.requirement_code}`), el('span', { class: 'cite-date' }, `${x.audit_years[0] || ''}–${x.audit_years[1] || ''}`)),
        el('p', { class: 'cite-q' }, `${fmtInt(x.finding_report_count)} of ${fmtInt(x.eligible_report_count)} reports had this finding.`),
        el('p', { class: 'muted small' }, x.cohort_rule, '. Broad pool, not verified peers.'));
    }
    if (src.gaps?.[ref]) return el('div', { class: 'tr-src' }, el('div', { class: 'cite-k' }, 'Gap fact'), el('p', { class: 'cite-q' }, src.gaps[ref].text));
    return el('p', { class: 'muted' }, ref);
  }

  function turnCard(t, a) {
    return el('div', { class: 'tr-sec' },
      el('div', { class: 'tr-k' }, `Answer bound to v${t.assessment_version ?? a.version}`),
      el('p', { class: 'tr-claim' }, t.question || ''),
      el('p', { class: 'muted small' }, `${t.model || ''} · ${t.created_at ? fmtDate(t.created_at) : ''} · ${(t.trace || []).length} lookup(s)`,
        t.record_ids_read?.length ? ` · read ${t.record_ids_read.length} record(s)` : ''));
  }

  function step(ev, hit) {
    const args = ev.args && Object.keys(ev.args).length ? JSON.stringify(ev.args) : '';
    return el('li', { class: `tr-step${hit ? ' tr-hit' : ''}${ev.verdict && ev.verdict !== 'ok' && ev.verdict !== 'pass' ? ' tr-issue' : ''}` },
      el('div', { class: 'tr-step-h' },
        el('span', { class: 'tr-stage' }, STAGE_LABEL[ev.stage] || ev.stage || ''),
        el('span', { class: 'tr-tool' }, ev.tool_name || ev.tool),
        ev.verdict && ev.verdict !== 'ok' ? el('span', { class: `tr-v tr-v-${ev.verdict}` }, ev.verdict) : null),
      el('div', { class: 'tr-step-r' }, ev.reason || ''),
      el('div', { class: 'tr-step-s' }, ev.result_summary || ''),
      (ev.input_record_ids?.length || ev.output_record_ids?.length || args || ev.rule_or_prompt_version)
        ? el('details', {}, el('summary', {}, 'Records and rule'),
          ev.rule_or_prompt_version ? el('div', { class: 'tr-ids' }, 'Rule / prompt: ', ev.rule_or_prompt_version) : null,
          args ? el('div', { class: 'tr-ids' }, 'Input: ', args.length > 400 ? `${args.slice(0, 400)}…` : args) : null,
          ev.input_record_ids?.length ? el('div', { class: 'tr-ids' }, 'Read: ', ev.input_record_ids.join(', ')) : null,
          ev.output_record_ids?.length ? el('div', { class: 'tr-ids' }, 'Produced: ', ev.output_record_ids.join(', ')) : null) : null);
  }

  document.getElementById('trace-close').addEventListener('click', close);
  drawer.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
  return { open, close, isOpen, render };
}
