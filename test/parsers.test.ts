import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseLog, parseTectonicLog } from '../src/latex/logParser';
import { parseBib } from '../src/latex/bibParser';
import { parseEditOutput, parseViewOutput } from '../src/synctex/synctex';
import { toWorkspacePath } from '../src/synctex/paths';
import { findMainFile } from '../src/latex/mainFile';
import { latexmkArgs } from '../src/latex/builder';

const fixtures = path.resolve(__dirname, 'fixtures');
const read = (name: string) => fs.readFileSync(path.join(fixtures, name), 'utf-8');

describe('parseTectonicLog', () => {
  const onDisk = (...files: string[]) => (file: string) => files.includes(path.relative('/proj', file));

  it('finds a file named without its extension', () => {
    const log = ['(main.tex', '(article.cls (size10.clo)) (sub', '! Undefined control sequence.', 'l.2 \\bad', ''].join('\n');
    expect(parseTectonicLog(log, '/proj', onDisk('main.tex', 'sub.tex'))).toEqual([
      { severity: 'error', message: 'Undefined control sequence.', file: path.resolve('/proj/sub.tex'), line: 2 },
    ]);
  });

  it('joins a file name wrapped at 79 columns', () => {
    const name = 'a-section-file-with-a-long-name-so-that-the-log-line-goes-past-seventy-nine-columns';
    const log = ['(main.tex', `(${name.slice(0, 78)}`, name.slice(78), '! Undefined control sequence.', 'l.2 \\bad', ''].join('\n');
    expect(parseTectonicLog(log, '/proj', onDisk('main.tex', `${name}.tex`))[0].file).toBe(path.resolve(`/proj/${name}.tex`));
  });

  it('finds a file with a space in its name, and returns to the file that input it', () => {
    const log = ['(main.tex', '(sub dir/two.tex', "LaTeX Warning: Reference `a' on page 1 undefined on input line 2.", ')', "LaTeX Warning: Reference `b' on page 1 undefined on input line 9.", ''].join('\n');
    const warnings = parseTectonicLog(log, '/proj', onDisk('main.tex', 'sub dir/two.tex'));
    expect(warnings.map((w) => [path.relative('/proj', w.file), w.line])).toEqual([
      ['sub dir/two.tex', 2],
      ['main.tex', 9],
    ]);
  });

  it('joins a warning wrapped at 79 columns, so its line number is found', () => {
    const start = "LaTeX Warning: Reference `a-label-long-enough-to-wrap' on page 1 undefined on i";
    expect(start).toHaveLength(79);
    const [warning] = parseTectonicLog(['(main.tex', start, 'nput line 7.', ''].join('\n'), '/proj', onDisk('main.tex'));
    expect(warning).toMatchObject({ line: 7, message: "Reference `a-label-long-enough-to-wrap' on page 1 undefined" });
  });

  it('does not join an error to a line that happens to fill 79 columns', () => {
    const log = ['(main.tex', 'x'.repeat(79), '! Undefined control sequence.', 'l.3 \\bad', ''].join('\n');
    expect(parseTectonicLog(log, '/proj', onDisk('main.tex')).map((e) => e.line)).toEqual([3]);
  });

  it('tidies the doubled mark on a LaTeX error', () => {
    const log = ['(main.tex', "! ! LaTeX Error: File `nosuch.sty' not found..", 'l.3 \\begin', ''].join('\n');
    expect(parseTectonicLog(log, '/proj', onDisk('main.tex'))[0].message).toBe("LaTeX Error: File `nosuch.sty' not found.");
  });

  it('leaves text in parentheses alone', () => {
    const log = ['(main.tex', '(see the transcript file for details)', '! Oops.', 'l.1 x', ''].join('\n');
    expect(parseTectonicLog(log, '/proj', onDisk('main.tex'))[0].file).toBe(path.resolve('/proj/main.tex'));
  });
});

describe('parseLog', () => {
  it('finds classic `!` errors with their line numbers', () => {
    const errors = parseLog(read('sample-errors.log'), fixtures).filter((e) => e.severity === 'error');
    expect(errors.map((e) => [e.message, e.line])).toEqual([
      ['Undefined control sequence.', 15],
      ['Missing $ inserted.', 22],
    ]);
    expect(errors[0].file).toBe(path.join(fixtures, 'main.tex'));
  });

  it('finds LaTeX and package warnings', () => {
    const warnings = parseLog(read('sample-warnings.log'), fixtures).filter((e) => e.severity === 'warning');
    expect(warnings.some((w) => w.message.includes("Reference `fig:unknown'") && w.line === 12)).toBe(true);
    expect(warnings.some((w) => w.message.startsWith('[hyperref]'))).toBe(true);
  });

  it('reports nothing for a clean log', () => {
    expect(parseLog(read('sample.log'), fixtures).filter((e) => e.severity === 'error')).toEqual([]);
  });

  it('parses -file-line-error output', () => {
    const log = [
      '(./main.tex',
      '(./chapters/intro.tex',
      './chapters/intro.tex:7: Undefined control sequence.',
      'l.7 \\foo',
      ')',
      ')',
    ].join('\n');
    const [error] = parseLog(log, '/proj');
    expect(error).toEqual({
      severity: 'error',
      message: 'Undefined control sequence.',
      file: path.resolve('/proj/chapters/intro.tex'),
      line: 7,
    });
  });

  it('joins multi-line package warnings and keeps the file through non-file parens', () => {
    const log = [
      '(./main.tex (see the transcript file for additional information)',
      'Package natbib Warning: Citation `foo\' on page 1 undefined on input line 9.',
      'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
      '(hyperref)                removing `math shift\' on input line 3.',
      ')',
    ].join('\n');
    const entries = parseLog(log, '/proj');
    expect(entries[0]).toMatchObject({ file: path.resolve('/proj/main.tex'), line: 9 });
    expect(entries[1].message).toBe("[hyperref] Token not allowed in a PDF string (Unicode): removing `math shift'");
    expect(entries[1].line).toBe(3);
  });

  it('reports box warnings as info', () => {
    const [entry] = parseLog('(./a.tex\nOverfull \\hbox (12.3pt too wide) in paragraph at lines 10--12\n)', '/p');
    expect(entry).toMatchObject({ severity: 'info', line: 10 });
  });
});

