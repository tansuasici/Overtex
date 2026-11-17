import { describe, expect, it, vi } from 'vitest';
import { parseBib } from '../src/latex/bibParser';
import {
  SearchHit,
  arxivUrl,
  bibliographyMatcher,
  cleanText,
  hitIdentifier,
  mergeHits,
  openAlexUrl,
  parseArxivAtom,
  parseOpenAlex,
  searchLiterature,
} from '../src/latex/literature';

const OPENALEX = {
  meta: { count: 3 },
  results: [
    {
      id: 'https://openalex.org/W1',
      doi: 'https://doi.org/10.1038/NATURE14539',
      display_name: 'Deep <i>learning</i>',
      publication_year: 2015,
      authorships: [{ author: { display_name: 'Yann LeCun' } }, { author: null }, { author: { display_name: 'Geoffrey Hinton' } }],
      primary_location: { source: { display_name: 'Nature' }, landing_page_url: 'https://www.nature.com/articles/nature14539' },
      locations: [{ landing_page_url: 'https://arxiv.org/abs/1501.00001v3' }],
      cited_by_count: 70000,
    },
    {
      id: 'https://openalex.org/W2',
      doi: 'https://doi.org/10.48550/arxiv.1706.03762',
      display_name: 'Attention Is All You Need',
      publication_year: 2017,
      authorships: null,
      primary_location: { source: { display_name: 'arXiv (Cornell University)' } },
      locations: null,
      cited_by_count: null,
    },
    { id: 'https://openalex.org/W3', doi: null, display_name: null },
    null,
  ],
};

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>http://arxiv.org/api/abc</id>
  <title type="html">ArXiv Query: search_query=all:attention</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
      You Need</title>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/hep-th/9711200v3</id>
    <published>1997-11-27T00:00:00Z</published>
    <title>The Large N Limit &amp; Supergravity</title>
    <author><name>Juan M. Maldacena</name></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1023/A:1026654312961</arxiv:doi>
    <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">Int.J.Theor.Phys.38:1113-1133,1999</arxiv:journal_ref>
  </entry>
  <entry>
    <id>http://arxiv.org/api/errors#incorrect_id_format</id>
    <title>Error</title>
  </entry>
