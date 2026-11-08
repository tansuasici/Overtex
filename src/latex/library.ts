// The logic behind the Papers panel. No vscode import, so it is unit-testable.
import * as path from 'path';

import { stripComments } from './arxiv';
import { arxivIdOf } from './bibCheck';
import { BibEntry } from './bibParser';
import { CitationNotFoundError, normalizeDoi } from './citationImport';

export interface CitedKeys {
  keys: Set<string>;
  /** `\nocite{*}` is there, so every entry counts as cited. */
  all: boolean;
}

export type PaperSort = 'year' | 'author' | 'title';

const CITE_COMMAND = /\\([a-z]*cite[a-z]*)\*?/gi;
/** Commands with `cite` in the name that set things up rather than cite. */
const NOT_A_CITATION = /^(?:citestyle|citeindex|declare|new|renew|provide|def)/i;

/** The keys `\cite`-like commands name, including biblatex's `\cites[a]{x}[b]{y}`. Comments do not count. */
export function citedKeys(tex: string): CitedKeys {
  const text = stripComments(tex);
  const found: CitedKeys = { keys: new Set(), all: false };
  for (const m of text.matchAll(CITE_COMMAND)) {
    if (NOT_A_CITATION.test(m[1])) {
      continue;
    }
    const several = /cites$/i.test(m[1]);
    let i = m.index + m[0].length;
    for (;;) {
      while (/\s/.test(text[i] ?? '')) {
        i++;
      }
      const open = text[i];
      if (open === '[' || open === '(') {
        const end = text.indexOf(open === '[' ? ']' : ')', i);
        if (end < 0) {
          break;
        }
        i = end + 1;
      } else if (open === '{') {
        const end = text.indexOf('}', i);
        if (end < 0) {
          break;
        }
        for (const part of text.substring(i + 1, end).split(',')) {
          const key = part.trim();
          if (key === '*') {
            found.all = true;
          } else if (key) {
            found.keys.add(key);
          }
        }
        i = end + 1;
        if (!several) {
          break;
        }
      } else {
        break;
      }
    }
  }
  return found;
}

export function mergeCited(all: Iterable<CitedKeys>): CitedKeys {
  const merged: CitedKeys = { keys: new Set(), all: false };
  for (const one of all) {
    one.keys.forEach((k) => merged.keys.add(k));
    merged.all ||= one.all;
  }
  return merged;
}

const ACCENTS: Record<string, string> = {
  '"': '\u0308', "'": '\u0301', '`': '\u0300', '^': '\u0302', '~': '\u0303', '=': '\u0304', '.': '\u0307',
  u: '\u0306', v: '\u030C', H: '\u030B', c: '\u0327', k: '\u0328', r: '\u030A',
};
const SYMBOLS: Record<string, string> = {
  ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
};