describe('parseBib', () => {
  it('reads keys and fields, including nested braces and bare numbers', () => {
    const entries = parseBib(read('project/refs.bib'));
    expect(entries).toEqual([
      {
        key: 'einstein1905',
        type: 'article',
        title: 'Zur Elektrodynamik bewegter K\\"orper',
        author: 'Albert Einstein',
        year: '1905',
        abstract: '',
        doi: '',
        line: 0,
        fields: { journal: 'Annalen der Physik' },
      },
    ]);
  });

  it('skips @string and @comment and handles several entries', () => {
    const entries = parseBib(read('sample.bib'));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.key && !['string', 'comment', 'preamble'].includes(e.type))).toBe(true);
  });
});

describe('synctex output', () => {
  it('takes the first record of `synctex view`', () => {
    const out = [
      'This is SyncTeX command line utility, version 1.5',
      'SyncTeX result begin',
      'Output:/p/main.pdf',
      'Page:2',
      'x:133.768356',
      'y:180.392975',
      'h:133.768356',
      'v:182.392975',
      'W:343.711060',
      'H:9.962640',
      'before:',
      'offset:0',
      'middle:',
      'after:',
      'Output:/p/main.pdf',
      'Page:3',
      'h:1',
      'v:2',
      'SyncTeX result end',
    ].join('\n');
    const rect = parseViewOutput(out)!;
    expect(rect.page).toBe(2);
    expect(rect.x).toBeCloseTo(133.768356);
    expect(rect.y).toBeCloseTo(182.392975 - 9.96264);
    expect(rect.width).toBeCloseTo(343.71106);
  });

  it('returns null when there is no record', () => {
    expect(parseViewOutput('SyncTeX result begin\nSyncTeX result end\n')).toBeNull();
  });

  it('resolves `synctex edit` input paths against the PDF directory', () => {
    const out = 'SyncTeX result begin\nOutput:main.pdf\nInput:./chapters/../chapters/intro.tex\nLine:3\nColumn:-1\nOffset:0\nContext:\nSyncTeX result end\n';
    expect(parseEditOutput(out, '/proj')).toEqual({ file: path.resolve('/proj/chapters/intro.tex'), line: 3, column: 0 });
  });
});

describe('findMainFile', () => {
  const project = path.join(fixtures, 'project');
  const intro = path.join(project, 'chapters', 'intro.tex');

  it('follows the % !TEX root magic comment', () => {
    expect(findMainFile({ workspaceRoot: project, active: { path: intro, text: read('project/chapters/intro.tex') } })).toBe(
      path.join(project, 'main.tex')
    );
  });

  it('prefers the configured main file', () => {
    expect(findMainFile({ workspaceRoot: project, configured: 'other.tex', active: { path: intro, text: '' } })).toBe(
      path.join(project, 'other.tex')
    );
  });

  it('searches the workspace for a \\documentclass when the active file is a fragment', () => {
    expect(findMainFile({ workspaceRoot: project, active: { path: intro, text: '\\section{x}' } })).toBe(path.join(project, 'main.tex'));
  });

  it('ignores a commented-out \\documentclass', () => {
    const file = '/tmp/frag.tex';
    expect(findMainFile({ active: { path: file, text: '% \\documentclass{article}\n\\section{x}' } })).toBe(file);
  });
});

describe('latexmkArgs', () => {
  it('maps the engine and always enables synctex, recorder and file:line errors', () => {
    expect(latexmkArgs('/p/main.tex', { tool: 'latexmk', latexmk: 'latexmk', tectonic: 'tectonic', docker: 'docker', dockerImage: 'texlive/texlive:latest', engine: 'xelatex', outDir: 'build', extraArgs: ['-shell-escape'] })).toEqual([
      '-pdfxe',
      '-interaction=nonstopmode',
      '-file-line-error',
      '-synctex=1',
      '-recorder',
      '-outdir=build',
      '-shell-escape',
      'main.tex',
    ]);
  });
});

describe('toWorkspacePath', () => {
  const real = (links: Record<string, string>) => (p: string) => links[p] ?? p;

  it('maps a symlink-resolved path back under the workspace folder', () => {
    const realpath = real({ '/var/proj': '/private/var/proj' });
    expect(toWorkspacePath('/private/var/proj/chapters/a.tex', ['/var/proj'], realpath)).toBe(
      path.join('/var/proj', 'chapters', 'a.tex')
    );
  });

  it('leaves paths alone when the folder is not a symlink or the file is outside it', () => {
    expect(toWorkspacePath('/home/me/proj/a.tex', ['/home/me/proj'], real({}))).toBe('/home/me/proj/a.tex');
    const realpath = real({ '/var/proj': '/private/var/proj' });
    expect(toWorkspacePath('/private/var/other/a.tex', ['/var/proj'], realpath)).toBe('/private/var/other/a.tex');
  });

  it('skips folders that no longer exist', () => {
    const realpath = (p: string) => {
      throw new Error(`ENOENT ${p}`);
    };
    expect(toWorkspacePath('/x/a.tex', ['/gone'], realpath)).toBe('/x/a.tex');
  });
});
