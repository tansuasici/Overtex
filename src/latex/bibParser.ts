export interface BibEntry {
  key: string;
  type: string;
  title: string;
  author: string;
  year: string;
  abstract: string;
  doi: string;
}

const IGNORED_TYPES = new Set(['string', 'comment', 'preamble']);

/** A lenient BibTeX reader: enough for completion and hovers, not a full parser. */
export function parseBib(content: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const head = /@(\w+)\s*[{(]\s*([^,\s]+)\s*,/g;
  let m: RegExpExecArray | null;

  while ((m = head.exec(content)) !== null) {
    const type = m[1].toLowerCase();
    if (IGNORED_TYPES.has(type)) {
      continue;
    }
    const body = entryBody(content, m.index + m[0].length);
    entries.push({
      key: m[2],
      type,
      title: field(body, 'title'),
      author: field(body, 'author'),
      year: field(body, 'year'),
      abstract: field(body, 'abstract'),
      doi: field(body, 'doi'),
    });
    head.lastIndex = m.index + m[0].length + body.length;
  }

  return entries;
}

/** Returns the text from `from` up to the brace that closes the entry. */
function entryBody(content: string, from: number): string {
  let depth = 1;
  for (let i = from; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{' || ch === '(') {
      depth++;
    } else if (ch === '}' || ch === ')') {
      depth--;
      if (depth === 0) {
        return content.substring(from, i);
      }
    }
  }
  return content.substring(from);
}

/** Reads `name = {value}`, `name = "value"` or `name = 2020`, allowing nested braces. */
function field(body: string, name: string): string {
  const m = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*`, 'i').exec(body);
  if (!m) {
    return '';
  }
  let i = m.index + m[0].length;
  const open = body[i];
  let value = '';
  if (open === '{' || open === '"') {
    const close = open === '{' ? '}' : '"';
    let depth = 0;
    for (i++; i < body.length; i++) {
      const ch = body[i];
      if (ch === '{') {
        depth++;
      } else if (ch === '}' && depth > 0) {
        depth--;
      } else if (ch === close && depth === 0) {
        break;
      }
      value += ch;
    }
  } else {
    value = body.substring(i).match(/^[^,}\s]*/)?.[0] ?? '';
  }
  return value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}
