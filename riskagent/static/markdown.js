// Small, XSS-safe markdown renderer for agent replies and the export preview.
//
// Safety model: every source line is HTML-escaped before any markup is added. The only tags in
// the output are the ones generated here; the only attributes are fixed class names, a numeric
// `start`, `href` values that pass an allowlist (http, https, mailto, in-page #, same-origin /),
// and `data-ref` values that match a strict [A-Za-z0-9:._] pattern.
//
// Supported: ATX headings, paragraphs (single newlines become <br>), bold, italic, strikethrough,
// inline code, fenced code, links, blockquotes, nested bullet/numbered lists, horizontal rules
// and pipe tables. With {refs: true}, lead ids (L1–L5) and row ids (P:93.224, R:93.224:L) become
// buttons that the app wires to the review table.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(```+|~~~+)\s*([\w-]*)\s*$/;
const QUOTE_RE = /^\s{0,3}>/;
const REF_RE = /\b(R:[0-9A-Za-z_]+(?:\.[0-9A-Za-z_]+)*:[A-NP]|P:[0-9A-Za-z_]+(?:\.[0-9A-Za-z_]+)*|L[1-5])\b/g;

export function renderMarkdown(src, opts = {}) {
  const text = String(src ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000\u0001]/g, '');
  return renderBlocks(text.split('\n'), opts);
}

function renderBlocks(lines, opts) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    let m;
    if ((m = line.match(FENCE_RE))) {
      const fence = m[1];
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = line.match(HEADING_RE))) {
      const level = Math.min(6, m[1].length + (opts.headingShift || 0));
      out.push(`<h${level}>${inline(m[2], opts)}</h${level}>`);
      i++;
      continue;
    }
    if (HR_RE.test(line)) { out.push('<hr>'); i++; continue; }
    if (QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${renderBlocks(buf, opts)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const [html, next] = parseTable(lines, i, opts);
      out.push(html);
      i = next;
      continue;
    }
    if (LIST_RE.test(line)) {
      const [html, next] = parseList(lines, i, opts);
      out.push(html);
      i = next;
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !startsBlock(lines, i)) buf.push(lines[i++]);
    out.push(`<p>${buf.map(l => inline(l.trim(), opts)).join('<br>')}</p>`);
  }
  return out.join('\n');
}

function startsBlock(lines, i) {
  const l = lines[i];
  return FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l)
    || (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]));
}

// ---------------------------------------------------------------- lists
function parseList(lines, start, opts) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    const m = l.match(LIST_RE);
    if (m) {
      items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), num: parseInt(m[2], 10), text: m[3] });
      i++;
      continue;
    }
    if (/^\s*$/.test(l)) {
      if (i + 1 < lines.length && LIST_RE.test(lines[i + 1])) { i++; continue; }
      break;
    }
    if (items.length && /^\s+\S/.test(l)) { items[items.length - 1].text += ` ${l.trim()}`; i++; continue; }
    break;
  }
  let html = '';
  const stack = [];
  for (const it of items) {
    const tag = it.ordered ? 'ol' : 'ul';
    const startAttr = it.ordered && Number.isFinite(it.num) && it.num !== 1 ? ` start="${it.num}"` : '';
    if (!stack.length || it.indent > stack[stack.length - 1].indent + 1) {
      html += `<${tag}${startAttr}>`;
      stack.push({ indent: it.indent, tag });
    } else {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent - 1) html += `</li></${stack.pop().tag}>`;
      if (stack[stack.length - 1].tag !== tag) {
        // A bullet list followed by a numbered list (or the reverse) at the same level: new list.
        const prev = stack.pop();
        html += `</li></${prev.tag}><${tag}${startAttr}>`;
        stack.push({ indent: it.indent, tag });
      } else {
        html += '</li>';
      }
    }
    html += `<li>${inline(it.text, opts)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return [html, i];
}

// ---------------------------------------------------------------- tables
function isTableSep(l) {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes('-') && (l.includes('|') || /:?-+:?/.test(l));
}

function splitRow(l) {
  let s = l.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (s[k] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[k];
  }
  cells.push(cur.trim());
  return cells;
}

function parseTable(lines, start, opts) {
  const head = splitRow(lines[start]);
  const align = splitRow(lines[start + 1]).map(c => (/^:-+:$/.test(c) ? 'al-c' : /-+:$/.test(c) ? 'al-r' : ''));
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
  const cell = (tag, c, k) => `<${tag}${align[k] ? ` class="${align[k]}"` : ''}>${inline(c || '', opts)}</${tag}>`;
  const th = head.map((c, k) => cell('th', c, k)).join('');
  const body = rows.map(r => `<tr>${head.map((_, k) => cell('td', r[k], k)).join('')}</tr>`).join('');
  return [`<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`, i];
}

// ---------------------------------------------------------------- inline
function safeHref(escapedUrl) {
  const raw = escapedUrl.replace(/&amp;/g, '&');
  if (/^(https?:\/\/|mailto:)/i.test(raw)) return { href: escapedUrl, external: true };
  if (/^(#|\/(?!\/))/.test(raw)) return { href: escapedUrl, external: false };
  return null;
}

function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

function inline(text, opts) {
  const slots = [];
  const hold = html => `\u0000${slots.push(html) - 1}\u0001`;
  let s = escapeHtml(text);
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(`<code>${code.trim()}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(\s*([^\s)]+)(?:\s+&quot;[^\n]*?&quot;)?\s*\)/g, (whole, labelText, url) => {
    const ok = safeHref(url);
    if (!ok) return labelText;
    const attrs = ok.external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return hold(`<a href="${ok.href}"${attrs}>${emphasis(labelText)}</a>`);
  });
  s = emphasis(s);
  if (opts.refs) {
    s = s.replace(REF_RE, tok => hold(
      `<button type="button" class="ref-link" data-ref="${tok}" title="Show ${tok} in the review table">${tok}</button>`));
  }
  for (let n = 0; n < 4 && s.includes('\u0000'); n++) s = s.replace(/\u0000(\d+)\u0001/g, (_, k) => slots[+k]);
  return s;
}
