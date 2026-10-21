// Planning recommendation: the decision layer, opened from the review header into a right-side drawer.
// PROTOTYPE: assembled from the saved assessment (leads grouped by program, template sentences,
// staff questions, unranked programs). Later the agent writes it as structured, cited claims.
// Every source pill links down to the evidence table.

import { el, fill, fmtMoney, fmtInt, fmtDate, plural, shortName, checkBadge, CHECK_LABELS, DISPOSITION_LABELS } from './util.js';
import { icon } from './icons.js';
import { claimItem } from './claims.js';

const AREA = { L: 'Reporting', P: 'Other', C: 'Cash management', E: 'Eligibility', N: 'Special tests', B: 'Allowable costs', A: 'Activities allowed', I: 'Procurement', M: 'Subrecipient monitoring', G: 'Matching', H: 'Period of performance', F: 'Equipment', J: 'Program income' };

const money = n => n == null ? '' : n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`;

export function createRecommendation(ctx, root) {
  let undo = null;
  let tab = 'rec'; // 'rec' = the agent's recommendation, 'focus' = the manager's selected focus

  function build(a, name) {
    const leads = a.risks || [];
    const progs = a.program_assessments || [];
    const byProg = new Map();
    for (const r of leads) {
      if (!byProg.has(r.program_id)) byProg.set(r.program_id, []);
      byProg.get(r.program_id).push(r);
    }
    const focus = [...byProg.entries()].map(([aln, rs]) => ({ aln, rs, prog: progs.find(p => p.aln === aln) }))
      .sort((x, y) => x.rs[0].rank - y.rs[0].rank);
    const lighter = progs.filter(p => !byProg.has(p.aln) && (p.requirements || []).length);
    const unranked = progs.filter(p => !(p.requirements || []).length);
    const own = r => r.group === 'own_latest' || r.group === 'own_older';
    const ownYears = r => r.own_summary?.years || [];
    const area = r => r.short_title || AREA[r.requirement_code] || r.requirement_name;
    return { leads, focus, lighter, unranked, own, ownYears, area, name };
  }

  // A source pill: names the evidence, links to its rows.
  const pill = (text, onclick, title) => el('button', { type: 'button', class: 'rec-pill', title: title || text, onclick }, text);
  const toRow = rowId => () => { close(); ctx.actions.gotoRef(rowId); };
  const drawer = root.closest('.brief');
  const isOpen = () => !drawer.hidden;
  function open() { drawer.hidden = false; document.body.classList.add('brief-open'); render(); document.getElementById('brief-title').focus(); }
  function close() { if (drawer.hidden) return; drawer.hidden = true; document.body.classList.remove('brief-open'); document.getElementById('brief-btn')?.focus(); }

  function render() {
    const a = ctx.state.assessment;
    if (!isOpen()) return;
    if (!a) { fill(root, el('p', { class: 'muted' }, 'Assess the engagement first; the recommendation summarizes the saved assessment.')); return; }
    if (!(a.risks || []).length) { fill(root, el('p', { class: 'muted' }, 'No area had evidence that fits well enough to propose as a lead. Every program and its history are still in the review table, with the reason for each row.')); return; }
    const name = ctx.actions.displayName(a.target_org?.name) || 'This nonprofit';
    if (a.brief?.claims?.length) { renderAgent(a, name); return; }
    const m = build(a, name);
    // Short org name for sentences: drop the legal suffix, keep up to two words.
    const base = name.replace(/,?\s+(inc|llc|corp|corporation|co)\.?$/i, '').trim();
    const short = base.length > 22 ? base.split(/\s+/).slice(0, 2).join(' ') : base;
    const pname = p => ctx.actions.displayName(p?.program_name || '') || '';
    const collapsed = !!ctx.prefs.recCollapsed;
    const top = m.focus[0];
    const latestOwn = top.rs.filter(r => r.group === 'own_latest');
    const topAreas = (latestOwn.length ? latestOwn : top.rs.filter(m.own)).slice(0, 2).map(r => (r.short_title || AREA[r.requirement_code] || r.requirement_name));
    const topRepeat = top.rs.some(r => m.ownYears(r).length > 1);
    const topSrc = top.rs.find(m.own);
    const headline = [
      'Give ', el('strong', {}, `${shortName(pname(top.prog), 40) || top.aln} (${top.aln}, ${fmtMoney(top.prog?.amount)})`), ' a close look',
      topAreas.length ? [', focusing on ', el('strong', {}, joinAnd(topAreas.map(x => x.toLowerCase()))),
        topRepeat ? `: repeat findings in ${short}’s own audits.` : `: reported in ${short}’s own latest audit.`] : ': other nonprofits often report findings here.',
    ];
    const decided = ctx.decisions;
    const undecided = m.leads.filter(r => !decided.get(a.assessment_id, r.requirement_row_id).disposition);
    const nRead = m.leads.reduce((n, r) => n + (r.evidence_check?.narratives_read || []).length, 0);
    const maxPeers = Math.max(0, ...m.leads.map(r => r.peer?.n || 0));
    const latest = a.own_history?.reports?.[0]?.audit_year;

    document.getElementById('brief-sub').textContent = `${name} · v${a.version} · public reports as of ${a.prediction_date}`;

    const sec = (title, items) => items.length ? el('div', { class: 'rec-sec' }, el('h4', {}, title), el('ul', {}, ...items)) : null;
    const body = el('div', { class: 'rec-body' },
      el('p', { class: 'rec-trace' }, `Checked ${plural((a.own_history?.reports || []).length, 'public report')} of ${short} · ${fmtInt(maxPeers)} same-program audits · read ${plural(nRead, 'finding')}`),
      el('div', { class: 'rec-lead' },
        el('div', { class: 'rec-lead-k' }, 'Recommended testing focus'),
        el('p', {}, ...headline.flat(), ' ', topSrc ? pill(`${short} ${m.ownYears(topSrc).at(-1) || ''} audit${topSrc.sources?.length > 1 ? ` +${topSrc.sources.length - 1}` : ''}`, toRow(topSrc.requirement_row_id)) : null)),
      sec('Programs to give a close look', [
        ...m.focus.map(f => el('li', {}, el('strong', {}, `${f.aln} ${shortName(pname(f.prog), 30)}: `),
          joinAnd(f.rs.map(m.area)), '. ',
          f.rs.some(m.own) ? `Own findings ${yearsOf(f.rs.flatMap(m.ownYears))}.` : 'Same-program patterns only.', ' ',
          ...f.rs.slice(0, 1).map(r => pill(`${r.lead_id}${f.rs.length > 1 ? ` +${f.rs.length - 1}` : ''}`, toRow(r.requirement_row_id))))),
        ...m.lighter.slice(0, 2).map(p => el('li', { class: 'rec-light' }, el('strong', {}, `${p.aln} ${shortName(pname(p), 30)} (${fmtMoney(p.amount)}): `),
          'weaker signals only, ranked below the top five; not reviewed by the agent. ', pill('Rows', toRow(p.row_id)))),
      ]),
      sec('Ask the client for early', m.leads.filter(r => r.verification_question).map(r => el('li', {},
        el('strong', {}, `${m.area(r)}: `), firstSentence(r.verification_question), ' ', pill(r.lead_id, toRow(r.requirement_row_id))))),
      m.unranked.length ? el('div', { class: 'rec-sec rec-caution' }, el('h4', {}, 'Where history can’t help: your call'),
        el('ul', {}, el('li', {}, `${plural(m.unranked.length, 'program')} (${fmtMoney(m.unranked.reduce((s, p) => s + (p.amount || 0), 0))}) can’t be ranked: `,
          unrankedWhy(m.unranked), '. None of this means low risk. Decide whether each needs a close look. ',
          pill(`Not ranked (${m.unranked.length})`, () => { close(); ctx.actions.filterRows({ state: 'unranked', program: 'all' }); })))) : null,
      sec('What could change this', [
        latest ? el('li', {}, `${short}'s latest usable audit is ${latest}`, a.target_year - latest > 1 ? `, ${a.target_year - latest} years before this one` : '', '. Later results may differ.') : el('li', {}, `No earlier public audit of ${short}: this rests on other nonprofits only.`),
        ...m.leads.filter(r => r.evidence_check?.status === 'weak_match' || r.evidence_check?.status === 'conflict').slice(0, 2)
          .map(r => el('li', {}, `${r.lead_id} (${m.area(r)}) is a ${r.evidence_check.status === 'conflict' ? 'conflict' : 'weak match'} with its source text. `, pill(r.lead_id, toRow(r.requirement_row_id)))),
      ]),
      el('div', { class: 'rec-actions' },
        undo ? el('span', { class: 'rec-done' }, icon('check', { size: 13 }), `Marked ${plural(undo.length, 'area')} Include. `,
          el('button', { type: 'button', class: 'btn-link small', onclick: () => { for (const [rid, d] of undo) decided.setDisposition(a.assessment_id, rid, d); undo = null; render(); } }, 'Undo'))
          : undecided.length ? el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => {
            undo = undecided.map(r => [r.requirement_row_id, null]);
            for (const r of undecided) decided.setDisposition(a.assessment_id, r.requirement_row_id, 'include');
            render();
          } }, icon('check', { size: 13 }), `Mark these ${plural(undecided.length, 'area')} Include`)
            : el('span', { class: 'rec-done' }, icon('check', { size: 13 }), `All ${m.leads.length} areas have a decision.`),
        el('button', { type: 'button', class: 'rec-next', onclick: () => { close(); ctx.actions.sendPrompt('Draft the staff focus note from my decisions'); } },
          el('span', { class: 'rec-next-ic', 'aria-hidden': 'true' }, '↳'), 'Draft the staff note from this?', el('span', { class: 'rec-yes' }, 'Yes →'))));
    fill(root, el('section', { class: 'rec' }, body));
  }

  // The manager's planning decision in one place: selected priorities with reasons, the early
  // requests for them, and what is still unresolved. Built from decisions + the saved version.
  function focusView(a, m, requestItems) {
    const decided = ctx.decisions;
    const d = r => decided.get(a.assessment_id, r.requirement_row_id);
    const leads = m.leads;
    const sel = leads.filter(r => ['include', 'investigate'].includes(d(r).disposition));
    const aside = leads.filter(r => d(r).disposition === 'set_aside');
    const open_ = leads.filter(r => !d(r).disposition);
    const questions = (a.brief?.claims || []).filter(c => c.kind === 'client_question');
    const pname = p => ctx.actions.displayName(p?.program_name || '') || '';
    const prog = r => (a.program_assessments || []).find(p => p.aln === r.program_id);
    const unresolved = [];
    for (const r of sel) {
      for (const x of r.related || []) if (x.status !== 'supported') unresolved.push([r, `${CHECK_LABELS[x.status] || x.status}: ${x.requirement_name} rests on the same findings. ${x.distinct_check}`]);
      if (r.conditional) unresolved.push([r, `Conditional: ${r.conditional}`]);
      if (['weak_match', 'conflict'].includes(r.evidence_check?.status)) unresolved.push([r, `${CHECK_LABELS[r.evidence_check.status]}: ${r.evidence_check.notes?.split(/(?<=\.)\s/)[0] || ''}`]);
    }
    const head = r => el('div', { class: 'rec-req-h' }, el('button', { type: 'button', class: 'rec-area-link', onclick: toRow(r.requirement_row_id) },
      el('strong', {}, `${r.lead_id} · ${r.program_id} ${shortName(pname(prog(r)), 34)} · ${m.area(r)}`)),
      el('span', { class: `rec-dec rec-dec-${d(r).disposition}` }, DISPOSITION_LABELS[d(r).disposition] || ''));
    const selItem = r => {
      const q = questions.find(c => c.row_ids.includes(r.requirement_row_id));
      return el('li', { class: 'rec-sel' }, head(r),
        el('p', { class: 'rec-sel-why' }, el('span', { class: 'rec-sel-k' }, d(r).note ? 'Your reason' : 'Agent’s reason'), d(r).note || r.why_this_client || r.plain_language_risk),
        el('p', { class: 'rec-sel-why' }, el('span', { class: 'rec-sel-k' }, 'Evidence check'), checkBadge(r.evidence_check?.status),
          (r.related || []).length ? ` · also tagged ${r.related.map(x => x.requirement_name).join(', ')}` : ''),
        el('p', { class: 'rec-sel-why' }, el('span', { class: 'rec-sel-k' }, 'Early request'), q ? q.sentence : (r.verification_question || '')));
    };
    const sec = (title, nodes, cls = '') => nodes.length ? el('div', { class: `rec-sec ${cls}`.trim() }, el('h4', {}, title), ...nodes) : null;
    const progDecs = (a.program_assessments || []).map(p => ({ p, d: decided.get(a.assessment_id, p.row_id) })).filter(x => x.d.disposition);
    const DORD = { include: 0, investigate: 1, set_aside: 2 };
    progDecs.sort((x, y) => DORD[x.d.disposition] - DORD[y.d.disposition]);
    return el('div', { class: 'rec-body' },
      el('div', { class: 'rec-lead' }, el('div', { class: 'rec-lead-k' }, 'Your planning focus'),
        el('p', {}, progDecs.length ? `${plural(progDecs.length, 'program decision')}; ` : '', sel.length ? `${plural(sel.length, 'area')} selected for testing focus` : 'No areas selected yet', `, ${aside.length} set aside, ${open_.length} still undecided. `,
          el('span', { class: 'muted' }, 'The agent proposes areas to verify; these are your decisions.'))),
      progDecs.length ? sec('Program decisions', [el('ul', { class: 'rec-sels' }, ...progDecs.map(({ p, d: pd }) => el('li', { class: 'rec-sel' },
        el('div', { class: 'rec-req-h' }, el('button', { type: 'button', class: 'rec-area-link', onclick: () => { close(); ctx.actions.filterRows({ program: p.row_id, state: 'all' }); } },
          el('strong', {}, `${p.aln} ${shortName(pname(p), 40)}`)), el('span', { class: `rec-dec rec-dec-${pd.disposition}` }, DISPOSITION_LABELS[pd.disposition])),
        pd.note ? el('p', { class: 'rec-sel-why' }, el('span', { class: 'rec-sel-k' }, 'Your reason'), pd.note) : null)))]) : null,
      sel.length ? sec('Selected priorities', [el('ol', { class: 'rec-sels' }, ...sel.map(selItem))])
        : el('p', { class: 'muted' }, 'Mark areas Include or Investigate in the review table or the recommendation; they collect here with your reasons.'),
      sec('Unresolved checks', [el('ul', {},
        ...unresolved.map(([r, t]) => el('li', {}, el('strong', {}, `${r.lead_id}: `), t)),
        open_.length ? el('li', {}, `No decision yet on ${open_.map(r => r.lead_id).join(', ')}. `, ...open_.slice(0, 5).map(r => pill(r.lead_id, toRow(r.requirement_row_id)))) : null)].filter(x => x.childNodes.length), 'rec-caution'),
      aside.length ? sec('Set aside', [el('ul', {}, ...aside.map(r => el('li', {}, el('strong', {}, `${r.lead_id} · ${m.area(r)}: `), d(r).note || 'no note')))]) : null,
      el('div', { class: 'rec-actions' },
        el('button', { type: 'button', class: 'rec-next', onclick: () => { close(); ctx.actions.sendPrompt('Draft the staff focus note from my decisions'); } },
          el('span', { class: 'rec-next-ic', 'aria-hidden': 'true' }, '↳'), 'Draft the staff note from these decisions?', el('span', { class: 'rec-yes' }, 'Yes →'))));
  }


  // Agent-written brief: checked claims from the saved version, each with exact citations.
  const SECTION_TITLE = { focus: 'Where to look', requests: 'Ask the client for early', gaps: 'Where history can’t help', changes: 'What could change this' };
  function renderAgent(a, name) {
    const b = a.brief;
    const claims = new Map(b.claims.map(c => [c.claim_id, c]));
    const n = q => (b.checks || []).filter(c => c.quality_result === q && claims.has(c.claim_id)).length;
    const decided = ctx.decisions;
    const m = build(a, name);
    const leads = m.leads;
    const undecided = leads.filter(r => !decided.get(a.assessment_id, r.requirement_row_id).disposition);
    const pname = p => ctx.actions.displayName(p?.program_name || '') || '';
    const progsOf = c => [...new Set(c.row_ids.map(r => r.split(':')[1]).filter(Boolean))];
    const inSec = s => (b.sections?.[s] || []).map(id => claims.get(id)).filter(Boolean);
    const facts = c => c.kind === 'history_fact' || c.kind === 'aggregate_fact';
    const li = c => claimItem(ctx, a, c, close);
    document.getElementById('brief-sub').textContent = `${name} · v${a.version} · public reports as of ${a.prediction_date}`;

    // The plan is per program (program_focus claims); finding-level facts live on the evidence rows.
    // Briefs written before program_focus existed show their first focus claim for the program.
    const focus = inSec('focus');
    const auditWide = c => c.evidence_refs.some(ref => b.sources?.findings?.[ref]?.scope === 'audit_filing');
    const across = focus.filter(c => facts(c) && (progsOf(c).length > 1 || auditWide(c)));
    const reasonsFor = aln => {
      const plan = focus.filter(c => c.kind === 'program_focus' && progsOf(c)[0] === aln);
      return plan.length ? plan : focus.filter(c => progsOf(c).length === 1 && progsOf(c)[0] === aln).slice(0, 1);
    };
    const nEvidence = f => b.claims.filter(c => facts(c) && f.rs.some(r => c.row_ids.includes(r.requirement_row_id))).length;
    const basis = r => r.group === 'peer_only' ? 'other nonprofits' : `own ${yearsOf(m.ownYears(r))}`;
    const review = f => () => { close(); ctx.actions.filterRows({ program: `P:${f.aln}`, state: 'all' }); };
    const textOf = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();

    // Fixed anatomy: every section has a number, a title, where its content comes from, and Ask.
    const askBtn = (title, quote, rowId) => el('button', { type: 'button', class: 'ask-btn', title: 'Ask the agent about this',
      onclick: () => ctx.actions.askAbout?.(title, quote, rowId) }, icon('ask', { size: 13 }), 'Ask');
    const section = (num, title, source, nodes, { rowId = 'the planning brief', cls = '' } = {}) => {
      const content = nodes.filter(Boolean);
      const bodyEl = el('div', { class: 'rec-sb' }, ...(content.length ? content : [el('p', { class: 'rec-none' }, 'None noted.')]));
      return el('section', { class: `rec-s ${cls}`.trim() },
        el('div', { class: 'rec-sh' }, el('span', { class: 'rec-sn' }, num), el('h4', {}, title), el('span', { class: 'rec-src' }, source),
          askBtn(title, textOf(bodyEl), rowId)),
        bodyEl);
    };
    const field = (label, ...content) => el('div', { class: 'rec-f' }, el('h5', { class: 'rec-fk' }, label), el('div', { class: 'rec-fv' }, ...content));

    const pdec = f => decided.get(a.assessment_id, `P:${f.aln}`).disposition;
    // One program, said once: header, area lines, one reason, an optional note, the evidence link.
    const progCard = (f, i) => {
      const notes = [];
      for (const r of f.rs) {
        for (const x of r.related || []) notes.push(`${r.lead_id} is also tagged ${(AREA[x.requirement_code] || x.requirement_name).toLowerCase()} on the same findings (${(CHECK_LABELS[x.status] || x.status).toLowerCase()}); check it separately.`);
        if (['weak_match', 'conflict'].includes(r.evidence_check?.status)) notes.push(`${r.lead_id}: ${CHECK_LABELS[r.evidence_check.status].toLowerCase()} with its source text.`);
      }
      const why = reasonsFor(f.aln)[0];
      const whyNode = why ? claimItem(ctx, a, why, close, 'div') : null;
      if (whyNode) whyNode.classList.add('rec-why-text');
      const long = why && why.sentence.length > 200;
      return el('li', { class: 'rec-card' },
        el('div', { class: 'rec-card-h' },
          el('span', { class: 'rec-prog-n' }, String(i + 1)),
          el('span', { class: 'rec-prog-title' },
            el('button', { type: 'button', class: 'rec-prog-name', onclick: review(f) },
              el('span', { class: 'rec-prog-aln' }, f.aln), ' ', shortName(pname(f.prog), 46)),
            f.prog?.amount != null ? el('span', { class: 'rec-prog-amt-inline' }, ` · ${money(f.prog.amount)}`) : null,
            pdec(f) ? el('span', { class: `rec-dec rec-dec-${pdec(f)}`, title: 'Your program decision' }, DISPOSITION_LABELS[pdec(f)]) : null),
          askBtn(`${f.aln} ${pname(f.prog)}`, why?.sentence || '', `P:${f.aln}`)),
        ...f.rs.map(r => el('div', { class: 'rec-area-line' },
          el('button', { type: 'button', class: 'rec-area-link', title: `Open ${r.requirement_row_id}`, onclick: toRow(r.requirement_row_id) },
            el('span', { class: 'rec-area-id' }, r.lead_id), ` ${m.area(r)}`),
          el('span', { class: 'rec-area-basis' }, ` · ${basis(r)}`),
          r.conditional ? el('span', { class: 'tag tag-sand tag-xs', title: r.conditional }, 'Conditional') : null)),
        whyNode,
        long ? el('button', { type: 'button', class: 'rec-more', onclick: e => { whyNode.classList.toggle('is-open'); e.currentTarget.textContent = whyNode.classList.contains('is-open') ? 'less' : 'more'; } }, 'more') : null,
        ...notes.map(t => el('div', { class: 'rec-note-line' }, t)),
        el('button', { type: 'button', class: 'rec-ev', onclick: review(f) },
          `Review evidence${nEvidence(f) ? ` · ${plural(nEvidence(f), 'note')}` : ''} →`));
    };

    // ① Focus: from the frozen ranking (code, not the model).
    const nOwn = leads.filter(m.own).length;
    const first = m.focus[0];
    const nCond = leads.filter(r => r.conditional).length;
    const headline = el('p', { class: 'rec-headline' },
      m.focus.length === 1 ? 'Give ' : `Give ${m.focus.length} programs a close look, starting with `,
      el('strong', {}, `${first.aln} ${shortName(pname(first.prog), 44)}`), m.focus.length === 1 ? ' a close look.' : '.');
    const facts1 = el('p', { class: 'rec-facts' },
      [plural(m.focus.length, 'program'), plural(leads.length, 'area'),
        nOwn === leads.length ? 'all from own findings' : nOwn ? `${nOwn} from own findings` : 'all from other nonprofits’ audits',
        nCond ? `${nCond} conditional` : null].filter(Boolean).join(' · '));

    // ③ Early client requests: one per lead, then engagement-wide ones; manager decisions first.
    const questions = b.claims.filter(c => c.kind === 'client_question');
    const DORDER = { include: 0, investigate: 1, null: 2, undefined: 2, set_aside: 3 };
    const requestItems = () => {
      const items = leads.map(r => ({ r, d: decided.get(a.assessment_id, r.requirement_row_id).disposition,
        qs: questions.filter(c => c.row_ids.includes(r.requirement_row_id)) }));
      const general = questions.filter(c => !leads.some(r => c.row_ids.includes(r.requirement_row_id)));
      items.sort((x, y) => (DORDER[x.d] - DORDER[y.d]) || (x.r.rank - y.r.rank));
      const row = (label, sub, d, node, cls = '') => el('li', { class: `rec-req ${cls}`.trim() },
        el('span', { class: 'rec-req-k' }, el('span', { class: 'rec-req-id' }, label), sub ? el('span', { class: 'rec-req-sub' }, sub) : null,
          d ? el('span', { class: `rec-dec rec-dec-${d}` }, DISPOSITION_LABELS[d]) : null), node);
      return [
        ...items.map(({ r, d, qs }) => row(`${r.lead_id} · ${r.program_id}`, m.area(r), d,
          qs.length ? claimItem(ctx, a, qs[0], close, 'div') : el('div', { class: 'claim' }, r.verification_question || '', ' ', pill('row', toRow(r.requirement_row_id))),
          d === 'set_aside' ? 'is-aside' : '')),
        ...general.map(c => row('Engagement-wide', c.derived_from_claim_ids.some(id => { const f = claims.get(id); return f && auditWide(f); }) ? 'Audit filing' : null,
          null, claimItem(ctx, a, c, close, 'div'))),
      ];
    };

    // Weaker programs fold into ②: checked and not leads, then ranked below the leads.
    const notLeads = (a.review_order?.entries || []).filter(e => e.review_rank == null && ['weak_match', 'conflict'].includes(e.check));
    const label = rid => { const [, aln, l] = rid.split(':'); return `${aln} ${AREA[l] || l}`; };
    const crossProgram = across.filter(c => !auditWide(c));
    const audits = across.filter(auditWide);

    const body = el('div', { class: 'rec-body' },
      el('div', { class: 'rec-meta' },
        el('span', {}, b.status === 'model' ? 'Agent-written' : 'Model unavailable · source-based', ` · ${plural(b.claims.length, 'claim')} checked`,
          n('repaired') ? ` · ${n('repaired')} repaired` : '', n('fallback') ? ` · ${n('fallback')} fallback` : ''),
        el('button', { type: 'button', class: 'rec-meta-link', id: 'brief-trace', onclick: () => ctx.actions.inspectTrace({}) }, 'Inspect trace')),
      section('1', 'Focus', 'From the ranking', [headline, facts1]),
      section('2', 'Programs to examine', 'Agent-written · checked', [
        crossProgram.length ? field('Across', ...crossProgram.map(c => claimItem(ctx, a, c, close, 'div'))) : null,
        el('ol', { class: 'rec-cards' }, ...m.focus.map(progCard)),
        notLeads.length ? el('p', { class: 'rec-light' }, 'Not leads after the evidence check: ',
          ...notLeads.slice(0, 3).flatMap((e, i) => [i ? ', ' : '', el('button', { type: 'button', class: 'rec-light-link', onclick: toRow(e.row_id) }, label(e.row_id)), ` (${CHECK_LABELS[e.check].toLowerCase()})`]),
          notLeads.length > 3 ? ` +${notLeads.length - 3} more` : '', '.') : null,
        m.lighter.length ? el('p', { class: 'rec-light' }, 'Ranked below the leads: ',
          ...m.lighter.slice(0, 3).flatMap((p, i) => [i ? ', ' : '', el('button', { type: 'button', class: 'rec-light-link', onclick: () => { close(); ctx.actions.filterRows({ program: p.row_id, state: 'all' }); } }, `${p.aln} ${shortName(pname(p), 26)}`), ` (${money(p.amount)})`]),
          m.lighter.length > 3 ? ` +${m.lighter.length - 3} more` : '', '.') : null]),
      section('3', 'Early client requests', 'Agent-written · checked', [el('ol', { class: 'rec-reqs' }, ...requestItems())]),
      section('4', 'Limits of history · your call', 'From the record', [
        ...audits.map(c => claimItem(ctx, a, c, close, 'div')),
        ...inSec('gaps').map(c => claimItem(ctx, a, c, close, 'div')),
        m.unranked.length ? el('div', { class: 'claim' }, `${plural(m.unranked.length, 'program')} (${fmtMoney(m.unranked.reduce((s, p) => s + (p.amount || 0), 0))}) can’t be ranked: `, unrankedWhy(m.unranked), '. None of this means low risk. ',
          pill(`Not ranked (${m.unranked.length})`, () => { close(); ctx.actions.filterRows({ state: 'unranked', program: 'all' }); })) : null], { cls: 'rec-s-limits' }),
      section('5', 'What could change this', 'Agent-written', inSec('changes').map(c => claimItem(ctx, a, c, close, 'div'))),
      el('div', { class: 'rec-actions' },
        undo ? el('span', { class: 'rec-done' }, icon('check', { size: 13 }), `Marked ${plural(undo.length, 'area')} Include. `,
          el('button', { type: 'button', class: 'btn-link small', onclick: () => { for (const [rid, d] of undo) decided.setDisposition(a.assessment_id, rid, d); undo = null; render(); } }, 'Undo'))
          : undecided.length ? el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => {
            undo = undecided.map(r => [r.requirement_row_id, null]);
            for (const r of undecided) decided.setDisposition(a.assessment_id, r.requirement_row_id, 'include');
            render();
          } }, icon('check', { size: 13 }), `Mark these ${plural(undecided.length, 'area')} Include`)
            : el('span', { class: 'rec-done' }, icon('check', { size: 13 }), `All ${leads.length} areas have a decision.`),
        el('button', { type: 'button', class: 'rec-next', onclick: () => { close(); ctx.actions.sendPrompt('Draft the staff focus note from my decisions'); } },
          el('span', { class: 'rec-next-ic', 'aria-hidden': 'true' }, '↳'), 'Draft the staff note from this?', el('span', { class: 'rec-yes' }, 'Yes →'))));
    const nSel = leads.filter(r => ['include', 'investigate'].includes(decided.get(a.assessment_id, r.requirement_row_id).disposition)).length
      + (a.program_assessments || []).filter(p => ['include', 'investigate'].includes(decided.get(a.assessment_id, p.row_id).disposition)).length;
    const tabs = el('div', { class: 'rec-tabs', role: 'tablist' },
      el('button', { type: 'button', role: 'tab', class: 'rec-tab', 'aria-selected': String(tab === 'rec'), onclick: () => { tab = 'rec'; render(); } }, 'Recommendation'),
      el('button', { type: 'button', role: 'tab', class: 'rec-tab', 'aria-selected': String(tab === 'focus'), onclick: () => { tab = 'focus'; render(); } }, 'Your focus', el('span', { class: 'rec-tab-n' }, String(nSel))));
    fill(root, el('section', { class: 'rec' }, tabs, tab === 'focus' ? focusView(a, m, requestItems) : body));
  }

  document.getElementById('brief-close').addEventListener('click', close);
  drawer.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
  return { render, open, close, isOpen, clearUndo: () => { undo = null; } };
}

// Why programs can't be ranked, in plain words. "No reported signal" means history exists
// with no reported finding; it is not the same as no history.
function unrankedWhy(progs) {
  const say = { no_reported_signal: 'tested before with nothing reported', too_little_evidence: 'too little same-program history', could_not_assess: 'program number not recognized' };
  return progs.map(p => `${p.aln} (${say[p.state] || 'no ranking signal'})`).join(', ');
}

function joinAnd(xs) {
  const u = [...new Set(xs)];
  return u.length <= 1 ? (u[0] || '') : `${u.slice(0, -1).join(', ')} and ${u.at(-1)}`;
}
function yearsOf(ys) {
  const u = [...new Set(ys)].sort();
  return u.length > 2 && u.at(-1) - u[0] === u.length - 1 ? `${u[0]}–${u.at(-1)}` : u.join(', ');
}
function firstSentence(t) {
  const s = (t || '').split(/(?<=\?|\.)\s/)[0];
  if (s.length <= 120) return s;
  return `${s.slice(0, s.lastIndexOf(' ', 118))}…`;
}
