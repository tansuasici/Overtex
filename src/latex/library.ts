// The logic behind the Papers panel. No vscode import, so it is unit-testable.
import * as path from 'path';

import { VERBATIM_ENVS, commentStart } from './arxiv';
import { arxivIdOf } from './bibCheck';
import { BibEntry } from './bibParser';
import { CitationNotFoundError, normalizeDoi } from './citationImport';
import { isHeadingLine } from '../shared/headings';

/** Where a key is cited: a 0-based line and column, and the heading the citation falls under, if any. */
export interface CitationUse {
  line: number;
  column: number;
  section?: string;
}

/** Each cited key with where it is cited, in source order. */
export type CitationUses = Map<string, CitationUse[]>;

export type PaperSort = 'year' | 'author' | 'title';

const CITE_COMMAND = /\\([a-z]*cite[a-z]*)\*?/gi;
/** Commands with `cite` in the name that set things up rather than cite. */
const NOT_A_CITATION = /^(?:citestyle|citeindex|declare|new|renew|provide|def)/i;
const BEGIN_VERBATIM = new RegExp(`\\\\begin\\s*\\{(${VERBATIM_ENVS})\\*?\\}`);
const VERB = /\\verb\*?([^a-zA-Z\s*])[^\n]*?\1/g;
const SECTION_TITLE =
  /\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|addpart|addchap|addsec|minisec|frametitle)\*?\s*(?:\[[^\]]*\]\s*)?\{/;
const FRAME_TITLE = /\\begin\s*\{frame\}\s*(?:<[^>]*>\s*)?(?:\[[^\]]*\]\s*)?\{/;

const blank = (text: string) => text.replace(/[^\n]/g, ' ');

/**
 * The source with comments, verbatim environments and `\verb` turned into spaces. Every other
 * character stays where it was, so an offset into the mask is an offset into the source.
 */
export function maskNonCode(tex: string): string {
  const out: string[] = [];
  let verbatimEnd: string | undefined;
  for (const line of tex.split('\n')) {
    let rest = line;
    let masked = '';
    while (rest) {
      if (verbatimEnd) {
        const end = rest.indexOf(verbatimEnd);
        if (end < 0) {
          masked += blank(rest);
          break;
        }
        const after = end + verbatimEnd.length;
        masked += blank(rest.substring(0, after));
        rest = rest.substring(after);
        verbatimEnd = undefined;
        continue;
      }
      const at = commentStart(rest);
      const code = at < 0 ? rest : rest.substring(0, at);
      const begin = BEGIN_VERBATIM.exec(code);
      if (begin) {
        const after = begin.index + begin[0].length;
        masked += maskVerb(rest.substring(0, after));
        verbatimEnd = `\\end{${begin[1]}`;
        rest = rest.substring(after);
        continue;
      }
      masked += maskVerb(code) + blank(rest.substring(code.length));
      break;
    }
    out.push(masked);
  }
  return out.join('\n');
}

function maskVerb(code: string): string {
  return code.replace(VERB, (verb) => '\\verb' + blank(verb.substring(5)));
}

/** The text of the group that opens at `open` (a `{`), braces matched, or undefined if it does not close soon. */
function braced(text: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < text.length && i < open + 500; i++) {
    if (text[i] === '\\') {
      i++;
    } else if (text[i] === '{') {
      depth++;
    } else if (text[i] === '}' && --depth === 0) {
      return text.substring(open + 1, i);
    }
  }
  return undefined;
}

/** Where each heading starts in the masked source, with its title as plain text. */
function headings(masked: string): { offset: number; title: string }[] {
  const found: { offset: number; title: string }[] = [];
  let offset = 0;
  for (const line of masked.split('\n')) {
    if (isHeadingLine(line)) {
      const m = SECTION_TITLE.exec(line) ?? FRAME_TITLE.exec(line);
      const title = m && braced(masked, offset + m.index + m[0].length - 1);
      const plain = title ? plainTex(title) : '';
      if (plain) {
        found.push({ offset, title: plain });
      }
    }
    offset += line.length + 1;
  }
  return found;
}

/**
 * Where each key is cited by a `\cite`-like command, biblatex's `\cites[a]{x}[b]{y}` included.
 * Comments and verbatim text do not count, nor does `\nocite{*}`; `\nocite{key}` does. Keys
 * with `#` or `\` in them come from macro definitions, not citations, and are left out.
 */
export function citationUses(tex: string): CitationUses {
  const text = maskNonCode(tex);
  const uses: CitationUses = new Map();
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    lineStarts.push(i + 1);
  }
  const heads = headings(text);
  let head = -1;
  let line = 0;
  const add = (key: string, offset: number) => {
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) {
      line++;
    }
    while (head + 1 < heads.length && heads[head + 1].offset <= offset) {
      head++;
    }
    const use: CitationUse = { line, column: offset - lineStarts[line] };
    if (head >= 0) {
      use.section = heads[head].title;
    }
    const list = uses.get(key);
    if (list) {
      list.push(use);
    } else {
      uses.set(key, [use]);
    }
  };
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
        let at = i + 1;
        for (const part of text.substring(i + 1, end).split(',')) {
          const key = part.trim();
          if (key && key !== '*' && !/[#\\]/.test(key)) {
            add(key, at + part.indexOf(key));
          }
          at += part.length + 1;
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
  return uses;
}

/** The keys `\cite`-like commands name; see {@link citationUses}. */
export function citedKeys(tex: string): Set<string> {
  return new Set(citationUses(tex).keys());
}

/** How many times each key is cited across the files. */
export function citationCounts(all: Iterable<CitationUses>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const uses of all) {
    for (const [key, list] of uses) {
      counts.set(key, (counts.get(key) ?? 0) + list.length);
    }
  }
  return counts;
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

/** Cited papers (cited at least once) and the rest, leaving out a group with nothing in it. */
export function groupPapers<T extends Sortable>(
  entries: readonly T[],
  counts: ReadonlyMap<string, number>,
  sort: PaperSort
): { group: 'Cited' | 'Not cited'; papers: T[] }[] {
  const isCited = (entry: T) => (counts.get(entry.key) ?? 0) > 0;
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
