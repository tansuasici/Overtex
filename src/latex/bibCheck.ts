// Checks a bibliography against doi.org (Crossref, DataCite) and the arXiv API.
// No vscode import, so it is unit-testable with a fake fetch.
import type { BibEntry } from './bibParser';
import { fold, normalizeDoi, parseIdentifier } from './citationImport';

export interface BibFinding {
  kind: 'missing' | 'doi' | 'mismatch' | 'preprint' | 'unverified';
  severity: 'warning' | 'info';
  key: string;
  /** 0-based line of the entry. */
  line: number;
  message: string;
}

export interface BibCheckReport {
  entries: number;
  /** Entries looked up online (by DOI or arXiv ID). */
  checked: number;
  /** Lookups that failed for network reasons, so nothing is known about them. */
  unreachable: number;
  findings: BibFinding[];
}

export interface BibCheckOptions {
  fetchFn?: typeof fetch;
  /** Aborting it stops the check; lookups not yet made are skipped. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Sent as User-Agent, as Crossref asks of API clients. */
  userAgent?: string;
  /** Pause between arXiv API calls (arXiv asks for 3 s). */
  arxivDelayMs?: number;
  onProgress?: (done: number, total: number) => void;
}

const REQUIRED: Record<string, string[][]> = {
  article: [['author'], ['title'], ['journal', 'journaltitle'], ['year', 'date']],
  book: [['author', 'editor'], ['title'], ['publisher'], ['year', 'date']],
  inbook: [['author', 'editor'], ['title'], ['publisher'], ['year', 'date']],
  incollection: [['author'], ['title'], ['booktitle'], ['year', 'date']],
  inproceedings: [['author'], ['title'], ['booktitle'], ['year', 'date']],
  conference: [['author'], ['title'], ['booktitle'], ['year', 'date']],
  phdthesis: [['author'], ['title'], ['school', 'institution'], ['year', 'date']],
  mastersthesis: [['author'], ['title'], ['school', 'institution'], ['year', 'date']],
  thesis: [['author'], ['title'], ['school', 'institution'], ['year', 'date']],
  techreport: [['author'], ['title'], ['institution'], ['year', 'date']],
};

function value(entry: BibEntry, name: string): string {
  switch (name) {
    case 'author':
    case 'title':
    case 'year':
    case 'doi':
      return entry[name];
    default:
      return entry.fields[name] ?? '';
  }
}

/** Fields BibTeX styles expect for the entry type that the entry lacks. */
export function missingFields(entry: BibEntry): string[] {
  const required = REQUIRED[entry.type];
  if (!required) {
    return [];
  }
  return required.filter((alternatives) => alternatives.every((f) => !value(entry, f))).map((alternatives) => alternatives[0]);
}

/** The arXiv ID an entry cites, from `eprint`, an arXiv DOI, an arxiv.org URL, or `arXiv:…` in journal or note. */
export function arxivIdOf(entry: BibEntry): string | undefined {
  const prefix = (entry.fields.archiveprefix ?? '').toLowerCase();
  const eprint = entry.fields.eprint;
  if (eprint && (prefix === 'arxiv' || !prefix)) {
    const id = parseIdentifier(eprint);
    if (id?.kind === 'arxiv') {
      return id.id;
    }
  }
  if (entry.doi) {
    const id = parseIdentifier(normalizeDoi(entry.doi));
    if (id?.kind === 'arxiv') {
      return id.id;
    }
  }
  const url = entry.fields.url ?? '';
  if (/arxiv\.org\/(?:abs|pdf)\//i.test(url)) {
    const id = parseIdentifier(url);
    if (id?.kind === 'arxiv') {
      return id.id;
    }
  }
  for (const text of [entry.fields.journal ?? '', entry.fields.note ?? '']) {
    const m = /arxiv:\s*([\w.\/-]+)/i.exec(text);
    const id = m ? parseIdentifier(m[1]) : undefined;
    if (id?.kind === 'arxiv') {
      return id.id;
    }
  }
  return undefined;
}

const DOI = /^10\.\d{4,9}\/\S+$/;

function words(title: string): string[] {
  return title
    .replace(/<[^>]+>/g, ' ')
    .split(/[\s\-–—:/]+/)
    .map(fold)
    .filter((w) => w.length > 0);
}

/**
 * Whether two titles name the same work: most words of the shorter one appear in the longer,
 * which tolerates subtitles, LaTeX markup, accents and HTML in Crossref titles.
 */
export function sameTitle(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) {
    return true; // nothing to compare
  }
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const pool = new Set(long);
  const hits = short.filter((w) => pool.has(w)).length;
  return hits / short.length >= 0.7;
}

