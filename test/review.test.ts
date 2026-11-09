// The end of this file runs the real git, latexdiff and latexmk, and is skipped when they are not installed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuildSettings } from '../src/latex/builder';
import { CompareError } from '../src/latex/latexdiff';
import {
  documentStart,
  escapeLatex,
  exportReview,
  flattenInputs,
  injectPreamble,
  insertNoteMarkers,
  loadsPackage,
  replaceNoteMarkers,
} from '../src/latex/review';

const settings: BuildSettings = { tool: 'latexmk', latexmk: 'latexmk', tectonic: 'tectonic', docker: 'docker', dockerImage: 'texlive/texlive:latest', engine: 'pdflatex', outDir: '', extraArgs: [] };

describe('insertNoteMarkers', () => {
  it('puts each marker above its line, counting lines in the original file', () => {
    const text = 'a\nb\nc\n';
    const out = insertNoteMarkers(text, [
      { id: 'one', line: 1 },
      { id: 'three', line: 3 },
    ]);
    expect(out).toBe('%OVERTEX-NOTE:one\na\nb\n%OVERTEX-NOTE:three\nc\n');
  });

  it('puts a note in a table above the table, where TeX allows it', () => {
    const text = 'a\n\\begin{table}\n\\begin{tabular}{l}\n\\hline\nx \\\\\n\\end{tabular}\n% \\begin{tabular}\nb\n';
    const out = insertNoteMarkers(text, [
      { id: 'row', line: 5 },
      { id: 'after', line: 8 },
    ]);
    expect(out).toBe('a\n\\begin{table}\n%OVERTEX-NOTE:row\n\\begin{tabular}{l}\n\\hline\nx \\\\\n\\end{tabular}\n% \\begin{tabular}\n%OVERTEX-NOTE:after\nb\n');
  });

  it('keeps CRLF line endings and clamps lines past the end', () => {
    const out = insertNoteMarkers('a\r\nb\r\n', [{ id: 'x', line: 99 }]);
    expect(out).toBe('a\r\nb\r\n%OVERTEX-NOTE:x\r\n');
  });
});

describe('escapeLatex', () => {
  it('escapes the special characters and joins lines', () => {
    expect(escapeLatex('50% of $x_1$ & {more}\n  #2 ~ ^ \\')).toBe(
      '50\\% of \\$x\\_1\\$ \\& \\{more\\} \\#2 \\textasciitilde{} \\textasciicircum{} \\textbackslash{}'
    );
  });
});

describe('replaceNoteMarkers', () => {
  const notes = new Map([
    ['a-1', 'Fix this'],
    ['b-2', 'And this'],
  ]);

  it('replaces markers kept as is and those latexdiff moved after a changed passage', () => {
    const { text, placed } = replaceNoteMarkers('x\n  %OVERTEX-NOTE:a-1\n\\DIFdelbegin \\DIFdel{Old }\\DIFdelend %DIF > OVERTEX-NOTE:b-2\nz', notes);
    expect(text).toBe(
      'x\n  \\marginnote{\\footnotesize\\raggedright Fix this}%\n\\DIFdelbegin \\DIFdel{Old }\\DIFdelend \\marginnote{\\footnotesize\\raggedright And this}%\nz'
    );
    expect([...placed]).toEqual(['a-1', 'b-2']);
  });

  it('leaves an escaped percent sign alone', () => {
    expect(replaceNoteMarkers('50\\%OVERTEX-NOTE:a-1', notes).placed.size).toBe(0);
  });

  it('leaves unknown and repeated markers alone', () => {
    const { text, placed } = replaceNoteMarkers('%OVERTEX-NOTE:zzz\r\n%OVERTEX-NOTE:a-1\r\n%OVERTEX-NOTE:a-1\r\n', notes);
    expect(text).toBe('%OVERTEX-NOTE:zzz\r\n\\marginnote{\\footnotesize\\raggedright Fix this}%\r\n%OVERTEX-NOTE:a-1\r\n');
    expect(placed.size).toBe(1);
  });
});

