import { arxivIdOf } from './bibCheck';
import type { BibEntry } from './bibParser';
import { CitationId, fold, normalizeDoi, parseIdentifier } from './citationImport';

/** One paper found by a literature search. */
export interface SearchHit {
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  /** The published DOI, lowercase, never an arXiv DataCite DOI. */
  doi?: string;
  /** The arXiv ID without a version. */
  arxiv?: string;
  citedBy?: number;
  sources: Array<'OpenAlex' | 'arXiv'>;
}

export const SEARCH_RESULTS = 25;

export class SearchError extends Error {}

const OPENALEX_FIELDS = 'id,doi,display_name,publication_year,authorships,primary_location,locations,cited_by_count';

/** OpenAlex's relevance search over titles, abstracts and full text. Anonymous: no key, no email. */
export function openAlexUrl(query: string, perPage = SEARCH_RESULTS): string {
  const params = new URLSearchParams({ search: query.trim(), 'per-page': String(perPage), select: OPENALEX_FIELDS });
  return `https://api.openalex.org/works?${params}`;
}

/** Words arXiv does not index, so requiring one finds nothing, and its query operators. */
const STOP_WORDS = new Set(
  'a an and andnot are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with'.split(' ')
);

/**
 * arXiv's search, every word required except stop words. Words are reduced to letters and
 * digits, so what the user typed cannot become query syntax (fields, quotes, AND/OR/ANDNOT, parentheses).
 */
export function arxivUrl(query: string, maxResults = SEARCH_RESULTS): string | undefined {
  const words = query
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}-]/gu, '').replace(/^-+|-+$/g, ''))
    .filter((w) => w && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 12);
  if (words.length === 0) {
    return undefined;
  }
  const search = words.map((w) => `all:${w}`).join(' AND ');
  const params = new URLSearchParams({ search_query: search, start: '0', max_results: String(maxResults), sortBy: 'relevance' });
  return `https://export.arxiv.org/api/query?${params}`;
}

/** Splits a DOI into the published one and the arXiv ID an arXiv DataCite DOI stands for. */
function splitDoi(raw: unknown): { doi?: string; arxiv?: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return {};
  }
  const id = parseIdentifier(normalizeDoi(raw));
  if (!id) {
    return {};
  }
  return id.kind === 'arxiv' ? { arxiv: id.id } : { doi: id.doi.toLowerCase() };
}

function arxivFromUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || !/arxiv\.org\/(?:abs|pdf)\//i.test(url)) {
    return undefined;
  }
  const id = parseIdentifier(url.replace(/^http:/i, 'https:'));
  return id?.kind === 'arxiv' ? id.id : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Removes markup and collapses whitespace in a title or name from a remote service. */
export function cleanText(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.substring(2), 16) : parseInt(name.substring(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** The works in an OpenAlex `/works` answer. Anything missing or malformed is skipped. */
export function parseOpenAlex(json: unknown): SearchHit[] {
  const results = record(json)?.results;
  if (!Array.isArray(results)) {
    return [];
  }
  const hits: SearchHit[] = [];
  for (const raw of results) {
    const work = record(raw);
    if (!work) {
      continue;
    }
    const title = cleanText(text(work.display_name));
    if (!title) {
      continue;
    }
    const { doi, arxiv: fromDoi } = splitDoi(work.doi);
    const primary = record(work.primary_location);
    const locations = Array.isArray(work.locations) ? work.locations.map(record) : [];
    let arxiv = fromDoi ?? arxivFromUrl(primary?.landing_page_url);
    for (const loc of locations) {
      arxiv ??= arxivFromUrl(loc?.landing_page_url) ?? splitDoi(loc?.landing_page_url).arxiv;
    }
    const authors = (Array.isArray(work.authorships) ? work.authorships : [])
      .map((a) => cleanText(text(record(record(a)?.author)?.display_name)))
      .filter(Boolean);
    const venue = cleanText(text(record(primary?.source)?.display_name));
    const year = typeof work.publication_year === 'number' ? work.publication_year : undefined;
    const citedBy = typeof work.cited_by_count === 'number' ? work.cited_by_count : undefined;
    hits.push({
      title,
      authors,
      year,
      venue: venue && !/^arxiv\b/i.test(venue) ? venue : undefined,
      doi,
      arxiv,
      citedBy,
      sources: ['OpenAlex'],
    });
  }
  return hits;
}

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  return m?.[1];
}

/** The entries of an arXiv Atom feed. The feed's own id and title are not entries; error entries have no arXiv abs id. */
export function parseArxivAtom(xml: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1];
    const arxiv = arxivFromUrl(cleanText(tag(entry, 'id') ?? ''));
    const title = cleanText(tag(entry, 'title') ?? '');
    if (!arxiv || !title) {
      continue;
    }
    const authors = [...entry.matchAll(/<author>([\s\S]*?)<\/author>/g)]
      .map((a) => cleanText(tag(a[1], 'name') ?? ''))
      .filter(Boolean);
    const year = Number(/^(\d{4})/.exec(cleanText(tag(entry, 'published') ?? ''))?.[1]) || undefined;
    const { doi } = splitDoi(cleanText(tag(entry, 'arxiv:doi') ?? ''));
    const venue = cleanText(tag(entry, 'arxiv:journal_ref') ?? '') || undefined;
    hits.push({ title, authors, year, venue, doi, arxiv, sources: ['arXiv'] });
  }
  return hits;
}

function titleKey(hit: SearchHit): string {
  return fold(hit.title);
}

