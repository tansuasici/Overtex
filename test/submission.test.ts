import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseLog } from '../src/latex/logParser';
import {
  anonymityFindings,
  bitmapFonts,
  checkSubmission,
  draftLine,
  pageCount,
  referenceProblems,
  summarize,
  todoFindings,
} from '../src/latex/submission';

const fixture = (name: string) => fs.readFileSync(path.resolve(__dirname, 'fixtures', name), 'utf8');

describe('pageCount', () => {
  it('reads the page count from the log', () => {
    expect(pageCount('Output written on main.pdf (12 pages, 34567 bytes).')).toBe(12);
    expect(pageCount('Output written on main.pdf (1 page, 81475 bytes).')).toBe(1);
    expect(pageCount('No pages of output.')).toBeNull();
  });
});

describe('bitmapFonts', () => {
  it('finds pk fonts in the recorder file', () => {
    const fls = [
      'PWD /p',
      'INPUT /tl/fonts/type1/public/amsfonts/cm/cmr10.pfb',
      'INPUT /home/u/texmf-var/fonts/pk/ljfour/public/bbm/bbm10.600pk',
      'INPUT /home/u/texmf-var/fonts/pk/ljfour/public/bbm/bbm10.600pk',
      'INPUT /home/u/texmf-var/fonts/pk/ljfour/public/clock/clock.657pk',
    ].join('\n');
    expect(bitmapFonts(fls)).toEqual(['bbm10', 'clock']);
  });
});

describe('referenceProblems', () => {
  it('reports undefined references and citations from the log', () => {
    const found = referenceProblems(parseLog(fixture('sample-warnings.log'), '/proj'));
    expect(found.map((f) => f.message)).toEqual([
      "Reference `fig:unknown' is undefined and prints as ??.",
      "Citation `smith2020' is undefined and prints as ??.",
    ]);
    expect(found.every((f) => f.fromBuild && f.line! > 0)).toBe(true);
  });

  it('reports duplicate labels', () => {
    const found = referenceProblems([{ severity: 'warning', message: "Label `eq:1' multiply defined.", file: '/p/main.tex', line: 0 }]);
    expect(found[0].message).toBe("Label `eq:1' is defined more than once.");
  });
});

describe('draftLine', () => {
  it('finds the draft class option', () => {
    expect(draftLine('% \\documentclass[draft]{article}\n\\documentclass[11pt, draft]{article}')).toBe(2);
    expect(draftLine('\\documentclass[draftmode]{article}')).toBe(0);
    expect(draftLine('\\documentclass{article}\n\\usepackage[draft]{graphicx}')).toBe(0);
  });
});

describe('todoFindings', () => {
  it('tells TODOs in the text from TODOs in comments', () => {
    const tex = ['\\usepackage{todonotes}', 'Results \\todo{check numbers}.', 'TODO: rewrite', 'Text % TODO later', '50\\% done', 'Proto-XXXL'].join('\n');
    expect(todoFindings('/p/a.tex', tex).map((f) => [f.line, f.severity])).toEqual([
      [2, 'warning'],
      [3, 'warning'],
      [4, 'info'],
    ]);
  });
});

describe('anonymityFindings', () => {
  it('points at author information but not at anonymous placeholders', () => {
    const tex = [
      '\\author{Ada Lovelace}',
      '\\author{Anonymous Authors}',
      '\\author[1]{Anonymous}',
      '% \\thanks{grant}',
      'x\\thanks{Funded by X}',
      '\\section*{Acknowledgments}',
      '\\hypersetup{pdfauthor={Ada}}',
      '\\hypersetup{pdfauthor={}}',
    ].join('\n');
    expect(anonymityFindings('/p/a.tex', tex).map((f) => f.line)).toEqual([1, 5, 6, 7]);
  });
});

describe('checkSubmission', () => {
  const files: Record<string, string> = {
    [path.resolve('/p/main.tex')]: '\\documentclass[draft]{article}\n\\author{Ada}\n\\begin{document}\n\\input{sec}\n\\end{document}\n',
    [path.resolve('/p/sec.tex')]: 'Text \\todo{x}\n',
  };
  const base = {
    log: 'Output written on main.pdf (9 pages, 1 bytes).',
    fls: 'PWD /p\nINPUT main.tex\nINPUT main.aux\nINPUT sec.tex\nINPUT /tl/article.cls\n',
    entries: [],
    mainFile: path.resolve('/p/main.tex'),
    outDir: path.resolve('/p'),
    exists: (f: string) => f in files,
    read: (f: string) => files[f],
  };

  it('runs every check and summarizes', () => {
    const report = checkSubmission({ ...base, pageLimit: 8, anonymous: true });
    expect(report.pages).toBe(9);
    expect(report.findings.map((f) => [f.kind, path.basename(f.file ?? ''), f.line])).toEqual([
      ['pages', 'main.tex', 0],
      ['draft', 'main.tex', 1],
      ['anonymity', 'main.tex', 2],
      ['todo', 'sec.tex', 1],
    ]);
    expect(summarize(report, 8)).toBe('9 pages (limit 8) · 1 draft option · 1 TODO in the text · 1 possible author identification');
  });

  it('skips the page limit and anonymity checks unless asked', () => {
    const report = checkSubmission({ ...base, pageLimit: 0, anonymous: false });
    expect(report.findings.map((f) => f.kind)).toEqual(['draft', 'todo']);
  });

  describe('open PDF notes', () => {
    const notesFile = path.resolve('/p/main.overtex-notes.json');
    const stored = (n: object) => ({ id: 'i', page: 1, x: 1, y: 1, text: 'Check', createdAt: 'c', ...n });
    const run = (content: string) => {
      const withNotes = { ...files, [notesFile]: content };
      return checkSubmission({ ...base, pageLimit: 0, anonymous: false, exists: (f) => f in withNotes, read: (f) => withNotes[f] });
    };
    const noteFindings = (report: { findings: { kind: string }[] }) => report.findings.filter((f) => f.kind === 'note' || f.kind === 'noteFile');

    it('lists notes not marked done, in order, on the main file', () => {
      const report = run(
        JSON.stringify({
          version: 1,
          notes: [
            stored({ id: 'b', page: 3, text: 'Second\nmore' }),
            stored({ id: 'a', page: 1, text: 'First' }),
            stored({ id: 'c', page: 2, doneAt: 'd' }),
          ],
        })
      );
      expect(noteFindings(report)).toEqual([
        { kind: 'note', severity: 'warning', message: 'Open PDF note on page 1: First', file: base.mainFile, line: 0 },
        { kind: 'note', severity: 'warning', message: 'Open PDF note on page 3: Second', file: base.mainFile, line: 0 },
      ]);
      expect(summarize(report, 0)).toBe('9 pages · 1 draft option · 1 TODO in the text · 2 open PDF notes');
    });

    it('finds nothing when every note is done', () => {
      expect(noteFindings(run(JSON.stringify({ version: 1, notes: [stored({ doneAt: 'd' })] })))).toEqual([]);
    });

    it('says so when the file cannot be read, rather than failing the check', () => {
      const report = run('<<<<<<< HEAD\n');
      expect(report.findings.map((f) => f.kind)).toEqual(['draft', 'todo', 'noteFile']);
      expect(report.findings[2].message).toContain('main.overtex-notes.json');
      expect(summarize(report, 0)).toContain('1 unreadable notes file');
      expect(summarize(report, 0)).not.toContain('open PDF note');
    });
  });
});
