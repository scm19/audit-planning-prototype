// The manager's planning decision for a whole program, stored on the program row (P:<aln>)
// alongside area decisions. It records where the manager wants a close look; it does not
// replace the auditor's major-program selection.

import { el, DISPOSITIONS, DISPOSITION_LABELS } from './util.js';

const HINT = { include: 'Close look', investigate: 'Need more information', set_aside: 'Not a focus' };

export function programDecision(ctx, a, progRowId) {
  const d = ctx.decisions.get(a.assessment_id, progRowId);
  const set = v => ctx.decisions.setDisposition(a.assessment_id, progRowId, ctx.decisions.get(a.assessment_id, progRowId).disposition === v ? null : v);
  return el('div', { class: 'pdec' },
    el('span', { class: 'pdec-k' }, 'Your program decision'),
    el('div', { class: 'pdec-seg', role: 'group', 'aria-label': 'Program decision' },
      ...DISPOSITIONS.map(o => el('button', { type: 'button', class: `pdec-b pdec-${o.value}`, 'data-pdec': progRowId, 'data-v': o.value,
        'aria-pressed': String(d.disposition === o.value), title: HINT[o.value], onclick: () => set(o.value) }, o.label))),
    el('input', { type: 'text', class: 'pdec-note', placeholder: 'Why (optional)', value: d.note || '', 'aria-label': 'Program decision note',
      oninput: e => ctx.decisions.setNote(a.assessment_id, progRowId, e.target.value) }));
}

/** Keep the buttons in sync without re-rendering (so a note being typed keeps focus). */
export function syncProgramDecision(root, rowId, e) {
  for (const b of root.querySelectorAll(`[data-pdec="${CSS.escape(rowId)}"]`)) b.setAttribute('aria-pressed', String(e.disposition === b.dataset.v));
}

export const programDecisionLabel = v => DISPOSITION_LABELS[v] || '';
