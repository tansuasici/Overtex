import { BibEntry, parseBib } from './bibParser';

export interface CitationId {
  kind: 'doi' | 'arxiv';
  /** What the user gave, normalised: the DOI, or the arXiv ID without a version. */
  id: string;
  /** The DOI to resolve. arXiv papers have DataCite DOIs under 10.48550. */
  doi: string;
}

const DOI = /^10\.\d{4,9}\/\S+$/;
const ARXIV_NEW = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const ARXIV_OLD = /^([a-z-]+(?:\.[a-z]{2})?\/\d{7})(v\d+)?$/i;

/**
 * Recognises a DOI or an arXiv ID in what the user typed or pasted:
 * `10.1103/PhysRev.47.777`, `doi:…`, `https://doi.org/…`, `arXiv:1706.03762v5`,
 * `https://arxiv.org/abs/1706.03762`, `hep-th/9901001`.
 */
export function parseIdentifier(input: string): CitationId | undefined {
  let s = input.trim().replace(/[.,;]+$/, '');
  if (!s) {
    return undefined;
  }

  s = s.replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  if (DOI.test(s)) {
    let doi = s;
    try {
      doi = decodeURIComponent(s);
    } catch {
      // Keep it as typed.
    }
    const arxiv = /^10\.48550\/arxiv\.(.+)$/i.exec(doi);
    if (arxiv) {
      return arxivId(arxiv[1]) ?? { kind: 'doi', id: doi, doi };
    }
    return { kind: 'doi', id: doi, doi };
  }

  s = s
    .replace(/^arxiv:\s*/i, '')
    .replace(/^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '');
  return arxivId(s);
}

function arxivId(s: string): CitationId | undefined {
  const m = ARXIV_NEW.exec(s) ?? ARXIV_OLD.exec(s);
  if (!m) {
    return undefined;
  }
  return { kind: 'arxiv', id: m[1], doi: `10.48550/arXiv.${m[1]}` };
}

export class CitationNotFoundError extends Error {}

