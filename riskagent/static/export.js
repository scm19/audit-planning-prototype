// Export: staff focus note (text/markdown) for the selected version, with preview, copy, download.

import { el, $, slug, fill } from './util.js';
import { renderMarkdown } from './markdown.js';

export function createExport(ctx) {
  const dlg = document.getElementById('export-dialog');
  const preview = $('#export-preview', dlg);
  const status = $('#export-status', dlg);
  const copyBtn = $('#export-copy', dlg);
  const dlBtn = $('#export-download', dlg);
  let md = '';
  let filename = 'staff-focus-note.md';

  $('#export-close', dlg).addEventListener('click', () => dlg.close());
  $('#export-close-2', dlg).addEventListener('click', () => dlg.close());
  copyBtn.addEventListener('click', copy);
  dlBtn.addEventListener('click', download);

  async function open() {
    const a = ctx.state.assessment;
    if (!a) return;
    md = '';
    copyBtn.disabled = dlBtn.disabled = true;
    status.textContent = '';
    $('#export-title', dlg).textContent = `Staff focus note · v${a.version}`;
    fill(preview, el('div', { class: 'loading-block', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Saving decisions and building the note…'));
    if (!dlg.open) dlg.showModal();
    try {
      await ctx.decisions.flushAll();
      md = await ctx.api.exportNote(a.assessment_id);
    } catch (e) {
      fill(preview, el('div', { class: 'error-block', role: 'alert' }, el('strong', {}, 'Could not build the note. '), e.message,
        el('div', {}, el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: open }, 'Try again'))));
      return;
    }
    filename = `staff-focus-note-${slug(a.target_org?.name || 'engagement')}-${a.target_year}-v${a.version}.md`;
    preview.innerHTML = renderMarkdown(md || '_The export is empty._');
    copyBtn.disabled = dlBtn.disabled = !md;
    status.textContent = `Reads v${a.version} and your saved decisions.`;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(md);
    } catch {
      const ta = el('textarea', { class: 'sr-only', value: md });
      dlg.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    status.textContent = 'Copied the markdown to the clipboard.';
  }

  function download() {
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = `Downloaded ${filename}.`;
  }

  return { open };
}
