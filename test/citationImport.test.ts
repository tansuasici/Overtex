import { describe, expect, it, vi } from 'vitest';
import { parseBib } from '../src/latex/bibParser';
import {
  bibResourcesIn,
  citeInsertion,
  CitationNotFoundError,
  fetchBibtex,
  findByDoi,
  generateKey,
  parseIdentifier,
  prepareEntry,
  rewriteBibtex,
} from '../src/latex/citationImport';

const CROSSREF =
  '@article{Einstein_1935, title={Can Quantum-Mechanical Description of Physical Reality Be Considered Complete?}, volume={47}, ISSN={0031-899X}, url={http://dx.doi.org/10.1103/PhysRev.47.777}, DOI={10.1103/physrev.47.777}, number={10}, journal={Physical Review}, publisher={American Physical Society (APS)}, author={Einstein, A. and Podolsky, B. and Rosen, N.}, year={1935}, month=may, pages={777–780} }';

const DATACITE = `@misc{https://doi.org/10.48550/arxiv.1706.03762,
  doi = {10.48550/ARXIV.1706.03762},
  url = {https://arxiv.org/abs/1706.03762},
  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},
  keywords = {Computation and Language (cs.CL), Machine Learning (cs.LG), FOS: Computer and information sciences},
  title = {Attention Is All You Need},
  publisher = {arXiv},
  year = {2017},
  copyright = {arXiv.org perpetual, non-exclusive license}
}`;

describe('parseIdentifier', () => {
  it.each([
    ['10.1103/PhysRev.47.777', '10.1103/PhysRev.47.777'],
    ['doi:10.1103/PhysRev.47.777', '10.1103/PhysRev.47.777'],
    ['https://doi.org/10.1103/PhysRev.47.777', '10.1103/PhysRev.47.777'],
    ['  http://dx.doi.org/10.1000/xyz(1)2. ', '10.1000/xyz(1)2'],
  ])('reads the DOI %s', (input, doi) => {
    expect(parseIdentifier(input)).toEqual({ kind: 'doi', id: doi, doi });
  });

  it.each([
    ['1706.03762', '1706.03762'],
    ['arXiv:1706.03762v5', '1706.03762'],
    ['https://arxiv.org/abs/2101.00001v2', '2101.00001'],
    ['https://arxiv.org/pdf/2101.00001.pdf', '2101.00001'],
    ['hep-th/9901001', 'hep-th/9901001'],
    ['math.GT/0309136v1', 'math.GT/0309136'],
    ['10.48550/arXiv.1706.03762', '1706.03762'],
  ])('reads the arXiv ID %s', (input, id) => {
    expect(parseIdentifier(input)).toEqual({ kind: 'arxiv', id, doi: `10.48550/arXiv.${id}` });
  });

  it.each(['', 'hello world', '10.12/x', 'arXiv:abc', '1706.037'])('rejects %j', (input) => {
    expect(parseIdentifier(input)).toBeUndefined();
  });
});

describe('generateKey', () => {
  it('uses surname, year and the first significant title word', () => {
    expect(generateKey({ author: 'Vaswani, Ashish and Shazeer, Noam', year: '2017', title: 'Attention Is All You Need' }, [])).toBe(
      'vaswani2017attention'
    );
    expect(generateKey({ author: 'Albert Einstein', year: '1905', title: 'On the Electrodynamics of Moving Bodies' }, [])).toBe(
      'einstein1905electrodynamics'
    );
  });

  it('folds accents and LaTeX escapes', () => {
    expect(generateKey({ author: 'G\\"{o}del, Kurt', year: '1931', title: 'Über formal unentscheidbare Sätze' }, [])).toBe(
      'godel1931uber'
    );
    expect(generateKey({ author: 'Erdős, Paul', year: '1947', title: 'Some remarks' }, [])).toBe('erdos1947some');
  });

  it('adds a letter when the key is taken', () => {
    const entry = { author: 'Smith, J.', year: '2020', title: 'Results' };
    expect(generateKey(entry, ['smith2020results'])).toBe('smith2020resultsa');
    expect(generateKey(entry, ['Smith2020Results', 'smith2020resultsa'])).toBe('smith2020resultsb');
  });

  it('falls back to ref when nothing is known', () => {
    expect(generateKey({ author: '', year: '', title: '' }, [])).toBe('ref');
  });
});

