import { describe, expect, it } from 'vitest';
import * as path from 'path';

import { arxivIdOf } from '../src/latex/bibCheck';
import { BibEntry, parseBib } from '../src/latex/bibParser';
import {
  citedKeys,
  fetchArxivPdf,
  filePathsIn,
  findPdf,
  groupPapers,
  mergeCited,
  paperPdfPath,
  paperUrl,
  paperYear,
  pdfFileName,
  plainTex,
  shortAuthors,
  sortPapers,
} from '../src/latex/library';

function entry(key: string, over: Partial<BibEntry> = {}): BibEntry {
  return { key, type: 'article', title: '', author: '', year: '', abstract: '', doi: '', line: 0, fields: {}, ...over };
}

describe('citedKeys', () => {
  it('finds keys across cite commands, with options and several keys', () => {
    const { keys, all } = citedKeys(String.raw`\cite{a, b} \citep[p.~2]{c} \parencite*[see][1]{d} \Autocite{e} \nocite{f}`);
    expect([...keys].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(all).toBe(false);
  });

  it("reads each group of biblatex's \\cites", () => {
    const { keys } = citedKeys(String.raw`\cites[1]{a}[2]{b,c}{d} and {not}`);
    expect([...keys].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores comments but not an escaped percent', () => {
    const { keys } = citedKeys('% \\cite{gone}\n50\\% \\cite{kept} % \\cite{gone2}\n');
    expect([...keys]).toEqual(['kept']);
  });

  it('treats \\nocite{*} as citing everything', () => {
    expect(citedKeys(String.raw`\nocite{*}`).all).toBe(true);
  });

  it('does not take setup commands for citations', () => {
    expect(citedKeys(String.raw`\citestyle{ieee} \newcite{x}`).keys.size).toBe(0);
  });

  it('survives an unclosed group', () => {
    expect(citedKeys(String.raw`\cite{a`).keys.size).toBe(0);
    expect(citedKeys(String.raw`\cite[p`).keys.size).toBe(0);
  });

  it('merges files', () => {
    const merged = mergeCited([citedKeys(String.raw`\cite{a}`), citedKeys(String.raw`\nocite{*}\cite{b}`)]);
    expect([...merged.keys].sort()).toEqual(['a', 'b']);
    expect(merged.all).toBe(true);
  });
});

describe('plainTex', () => {
  it.each([
    [String.raw`K{\"o}rper`, 'Körper'],
    [String.raw`Erd{\H{o}}s`, 'Erdős'],
    [String.raw`Erd\H{o}s`, 'Erdős'],
    [String.raw`{\c{C}}al{\i}{\c s}ma`, 'Çalışma'],
    [String.raw`S{\o}ren`, 'Søren'],
    [String.raw`Stra{\ss}e`, 'Straße'],
    [String.raw`Caf\'e \& Bar`, 'Café & Bar'],
    [String.raw`\'{\i}ndice`, 'índice'],
    [String.raw`\textbf{Bold} title`, 'Bold title'],
    [String.raw`The $\kappa$ model`, 'The model'],
    ['Pages 1--2 --- done', 'Pages 1–2 — done'],
    ['A~B', 'A B'],
  ])('%s', (input, expected) => {
    expect(plainTex(input)).toBe(expected);
  });
});

describe('shortAuthors', () => {
  it.each([
    ['Einstein, Albert', 'Einstein'],
    ['Albert Einstein and Rosen, Nathan', 'Einstein and Rosen'],
    ['A, B and C, D and E, F', 'A et al.'],
    ['A, B and others', 'A et al.'],
    ['{Google Research}', 'Google Research'],
    [String.raw`G{\"o}del, Kurt`, 'Gödel'],
    ['', ''],
  ])('%s', (input, expected) => {
    expect(shortAuthors(input)).toBe(expected);
  });
});

describe('sorting and grouping', () => {
  const papers = [
    entry('old', { year: '1905', author: 'Einstein, A', title: 'Zeta' }),
    entry('new', { year: '2020', author: 'Vaswani, A', title: 'Alpha' }),
    entry('none', { title: 'Middle' }),
  ];

  it('sorts by year, author and title, with blanks last', () => {
    expect(sortPapers(papers, 'year').map((p) => p.key)).toEqual(['new', 'old', 'none']);
    expect(sortPapers(papers, 'author').map((p) => p.key)).toEqual(['old', 'new', 'none']);
    expect(sortPapers(papers, 'title').map((p) => p.key)).toEqual(['new', 'none', 'old']);
  });

  it('takes the year from biblatex date', () => {
    expect(paperYear(entry('x', { fields: { date: '2017-06' } }))).toBe('2017');
  });

  it('groups and leaves out empty groups', () => {
    const groups = groupPapers(papers, { keys: new Set(['old']), all: false }, 'year');
    expect(groups.map((g) => [g.group, g.papers.map((p) => p.key)])).toEqual([
      ['Cited', ['old']],
      ['Not cited', ['new', 'none']],
    ]);
    expect(groupPapers(papers, { keys: new Set(), all: true }, 'year').map((g) => g.group)).toEqual(['Cited']);
    expect(groupPapers([], { keys: new Set(), all: false }, 'year')).toEqual([]);
  });
});

describe('filePathsIn', () => {
  it.each([
    ['papers/a.pdf', ['papers/a.pdf']],
    ['Full Text:files/12/a.pdf:application/pdf', ['files/12/a.pdf']],
    [':paper.pdf:PDF', ['paper.pdf']],
    ['Snapshot:a.html:text/html;Full Text:b.pdf:application/pdf', ['b.pdf']],
    ['/home/me/a.pdf;/home/me/b.PDF', ['/home/me/a.pdf', '/home/me/b.PDF']],
    [String.raw`C:\Users\me\a.pdf`, [String.raw`C:\Users\me\a.pdf`]],
    [String.raw`Full Text:C\:\\Users\\me\\a\_b.pdf:application/pdf`, [String.raw`C:\Users\me\a_b.pdf`]],
    ['Snapshot:a.html:text/html', []],
    ['', []],
  ])('%s', (input, expected) => {
    expect(filePathsIn(input)).toEqual(expected);
  });

  it('reads through the parser', () => {
    const [parsed] = parseBib('@article{a, file = {Full Text:files/12/a b.pdf:application/pdf}}');
    expect(filePathsIn(parsed.fields.file)).toEqual(['files/12/a b.pdf']);
  });
});

describe('pdfFileName', () => {
  it.each([
    ['einstein1905', 'einstein1905.pdf'],
    ['Einstein:1935rr', 'Einstein_1935rr.pdf'],
    ['../../etc/passwd', '___.._etc_passwd.pdf'],
    ['a\\b/c', 'a_b_c.pdf'],
    ['Öztürk2020', 'Öztürk2020.pdf'],
    ['CON', '_CON.pdf'],
    ['nul.x', '_nul.x.pdf'],
    ['..', '__.pdf'],
  ])('%s', (key, expected) => {
    const name = pdfFileName(key);
    expect(name).toBe(expected);
    expect(path.basename(name)).toBe(name);
  });
});

describe('findPdf', () => {
  const bib = path.join(path.sep, 'p', 'refs.bib');

  it('prefers the file field, resolved against the .bib', () => {
    const named = path.join(path.sep, 'p', 'pdfs', 'a.pdf');
    const paper = entry('a', { fields: { file: 'pdfs/a.pdf' } });
    expect(findPdf(paper, bib, (f) => f === named || f === paperPdfPath(bib, 'a'))).toBe(named);
  });

  it('falls back to papers/<key>.pdf', () => {
    const paper = entry('a', { fields: { file: 'gone.pdf' } });
    expect(findPdf(paper, bib, (f) => f === path.join(path.sep, 'p', 'papers', 'a.pdf'))).toBe(paperPdfPath(bib, 'a'));
  });

  it('is undefined when nothing is on disk', () => {
    expect(findPdf(entry('a'), bib, () => false)).toBeUndefined();
  });
});

describe('paperUrl', () => {
  it('prefers a publisher DOI', () => {
    expect(paperUrl(entry('a', { doi: '10.1103/PhysRev.47.777', fields: { eprint: '1706.03762' } }))).toBe('https://doi.org/10.1103/physrev.47.777');
  });

  it('goes to arXiv for an arXiv DOI or eprint', () => {
    expect(paperUrl(entry('a', { doi: '10.48550/arXiv.1706.03762' }))).toBe('https://arxiv.org/abs/1706.03762');
    expect(paperUrl(entry('a', { fields: { eprint: '1706.03762', eprinttype: 'arxiv' } }))).toBe('https://arxiv.org/abs/1706.03762');
  });

  it('only opens http(s) urls', () => {
    expect(paperUrl(entry('a', { fields: { url: 'https://example.org/x' } }))).toBe('https://example.org/x');
    expect(paperUrl(entry('a', { fields: { url: 'file:///etc/passwd' } }))).toBeUndefined();
    expect(paperUrl(entry('a', { fields: { url: 'javascript:alert(1)' } }))).toBeUndefined();
    expect(paperUrl(entry('a'))).toBeUndefined();
  });
});

describe('arxivIdOf', () => {
  it('reads biblatex eprinttype, and does not take another archive for arXiv', () => {
    expect(arxivIdOf(entry('a', { fields: { eprint: '1706.03762', eprinttype: 'arxiv' } }))).toBe('1706.03762');
    expect(arxivIdOf(entry('a', { fields: { eprint: '1706.03762', eprinttype: 'pubmed' } }))).toBeUndefined();
  });
});

describe('fetchArxivPdf', () => {
  const pdf = new TextEncoder().encode('%PDF-1.5 body');
  const respond = (body: string | null, init?: ResponseInit) => (async () => new Response(body, init)) as unknown as typeof fetch;

  it('asks arXiv with the given User-Agent and returns the bytes', async () => {
    let url = '';
    let headers: Record<string, string> = {};
    const fetchFn = (async (input: string, init: RequestInit) => {
      url = input;
      headers = init.headers as Record<string, string>;
      return new Response(pdf);
    }) as unknown as typeof fetch;
    const data = await fetchArxivPdf('hep-th/9901001', { userAgent: 'Overtex/test', fetchFn });
    expect(url).toBe('https://arxiv.org/pdf/hep-th/9901001');
    expect(headers['User-Agent']).toBe('Overtex/test');
    expect(Buffer.from(data).toString()).toBe('%PDF-1.5 body');
  });

  it('rejects a 200 that is not a PDF', async () => {
    await expect(fetchArxivPdf('1706.03762', { userAgent: 'x', fetchFn: respond('<html>wait</html>') })).rejects.toThrow('did not send a PDF');
  });

  it('reports a missing paper and other statuses', async () => {
    await expect(fetchArxivPdf('1706.03762', { userAgent: 'x', fetchFn: respond(null, { status: 404 }) })).rejects.toThrow('has no PDF');
    await expect(fetchArxivPdf('1706.03762', { userAgent: 'x', fetchFn: respond(null, { status: 503 }) })).rejects.toThrow('503');
  });

  it('stops when cancelled or too slow', async () => {
    const hang = ((_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })) as unknown as typeof fetch;
    const abort = new AbortController();
    const cancelled = fetchArxivPdf('1706.03762', { userAgent: 'x', fetchFn: hang, signal: abort.signal });
    abort.abort();
    await expect(cancelled).rejects.toThrow('aborted');
    await expect(fetchArxivPdf('1706.03762', { userAgent: 'x', fetchFn: hang, timeoutMs: 5 })).rejects.toThrow('aborted');
  });
});

describe('parseBib raw fields', () => {
  it('keeps the braces for display and strips them for the rest', () => {
    const [parsed] = parseBib(String.raw`@article{a, title = {K{\"o}rper}, author = {G{\"o}del, Kurt}}`);
    expect(parsed.title).toBe(String.raw`K\"orper`);
    expect(plainTex(parsed.rawTitle ?? '')).toBe('Körper');
    expect(shortAuthors(parsed.rawAuthor ?? '')).toBe('Gödel');
  });
});