function plain(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function quote(title: string): string {
  const t = plain(title);
  return `“${t.length > 90 ? `${t.substring(0, 87)}…` : t}”`;
}

class Unreachable extends Error {}
class Cancelled extends Error {}

interface Work {
  title: string;
  year?: number;
  volume?: string;
  page?: string;
  container?: string;
}

function str(v: unknown): string {
  if (Array.isArray(v)) {
    return typeof v[0] === 'string' ? v[0] : '';
  }
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** Reads the CSL JSON doi.org returns for both Crossref and DataCite DOIs. */
export function parseCsl(json: unknown): Work {
  const o = (json ?? {}) as Record<string, unknown>;
  const dates = ['issued', 'published-print', 'published-online', 'published'];
  let year: number | undefined;
  for (const d of dates) {
    const parts = (o[d] as { 'date-parts'?: unknown[][] } | undefined)?.['date-parts'];
    const y = Array.isArray(parts) && Array.isArray(parts[0]) ? Number(parts[0][0]) : NaN;
    if (Number.isFinite(y) && y > 0) {
      year = y;
      break;
    }
  }
  return {
    title: str(o.title),
    year,
    volume: str(o.volume) || undefined,
    page: str(o.page) || undefined,
    container: str(o['container-title']) || undefined,
  };
}

export interface ArxivRecord {
  title: string;
  doi?: string;
  journalRef?: string;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Entries of an arXiv API Atom feed, by arXiv ID without the version. */
export function parseArxivFeed(xml: string): Map<string, ArxivRecord> {
  const records = new Map<string, ArxivRecord>();
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const body = m[1];
    const tag = (name: string) => {
      const t = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(body);
      return t ? unescapeXml(t[1]).replace(/\s+/g, ' ').trim() : undefined;
    };
    const idUrl = tag('id') ?? '';
    const id = /arxiv\.org\/abs\/(.+?)(?:v\d+)?$/i.exec(idUrl)?.[1];
    if (!id) {
      continue; // an error entry
    }
    records.set(id.toLowerCase(), { title: tag('title') ?? '', doi: tag('arxiv:doi'), journalRef: tag('arxiv:journal_ref') });
  }
  return records;
}

/** A signal that fires on the caller's abort or after `ms`, whichever comes first (Node 18 has no AbortSignal.any). */
function deadline(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Unreachable('timed out')), ms);
  const onAbort = () => ctl.abort(new Cancelled());
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function get(url: string, accept: string, opts: Required<Pick<BibCheckOptions, 'fetchFn' | 'timeoutMs'>> & BibCheckOptions): Promise<Response> {
  if (opts.signal?.aborted) {
    throw new Cancelled();
  }
  const d = deadline(opts.signal, opts.timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: accept };
    if (opts.userAgent) {
      headers['User-Agent'] = opts.userAgent;
    }
    const res = await opts.fetchFn(url, { headers, redirect: 'follow', signal: d.signal });
    if (res.status >= 500 || res.status === 429) {
      throw new Unreachable(`${res.status}`);
    }
    return res;
  } catch (err) {
    if (opts.signal?.aborted) {
      throw new Cancelled();
    }
    throw err instanceof Unreachable ? err : new Unreachable(String(err));
  } finally {
    d.done();
  }
}

async function lookupDoi(doi: string, opts: Required<Pick<BibCheckOptions, 'fetchFn' | 'timeoutMs'>> & BibCheckOptions): Promise<Work | null> {
  const path = doi.split('/').map(encodeURIComponent).join('/');
  const res = await get(`https://doi.org/${path}`, 'application/vnd.citationstyles.csl+json', opts);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Unreachable(`${res.status}`);
  }
  try {
    return parseCsl(await res.json());
  } catch {
    // doi.org answers some DOIs (registered with other agencies) with a landing page, not CSL.
    throw new Unreachable('no metadata');
  }
}

