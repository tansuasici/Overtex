// Picks references from Zotero through Better BibTeX's local CAYW endpoint. No vscode import, so
// it is unit-testable.
import { BibEntry, parseBib } from './bibParser';
import { findByDoi, fold, generateKey, normalizeDoi, rewriteBibtex } from './citationImport';

export const DEFAULT_ZOTERO_URL = 'http://127.0.0.1:23119';

export type BibTranslator = 'bibtex' | 'biblatex';

export type ZoteroUnavailableReason = 'not-running' | 'starting' | 'no-better-bibtex';

export class ZoteroUnavailableError extends Error {
  constructor(readonly reason: ZoteroUnavailableReason) {
    super(reason);
    this.name = 'ZoteroUnavailableError';
  }
}

/** The local path of an attachment, which has no business in a shared .bib. */
const OMITTED_FIELDS = ['file'];
const IGNORED_TYPES = new Set(['string', 'comment', 'preamble']);
// Zotero refuses requests that look like they come from a web page.
const HEADERS = { 'User-Agent': 'Overtex' };

function caywUrl(baseUrl: string, params: Record<string, string>): string {
  return `${baseUrl.replace(/\/+$/, '')}/better-bibtex/cayw?${new URLSearchParams(params)}`;
}

/** Says whether Zotero and Better BibTeX are there; this one never opens the picker. */
export async function probeZotero(baseUrl: string, fetchFn: typeof fetch = fetch, timeoutMs = 2000): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(caywUrl(baseUrl, { probe: 'true' }), { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ZoteroUnavailableError('not-running');
  }
  const answer = res.ok ? (await res.text()).trim() : '';
  if (answer === 'starting') {
    throw new ZoteroUnavailableError('starting');
  }
  // Zotero answers on this port without Better BibTeX too, but not with `ready`. So does a Zotero
  // that has not loaded the add-on yet, for about a second after it starts.
  if (answer !== 'ready') {
    throw new ZoteroUnavailableError('no-better-bibtex');
  }
}

/**
 * Opens Zotero's picker and returns the picked references as BibTeX, or an empty string when the
 * user cancelled. Takes as long as the user does, so only `signal` ends it early.
 */
export async function pickFromZotero(baseUrl: string, translator: BibTranslator, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(caywUrl(baseUrl, { format: 'translate', translator }), { headers: HEADERS, signal });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Zotero answered ${res.status}${body.trim() ? `: ${body.trim().split('\n')[0]}` : ''}`);
  }
  return body.trim();
}

/** biblatex projects get biblatex fields (`journaltitle`, `date`), others classic BibTeX. */
export function translatorFor(tex: string): BibTranslator {
  const text = tex.replace(/(^|[^\\])%.*$/gm, '$1');
  return /\\addbibresource\b|\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bbiblatex\b/.test(text) ? 'biblatex' : 'bibtex';
}

/** The entries in a BibTeX text, each as written; `@string`, `@comment` and `@preamble` are left out. */
export function splitEntries(raw: string): string[] {
  const entries: string[] = [];
  const head = /@(\w+)\s*([{(])/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(raw)) !== null) {
    const end = entryEnd(raw, m.index + m[0].length, m[2], m[2] === '{' ? '}' : ')');
    if (!IGNORED_TYPES.has(m[1].toLowerCase())) {
      entries.push(raw.substring(m.index, end));
    }
    head.lastIndex = end;
  }
  return entries;
}

function entryEnd(raw: string, from: number, open: string, close: string): number {
  let depth = 1;
  for (let i = from; i < raw.length; i++) {
    if (raw[i] === '\\') {
      i++;
    } else if (raw[i] === open) {
      depth++;
    } else if (raw[i] === close && --depth === 0) {
      return i + 1;
    }
  }
  return raw.length;
}

function sameWork(a: BibEntry, b: BibEntry): boolean {
  if (a.doi && b.doi) {
    return normalizeDoi(a.doi) === normalizeDoi(b.doi);
  }
  return !a.title || !b.title || fold(a.title) === fold(b.title);
}

export interface MergedPicks {
  /** What to cite, in the order Zotero returned the picks. */
  keys: string[];
  /** The new entries to append to the bibliography, empty when all were there already. */
  text: string;
}

/**
 * Sets the picks against the bibliography. Picks keep the citation keys the user knows from
 * Zotero; a paper already there keeps the key it has, and only a key taken by a different paper
 * gets a new one.
 */
export function mergePicks(raw: string, existing: BibEntry[]): MergedPicks {
  const known = [...existing];
  const keys: string[] = [];
  const added: string[] = [];

  for (const source of splitEntries(raw)) {
    const pick = parseBib(source)[0];
    if (!pick) {
      continue;
    }
    const taken = known.find((e) => e.key.toLowerCase() === pick.key.toLowerCase());
    const present = (pick.doi ? findByDoi(known, pick.doi) : undefined) ?? (taken && sameWork(taken, pick) ? taken : undefined);
    let key: string;
    if (present) {
      key = present.key;
    } else {
      key = taken ? generateKey(pick, known.map((e) => e.key)) : pick.key;
      known.push({ ...pick, key });
      added.push(rewriteBibtex(source, key, OMITTED_FIELDS));
    }
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }

  return { keys, text: added.join('\n') };
}
