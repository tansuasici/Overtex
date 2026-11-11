import { describe, expect, it, vi } from 'vitest';

import { parseBib } from '../src/latex/bibParser';
import {
  arxivIdOf,
  checkBibliography,
  isCancellation,
  missingFields,
  parseArxivFeed,
  parseCsl,
  describeUpdates,
  sameTitle,
  summarizeBibCheck,
} from '../src/latex/bibCheck';

const EPR_CSL = {
  DOI: '10.1103/physrev.47.777',
  title: 'Can Quantum-Mechanical Description of Physical Reality Be Considered Complete?',
  author: [{ family: 'Einstein', given: 'A.' }],
  issued: { 'date-parts': [[1935, 5, 15]] },
  'container-title': 'Physical Review',
  volume: '47',
  page: '777-780',
};

// The shape doi.org returns for a retracted article (Wakefield et al., The Lancet, 1998), trimmed.
const RETRACTED_CSL = {
  DOI: '10.1016/s0140-6736(97)11096-0',
  title: 'RETRACTED: Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children',
  issued: { 'date-parts': [[1998, 2]] },
  'container-title': 'The Lancet',
  'updated-by': [
    {
      DOI: '10.1016/s0140-6736(04)15715-2',
      type: 'correction',
      label: 'Correction',
      source: 'publisher',
      updated: { 'date-parts': [[2004, 3, 6]], 'date-time': '2004-03-06T00:00:00Z' },
    },
    {
      DOI: '10.1016/s0140-6736(10)60175-4',
      type: 'retraction',
      label: 'Retraction',
      source: 'publisher',
      updated: { 'date-parts': [[2010, 2, 6]], 'date-time': '2010-02-06T00:00:00Z' },
    },
    {
      DOI: '10.1016/S0140-6736(10)60175-4',
      type: 'retraction',
      label: 'Retraction',
      source: 'retraction-watch',
      updated: { 'date-parts': [[2010, 2, 6]], 'date-time': '2010-02-06T00:00:00Z' },
      'record-id': 1,
    },
  ],
};

const FEED = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/hep-th/9711200v3</id>
    <title>The Large N Limit of Superconformal Field Theories
      and Supergravity</title>
    <arxiv:journal_ref>Adv.Theor.Math.Phys.2:231-252,1998</arxiv:journal_ref>
    <arxiv:doi>10.1023/A:1026654312961</arxiv:doi>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All You Need</title>
  </entry>
</feed>`;

function response(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status });
}

function bib(text: string) {
  return parseBib(text);
}

describe('missingFields', () => {
  it('lists required fields by entry type, accepting alternatives', () => {
    const [article, book, misc] = bib(`
@article{a, title = {T}, year = 2020}
@book{b, editor = {E}, title = {T}, publisher = {P}, date = {2020}}
@misc{c, title = {T}}`);
    expect(missingFields(article)).toEqual(['author', 'journal']);
    expect(missingFields(book)).toEqual([]);
    expect(missingFields(misc)).toEqual([]);
  });
});

describe('arxivIdOf', () => {
  it('finds the arXiv ID in eprint, an arXiv DOI, a URL or the journal field', () => {
    const entries = bib(`