async function lookupArxiv(ids: string[], opts: Required<Pick<BibCheckOptions, 'fetchFn' | 'timeoutMs'>> & BibCheckOptions): Promise<Map<string, ArxivRecord>> {
  const url = `https://export.arxiv.org/api/query?id_list=${ids.map(encodeURIComponent).join(',')}&max_results=${ids.length}`;
  const res = await get(url, 'application/atom+xml', opts);
  if (!res.ok) {
    throw new Unreachable(`${res.status}`);
  }
  return parseArxivFeed(await res.text());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(new Cancelled());
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function isCancellation(err: unknown): boolean {
  return err instanceof Cancelled;
}

/**
 * Checks each entry for missing required fields (offline), then looks up its DOI on doi.org
 * (does it exist, and is it the paper the entry describes?) or its arXiv ID on the arXiv API
 * (has the preprint been published?). Throws a cancellation error, see `isCancellation`,
 * when `signal` is aborted.
 */
export async function checkBibliography(entries: BibEntry[], options: BibCheckOptions = {}): Promise<BibCheckReport> {
  const opts = { fetchFn: fetch, timeoutMs: 15000, arxivDelayMs: 3000, ...options };
  const findings: BibFinding[] = [];
  const add = (entry: BibEntry, kind: BibFinding['kind'], severity: BibFinding['severity'], message: string) =>
    findings.push({ kind, severity, key: entry.key, line: entry.line, message });

  const byDoi = new Map<string, BibEntry>();
  const doiLookups: { entry: BibEntry; doi: string }[] = [];
  const arxivLookups: { entry: BibEntry; id: string }[] = [];

  for (const entry of entries) {
    const missing = missingFields(entry);
    if (missing.length) {
      add(entry, 'missing', 'warning', `${entry.key}: @${entry.type} entry has no ${missing.join(', ')}.`);
    }

    const arxiv = arxivIdOf(entry);
    const doi = entry.doi ? normalizeDoi(entry.doi) : '';
    if (doi && !doi.startsWith('10.48550/')) {
      if (!DOI.test(doi)) {
        add(entry, 'doi', 'warning', `${entry.key}: “${entry.doi}” is not a DOI.`);
        continue;
      }
      const other = byDoi.get(doi);
      if (other) {
        add(entry, 'doi', 'warning', `${entry.key} has the same DOI as ${other.key}.`);
        continue;
      }
      byDoi.set(doi, entry);
      doiLookups.push({ entry, doi });
    } else if (arxiv) {
      arxivLookups.push({ entry, id: arxiv });
    }
  }

  const total = doiLookups.length + arxivLookups.length;
  let done = 0;
  let unreachable = 0;
  const progress = () => opts.onProgress?.(done, total);
  const failed = (entry: BibEntry, what: string, err: unknown) => {
    if (err instanceof Cancelled) {
      throw err;
    }
    unreachable++;
    add(entry, 'unverified', 'info', `${entry.key}: could not look up ${what}${err instanceof Unreachable && err.message === 'no metadata' ? ' (doi.org returned no metadata for it)' : ''}.`);
  };

  await pool(doiLookups, 4, async ({ entry, doi }) => {
    try {
      const work = await lookupDoi(doi, opts);
      if (!work) {
        add(entry, 'doi', 'warning', `${entry.key}: DOI ${doi} does not exist.`);
      } else if (entry.title && work.title && !sameTitle(entry.title, work.title)) {
        add(entry, 'mismatch', 'warning', `${entry.key}: DOI ${doi} is ${quote(work.title)}${work.year ? ` (${work.year})` : ''}, not this entry's title.`);
      } else {
        const year = /\d{4}/.exec(entry.year)?.[0];
        if (year && work.year && Math.abs(Number(year) - work.year) > 1) {
          add(entry, 'mismatch', 'info', `${entry.key}: year is ${year}, but DOI ${doi} was published in ${work.year}.`);
        }
        if (entry.type === 'article') {
          const have: string[] = [];
          if (work.volume && !entry.fields.volume) {
            have.push(`volume = {${work.volume}}`);
          }
          if (work.page && !entry.fields.pages) {
            have.push(`pages = {${work.page.replace(/-/g, '--')}}`);
          }
          if (have.length) {
            add(entry, 'missing', 'info', `${entry.key}: the DOI record has ${have.join(', ')}, which the entry lacks.`);
          }
        }
      }
    } catch (err) {
      failed(entry, `DOI ${doi}`, err);
    }
    done++;
    progress();
  });

  for (let i = 0; i < arxivLookups.length; i += 50) {
    const batch = arxivLookups.slice(i, i + 50);
    if (i > 0) {
      await sleep(opts.arxivDelayMs, opts.signal);
    }
    let records: Map<string, ArxivRecord> | undefined;
    try {
      records = await lookupArxiv(batch.map((b) => b.id), opts);
    } catch (err) {
      for (const { entry, id } of batch) {
        failed(entry, `arXiv:${id}`, err);
      }
    }
    for (const { entry, id } of records ? batch : []) {
      const rec = records!.get(id.toLowerCase());
      if (!rec) {
        add(entry, 'doi', 'warning', `${entry.key}: arXiv:${id} does not exist.`);
      } else if (entry.title && rec.title && !sameTitle(entry.title, rec.title)) {
        add(entry, 'mismatch', 'warning', `${entry.key}: arXiv:${id} is ${quote(rec.title)}, not this entry's title.`);
      } else if (rec.doi) {
        const where = rec.journalRef ? ` in ${rec.journalRef}` : '';
        add(entry, 'preprint', 'info', `${entry.key}: arXiv:${id} has been published${where}; cite the published version, DOI ${rec.doi}.`);
      }
    }
    done += batch.length;
    progress();
  }

  findings.sort((a, b) => a.line - b.line);
  return { entries: entries.length, checked: total, unreachable, findings };
}

/** `12 entries, 7 looked up online: 2 warnings` and the like, for the notification. */
export function summarizeBibCheck(report: BibCheckReport): string {
  const warnings = report.findings.filter((f) => f.severity === 'warning').length;
  const notes = report.findings.filter((f) => f.severity === 'info' && f.kind !== 'unverified').length;
  const parts = [`${report.entries} ${report.entries === 1 ? 'entry' : 'entries'}`];
  if (report.checked) {
    parts.push(`${report.checked} looked up online`);
  }
  const counts: string[] = [];
  if (warnings) {
    counts.push(`${warnings} ${warnings === 1 ? 'problem' : 'problems'}`);
  }
  if (notes) {
    counts.push(`${notes} ${notes === 1 ? 'suggestion' : 'suggestions'}`);
  }
  if (report.unreachable) {
    counts.push(`${report.unreachable} could not be looked up`);
  }
  return `${parts.join(', ')}${counts.length ? `: ${counts.join(', ')}` : ''}`;
}