</feed>`;

function hit(over: Partial<SearchHit>): SearchHit {
  return { title: 'A paper', authors: [], sources: ['OpenAlex'], ...over };
}

describe('URLs', () => {
  it('asks OpenAlex anonymously for the fields it reads', () => {
    const url = new URL(openAlexUrl('  deep learning '));
    expect(url.origin + url.pathname).toBe('https://api.openalex.org/works');
    expect(url.searchParams.get('search')).toBe('deep learning');
    expect(url.searchParams.get('per-page')).toBe('25');
    expect(url.searchParams.get('select')).toContain('cited_by_count');
    expect(url.search).not.toMatch(/mailto|api_key|@/);
  });

  it('turns the query into required arXiv words, never into query syntax', () => {
    const url = new URL(arxivUrl('ti:"black holes" AND (Hawking OR -radiation-) andnot x')!);
    expect(url.origin + url.pathname).toBe('https://export.arxiv.org/api/query');
    expect(url.searchParams.get('search_query')).toBe('all:tiblack AND all:holes AND all:Hawking AND all:radiation AND all:x');
    expect(url.searchParams.get('max_results')).toBe('25');
    expect(new URL(arxivUrl('Attention is all you need')!).searchParams.get('search_query')).toBe('all:Attention AND all:all AND all:you AND all:need');
    expect(arxivUrl('"" () :')).toBeUndefined();
    expect(arxivUrl('the of a')).toBeUndefined();
    expect(new URL(arxivUrl('a b c d e f g h i j k l m n')!).searchParams.get('search_query')!.split(' AND ')).toHaveLength(12);
  });
});

describe('cleanText', () => {
  it('drops markup, decodes entities and collapses space', () => {
    expect(cleanText(' <b>Fish</b> &amp;\n chips &#233;&#x3b1; &bogus; ')).toBe('Fish & chips éα &bogus;');
  });
});

describe('parseOpenAlex', () => {
  it('reads works, finding arXiv IDs in DOIs and locations', () => {
    const [nature, attention] = parseOpenAlex(OPENALEX);
    expect(nature).toEqual({
      title: 'Deep learning',
      authors: ['Yann LeCun', 'Geoffrey Hinton'],
      year: 2015,
      venue: 'Nature',
      doi: '10.1038/nature14539',
      arxiv: '1501.00001',
      citedBy: 70000,
      sources: ['OpenAlex'],
    });
    expect(attention).toMatchObject({ title: 'Attention Is All You Need', authors: [], arxiv: '1706.03762', doi: undefined, venue: undefined, citedBy: undefined });
  });

  it('skips works without a title and survives malformed answers', () => {
    expect(parseOpenAlex(OPENALEX)).toHaveLength(2);
    expect(parseOpenAlex(null)).toEqual([]);
    expect(parseOpenAlex({ results: 'no' })).toEqual([]);
  });
});

describe('parseArxivAtom', () => {
  it('reads entries but not the feed header or error entries', () => {
    const hits = parseArxivAtom(ATOM);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      year: 2017,
      venue: undefined,
      doi: undefined,
      arxiv: '1706.03762',
      sources: ['arXiv'],
    });
    expect(hits[1]).toMatchObject({
      title: 'The Large N Limit & Supergravity',
      arxiv: 'hep-th/9711200',
      doi: '10.1023/a:1026654312961',
      venue: 'Int.J.Theor.Phys.38:1113-1133,1999',
      year: 1997,
    });
  });
});

describe('mergeHits', () => {
  it('joins a preprint and its published version through a chain of matches', () => {
    const openAlex = [hit({ title: 'Quantum widgets for everyone', doi: '10.1/j', citedBy: 5 })];
    const arxiv = [
      hit({ title: 'Something else entirely', arxiv: '2001.00002', sources: ['arXiv'] }),
      hit({ title: 'Quantum Widgets for Everyone', arxiv: '2001.00001', sources: ['arXiv'] }),
    ];
    const extra = [hit({ title: 'Other title', arxiv: '2001.00001', doi: '10.1/j' })];
    const merged = mergeHits(openAlex, arxiv, extra);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ doi: '10.1/j', arxiv: '2001.00001', citedBy: 5, sources: ['OpenAlex', 'arXiv'] });
  });

  it('keeps papers with different DOIs apart even when their titles match', () => {
    const merged = mergeHits([hit({ title: 'Introduction to the topic', doi: '10.1/a' })], [hit({ title: 'Introduction to the Topic', doi: '10.1/b' })]);
    expect(merged).toHaveLength(2);
  });

  it('keeps different arXiv papers apart even when their titles match', () => {
    const merged = mergeHits(
      [hit({ title: 'Notes on gauge theories', arxiv: '2001.00001', sources: ['arXiv'] })],
      [hit({ title: 'Notes on Gauge Theories', arxiv: '2002.00002', sources: ['arXiv'] })]
    );
    expect(merged).toHaveLength(2);
  });

  it('does not merge on short titles', () => {
    expect(mergeHits([hit({ title: 'Reply' })], [hit({ title: 'Reply' })])).toHaveLength(2);
  });

  it('interleaves the lists by rank', () => {
    const a = [hit({ title: 'a1', doi: '10.1/a1' }), hit({ title: 'a2', doi: '10.1/a2' })];
    const b = [hit({ title: 'b1', doi: '10.1/b1' }), hit({ title: 'b2', doi: '10.1/b2' })];
    expect(mergeHits(a, b).map((h) => h.title)).toEqual(['a1', 'b1', 'a2', 'b2']);
  });
});

describe('bibliographyMatcher', () => {
  const entries = parseBib(`