/** LaTeX in a raw title or author name, braces included, as plain text for a list: `K{\"o}rper` becomes `Körper`. */
export function plainTex(text: string): string {
  return text
    .replace(/(?<!\\)\$/g, '')
    .replace(/\\(["'`^~=.])\s*(?:\{\s*\\?([A-Za-z])\s*\}|\\?([A-Za-z]))/g, (_, accent: string, a?: string, b?: string) => (a ?? b) + ACCENTS[accent])
    // These accents are letters, so they need a brace or a space to end: `\kappa` is not one.
    .replace(/\\([uvHckr])(?:\s*\{\s*\\?([A-Za-z])\s*\}|\s+\\?([A-Za-z]))/g, (_, accent: string, a?: string, b?: string) => (a ?? b) + ACCENTS[accent])
    .replace(/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i|j)(?![A-Za-z])\s*/g, (_, name: string) => SYMBOLS[name])
    .replace(/\\([&%_$#])/g, '$1')
    .replace(/\\[A-Za-z]+\s*/g, '')
    .replace(/\\./g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
}

function surnames(author: string): string[] {
  return author
    .split(/\s+and\s+/i)
    .filter((name) => name.trim() && name.trim().toLowerCase() !== 'others')
    .map((name) => {
      const raw = name.trim();
      const plain = plainTex(raw);
      // A name wholly in braces is one name: {Google Research}.
      if (/^\{.*\}$/.test(raw) && !raw.slice(1, -1).includes('{')) {
        return plain;
      }
      return plain.includes(',') ? plain.split(',')[0].trim() : (plain.split(' ').pop() ?? plain);
    });
}

/** "Einstein", "Einstein and Rosen", "Einstein et al." */
export function shortAuthors(author: string): string {
  const names = surnames(author);
  if (names.length > 2 || /\s+and\s+others\s*$/i.test(author)) {
    return `${names[0]} et al.`;
  }
  return names.join(' and ');
}

/** The year of the entry, from `year` or biblatex's `date`, or '' when it has none. */
export function paperYear(entry: Pick<BibEntry, 'year' | 'fields'>): string {
  return /\d{4}/.exec(entry.year || entry.fields.date || '')?.[0] ?? '';
}

type Sortable = Pick<BibEntry, 'key' | 'title' | 'author' | 'year' | 'fields' | 'rawTitle' | 'rawAuthor'>;

/** Newest first, or by first author's surname or title; entries without the value go last. */
export function sortPapers<T extends Sortable>(entries: readonly T[], sort: PaperSort): T[] {
  const text = (a: string, b: string) => {
    if (!a || !b) {
      return a ? -1 : b ? 1 : 0;
    }
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  };
  const byYear = (a: T, b: T) => Number(paperYear(b) || 0) - Number(paperYear(a) || 0);
  const byAuthor = (a: T, b: T) => text(surnames(a.rawAuthor ?? a.author)[0] ?? '', surnames(b.rawAuthor ?? b.author)[0] ?? '');
  const byTitle = (a: T, b: T) => text(plainTex(a.rawTitle ?? a.title), plainTex(b.rawTitle ?? b.title));
  const order = sort === 'year' ? [byYear, byAuthor, byTitle] : sort === 'author' ? [byAuthor, byYear, byTitle] : [byTitle, byAuthor, byYear];
  return [...entries].sort((a, b) => {
    for (const compare of order) {
      const result = compare(a, b);
      if (result) {
        return result;
      }
    }
    return a.key.localeCompare(b.key);
  });
}

/** Cited papers and the rest, leaving out a group with nothing in it. */
export function groupPapers<T extends Sortable>(
  entries: readonly T[],
  cited: CitedKeys,
  sort: PaperSort
): { group: 'Cited' | 'Not cited'; papers: T[] }[] {
  const isCited = (entry: T) => cited.all || cited.keys.has(entry.key);
  const sorted = sortPapers(entries, sort);
  return [
    { group: 'Cited' as const, papers: sorted.filter(isCited) },
    { group: 'Not cited' as const, papers: sorted.filter((e) => !isCited(e)) },
  ].filter((g) => g.papers.length > 0);
}

/**
 * The paths a bibliography's `file` field names. It is a bare path (Better BibTeX) or a
 * `;`-separated list of `Name:path:type` (Zotero, JabRef, Mendeley), with `\:`, `\;` and `\\` escaped.
 */
export function filePathsIn(field: string): string[] {
  const paths: string[] = [];
  for (const attachment of splitEscaped(field, ';')) {
    const parts = splitEscaped(attachment, ':');
    // An unescaped Windows drive looks like one more separator: C:\Users\me\a.pdf.
    for (let i = 0; i + 1 < parts.length; i++) {
      if (/^[A-Za-z]$/.test(parts[i]) && /^[\\/]/.test(parts[i + 1])) {
        parts.splice(i, 2, `${parts[i]}:${parts[i + 1]}`);
      }
    }
    const pdf = parts.find((part) => /\.pdf$/i.test(part.trim()));
    if (pdf) {
      paths.push(pdf.trim());
    }
  }
  return paths;
}

/** Splits on `separator`, and undoes the backslash escapes of `:`, `;`, `_` and `\`. */
function splitEscaped(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\\' && (next === ':' || next === ';' || next === '\\' || next === '_')) {
      // Keep the escape for a later split on the other separator, which undoes it.
      current += separator === ';' ? ch + next : next;
      i++;
    } else if (ch === separator) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * A file name for the entry's PDF. Keys may hold characters file names cannot (`Einstein:1935rr`),
 * and a key comes from the .bib, so nothing in it may lead out of the folder.
 */
export function pdfFileName(key: string): string {
  const safe = key.replace(/[^\p{L}\p{N}_.+-]/gu, '_').replace(/^\.+|\.+$/g, (dots) => '_'.repeat(dots.length));
  // Windows reserves these names whatever the extension.
  return `${/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(safe) ? '_' : ''}${safe || '_'}.pdf`;
}

/** Where a downloaded PDF goes, and where one dropped in by hand is looked for: `papers/<key>.pdf` beside the .bib. */
export function paperPdfPath(bibFile: string, key: string): string {
  return path.join(path.dirname(bibFile), 'papers', pdfFileName(key));
}

/** The entry's PDF on disk: what its `file` field names (relative to the .bib), else `papers/<key>.pdf`. */
export function findPdf(
  entry: Pick<BibEntry, 'key' | 'fields'>,
  bibFile: string,
  exists: (file: string) => boolean
): string | undefined {
  const named = filePathsIn(entry.fields.file ?? '').map((p) => path.resolve(path.dirname(bibFile), p));
  return [...named, paperPdfPath(bibFile, entry.key)].find(exists);
}

/** The page to read the paper on: the publisher's through its DOI, else arXiv, else the entry's `url`. */
export function paperUrl(entry: BibEntry): string | undefined {
  const doi = entry.doi ? normalizeDoi(entry.doi) : '';
  if (doi && !doi.startsWith('10.48550/')) {
    return `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}`;
  }
  const arxiv = arxivIdOf(entry);
  if (arxiv) {
    return `https://arxiv.org/abs/${arxiv}`;
  }
  if (doi) {
    return `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}`;
  }
  const url = entry.fields.url ?? '';
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/** Fetches a paper's PDF from arXiv. arXiv can answer 200 with an HTML page, so the bytes are checked. */
export async function fetchArxivPdf(
  id: string,
  opts: { userAgent: string; signal?: AbortSignal; fetchFn?: typeof fetch; timeoutMs?: number }
): Promise<Uint8Array> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  const timer = setTimeout(stop, opts.timeoutMs ?? 120000);
  opts.signal?.addEventListener('abort', stop);
  try {
    const res = await (opts.fetchFn ?? fetch)(`https://arxiv.org/pdf/${id.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { 'User-Agent': opts.userAgent, Accept: 'application/pdf' },
      redirect: 'follow',
      signal: abort.signal,
    });
    if (res.status === 404) {
      throw new CitationNotFoundError(`arXiv has no PDF for ${id}.`);
    }
    if (!res.ok) {
      throw new Error(`arXiv answered ${res.status} ${res.statusText}`.trim());
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (Buffer.from(data.subarray(0, 5)).toString('latin1') !== '%PDF-') {
      throw new Error(`arXiv did not send a PDF for ${id}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
  }
}