@misc{a, eprint = {1706.03762}, archivePrefix = {arXiv}}
@misc{b, doi = {10.48550/arXiv.1706.03762}}
@misc{c, url = {https://arxiv.org/abs/hep-th/9711200v3}}
@article{d, journal = {arXiv preprint arXiv:1706.03762}}
@misc{e, eprint = {12345}, archivePrefix = {PubMed}}`);
    expect(entries.map(arxivIdOf)).toEqual(['1706.03762', '1706.03762', 'hep-th/9711200', '1706.03762', undefined]);
  });
});

describe('sameTitle', () => {
  it('tolerates LaTeX markup, accents, case, HTML and subtitles', () => {
    expect(sameTitle('Zur {Elektrodynamik} bewegter K{\\"o}rper', 'Zur Elektrodynamik bewegter Körper')).toBe(true);
    expect(sameTitle('Attention is all you need', 'Attention Is All You Need: Transformers for <i>everything</i>')).toBe(true);
    expect(sameTitle('Attention is all you need', 'Deep Residual Learning for Image Recognition')).toBe(false);
  });
});

describe('parsers', () => {
  it('reads CSL JSON from doi.org', () => {
    expect(parseCsl(EPR_CSL)).toEqual({
      title: EPR_CSL.title,
      year: 1935,
      volume: '47',
      page: '777-780',
      container: 'Physical Review',
      updates: [],
    });
  });

  it('reads Crossref notices from updated-by, without duplicates', () => {
    expect(parseCsl(RETRACTED_CSL).updates).toEqual([
      { type: 'correction', doi: '10.1016/s0140-6736(04)15715-2', date: '2004-03-06' },
      { type: 'retraction', doi: '10.1016/s0140-6736(10)60175-4', date: '2010-02-06' },
    ]);
  });

  it('reads the arXiv Atom feed, keyed by ID without version', () => {
    const records = parseArxivFeed(FEED);
    expect(records.get('hep-th/9711200')).toEqual({
      title: 'The Large N Limit of Superconformal Field Theories and Supergravity',
      doi: '10.1023/A:1026654312961',
      journalRef: 'Adv.Theor.Math.Phys.2:231-252,1998',
    });
    expect(records.get('1706.03762')?.doi).toBeUndefined();
  });
});

describe('checkBibliography', () => {
  const ENTRIES = `@article{epr,
  author = {Einstein, A. and Podolsky, B. and Rosen, N.},
  title = {Can Quantum-Mechanical Description of Physical Reality Be Considered Complete?},
  journal = {Physical Review},
  year = {1935},
  doi = {https://doi.org/10.1103/PhysRev.47.777}
}

@article{wrong,
  author = {He, Kaiming},
  title = {Deep Residual Learning for Image Recognition},
  journal = {CVPR},
  year = {2016},
  doi = {10.1103/PhysRev.47.777x}
}

@article{gone, author = {A}, title = {T}, journal = {J}, year = 2000, doi = {10.9999/nothing}}
@misc{maldacena, title = {The Large N limit of superconformal field theories and supergravity}, eprint = {hep-th/9711200}}
@misc{vaswani, title = {Attention Is All You Need}, eprint = {1706.03762}, archivePrefix = {arXiv}}
@article{nodoi, title = {Untitled}, year = 2001}
`;

  function fakeFetch() {
    return vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === 'https://doi.org/10.1103/physrev.47.777') {
        return response(200, EPR_CSL);
      }
      if (url === 'https://doi.org/10.1103/physrev.47.777x') {
        return response(200, { ...EPR_CSL, DOI: 'x' });
      }
      if (url.startsWith('https://doi.org/')) {
        return response(404, 'not found');
      }
      if (url.startsWith('https://export.arxiv.org/api/query?')) {
        return response(200, FEED);
      }
      throw new Error(`unexpected ${url}`);
    });
  }

  it('reports wrong and missing DOIs, missing fields and published preprints', async () => {
    const fetchFn = fakeFetch();
    const report = await checkBibliography(bib(ENTRIES), { fetchFn: fetchFn as unknown as typeof fetch, userAgent: 'Overtex/test' });

    expect(report.entries).toBe(6);
    expect(report.checked).toBe(5);
    expect(report.unreachable).toBe(0);
    expect(report.findings.map((f) => [f.key, f.kind, f.severity])).toEqual([
      ['epr', 'missing', 'info'],
      ['wrong', 'mismatch', 'warning'],
      ['gone', 'doi', 'warning'],
      ['maldacena', 'preprint', 'info'],
      ['nodoi', 'missing', 'warning'],
    ]);
    const byKey = Object.fromEntries(report.findings.map((f) => [f.key, f]));
    expect(byKey.epr.message).toContain('volume = {47}, pages = {777--780}');
    expect(byKey.epr.line).toBe(0);
    expect(byKey.wrong.message).toContain('Can Quantum-Mechanical');
    expect(byKey.maldacena.message).toContain('10.1023/A:1026654312961');
    expect(byKey.nodoi.message).toContain('author, journal');

    // One arXiv request for both preprints, with the User-Agent Crossref asks for.
    const arxivCalls = fetchFn.mock.calls.filter(([u]) => String(u).includes('arxiv.org'));
    expect(arxivCalls).toHaveLength(1);
    expect(String(arxivCalls[0][0])).toContain('id_list=hep-th%2F9711200,1706.03762');
    const init = fetchFn.mock.calls[0][1] as unknown as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('Overtex/test');
    expect(summarizeBibCheck(report)).toBe('6 entries, 5 looked up online: 3 problems, 2 suggestions');
  });

  it('flags malformed and duplicate DOIs without looking them up', async () => {
    const fetchFn = vi.fn(async () => response(200, EPR_CSL));
    const report = await checkBibliography(
      bib(`@misc{a, doi = {not-a-doi}}
@misc{b, title = {Can quantum-mechanical description of physical reality be considered complete}, doi = {10.1103/PhysRev.47.777}}
@misc{c, doi = {doi:10.1103/physrev.47.777}}`),
      { fetchFn: fetchFn as unknown as typeof fetch }
    );
    expect(report.findings.map((f) => [f.key, f.message])).toEqual([
      ['a', 'a: “not-a-doi” is not a DOI.'],
      ['c', 'c has the same DOI as b.'],
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('marks entries as unverified, not wrong, when the network fails', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('arxiv')) {
        return response(503, 'busy');
      }
      throw new TypeError('fetch failed');
    });
    const report = await checkBibliography(bib(ENTRIES), { fetchFn: fetchFn as unknown as typeof fetch });
    expect(report.unreachable).toBe(5);
    expect(report.findings.filter((f) => f.kind === 'unverified')).toHaveLength(5);
    expect(report.findings.some((f) => f.kind === 'doi' || f.kind === 'mismatch')).toBe(false);
    expect(summarizeBibCheck(report)).toContain('5 could not be looked up');
  });

  it('stops when cancelled', async () => {
    const ctl = new AbortController();
    const fetchFn = vi.fn(async () => {
      ctl.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const err = await checkBibliography(bib(ENTRIES), { fetchFn: fetchFn as unknown as typeof fetch, signal: ctl.signal }).catch((e) => e);
    expect(isCancellation(err)).toBe(true);
  });

  it('times out slow lookups', async () => {
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    );
    const report = await checkBibliography(bib('@misc{a, doi = {10.1234/x}}'), { fetchFn: fetchFn as unknown as typeof fetch, timeoutMs: 20 });
    expect(report.findings.map((f) => f.kind)).toEqual(['unverified']);
  });

  it('reports retractions as errors with the notice DOI, date and a link', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url === 'https://doi.org/10.1016/s0140-6736(97)11096-0' ? response(200, RETRACTED_CSL) : response(404, 'not found')
    );
    const report = await checkBibliography(
      bib(`@article{wakefield, author = {Wakefield, A. J.}, journal = {The Lancet}, year = 1998,
  title = {Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children},
  doi = {10.1016/S0140-6736(97)11096-0}}`),
      { fetchFn: fetchFn as unknown as typeof fetch }
    );
    const updates = report.findings.filter((f) => f.kind === 'update');
    expect(updates).toEqual([
      {
        kind: 'update',
        severity: 'error',
        key: 'wakefield',
        line: 0,
        message:
          'wakefield: DOI 10.1016/s0140-6736(97)11096-0 has been retracted (2010-02-06); see DOI 10.1016/s0140-6736(10)60175-4. It also has: correction.',
        link: 'https://doi.org/10.1016/s0140-6736(10)60175-4',
      },
    ]);
    expect(report.findings[0].kind).toBe('update');
    expect(summarizeBibCheck(report)).toMatch(/1 problem\b/);
  });
});

describe('describeUpdates', () => {
  it('ranks expressions of concern above corrections and leaves out unknown types', () => {
    const d = describeUpdates('k', '10.1/x', [
      { type: 'correction', doi: '10.1/c', date: '2020-01-02' },
      { type: 'expression_of_concern', doi: '10.1/e', date: '2019-05-01' },
      { type: 'something_new', doi: '10.1/s' },
    ]);
    expect(d).toEqual({
      severity: 'warning',
      message: 'k: DOI 10.1/x has an expression of concern (2019-05-01); see DOI 10.1/e. It also has: correction.',
      link: 'https://doi.org/10.1/e',
    });
    expect(describeUpdates('k', '10.1/x', [{ type: 'erratum', doi: '10.1/r' }])?.severity).toBe('info');
    expect(describeUpdates('k', '10.1/x', [{ type: 'something_new', doi: '10.1/s' }])).toBeUndefined();
  });

  it('drops a retraction that was later reinstated', () => {
    expect(
      describeUpdates('k', '10.1/x', [
        { type: 'retraction', doi: '10.1/r', date: '2015-01-01' },
        { type: 'reinstatement', doi: '10.1/i', date: '2016-01-01' },
      ])
    ).toBeUndefined();
  });
});