describe('preamble', () => {
  it('finds \\begin{document} outside comments', () => {
    const text = '% \\begin{document}\n\\x\\%\\begin{document}\n';
    expect(documentStart(text)).toBe(text.indexOf('\\begin{document}', 3));
    expect(documentStart('\\documentclass{article}\n')).toBe(-1);
  });

  it('sees packages loaded in a list or with options, but not in comments', () => {
    expect(loadsPackage('\\usepackage[left]{amsmath, lineno}', 'lineno')).toBe(true);
    expect(loadsPackage('\\RequirePackage{marginnote}', 'marginnote')).toBe(true);
    expect(loadsPackage('% \\usepackage{lineno}', 'lineno')).toBe(false);
    expect(loadsPackage('\\usepackage{linenoX}', 'lineno')).toBe(false);
  });

  it('adds the packages on the line before \\begin{document}', () => {
    const out = injectPreamble('\\documentclass{article}\n  \\begin{document}\nHi\n\\end{document}\n', { lineNumbers: true, notes: true });
    expect(out).toBe(
      '\\documentclass{article}\n% Added by Overtex for the review copy\n\\usepackage[mathlines]{lineno}\n\\linenumbers\n\\usepackage{marginnote}\n  \\begin{document}\nHi\n\\end{document}\n'
    );
  });

  it('does not load a package again, which could clash with its options', () => {
    const out = injectPreamble('\\usepackage[right]{lineno}\n\\usepackage{marginnote}\n\\begin{document}\n', { lineNumbers: true, notes: true });
    expect(out).not.toContain('\\usepackage[mathlines]{lineno}');
    expect(out.match(/marginnote/g)).toHaveLength(1);
    expect(out).toContain('\\linenumbers\n\\begin{document}');
  });

  it('changes nothing when nothing is asked for, and needs a \\begin{document}', () => {
    expect(injectPreamble('\\begin{document}\n', { lineNumbers: false, notes: false })).toBe('\\begin{document}\n');
    expect(() => injectPreamble('\\section{x}\n', { lineNumbers: true, notes: false })).toThrow(CompareError);
  });
});

describe('flattenInputs', () => {
  const files: Record<string, string> = {
    '/p/main.tex': 'A\n\\input{ch/one}\n% \\input{ch/gone}\n\\include{two} after\n\\input{missing}\n',
    '/p/ch/one.tex': 'One \\input{ch/three.tex}',
    '/p/ch/three.tex': 'Three',
    '/p/two.tex': 'Two',
  };
  const read = (file: string) => files[file];

  it('pastes inputs from the main file folder, recursively, and leaves the rest', () => {
    expect(flattenInputs('/p/main.tex', read)).toBe(
      'A\nOne Three\n\n\n% \\input{ch/gone}\n\\clearpage\nTwo\n\\clearpage  after\n\\input{missing}\n'
    );
  });

  it('stops at a file that inputs itself', () => {
    const out = flattenInputs('/p/loop.tex', (f) => (f === '/p/loop.tex' ? 'x \\input{loop}' : undefined));
    expect(out.match(/x /g)).toHaveLength(11);
  });
});

function installed(command: string, ...args: string[]): boolean {
  try {
    cp.execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasTools = installed('git', '--version') && installed('latexdiff', '--version') && installed('latexmk', '-v') && installed('kpsewhich', 'lineno.sty', 'marginnote.sty');

describe.skipIf(!hasTools)('exportReview (real git, latexdiff and latexmk)', () => {
  let root: string;
  let main: string;
  let first: string;
  const source = (text: string) => `\\documentclass{article}\n\\begin{document}\n${text}\n\\input{part}\n\\end{document}\n`;
  const git = (...args: string[]) => cp.execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: root, encoding: 'utf-8' }).trim();

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-review-')));
    main = path.join(root, 'main.tex');
    fs.writeFileSync(main, source('Old words here.'));
    fs.writeFileSync(path.join(root, 'part.tex'), 'A part.\n');
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'one');
    first = git('rev-parse', 'HEAD');
    fs.writeFileSync(main, source('New words here.'));
    fs.writeFileSync(path.join(root, 'part.tex'), 'A changed part.\n');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const notes = () => [
    { id: 'n-1', text: 'Cite 50% of this & that', file: main, line: 3 },
    { id: 'n-2', text: 'In the part', file: path.join(root, 'part.tex'), line: 1 },
    { id: 'n-3', text: 'In the preamble', file: main, line: 1 },
  ];

  it('builds a copy with line numbers and notes, leaving the sources alone', async () => {
    const before = fs.readFileSync(main, 'utf-8');
    const result = await exportReview({ mainFile: main, lineNumbers: true, notes: notes(), latexdiff: 'latexdiff', build: settings });
    if (result.status !== 'built') {
      throw new Error(`status: ${result.status}`);
    }
    expect(result.complete).toBe(true);
    expect(result.placed).toBe(2);
    expect(result.pdf).toBe(path.join(root, 'main-review.pdf'));
    expect(fs.existsSync(result.pdf)).toBe(true);
    expect(fs.readFileSync(main, 'utf-8')).toBe(before);
    expect(fs.readdirSync(root).filter((f) => f.startsWith('overtex-diff-'))).toEqual([]);
  }, 120000);

  it('marks the changes since a commit, notes in changed passages included', async () => {
    const result = await exportReview({ mainFile: main, lineNumbers: true, notes: notes(), since: { revision: first }, latexdiff: 'latexdiff', build: settings });
    if (result.status !== 'built') {
      throw new Error(`status: ${result.status}`);
    }
    expect(result.complete).toBe(true);
    expect(result.placed).toBe(2);
    expect(fs.existsSync(result.pdf)).toBe(true);
  }, 120000);
});