/** Whether two hits are the same paper: a shared DOI or arXiv ID, or the same title without conflicting DOIs. */
function samePaper(a: SearchHit, b: SearchHit): boolean {
  if (a.doi && b.doi) {
    if (a.doi === b.doi) {
      return true;
    }
    if (!(a.arxiv && a.arxiv === b.arxiv)) {
      return false;
    }
  }
  if (a.arxiv && b.arxiv) {
    return a.arxiv === b.arxiv;
  }
  const t = titleKey(a);
  return t.length >= 12 && t === titleKey(b);
}

function combine(a: SearchHit, b: SearchHit): SearchHit {
  return {
    title: a.title || b.title,
    authors: a.authors.length ? a.authors : b.authors,
    year: a.year ?? b.year,
    venue: a.venue ?? b.venue,
    doi: a.doi ?? b.doi,
    arxiv: a.arxiv ?? b.arxiv,
    citedBy: a.citedBy ?? b.citedBy,
    sources: [...new Set([...a.sources, ...b.sources])],
  };
}

/**
 * One list from several with the same paper merged into one hit. A preprint and its
 * published version may share only an arXiv ID or a title, so merging repeats until
 * nothing more joins. Lists are interleaved by rank: each list's first hit, then each
 * list's second, and a merged hit keeps its best rank.
 */
export function mergeHits(...lists: SearchHit[][]): SearchHit[] {
  const groups: Array<{ hit: SearchHit; rank: number }> = [];
  lists.forEach((list, which) =>
    list.forEach((hit, index) => {
      let merged = { hit, rank: index * lists.length + which };
      for (let i = 0; i < groups.length; ) {
        if (samePaper(groups[i].hit, merged.hit)) {
          merged = { hit: combine(groups[i].hit, merged.hit), rank: Math.min(groups[i].rank, merged.rank) };
          groups.splice(i, 1);
          i = 0;
        } else {
          i++;
        }
      }
      groups.push(merged);
    })
  );
  return groups.sort((a, b) => a.rank - b.rank).map((g) => g.hit);
}

/** What to fetch BibTeX for: the published DOI when there is one, else the arXiv ID. */
export function hitIdentifier(hit: SearchHit): CitationId | undefined {
  return (hit.doi ? parseIdentifier(hit.doi) : undefined) ?? (hit.arxiv ? parseIdentifier(`arXiv:${hit.arxiv}`) : undefined);
}

/**
 * Finds the bibliography entry a hit already has: one with the same DOI, or with its
 * arXiv ID in `eprint`, an arXiv DOI or an arxiv.org URL.
 */
export function bibliographyMatcher(entries: BibEntry[]): (hit: SearchHit) => BibEntry | undefined {
  const byDoi = new Map<string, BibEntry>();
  const byArxiv = new Map<string, BibEntry>();
  for (const e of entries) {
    if (e.doi && !byDoi.has(normalizeDoi(e.doi))) {
      byDoi.set(normalizeDoi(e.doi), e);
    }
    const arxiv = arxivIdOf(e)?.toLowerCase();
    if (arxiv && !byArxiv.has(arxiv)) {
      byArxiv.set(arxiv, e);
    }
  }
  return (hit) => (hit.doi ? byDoi.get(normalizeDoi(hit.doi)) : undefined) ?? (hit.arxiv ? byArxiv.get(hit.arxiv.toLowerCase()) : undefined);
}

interface SearchOptions {
  userAgent: string;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** GETs a URL and reads it, giving up after the timeout or when the caller aborts (Node 18 has no AbortSignal.any). */
async function get<T>(service: string, url: string, accept: string, opts: SearchOptions, read: (res: Response) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), opts.timeoutMs ?? 15000);
  const onAbort = () => ctl.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await (opts.fetchFn ?? fetch)(url, { headers: { 'User-Agent': opts.userAgent, Accept: accept }, signal: ctl.signal });
    if (res.status === 429) {
      throw new SearchError(`${service} limits how often it can be searched; try again later`);
    }
    if (!res.ok) {
      throw new SearchError(`${service} answered ${res.status} ${res.statusText}`.trim());
    }
    return await read(res);
  } catch (err) {
    if (ctl.signal.aborted && ctl.signal.reason instanceof Error && ctl.signal.reason.name === 'TimeoutError') {
      throw new SearchError(`${service} did not answer in time`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export async function searchOpenAlex(query: string, opts: SearchOptions): Promise<SearchHit[]> {
  return get('OpenAlex', openAlexUrl(query), 'application/json', opts, async (res) => parseOpenAlex(await res.json()));
}

export async function searchArxiv(query: string, opts: SearchOptions): Promise<SearchHit[]> {
  const url = arxivUrl(query);
  return url ? get('arXiv', url, 'application/atom+xml', opts, async (res) => parseArxivAtom(await res.text())) : [];
}

export interface SearchResult {
  hits: SearchHit[];
  /** One message per source that failed. */
  failures: string[];
}

/** Searches OpenAlex and arXiv at once; one failing still returns the other's hits. */
export async function searchLiterature(query: string, opts: SearchOptions): Promise<SearchResult> {
  const settled = await Promise.allSettled([searchOpenAlex(query, opts), searchArxiv(query, opts)]);
  if (opts.signal?.aborted) {
    return { hits: [], failures: [] };
  }
  const lists: SearchHit[][] = [];
  const failures: string[] = [];
  for (const [i, s] of settled.entries()) {
    if (s.status === 'fulfilled') {
      lists.push(s.value);
    } else {
      const err = s.reason as unknown;
      failures.push(err instanceof SearchError ? err.message : `${i === 0 ? 'OpenAlex' : 'arXiv'} could not be reached (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { hits: mergeHits(...lists).filter((h) => hitIdentifier(h)), failures };
}
