import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { parseBib } from '../src/latex/bibParser';
import { citeInsertion } from '../src/latex/citationImport';
import { ZoteroUnavailableError, mergePicks, pickFromZotero, probeZotero, splitEntries, translatorFor } from '../src/latex/zotero';

const EPR = `@article{einsteinCanQuantumMechanical1935,
  title = {Can {{Quantum-Mechanical Description}} of {{Physical Reality Be Considered Complete}}?},
  author = {Einstein, A. and Podolsky, B. and Rosen, N.},
  year = {1935},
  journal = {Physical Review},
  doi = {10.1103/PhysRev.47.777},
  file = {/Users/someone/Zotero/storage/ABC/epr.pdf}
}`;

const ATTENTION = `@misc{vaswaniAttentionAllYou2017,
  title = {Attention {{Is All You Need}}},
  author = {Vaswani, Ashish},
  year = {2017}
}`;

describe('translatorFor', () => {
  it.each([
    ['\\bibliography{refs}', 'bibtex'],
    ['\\addbibresource{refs.bib}', 'biblatex'],
    ['\\usepackage[style=ieee]{biblatex}\n\\bibliography{refs}', 'biblatex'],
    ['\\usepackage{amsmath,biblatex}', 'biblatex'],
    ['% \\addbibresource{refs.bib}\n\\bibliography{refs}', 'bibtex'],
    ['', 'bibtex'],
  ])('%s gives %s', (tex, translator) => {
    expect(translatorFor(tex)).toBe(translator);
  });
});

describe('splitEntries', () => {
  it('separates entries and leaves out the rest', () => {
    const raw = `@comment{jabref-meta: x}\n@string{prl = "Phys. Rev. Lett."}\n\n${EPR}\n\n${ATTENTION}\n`;
    expect(splitEntries(raw)).toEqual([EPR, ATTENTION]);
  });

  it('is not fooled by escaped braces', () => {
    const entry = '@misc{k,\n  title = {A \\} brace}\n}';
    expect(splitEntries(`${entry}\n@misc{l, title = {B}}`)).toEqual([entry, '@misc{l, title = {B}}']);
  });
});

describe('mergePicks', () => {
  it('keeps the keys from Zotero, in the order picked', () => {
    const { keys, text } = mergePicks(`${EPR}\n\n${ATTENTION}\n`, []);
    expect(keys).toEqual(['einsteinCanQuantumMechanical1935', 'vaswaniAttentionAllYou2017']);
    expect(parseBib(text).map((e) => e.key)).toEqual(keys);
    expect(parseBib(text)[0].doi).toBe('10.1103/PhysRev.47.777');
  });

  it('does not copy local attachment paths into the bibliography', () => {
    const { text } = mergePicks(EPR, []);
    expect(text).not.toContain('/Users/someone');
    expect(text).not.toMatch(/^\s*file\s*=/m);
  });

  it('reuses an entry with the same key and appends nothing', () => {
    expect(mergePicks(EPR, parseBib(EPR))).toEqual({ keys: ['einsteinCanQuantumMechanical1935'], text: '' });
  });

  it('reuses an entry with the same DOI under its own key', () => {
    const existing = parseBib('@article{epr1935, title = {EPR}, doi = {https://doi.org/10.1103/physrev.47.777}}');
    expect(mergePicks(EPR, existing)).toEqual({ keys: ['epr1935'], text: '' });
  });

  it('gives a new key when the key belongs to a different paper', () => {
    const existing = parseBib('@misc{vaswaniAttentionAllYou2017, title = {Something Else}, year = {1999}}');
    const { keys, text } = mergePicks(ATTENTION, existing);
    expect(keys).toEqual(['vaswani2017attention']);
    expect(parseBib(text)[0].key).toBe('vaswani2017attention');
    expect(text).toContain('Attention');
  });

  it('adds a paper picked twice once', () => {
    const { keys, text } = mergePicks(`${ATTENTION}\n${ATTENTION}`, []);
    expect(keys).toEqual(['vaswaniAttentionAllYou2017']);
    expect(parseBib(text)).toHaveLength(1);
  });

  it('finds nothing in a text without entries', () => {
    expect(mergePicks('Translator not found', [])).toEqual({ keys: [], text: '' });
  });

  it('cites several keys through citeInsertion', () => {
    expect(citeInsertion('See ', 'a, b')).toBe('\\cite{a, b}');
    expect(citeInsertion('See \\cite{x', 'a, b')).toBe(', a, b');
  });
});

describe('talking to Zotero', () => {
  let server: http.Server;
  let url: string;
  let requests: URL[] = [];
  let answer: (req: URL, res: http.ServerResponse) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push(parsed);
      answer(parsed, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const reply = (status: number, body: string) => (_: URL, res: http.ServerResponse) => {
    res.writeHead(status);
    res.end(body);
  };

  it('is ready when Better BibTeX says so', async () => {
    requests = [];
    answer = reply(200, 'ready');
    await expect(probeZotero(`${url}/`)).resolves.toBeUndefined();
    expect(requests[0].pathname).toBe('/better-bibtex/cayw');
    expect(requests[0].searchParams.get('probe')).toBe('true');
  });

  it('tells a Better BibTeX that is still starting from a missing one', async () => {
    answer = reply(200, 'starting\n');
    const starting = await probeZotero(url).catch((e) => e);
    expect(starting).toBeInstanceOf(ZoteroUnavailableError);
    expect(starting.reason).toBe('starting');
  });

  it('tells a Zotero without Better BibTeX from no Zotero at all', async () => {
    answer = reply(404, 'No endpoint found');
    const noAddon = await probeZotero(url).catch((e) => e);
    expect(noAddon).toBeInstanceOf(ZoteroUnavailableError);
    expect(noAddon.reason).toBe('no-better-bibtex');

    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const notRunning = await probeZotero(`http://127.0.0.1:${port}`).catch((e) => e);
    expect(notRunning).toBeInstanceOf(ZoteroUnavailableError);
    expect(notRunning.reason).toBe('not-running');
  });

  it('asks for the project\'s kind of BibTeX and returns the picks', async () => {
    requests = [];
    answer = reply(200, `\n${EPR}\n`);
    expect(await pickFromZotero(url, 'biblatex')).toBe(EPR);
    expect(requests[0].searchParams.get('format')).toBe('translate');
    expect(requests[0].searchParams.get('translator')).toBe('biblatex');
  });

  it('returns nothing when the picker was cancelled', async () => {
    answer = reply(200, '');
    expect(await pickFromZotero(url, 'bibtex')).toBe('');
  });

  it('reports an error from Zotero', async () => {
    answer = reply(500, 'CAYW failed: no such translator\nstack…');
    await expect(pickFromZotero(url, 'bibtex')).rejects.toThrow('Zotero answered 500: CAYW failed: no such translator');
  });

  it('stops waiting for the picker when cancelled', async () => {
    answer = () => undefined; // The picker stays open.
    const abort = new AbortController();
    const pick = pickFromZotero(url, 'bibtex', abort.signal);
    abort.abort();
    await expect(pick).rejects.toMatchObject({ name: 'AbortError' });
  });
});
