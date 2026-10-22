// Agent claims with exact citations, shared by the brief drawer and the row drawer. Each pill is
// one cited record id from the saved version; its popover shows that record.

import { el, fmtInt, fmtDate, shortName } from './util.js';
import { openPopover } from './popover.js';

/** One claim as an <li>: sentence, exact source pills, fallback mark, trace link. */
export function claimItem(ctx, a, c, beforeNav = () => {}, tag = 'li') {
  const chk = (a.brief?.checks || []).find(x => x.claim_id === c.claim_id) || {};
  return el(tag, { class: 'claim', 'data-claim': c.claim_id },
    el('span', { class: 'claim-text' }, c.sentence), ' ',
    ...c.evidence_refs.map(ref => sourcePill(ctx, a, ref, c, beforeNav)),
    chk.quality_result === 'fallback' ? el('span', { class: 'claim-tag', title: 'The model’s sentence failed a check; this is a source-based fallback.' }, 'fallback') : null,
    el('button', { type: 'button', class: 'claim-tr', title: `Inspect trace for ${c.claim_id}`, 'aria-label': `Inspect trace for claim ${c.claim_id}`, onclick: () => ctx.actions.inspectTrace({ claimId: c.claim_id }) }, c.claim_id));
}

export function sourcePill(ctx, a, ref, c, beforeNav) {
  const src = a.brief?.sources || {};
  const f = src.findings?.[ref], bm = src.benchmarks?.[ref], g = src.gaps?.[ref];
  const label_ = f ? `${ref.split('#')[1]}` : bm ? `${fmtInt(bm.finding_report_count)}/${fmtInt(bm.eligible_report_count)}` : g ? 'gap' : ref;
  const kind = f ? 'own' : bm ? 'peer' : 'gap';
  return el('button', { type: 'button', class: `rec-pill rec-pill-${kind}`, title: f ? `Finding ${ref}` : bm ? 'Same-program audits' : 'Gap fact',
    onclick: e => openPopover(e.currentTarget, done => sourcePop(ctx, a, ref, c, done, beforeNav), { label: label_, cls: 'cite-pop' }) }, label_);
}

function sourcePop(ctx, a, ref, c, done, beforeNav) {
  const src = a.brief?.sources || {};
  const f = src.findings?.[ref], bm = src.benchmarks?.[ref], g = src.gaps?.[ref];
  const rowId = f?.row_id || bm?.row_id || c.row_ids[0];
  const head = (l, r) => el('div', { class: 'cite-head' }, el('span', { class: 'cite-k' }, l), r ? el('span', { class: 'cite-date' }, r) : null);
  const links = el('div', { class: 'cite-links' },
    rowId ? el('button', { type: 'button', class: 'cite-link', onclick: () => { done(); beforeNav(); ctx.actions.gotoRef(rowId); } }, 'Open row →') : null,
    el('button', { type: 'button', class: 'cite-link', onclick: () => { done(); ctx.actions.inspectTrace({ claimId: c.claim_id }); } }, 'Inspect trace →'));
  if (f) return el('div', { class: 'cite-body' },
    head(`${shortName(ctx.actions.displayName(f.org) || '', 26)} ${f.audit_year} · ${ref.split('#')[1]}`, `public ${fmtDate(f.public_acceptance_date)}`),
    f.condition ? el('p', { class: 'cite-q' }, f.condition) : el('p', { class: 'muted' }, 'No narrative text on file; codes and flags only.'),
    el('p', { class: 'muted small' }, `Codes ${f.requirement_codes} · ${f.flags.join(', ').replace(/_/g, ' ') || 'no flags'} · report ${ref.split('#')[0]}`), links);
  if (bm) return el('div', { class: 'cite-body' },
    head(`Same-program audits · ${bm.program_id}`, `${bm.audit_years[0] || ''}–${bm.audit_years[1] || ''}`),
    el('p', { class: 'cite-q' }, `${fmtInt(bm.finding_report_count)} of ${fmtInt(bm.eligible_report_count)} reports had a ${bm.requirement_code} finding.`),
    el('p', { class: 'muted small' }, `${bm.cohort_rule}. A broad pool, not verified peers.`), links);
  return el('div', { class: 'cite-body' }, head('Gap fact'), el('p', { class: 'cite-q' }, g?.text || ref), links);
}