describe('rewriteBibtex', () => {
  it('lays a one-line Crossref entry out one field per line with the new key', () => {
    const out = rewriteBibtex(CROSSREF, 'einstein1935quantum');
    expect(out.split('\n')[0]).toBe('@article{einstein1935quantum,');
    expect(out).toContain('\n  doi = {10.1103/physrev.47.777},\n');
    expect(out).toContain('\n  month = may,\n');
    expect(out).toContain('\n  pages = {777–780}\n}\n');
    expect(parseBib(out)[0]).toMatchObject({ key: 'einstein1935quantum', year: '1935', doi: '10.1103/physrev.47.777' });
  });

  it('replaces the URL key DataCite uses', () => {
    const out = rewriteBibtex(DATACITE, 'vaswani2017attention');
    expect(out.startsWith('@misc{vaswani2017attention,\n  doi = {10.48550/ARXIV.1706.03762},')).toBe(true);
    expect(out).toContain('keywords = {Computation and Language (cs.CL), Machine Learning (cs.LG), FOS: Computer and information sciences}');
    expect(out).not.toContain('https://doi.org/10.48550/arxiv.1706.03762,');
  });
});

describe('prepareEntry', () => {
  it('generates the key from the fetched fields', () => {
    expect(prepareEntry(CROSSREF, []).key).toBe('einstein1935quantum');
    expect(prepareEntry(DATACITE, ['vaswani2017attention']).key).toBe('vaswani2017attentiona');
  });
});

describe('findByDoi', () => {
  it('matches DOIs regardless of case and URL prefix', () => {
    const entries = parseBib(rewriteBibtex(DATACITE, 'v17'));
    expect(findByDoi(entries, '10.48550/arXiv.1706.03762')?.key).toBe('v17');
    expect(findByDoi(entries, 'https://doi.org/10.48550/ARXIV.1706.03762')?.key).toBe('v17');
    expect(findByDoi(entries, '10.1/other')).toBeUndefined();
  });
});

describe('bibResourcesIn', () => {
  it('reads \\bibliography and \\addbibresource, ignoring comments', () => {
    const tex = [
      '\\bibliography{refs, extra}',
      '% \\bibliography{old}',
      '\\addbibresource[location=local]{more.bib}',
      '\\addbibresource{refs.bib}',
    ].join('\n');
    expect(bibResourcesIn(tex)).toEqual(['refs.bib', 'extra.bib', 'more.bib']);
  });
});

describe('citeInsertion', () => {
  it('inserts a whole \\cite outside a citation', () => {
    expect(citeInsertion('as shown by ', 'k')).toBe('\\cite{k}');
    expect(citeInsertion('\\cite{a} and ', 'k')).toBe('\\cite{k}');
  });

  it('inserts only the key inside an open \\cite', () => {
    expect(citeInsertion('see \\cite{', 'k')).toBe('k');
    expect(citeInsertion('see \\citep[p.~3]{a,', 'k')).toBe('k');
    expect(citeInsertion('see \\parencite{a', 'k')).toBe(', k');
  });
});

describe('fetchBibtex', () => {
  const response = (status: number, body: string) =>
    ({ status, ok: status >= 200 && status < 300, statusText: '', text: async () => body }) as Response;

  it('asks doi.org for BibTeX', async () => {
    const fetchFn = vi.fn(async () => response(200, ` ${CROSSREF}\n`));
    await expect(fetchBibtex('10.1103/PhysRev.47.777', fetchFn as unknown as typeof fetch)).resolves.toBe(CROSSREF);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://doi.org/10.1103/PhysRev.47.777');
    expect((init.headers as Record<string, string>).Accept).toContain('application/x-bibtex');
  });

  it('reports a missing record', async () => {
    const notFound = vi.fn(async () => response(404, 'DOI Not Found'));
    await expect(fetchBibtex('10.1/none', notFound as unknown as typeof fetch)).rejects.toBeInstanceOf(CitationNotFoundError);
    const html = vi.fn(async () => response(200, '<html></html>'));
    await expect(fetchBibtex('10.1/none', html as unknown as typeof fetch)).rejects.toBeInstanceOf(CitationNotFoundError);
  });
});
