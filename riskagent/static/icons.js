// Monochrome line icons (24px grid, stroke = currentColor). Inline SVG, no external assets.

const NS = 'http://www.w3.org/2000/svg';
const PATHS = {
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  plus: 'M12 5v14M5 12h14',
  scale: 'M12 4v16M8 20h8M5 8h14M5 8l-2.5 6a2.5 2.5 0 0 0 5 0L5 8zM19 8l-2.5 6a2.5 2.5 0 0 0 5 0L19 8z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.2a2.5 2.5 0 0 1 4.8.8c0 1.7-2.4 2.2-2.4 3.5M12 16.8h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16v-4.5M12 8h.01',
  doc: 'M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5zM14 3v4.5h4.5M9 13h6M9 16.5h4',
  filter: 'M4 5h16l-6.2 7.4V18l-3.6 1.8v-7.4z',
  columns: 'M4 5h16v14H4zM9.4 5v14M14.6 5v14',
  chevronsLeft: 'M11.5 17l-5-5 5-5M18 17l-5-5 5-5',
  chevronsRight: 'M12.5 17l5-5-5-5M6 17l5-5-5-5',
  chevronDown: 'M6 9.5l6 6 6-6',
  chevronLeft: 'M14.5 6l-6 6 6 6',
  chevronRight: 'M9.5 6l6 6-6 6',
  x: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  tag: 'M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z M8 8h.01',
  flag: 'M5.5 21V4h11l-2.2 4 2.2 4h-11',
  building: 'M5 21V6.5L12 3l7 3.5V21M9.5 21v-4.5h5V21M9 9.5h.01M12 9.5h.01M15 9.5h.01M9 13h.01M12 13h.01M15 13h.01',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M15.5 4.3a3.5 3.5 0 0 1 0 6.4M21.5 20a6.5 6.5 0 0 0-4.5-6.2',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  note: 'M4.5 4.5h15v11l-4 4h-11zM15.5 19.5v-4h4',
  hash: 'M5 9h14M5 15h14M10.5 4L8.5 20M15.5 4l-2 16',
  text: 'M4.5 6.5h15M4.5 12h10M4.5 17.5h12.5',
  shield: 'M12 3l7 3v5.5c0 4.5-3 8-7 9.5-4-1.5-7-5-7-9.5V6z M9 12l2 2 4-4',
  download: 'M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 20h14',
  arrowLeft: 'M19 12H5.5M11 18l-6-6 6-6',
  spinner: 'M12 3.5a8.5 8.5 0 1 0 8.5 8.5',
  panelRight: 'M4 5h16v14H4zM15 5v14',
  dash: 'M7 12h10',
  book: 'M5 5.5A2 2 0 0 1 7 3.5h12v14H7a2 2 0 0 0-2 2zM5 19.5v-14M8.5 7.5h7',
  ask: 'M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5zM8 10h8M8 13h5',
  sparkle: 'M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  folder: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
  folderOpen: 'M3.5 17V7.5a2 2 0 0 1 2-2h4l2 2.2h6a2 2 0 0 1 2 2v1M3.5 17l2.3-5.6a1.5 1.5 0 0 1 1.4-.9h13.3l-2.6 6.8a1.5 1.5 0 0 1-1.4 1h-11.5A1.5 1.5 0 0 1 3.5 17z',
  compose: 'M11.5 4.5h-6a1.5 1.5 0 0 0-1.5 1.5v12.5A1.5 1.5 0 0 0 5.5 20H18a1.5 1.5 0 0 0 1.5-1.5v-6M17.6 3.6a2 2 0 0 1 2.8 2.8L12.5 14.3l-3.7.9.9-3.7z',
  chat: 'M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  panelLeft: 'M4 5h16v14H4zM9.5 5v14',
};

export function icon(name, { size = 16, cls = '' } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `ic ${cls}`.trim());
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', PATHS[name] || PATHS.dash);
  svg.append(path);
  return svg;
}
