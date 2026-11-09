import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changesBetween, collectSources, historyDir, HistoryStore, prune, Snapshot } from '../src/latex/history';

let tmp: string;
let project: string;
let store: HistoryStore;

function put(rel: string, text: string): void {
  const file = path.join(project, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function blobCount(): number {
  const blobs = path.join(store.dir, 'blobs');
  return fs.existsSync(blobs) ? fs.readdirSync(blobs).reduce((n, d) => n + fs.readdirSync(path.join(blobs, d)).length, 0) : 0;
}

const main = () => path.join(project, 'main.tex');
const record = (extra: { keep?: number; time?: number; pdf?: string } = {}) =>
  store.record({ mainFile: main(), trigger: 'build', keep: extra.keep ?? 50, time: extra.time, pdfFile: extra.pdf, outDir: path.join(project, 'out') });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-history-'));
  project = path.join(tmp, 'project');
  store = new HistoryStore(historyDir(path.join(tmp, 'storage'), path.join(project, 'main.tex')));
  put('main.tex', '\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n');
  put('chapters/intro.tex', 'Hello.\n');
  put('refs.bib', '@misc{a, title={A}}\n');
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('collectSources', () => {
  it('keeps sources and skips figures, hidden folders, build output and diff scratch folders', () => {
    put('figure.png', 'png');
    put('.git/x.tex', 'no');
    put('out/main.tex', 'no');
    put('overtex-diff-abc/main-diff.tex', 'no');
    put('node_modules/x.tex', 'no');
    put('style/my.sty', '%');
    expect(collectSources(project, path.join(project, 'out'))).toEqual(['chapters/intro.tex', 'main.tex', 'refs.bib', 'style/my.sty']);
  });
});

describe('HistoryStore', () => {
  it('records a snapshot and reads the files back', () => {
    const s = record({ time: 1000 })!;
    expect(s.main).toBe('main.tex');
    expect(s.files.map((f) => f.path)).toEqual(['chapters/intro.tex', 'main.tex', 'refs.bib']);
    const intro = s.files.find((f) => f.path === 'chapters/intro.tex')!;
    expect(store.read(intro.hash).toString()).toBe('Hello.\n');
    expect(store.list()).toHaveLength(1);
  });

  it('skips a snapshot when nothing changed, and stores an unchanged file once', () => {
    expect(record({ time: 1 })).toBeDefined();
    expect(record({ time: 2 })).toBeUndefined();
    const before = blobCount();
    put('chapters/intro.tex', 'Hello, world.\n');
    const s = record({ time: 3 })!;
    expect(store.list().map((x) => x.id)).toEqual([s.id, store.list()[1].id]);
    // Only the changed chapter adds a blob.
    expect(blobCount()).toBe(before + 1);
  });

  it('keeps the newest PDF with sources that were built again', () => {
    const pdf = path.join(project, 'out', 'main.pdf');
    put('out/main.pdf', '%PDF one');
    const s = record({ pdf })!;
    put('out/main.pdf', '%PDF two');
    expect(record({ pdf })).toBeUndefined();
    const latest = store.get(s.id)!;
    expect(store.read(latest.pdf!).toString()).toBe('%PDF two');
    // The first PDF is no longer referenced, so it is gone.
    expect(blobCount()).toBe(4);
  });

  it('lists what changed against the snapshot before', () => {
    const first = record({ time: 1 })!;
    put('chapters/intro.tex', 'Changed.\n');
    put('chapters/new.tex', 'New.\n');
    fs.rmSync(path.join(project, 'refs.bib'));
    const second = record({ time: 2 })!;
    expect(store.previous(second)?.id).toBe(first.id);
    expect(changesBetween(store.previous(second), second).map((c) => `${c.kind} ${c.path}`)).toEqual([
      'modified chapters/intro.tex',
      'added chapters/new.tex',
      'deleted refs.bib',
    ]);
    expect(changesBetween(undefined, first).every((c) => c.kind === 'added')).toBe(true);
  });

  it('prunes unnamed snapshots past the limit and frees their files, but keeps named ones', () => {
    const first = record({ time: 1, keep: 2 })!;
    store.setLabel(first.id, '  Submitted  ');
    for (let i = 2; i <= 5; i++) {
      put('chapters/intro.tex', `Version ${i}.\n`);
      record({ time: i, keep: 2 });
    }
    const left = store.list();
    expect(left.map((s) => s.time)).toEqual([5, 4, 1]);
    expect(left[2].label).toBe('Submitted');
    // main.tex and refs.bib are shared; intro versions 1, 4 and 5 remain.
    expect(blobCount()).toBe(5);
    store.setLabel(first.id, '');
    expect(store.get(first.id)?.label).toBeUndefined();
  });

  it('removes a snapshot and the files only it used', () => {
    record({ time: 1 });
    put('chapters/intro.tex', 'Only in the second.\n');
    const second = record({ time: 2 })!;
    const before = blobCount();
    store.remove(second.id);
    expect(store.list()).toHaveLength(1);
    expect(blobCount()).toBe(before - 1);
  });

  it('writes a snapshot out as a folder that builds like the original', () => {
    const s = record()!;
    put('chapters/intro.tex', 'Later.\n');
    const dest = path.join(tmp, 'copy');
    const mainCopy = store.materialize(s, dest);
    expect(mainCopy).toBe(path.join(dest, 'main.tex'));
    expect(fs.readFileSync(path.join(dest, 'chapters', 'intro.tex'), 'utf8')).toBe('Hello.\n');
  });

  it('records nothing when the main file is not a source it keeps', () => {
    fs.rmSync(main());
    expect(record()).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('treats a broken index as empty and refuses odd hashes', () => {
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(path.join(store.dir, 'index.json'), '{oops');
    expect(store.list()).toEqual([]);
    expect(() => store.blobPath('../../etc/passwd')).toThrow();
  });
});

describe('prune', () => {
  it('keeps at least one snapshot', () => {
    const s = (time: number, label?: string): Snapshot => ({ id: String(time), time, main: 'main.tex', files: [], trigger: 'build', ...(label && { label }) });
    expect(prune([s(3), s(2, 'x'), s(1)], 0).map((x) => x.id)).toEqual(['3', '2']);
  });
});

describe('historyDir', () => {
  it('gives each main file a folder of its own', () => {
    expect(historyDir('/s', '/a/main.tex')).not.toBe(historyDir('/s', '/b/main.tex'));
    expect(historyDir('/s', '/a/main.tex')).toBe(historyDir('/s', '/a/../a/main.tex'));
  });
});