/** Asks doi.org for BibTeX through content negotiation (Crossref and DataCite both answer). */
export async function fetchBibtex(
  doi: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15000
): Promise<string> {
  const path = doi.split('/').map(encodeURIComponent).join('/');
  const res = await fetchFn(`https://doi.org/${path}`, {
    headers: { Accept: 'application/x-bibtex; charset=utf-8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) {
    throw new CitationNotFoundError(`No record found for ${doi}.`);
  }
  if (!res.ok) {
    throw new Error(`doi.org answered ${res.status} ${res.statusText}`.trim());
  }
  const text = (await res.text()).trim();
  if (!text.startsWith('@')) {
    throw new CitationNotFoundError(`No BibTeX record found for ${doi}.`);
  }
  return text;
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'from', 'at', 'by',
  'toward', 'towards', 'via', 'is', 'are', 'how', 'what', 'why', 'when', 'do', 'does', 'can', 'should', 'will',
]);

/** Folds accents and LaTeX escapes to plain lowercase ASCII letters and digits. */
export function fold(s: string): string {
  return s
    .replace(/\\[a-zA-Z]+\s*/g, '')
    .replace(/\\./g, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function firstSurname(author: string): string {
  const first = author.split(/\s+and\s+/i)[0]?.trim() ?? '';
  if (!first) {
    return '';
  }
  if (first.includes(',')) {
    return fold(first.split(',')[0]);
  }
  const words = first.split(/\s+/);
  return fold(words[words.length - 1]);
}

function firstTitleWord(title: string): string {
  for (const word of title.split(/[\s\-–—:]+/)) {
    const w = fold(word);
    if (w && !STOP_WORDS.has(w)) {
      return w;
    }
  }
  return '';
}

/** `vaswani2017attention`, with `a`, `b`, … appended when the key is taken. */
export function generateKey(entry: Pick<BibEntry, 'author' | 'year' | 'title'>, taken: Iterable<string>): string {
  const year = /\d{4}/.exec(entry.year)?.[0] ?? '';
  const base = `${firstSurname(entry.author)}${year}${firstTitleWord(entry.title)}` || 'ref';
  const used = new Set(Array.from(taken, (k) => k.toLowerCase()));
  if (!used.has(base.toLowerCase())) {
    return base;
  }
  for (let i = 0; ; i++) {
    const suffix = suffixFor(i);
    if (!used.has(`${base}${suffix}`.toLowerCase())) {
      return `${base}${suffix}`;
    }
  }
}

function suffixFor(i: number): string {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Splits on commas that are not inside braces or quotes. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    } else if (ch === '"' && depth === 0) {
      quoted = !quoted;
    } else if (ch === ',' && depth === 0 && !quoted) {
      parts.push(body.substring(start, i));
      start = i + 1;
    }
  }
  parts.push(body.substring(start));
  return parts;
}

/**
 * Gives a fetched entry our key and lays it out one field per line. Crossref returns
 * the whole entry on one line, and DataCite uses the DOI URL as the key.
 */
export function rewriteBibtex(raw: string, key: string, omit: string[] = []): string {
  const head = /^\s*@(\w+)\s*([{(])/.exec(raw);
  if (!head) {
    throw new Error('Not a BibTeX entry.');
  }
  const type = head[1].toLowerCase();
  const close = head[2] === '{' ? '}' : ')';
  const rest = raw.substring(head[0].length);
  const end = rest.lastIndexOf(close);
  const inner = end >= 0 ? rest.substring(0, end) : rest;
  const [, ...fields] = splitTopLevel(inner);

  const lines: string[] = [];
  for (const f of fields) {
    const m = /^\s*([A-Za-z][\w:-]*)\s*=\s*([\s\S]*?)\s*$/.exec(f);
    if (m && m[2] && !omit.includes(m[1].toLowerCase())) {
      lines.push(`  ${m[1].toLowerCase()} = ${m[2].replace(/\s*\n\s*/g, ' ')}`);
    }
  }
  return `@${type}{${key},\n${lines.join(',\n')}\n}\n`;
}

/** Parses a fetched entry and picks a key that does not collide with `taken`. */
export function prepareEntry(raw: string, taken: Iterable<string>): { key: string; text: string } {
  // parseBib wants a key it can read; DataCite's URL keys are fine, but guard odd ones.
  const parsed = parseBib(raw)[0];
  const key = generateKey(parsed ?? { author: '', year: '', title: '' }, taken);
  return { key, text: rewriteBibtex(raw, key) };
}

export function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase();
}

/** The entry already in the bibliography for this DOI, if any. */
export function findByDoi(entries: BibEntry[], doi: string): BibEntry | undefined {
  const wanted = normalizeDoi(doi);
  return entries.find((e) => e.doi && normalizeDoi(e.doi) === wanted);
}

/** `.bib` files named by `\bibliography{a,b}` and `\addbibresource{x.bib}`, in order. */
export function bibResourcesIn(tex: string): string[] {
  const text = tex.replace(/(^|[^\\])%.*$/gm, '$1');
  const names: string[] = [];
  const add = (name: string) => {
    const n = name.trim();
    if (!n) {
      return;
    }
    const withExt = n.toLowerCase().endsWith('.bib') ? n : `${n}.bib`;
    if (!names.includes(withExt)) {
      names.push(withExt);
    }
  };
  for (const m of text.matchAll(/\\bibliography\s*\{([^}]*)\}/g)) {
    m[1].split(',').forEach(add);
  }
  for (const m of text.matchAll(/\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    add(m[1]);
  }
  return names;
}

const OPEN_CITE = /\\[A-Za-z]*cite[A-Za-z]*\*?(?:\[[^\]]*\]){0,2}\{[^}]*$/;

/** What to type at the cursor: just the key inside an open `\cite{`, else a whole `\cite{key}`. */
export function citeInsertion(lineBefore: string, key: string): string {
  if (!OPEN_CITE.test(lineBefore)) {
    return `\\cite{${key}}`;
  }
  const last = lineBefore.trimEnd().slice(-1);
  return last === '{' || last === ',' ? key : `, ${key}`;
}