@article{epr, title = {EPR}, doi = {10.1103/PhysRev.47.777}}
@misc{vaswani, title = {Attention}, eprint = {1706.03762v5}, archiveprefix = {arXiv}}
@misc{datacite, title = {Old}, doi = {10.48550/ARXIV.hep-th/9711200}}
@misc{linked, title = {Linked}, url = {https://arxiv.org/abs/2101.00001}}
`);
  const match = bibliographyMatcher(entries);

  it('finds entries by DOI whatever its case', () => {
    expect(match(hit({ doi: '10.1103/physrev.47.777' }))?.key).toBe('epr');
  });

  it('finds entries by arXiv ID in eprint, an arXiv DOI or a URL', () => {
    expect(match(hit({ arxiv: '1706.03762' }))?.key).toBe('vaswani');
    expect(match(hit({ arxiv: 'hep-th/9711200' }))?.key).toBe('datacite');
    expect(match(hit({ doi: '10.9999/journal', arxiv: '2101.00001' }))?.key).toBe('linked');
  });

  it('finds nothing for a new paper', () => {
    expect(match(hit({ doi: '10.9999/new', arxiv: '2201.00001' }))).toBeUndefined();
  });
});

describe('hitIdentifier', () => {
  it('prefers the published DOI, then the arXiv ID', () => {
    expect(hitIdentifier(hit({ doi: '10.1234/j', arxiv: '2001.00001' }))).toMatchObject({ kind: 'doi', doi: '10.1234/j' });
    expect(hitIdentifier(hit({ arxiv: '2001.00001' }))).toMatchObject({ kind: 'arxiv', id: '2001.00001' });
    expect(hitIdentifier(hit({}))).toBeUndefined();
  });
});

function respond(body: string, status = 200): Response {
  return new Response(body, { status, statusText: status === 200 ? 'OK' : 'Error' });
}

describe('searchLiterature', () => {
  it('merges both sources and sends no email or key', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('openalex') ? respond(JSON.stringify(OPENALEX)) : respond(ATOM)
    );
    const result = await searchLiterature('attention', { userAgent: 'Overtex/test', fetchFn: fetchFn as typeof fetch });
    expect(result.failures).toEqual([]);
    expect(result.hits.map((h) => h.title)).toEqual(['Deep learning', 'Attention Is All You Need', 'The Large N Limit & Supergravity']);
    expect(result.hits[1].sources).toEqual(['OpenAlex', 'arXiv']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchFn.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).not.toMatch(/mailto|api_key|@/);
      expect(init.headers).toEqual(expect.objectContaining({ 'User-Agent': 'Overtex/test' }));
    }
  });

  it('shows the other source when one fails', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('openalex')) {
        return respond('slow down', 429);
      }
      return respond(ATOM);
    });
    const result = await searchLiterature('attention', { userAgent: 'x', fetchFn: fetchFn as typeof fetch });
    expect(result.hits).toHaveLength(2);
    expect(result.failures).toEqual(['OpenAlex limits how often it can be searched; try again later']);
  });

  it('reports errors and timeouts per source', async () => {
    const fetchFn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('openalex')) {
        return Promise.resolve(respond('broken', 500));
      }
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      );
    });
    const result = await searchLiterature('attention', { userAgent: 'x', fetchFn: fetchFn as typeof fetch, timeoutMs: 10 });
    expect(result.hits).toEqual([]);
    expect(result.failures).toEqual(['OpenAlex answered 500 Error', 'arXiv did not answer in time']);
  });

  it('names a source that could not be reached', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await searchLiterature('attention', { userAgent: 'x', fetchFn: fetchFn as typeof fetch });
    expect(result.failures).toEqual(['OpenAlex could not be reached (fetch failed)', 'arXiv could not be reached (fetch failed)']);
  });

  it('returns nothing once the caller cancels', async () => {
    const abort = new AbortController();
    const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    );
    const pending = searchLiterature('attention', { userAgent: 'x', fetchFn: fetchFn as typeof fetch, signal: abort.signal });
    abort.abort();
    expect(await pending).toEqual({ hits: [], failures: [] });
  });
});
