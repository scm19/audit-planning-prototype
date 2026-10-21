// Small accessible popovers and menus. A trigger button toggles a floating panel appended to
// <body>. Escape, an outside click, focus leaving, or scrolling elsewhere closes it; Escape
// returns focus to the trigger. One popover is open at a time.

import { el } from './util.js';

let current = null;

export function openPopover(trigger, build, { label = '', cls = '', placement = 'below-start' } = {}) {
  if (current && current.trigger === trigger) { closePopover(); return; }
  closePopover();
  const id = `pop-${Math.random().toString(36).slice(2, 8)}`;
  const panel = el('div', { class: `popover ${cls}`.trim(), id, role: 'dialog', 'aria-label': label || trigger.getAttribute('aria-label') || 'Details', tabindex: '-1' });
  const content = build(closePopover);
  if (content) panel.append(content);
  document.body.append(panel);
  trigger.setAttribute('aria-expanded', 'true');
  trigger.setAttribute('aria-controls', id);
  current = { trigger, panel };
  position(panel, trigger, placement);
  const first = panel.querySelector('button:not([disabled]), [href], input, select, textarea');
  (first || panel).focus({ preventScroll: true });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', closePopover);
  panel.addEventListener('focusout', onFocusOut);
}

export function closePopover() {
  if (!current) return;
  const { trigger, panel } = current;
  current = null;
  panel.removeEventListener('focusout', onFocusOut);
  panel.remove();
  trigger.setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('mousedown', onDown, true);
  document.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', closePopover);
}

export const isPopoverOpen = () => !!current;

function position(panel, trigger, placement) {
  const r = trigger.getBoundingClientRect();
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;
  let left = placement === 'below-end' ? r.right - pw : placement === 'right' ? r.right + 8 : r.left;
  let top = placement === 'right' ? r.top : r.bottom + 6;
  left = Math.min(Math.max(8, left), window.innerWidth - pw - 8);
  if (top + ph > window.innerHeight - 8) top = Math.max(8, placement === 'right' ? window.innerHeight - ph - 8 : r.top - ph - 6);
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

function onKey(e) {
  if (e.key !== 'Escape' || !current) return;
  e.preventDefault();
  e.stopPropagation();
  const t = current.trigger;
  closePopover();
  t.focus();
}

function onDown(e) {
  if (!current) return;
  if (current.panel.contains(e.target) || current.trigger.contains(e.target)) return;
  closePopover();
}

function onScroll(e) {
  if (current && !current.panel.contains(e.target)) closePopover();
}

function onFocusOut(e) {
  if (!current) return;
  const to = e.relatedTarget;
  if (to && (current.panel.contains(to) || current.trigger.contains(to))) return;
  if (!to) return; // clicks on non-focusable content; outside clicks are handled by mousedown
  closePopover();
}

/** Small round ⓘ trigger. `build(close)` returns the popover content. */
export function infoButton(labelText, build, opts = {}) {
  return el('button', {
    type: 'button', class: `info-btn ${opts.btnClass || ''}`.trim(), 'aria-label': labelText, 'aria-expanded': 'false', title: labelText,
    onclick: e => { e.stopPropagation(); openPopover(e.currentTarget, build, { label: labelText, ...opts }); },
  }, 'ⓘ');
}
