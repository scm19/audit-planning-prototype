// Evaluation view (historical engagements only). Replaces the grid. Reported outcomes stay hidden
// until a saved version is revealed; the reveal compares that frozen version and cannot change it.

import { el, $, fill, fmtDate, fmtDateTime, fmtInt, plural, requirementName, shortName } from './util.js';
import { icon } from './icons.js';
import { infoButton } from './popover.js';

export function createEvaluation(ctx) {
  const root = document.getElementById('eval-view');
  const dlg = document.getElementById('reveal-dialog');
  let pendingAid = null;

  $('#reveal-cancel', dlg).addEventListener('click', () => dlg.close());
  $('#reveal-confirm', dlg).addEventListener('click', confirmReveal);

  function render() {
    const { detail, reveal } = ctx.state;
    if (!detail) { fill(root); return; }
    const eng = detail.engagement || {};
    const head = el('div', { class: 'eval-head' },
      el('button', { type: 'button', class: 'back-link', id: 'eval-back', onclick: () => ctx.actions.setView('review') }, icon('arrowLeft', { size: 14 }), 'Review table'),
      el('h2', { class: 'eval-title' }, 'Evaluation'));
    if (eng.mode !== 'historical') {
      fill(root, head, el('p', { class: 'muted' }, 'Evaluation is available only for historical engagements, where a filed audit exists to compare against.'));
      return;
    }
    fill(root, head, reveal ? revealRecord(reveal, eng) : revealAction(eng));
  }

  const howItWorks = eng => () => el('div', { class: 'pop-body' },
    el('h3', {}, 'How evaluation works'),
    el('p', {}, `The ${eng.audit_year} audit for this nonprofit has been filed. Its reported findings, major-program selections, opinions and corrective actions are hidden from the agent, the chat and the review table.`),
    el('p', {}, 'After an assessment is saved you can reveal the reported outcomes once. The comparison reads one frozen version and cannot change it. Versions created afterwards are marked post-reveal and are not part of the evaluation.'));

  function chosenAssessment() {
    const list = ctx.state.detail?.assessments || [];
    return list.find(x => x.assessment_id === ctx.state.selectedAid && !x.post_reveal) || list.filter(x => !x.post_reveal).at(-1) || null;
  }

  function revealAction(eng) {
    const target = chosenAssessment();
    return el('div', {},
      el('p', { class: 'eval-line' }, `Reported outcomes for ${eng.audit_year} stay hidden until you reveal them against one saved version. `, infoButton('How evaluation works', howItWorks(eng))),
      el('div', { class: 'eval-action' },
        el('p', {}, target
          ? ['Will compare with ', el('strong', {}, `v${target.version}`), ` (saved ${fmtDateTime(target.created_at)}). Pick a different version in the header first if needed.`]
          : 'Available after the first assessment is saved.'),
        el('button', { type: 'button', class: 'btn btn-primary', id: 'reveal-btn', disabled: !target || null, onclick: () => openConfirm(target) }, 'Reveal reported outcomes…')));
  }

  function openConfirm(target) {
    if (!target) return;
    pendingAid = target.assessment_id;
    $('#reveal-version', dlg).textContent = `v${target.version}`;
    $('#reveal-confirm', dlg).textContent = `Reveal and compare with v${target.version}`;
    $('#reveal-saved', dlg).textContent = fmtDateTime(target.created_at);
    $('#reveal-year', dlg).textContent = String(ctx.state.detail?.engagement?.audit_year ?? '');
    fill($('#reveal-error', dlg));
    $('#reveal-confirm', dlg).disabled = false;
    dlg.showModal();
  }

  async function confirmReveal() {
    const engId = ctx.state.engId;
    if (!pendingAid || !engId) return;
    const btn = $('#reveal-confirm', dlg);
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Revealing…';
    try {
      const rec = await ctx.api.reveal(engId, pendingAid);
      dlg.close();
      await ctx.actions.afterReveal(rec);
      ctx.toast(`Reported outcomes revealed and compared with v${rec?.version ?? ''}.`);
    } catch (e) {
      fill($('#reveal-error', dlg), el('div', { class: 'error-block', role: 'alert' }, e.message));
      btn.disabled = false;
    } finally {
      btn.textContent = label;
    }
  }

  function grid(headers, rows) {
    return el('div', { class: 'grid-wrap static' }, el('table', { class: 'grid compact' },
      el('colgroup', {}, ...headers.map(h => el('col', { style: h.w ? `width:${h.w}` : null }))),
      el('thead', {}, el('tr', {}, ...headers.map(h => el('th', { scope: 'col', class: h.num ? 'num' : '' }, el('span', { class: 'th-in' }, h.icon ? icon(h.icon, { size: 13 }) : null, h.label))))),
      el('tbody', {}, ...rows)));
  }

  function revealRecord(rv, eng) {
    const frozen = ctx.state.assessments.get(rv.assessment_id);
    if (!frozen) ctx.actions.ensureAssessment(rv.assessment_id).then(r => { if (r) render(); });
    const leadInfo = id => frozen?.risks?.find(r => r.lead_id === id);
    const progName = aln => frozen?.program_assessments?.find(p => p.aln === aln)?.program_name;
    const s = rv.summary || {};
    const matches = rv.lead_matches || [];
    const pairs = rv.reported_pairs || [];
    const late = rv.reports_filed_after_cutoff || [];
    const capturedBy = (aln, letter) => matches.filter(m => m.matched && m.aln === aln && m.letter === letter).map(m => m.lead_id);
    const nMatched = s.n_matched ?? matches.filter(m => m.matched).length;

    const leadRows = matches.map((m, i) => {
      const r = leadInfo(m.lead_id);
      return el('tr', { class: 'grid-row static' },
        el('td', { class: 'c-n' }, el('span', { class: 'rn' }, String(i + 1))),
        el('td', {}, el('div', { class: 'cv', title: r?.short_title || r?.plain_language_risk || '' }, el('strong', {}, m.lead_id), ' ', r?.short_title || r?.plain_language_risk || requirementName(m.letter, r?.requirement_name))),
        el('td', {}, el('div', { class: 'cv', title: progName(m.aln) || '' }, el('span', { class: 'mono-num' }, m.aln), ' ', shortName(progName(m.aln) || '', 40))),
        el('td', {}, el('div', { class: 'cv' }, `${m.letter} · ${requirementName(m.letter, r?.requirement_name)}`)),
        el('td', {}, m.matched ? el('span', { class: 'badge badge-sm res-matched' }, 'Matched')
          : el('span', { class: 'badge badge-sm res-false', title: 'No finding was reported for this pair in the filed audit. A missing reported finding is an incomplete negative.' }, 'Apparent false lead')),
        el('td', {}, el('div', { class: 'cv mono-num' }, (m.reference_numbers || []).join(', ') || '—')));
    });
    const pairRows = pairs.map((p, i) => {
      const by = capturedBy(p.aln, p.letter);
      return el('tr', { class: 'grid-row static' },
        el('td', { class: 'c-n' }, el('span', { class: 'rn' }, String(i + 1))),
        el('td', {}, el('div', { class: 'cv', title: progName(p.aln) || '' }, el('span', { class: 'mono-num' }, p.aln), ' ', shortName(progName(p.aln) || '', 40))),
        el('td', {}, el('div', { class: 'cv' }, `${p.letter} · ${requirementName(p.letter)}`)),
        el('td', {}, el('div', { class: 'cv mono-num' }, (p.reference_numbers || []).join(', '))),
        el('td', {}, p.in_input_programs ? 'Yes' : el('span', { class: 'warn-text' }, 'No')),
        el('td', {}, by.length ? el('span', { class: 'badge badge-sm res-matched' }, `Captured by ${by.join(', ')}`) : el('span', { class: 'badge badge-sm res-missed' }, 'Missed')));
    });

    return el('div', { class: 'reveal-record' },
      el('p', { class: 'eval-line' },
        `${fmtInt(nMatched)} of ${plural(s.n_leads ?? matches.length, 'lead')} in frozen v${rv.version} matched a finding reported in the filed ${eng.audit_year} audit. Revealed ${fmtDateTime(rv.revealed_at)}. `,
        infoButton('How evaluation works', howItWorks(eng))),
      el('div', { class: 'stat-row' },
        tile(`${fmtInt(nMatched)} of ${fmtInt(s.n_leads ?? matches.length)}`, 'Leads matching a reported finding'),
        tile(`${fmtInt(s.n_reported_pairs_captured ?? 0)} of ${fmtInt(s.n_reported_pairs ?? pairs.length)}`, 'Reported program × requirement pairs captured'),
        tile(s.has_program_finding === false ? 'No' : s.has_program_finding ? 'Yes' : '—', 'Program finding reported in the filed audit')),
      el('h3', { class: 'eval-sub' }, 'Leads in the frozen prediction'),
      grid([{ label: '#', w: '46px' }, { label: 'Lead', icon: 'flag', w: '28%' }, { label: 'Program', icon: 'doc', w: '21%' }, { label: 'Requirement', icon: 'list', w: '17%' }, { label: 'Reported?', icon: 'check', w: '19%' }, { label: 'Refs', icon: 'hash', w: '15%' }], leadRows),
      el('h3', { class: 'eval-sub' }, 'Pairs reported in the filed audit'),
      pairs.length
        ? grid([{ label: '#', w: '46px' }, { label: 'Program', icon: 'doc', w: '28%' }, { label: 'Requirement', icon: 'list', w: '24%' }, { label: 'Refs', icon: 'hash', w: '16%' }, { label: 'On input list', icon: 'list', w: '14%' }, { label: 'Captured', icon: 'check', w: '18%' }], pairRows)
        : el('p', { class: 'muted' }, 'The filed audit reported no program × requirement finding, so every lead is an apparent false lead. That is not proof the areas were free of issues.'),
      late.length ? el('h3', { class: 'eval-sub' }, 'Filed after the cutoff (hidden from the prediction)') : null,
      late.length ? el('p', { class: 'eval-late' }, ...late.flatMap((r, i) => [i ? ' · ' : null, `${r.audit_year} audit, accepted ${fmtDate(r.fac_accepted_date)}`]), '.',
        el('span', { class: 'muted small eval-late-note' }, 'These existed but were not public at the cutoff, so the prediction could not use them.')) : null,
      el('p', { class: 'grid-foot' }, 'An unmatched lead is an apparent false lead, not proof the area was free of issues. ',
        infoButton('About the reveal caveat', () => el('div', { class: 'pop-body' }, el('h3', {}, 'Caveat'),
          el('p', {}, rv.caveat || 'Reported findings are an incomplete label.'),
          el('p', { class: 'muted small' }, `Target report ${rv.target_report_id || '—'}. The reveal is final for this engagement.`)))));
  }

  function tile(value, text) {
    return el('div', { class: 'stat' }, el('div', { class: 'stat-value' }, value), el('div', { class: 'stat-label' }, text));
  }

  return { render };
}
