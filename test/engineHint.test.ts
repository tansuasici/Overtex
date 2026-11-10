import { describe, expect, it } from 'vitest';
import { engineMismatchHint, undefinedPdfTeXCommand, withEngineHint } from '../src/latex/engineHint';
import { LogEntry } from '../src/latex/logParser';

// As XeLaTeX and LuaLaTeX log `\pdfoutput=1` on line 1 with -file-line-error.
const LOG = [
  './main.tex:1: Undefined control sequence.',
  'l.1 \\pdfoutput',
  '              =1',
  'The control sequence at the end of the top line',
  './main.tex:7: Undefined control sequence.',
  'l.7 Hello \\foo',
  '',
].join('\n');

const entries: LogEntry[] = [
  { severity: 'warning', message: 'Some warning', file: '/p/main.tex', line: 3 },
  { severity: 'error', message: 'Undefined control sequence.', file: '/p/main.tex', line: 7 },
  { severity: 'error', message: 'Undefined control sequence.', file: '/p/main.tex', line: 1 },
];

describe('engine mismatch hint', () => {
  it('finds the undefined pdfTeX command and its line', () => {
    expect(undefinedPdfTeXCommand(LOG)).toEqual({ command: '\\pdfoutput', line: 1 });
    expect(undefinedPdfTeXCommand('! Undefined control sequence.\nl.4 Hello \\pdfstrcmp\n')).toEqual({ command: '\\pdfstrcmp', line: 4 });
  });

  it('ignores other undefined commands', () => {
    expect(undefinedPdfTeXCommand('./main.tex:7: Undefined control sequence.\nl.7 Hello \\foo\n')).toBeUndefined();
    // \pdfoutput is not the undefined command here: \foo at the end of the line is.
    expect(undefinedPdfTeXCommand('! Undefined control sequence.\nl.2 \\pdfoutput=1 \\foo\n')).toBeUndefined();
  });

  it('suggests pdfLaTeX for XeLaTeX, LuaLaTeX and Tectonic but not pdfLaTeX', () => {
    expect(engineMismatchHint('\\pdfoutput', 'latexmk', 'xelatex')).toContain('XeLaTeX does not have');
    expect(engineMismatchHint('\\pdfoutput', 'docker', 'lualatex')).toContain('overtex.latex.engine to pdflatex');
    expect(engineMismatchHint('\\pdfoutput', 'tectonic', 'pdflatex')).toContain('overtex.latex.tool to latexmk');
    expect(engineMismatchHint('\\pdfoutput', 'latexmk', 'pdflatex')).toBeUndefined();
  });

  it('adds the hint to the matching error and puts it first', () => {
    const hinted = withEngineHint(entries, LOG, 'latexmk', 'xelatex');
    expect(hinted).toHaveLength(3);
    expect(hinted[0].line).toBe(1);
    expect(hinted[0].message).toMatch(/^Undefined control sequence\. \\pdfoutput is a pdfTeX command/);
    expect(hinted.slice(1)).toEqual(entries.slice(0, 2));
  });

  it('leaves the entries alone when there is nothing to advise', () => {
    expect(withEngineHint(entries, LOG, 'latexmk', 'pdflatex')).toBe(entries);
    expect(withEngineHint(entries, 'no errors', 'latexmk', 'xelatex')).toBe(entries);
  });
});
