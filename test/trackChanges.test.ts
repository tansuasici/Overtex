import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { HistoryStore } from '../src/latex/history';
import { acceptHunk, diff, hunkRange, hunks, rejectHunk, splitLines, tokenize, wordChanges } from '../src/latex/trackChanges';

/** Applies an edit script to `a` and checks it gives `b`. */
function apply<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (const e of diff(a, b)) {
    if (e.op === 'equal') {
      out.push(...a.slice(e.aStart, e.aStart + e.length));
    } else if (e.op === 'insert') {
      out.push(...b.slice(e.bStart, e.bStart + e.length));
    }
  }
  return out;
}

describe('diff', () => {
  it('turns one sequence into the other', () => {
    const cases: [string, string][] = [
      ['', ''],
      ['abc', ''],
      ['', 'abc'],
      ['abcabba', 'cbabac'],
      ['the quick brown fox', 'the slow brown dog'],
      ['xaxbxc', 'abc'],
    ];
    for (const [a, b] of cases) {
      expect(apply([...a], [...b]).join('')).toBe(b);
    }
  });

  it('finds the shortest script', () => {
    const changed = (a: string, b: string) => diff([...a], [...b]).filter((e) => e.op !== 'equal').reduce((n, e) => n + e.length, 0);
    expect(changed('abcabba', 'cbabac')).toBe(5);
    expect(changed('abc', 'abc')).toBe(0);
    expect(changed('abc', 'abxc')).toBe(1);
  });

  it('agrees with random edits', () => {
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: rand(30) }, () => 'abcd'[rand(4)]);
      const b = Array.from({ length: rand(30) }, () => 'abcd'[rand(4)]);
      expect(apply(a, b)).toEqual(b);
    }
  });
});

describe('hunks', () => {
  const base = 'one\ntwo\nthree\nfour\nfive\n';

  it('finds changed, added and removed lines', () => {
    const cur = 'one\nTWO\nthree\nfive\nsix\n';
    expect(hunks(base, cur)).toEqual([
      { oldStart: 1, newStart: 1, oldLines: ['two\n'], newLines: ['TWO\n'] },
      { oldStart: 3, newStart: 3, oldLines: ['four\n'], newLines: [] },
      { oldStart: 5, newStart: 4, oldLines: [], newLines: ['six\n'] },
    ]);
  });

  it('finds nothing when the text is the same', () => {
    expect(hunks(base, base)).toEqual([]);
  });

  it('sees a missing last line break', () => {
    expect(hunks('a\nb\n', 'a\nb')).toEqual([{ oldStart: 1, newStart: 1, oldLines: ['b\n'], newLines: ['b'] }]);
  });

  it('accepting every hunk turns the baseline into the current text', () => {
    const cur = 'zero\none\nTWO\nthree\nfive';
    let b = base;
    // Accept from the last, so the earlier hunks' line numbers still hold.
    for (const h of hunks(base, cur).reverse()) {
      b = acceptHunk(b, h);
    }
    expect(b).toBe(cur);
  });

  it('accepting one hunk leaves the others', () => {
    const cur = 'one\nTWO\nthree\nfive\nsix\n';
    const [first] = hunks(base, cur);
    const after = acceptHunk(base, first);
    expect(after).toBe('one\nTWO\nthree\nfour\nfive\n');
    expect(hunks(after, cur)).toHaveLength(2);
  });

  it('rejecting every hunk turns the current text back into the baseline', () => {
    const cur = 'zero\none\nTWO\nthree\nfive';
    let c = cur;
    for (const h of hunks(base, cur).reverse()) {
      c = rejectHunk(c, h);
    }
    expect(c).toBe(base);
  });

  it('gives where a hunk is in the current text', () => {
    const cur = 'one\nTWO\nthree\n';
    const [h] = hunks('one\ntwo\nthree\n', cur);
    const r = hunkRange(cur, h);
    expect(cur.slice(r.start, r.end)).toBe('TWO\n');
    const del = hunks('one\ntwo\nthree\n', 'one\nthree\n')[0];
    expect(hunkRange('one\nthree\n', del)).toEqual({ start: 4, end: 4 });
  });

  it('keeps CRLF line breaks', () => {
    expect(splitLines('a\r\nb')).toEqual(['a\r\n', 'b']);
    const cur = 'a\r\nB\r\n';
    const [h] = hunks('a\r\nb\r\n', cur);
    expect(rejectHunk(cur, h)).toBe('a\r\nb\r\n');
  });
});

describe('wordChanges', () => {
  it('marks the words that changed in a line', () => {
    const oldText = 'The quick brown fox.\n';
    const newText = 'The slow brown fox jumps.\n';
    const w = wordChanges(oldText, newText);
    expect(w.inserted.map((r) => newText.slice(r.start, r.end))).toEqual(['slow', ' jumps']);
    expect(w.deleted).toEqual([{ at: 4, text: 'quick' }]);
  });

  it('splits LaTeX into words, spaces and single marks', () => {
    expect(tokenize('\\emph{çok} güzel')).toEqual(['\\', 'emph', '{', 'çok', '}', ' ', 'güzel']);
  });
});

describe('the Track Changes baseline', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-track-'));
    dirs.push(d);
    return d;
  };

  it('is kept however many snapshots are pruned', () => {
    const project = tmp();
    const store = new HistoryStore(tmp());
    const main = path.join(project, 'main.tex');
    fs.writeFileSync(main, 'baseline text\n');
    const baseline = store.startBaseline(main);
    const hash = baseline.files[0].hash;
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(main, `edit ${i}\n`);
      store.record({ mainFile: main, trigger: 'build', keep: 1, time: 1000 + i });
    }
    expect(store.list()).toHaveLength(1);
    expect(store.read(hash).toString()).toBe('baseline text\n');
  });

  it('changes one file at a time and goes away when cleared', () => {
    const project = tmp();
    const store = new HistoryStore(tmp());
    const main = path.join(project, 'main.tex');
    fs.writeFileSync(main, 'a\n');
    fs.mkdirSync(path.join(project, 'ch'));
    fs.writeFileSync(path.join(project, 'ch', 'one.tex'), 'one\n');
    store.startBaseline(main);
    store.setBaselineFile('main.tex', Buffer.from('b\n'));
    store.setBaselineFile('ch/one.tex', undefined);
    store.setBaselineFile('new.tex', Buffer.from('new\n'));
    const b = store.baseline()!;
    expect(b.files.map((f) => f.path)).toEqual(['main.tex', 'new.tex']);
    expect(store.read(b.files[0].hash).toString()).toBe('b\n');

    const dest = tmp();
    expect(store.materializeBaseline(b, dest)).toBe(path.join(dest, 'main.tex'));
    expect(fs.readFileSync(path.join(dest, 'new.tex'), 'utf8')).toBe('new\n');

    store.clearBaseline();
    expect(store.baseline()).toBeUndefined();
    expect(() => store.read(b.files[0].hash)).toThrow();
  });
});
