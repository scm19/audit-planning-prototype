// New engagement: debounced org search -> audit year (historical/live) -> program input -> create.

import { el, $, fmtDate, fmtInt, debounce, fill } from './util.js';

export function createNewEngagement(ctx) {
  const dlg = document.getElementById('new-eng-dialog');
  const form = $('#ne-form', dlg);
  const q = $('#ne-q', dlg);
  const results = $('#ne-results', dlg);
  const searchStatus = $('#ne-search-status', dlg);
  const yearsFs = $('#ne-years-fs', dlg);
  const years = $('#ne-years', dlg);
  const progFs = $('#ne-prog-fs', dlg);
  const liveNote = $('#ne-live-note', dlg);
  const createBtn = $('#ne-create', dlg);
  const err = $('#ne-error', dlg);
  let org = null;
  let year = null;
  let searchToken = 0;
  let yearsToken = 0;

  $('#ne-close', dlg).addEventListener('click', () => dlg.close());
  $('#ne-cancel', dlg).addEventListener('click', () => dlg.close());
  q.addEventListener('input', debounce(search, 280));
  q.addEventListener('focus', () => { if (!q.value.trim()) showRecent(); });
  form.addEventListener('submit', e => { e.preventDefault(); create(); });

  function open() {
    org = null;
    year = null;
    q.value = '';
    showRecent();
    yearsFs.hidden = true;
    progFs.hidden = true;
    liveNote.hidden = true;
    fill(err);
    $('#ne-mode-proxy', dlg).checked = true;
    update();
    dlg.showModal();
    q.focus();
  }

  async function search() {
    const term = q.value.trim();
    const t = ++searchToken;
    if (term.length < 2) { showRecent(); return; }
    searchStatus.textContent = 'Searching…';
    let list;
    try {
      list = await ctx.api.searchOrgs(term);
    } catch (e) {
      if (t !== searchToken) return;
      searchStatus.textContent = `Search failed: ${e.message}`;
      return;
    }
    if (t !== searchToken) return;
    list = list || [];
    searchStatus.textContent = list.length ? `${list.length === 20 ? 'First 20' : list.length} match${list.length === 1 ? '' : 'es'}` : 'No matching nonprofit in the local FAC data.';
    const mine = new Set(recentOrgs().map(o => o.org_id));
    list = [...list.filter(o => mine.has(o.org_id)), ...list.filter(o => !mine.has(o.org_id))];
    fill(results, ...list.map(o => el('li', {}, el('button', {
      type: 'button', class: 'ne-result', 'aria-pressed': String(org?.org_id === o.org_id), dataset: { orgId: o.org_id },
      onclick: () => pickOrg(o),
    },
    el('span', { class: 'ne-name' }, o.name),
    el('span', { class: 'ne-meta' }, [o.state, o.org_id, `${fmtInt(o.n_reports)} report${o.n_reports === 1 ? '' : 's'}`,
      o.first_year ? `${o.first_year}–${o.last_year}` : null].filter(Boolean).join(' · '),
    o.org_id_method && o.org_id_method !== 'uei' ? el('span', { class: 'flag' }, `matched by ${String(o.org_id_method).toUpperCase()}`) : null,
    mine.has(o.org_id) ? el('span', { class: 'flag flag-mine' }, 'Worked with') : null)))));
  }

  // Nonprofits from this firm's existing engagements, most recent first.
  function recentOrgs() {
    const seen = new Map();
    for (const e of ctx.state.engagements || []) {
      if (!e.org_id || seen.has(e.org_id)) continue;
      const years = (ctx.state.engagements || []).filter(x => x.org_id === e.org_id).map(x => x.audit_year).sort();
      seen.set(e.org_id, { org_id: e.org_id, name: e.org_name, years });
    }
    return [...seen.values()];
  }

  function showRecent() {
    const list = recentOrgs();
    if (!list.length) {
      fill(results);
      searchStatus.textContent = 'Type at least 2 characters of a name, UEI or EIN.';
      return;
    }
    searchStatus.textContent = 'Nonprofits you’ve worked with · or type to search all FAC nonprofits';
    fill(results, ...list.map(o => el('li', {}, el('button', {
      type: 'button', class: 'ne-result', 'aria-pressed': String(org?.org_id === o.org_id), dataset: { orgId: o.org_id },
      onclick: () => pickOrg(o),
    },
    el('span', { class: 'ne-name' }, o.name),
    el('span', { class: 'ne-meta' }, `Engagements: ${o.years.join(', ')}`), el('span', { class: 'flag flag-mine' }, 'Worked with')))));
  }

  async function pickOrg(o) {
    org = o;
    year = null;
    for (const b of results.querySelectorAll('.ne-result')) b.setAttribute('aria-pressed', String(b.dataset.orgId === o.org_id));
    yearsFs.hidden = false;
    progFs.hidden = true;
    liveNote.hidden = true;
    fill(years, el('p', { class: 'muted small' }, 'Loading audit years…'));
    update();
    const t = ++yearsToken;
    let list;
    try {
      list = await ctx.api.orgYears(o.org_id);
    } catch (e) {
      if (t !== yearsToken) return;
      fill(years, el('p', { class: 'err' }, `Could not load years: ${e.message}`));
      return;
    }
    if (t !== yearsToken) return;
    list = [...(list || [])].sort((x, y) => y.audit_year - x.audit_year);
    fill(years, ...list.map(y => {
      const id = `ne-year-${y.audit_year}`;
      return el('label', { class: 'ne-year', for: id },
        el('input', { type: 'radio', name: 'ne-year', id, value: String(y.audit_year), onchange: () => pickYear(y) }),
        el('span', { class: 'ne-year-main' }, String(y.audit_year)),
        el('span', { class: `badge mode-${y.mode}` }, y.mode === 'live' ? 'Upcoming' : 'Filed'),
        el('span', { class: 'ne-meta' }, y.mode === 'live'
          ? `Not filed yet · plan it with public history up to today`
          : `Already filed · replay as of FY-end ${fmtDate(y.fy_end_date)}, then compare with what was reported`));
    }));
    if (!list.length) fill(years, el('p', { class: 'muted' }, 'No audit years found.'));
  }

  function pickYear(y) {
    year = y;
    const historical = y.mode === 'historical';
    progFs.hidden = !historical;
    liveNote.hidden = historical;
    $('#ne-cutoff', dlg).textContent = historical
      ? `Replay: the agent sees only reports public before ${fmtDate(y.fy_end_date)}. What the ${y.audit_year} audit actually reported stays hidden until you reveal it in Evaluation.`
      : 'Planning: the agent uses every report public as of today (local FAC snapshot).';
    createBtn.textContent = historical ? `Start replay of ${y.audit_year}` : `Start planning ${y.audit_year}`;
    update();
  }

  function update() {
    createBtn.disabled = !(org && year);
  }

  async function create() {
    if (!org || !year) return;
    fill(err);
    const historical = year.mode === 'historical';
    const programMode = historical ? (form.elements['ne-prog'].value || 'proxy') : 'history_only';
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';
    try {
      const eng = await ctx.api.createEngagement({ org_id: org.org_id, audit_year: year.audit_year, program_mode: programMode });
      dlg.close();
      await ctx.actions.engagementCreated(eng);
    } catch (e) {
      fill(err, el('div', { class: 'error-block', role: 'alert' }, el('strong', {}, 'Could not create the engagement. '), e.message));
    } finally {
      createBtn.textContent = year ? (year.mode === 'historical' ? `Start replay of ${year.audit_year}` : `Start planning ${year.audit_year}`) : 'Start';
      update();
    }
  }

  return { open };
}
