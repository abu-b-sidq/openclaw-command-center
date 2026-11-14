// A small, safe markdown renderer for approval files and assistant reports: escape everything first, then
// apply a handful of rules (code, bold, https links, lists, headings, fences, pipe tables). Angular's
// sanitizer runs on top when the result is bound with [innerHTML].

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]!);

const inline = (t: string) =>
  esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(
      /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
    .replace(
      /(^|[\s(])(https:\/\/[^\s<)]*[^\s<).,;:])/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>',
    );

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => inline(c.trim()));

function table(rows: string[]): string {
  const head = rows.length > 1 && TABLE_SEP.test(rows[1]!) ? cells(rows[0]!) : null;
  const body = (head ? rows.slice(2) : rows).map(cells);
  const tr = (cs: string[], tag: 'td' | 'th') =>
    `<tr>${cs.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
  return `<table>${head ? `<thead>${tr(head, 'th')}</thead>` : ''}<tbody>${body.map((r) => tr(r, 'td')).join('')}</tbody></table>`;
}

const codeBox = (lang: string, body: string) =>
  `<pre><span class="lv-code-head"><span class="lv-code-lang">${esc(lang || 'code')}</span><span class="lv-code-copy">Copy</span></span><code>${esc(body)}</code></pre>`;

export function markdown(src: unknown): string {
  let out = '';
  let list: 'ul' | 'ol' | null = null;
  let para: string[] = [];
  let code: string[] | null = null;
  let lang = '';
  const flush = () => {
    if (para.length) {
      out += `<p>${para.map(inline).join('<br>')}</p>`;
      para = [];
    }
  };
  const close = () => {
    if (list) {
      out += `</${list}>`;
      list = null;
    }
  };
  const lines = String(src || '')
    .replace(/\r/g, '')
    .split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (code !== null) {
      if (/^\s*```/.test(raw)) {
        out += codeBox(lang, code.join('\n'));
        code = null;
      } else code.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) {
      flush();
      close();
      lang = (raw.match(/^\s*```\s*([\w+#.-]+)/)?.[1] ?? '').toLowerCase();
      code = [];
      continue;
    }
    const l = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if (!l.trim()) {
      flush();
      close();
      continue;
    }
    if (TABLE_ROW.test(l)) {
      flush();
      close();
      const rows = [l];
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1]!)) rows.push(lines[++i]!);
      out += table(rows);
      continue;
    }
    if ((m = l.match(/^#{1,6}\s+(.*)/))) {
      flush();
      close();
      out += `<h4>${inline(m[1]!)}</h4>`;
      continue;
    }
    if ((m = l.match(/^\s*[-*]\s+(.*)/))) {
      flush();
      if (list !== 'ul') {
        close();
        out += '<ul>';
        list = 'ul';
      }
      out += `<li>${inline(m[1]!)}</li>`;
      continue;
    }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) {
      flush();
      if (list !== 'ol') {
        close();
        out += '<ol>';
        list = 'ol';
      }
      out += `<li>${inline(m[1]!)}</li>`;
      continue;
    }
    if (list && /^\s{2,}\S/.test(l)) {
      out = `${out.slice(0, -5)}<br>${inline(l.trim())}</li>`;
      continue;
    }
    close();
    para.push(l);
  }
  if (code !== null) out += codeBox(lang, (code as string[]).join('\n'));
  flush();
  close();
  return out;
}
