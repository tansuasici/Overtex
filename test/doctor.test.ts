import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DoctorFinding,
  diagnose,
  doctorMessage,
  formatDoctor,
  installCommand,
  kernelDate,
  linenoLogWarning,
  linenoMisplacesNumbers,
  linenoVersion,
  loadRequests,
  texLivePackage,
} from '../src/latex/doctor';

const ROOT = path.resolve('/proj');
const at = (rel: string) => path.join(ROOT, rel);
const TEXMF = '/usr/local/texlive/2026/texmf-dist';

/** A fake TeX: `installed` files resolve under TEXMF, project files relative to the project folder. */
function fakeTex(files: Record<string, string>, installed: string[], texmf: Record<string, string> = {}) {
  const lookups: string[][] = [];
  // Keys are written with '/'; on Windows paths come back with '\\' and a drive letter, so compare resolved.
  const installedFiles = new Map(Object.entries(texmf).map(([k, v]) => [path.resolve(k), v]));
  const read = (file: string) => files[path.relative(ROOT, file).split(path.sep).join('/')] ?? installedFiles.get(path.resolve(file));
  const lookup = async (names: string[]) => {
    lookups.push(names);
    return names.flatMap((n) => {
      if (files[n] !== undefined) {
        return [`./${n}`];
      }
      return installed.includes(n) ? [`${TEXMF}/tex/${n}`] : [];
    });
  };
  return { read, lookup, lookups };
}

describe('load requests', () => {
  it('finds packages and classes with options, lists and multi-line options, without comments', () => {
    const tex = [
      '\\documentclass[11pt]{article}',
      '\\usepackage{amsmath, amssymb}',
      '% \\usepackage{commented}',
      '\\usepackage[',
      '  margin=1in',
      ']{geometry}',
      '\\RequirePackage{xcolor}\\LoadClassWithOptions{report}',
      '\\usepackage{\\mypkg} \\usepackage{#1} \\usepackage{-evil}',
    ].join('\n');
    expect(loadRequests(tex, '/p/main.tex', false).map((r) => `${r.name}@${r.line}`)).toEqual([
      'article.cls@1',
      'amsmath.sty@2',
      'amssymb.sty@2',
      'geometry.sty@4',
      'xcolor.sty@7',
      'report.cls@7',
    ]);
  });

  it('keeps an escaped percent sign as text', () => {
    expect(loadRequests('50\\% \\usepackage{siunitx}', 'f', false).map((r) => r.name)).toEqual(['siunitx.sty']);
  });
});

describe('diagnose', () => {
  it('reports a missing package where it is loaded, and the command to install it', async () => {
    const tex = fakeTex(
      { 'main.tex': '\\documentclass{article}\n\\usepackage{amsmath}\n\\input{sections/intro}\n', 'sections/intro.tex': '\n\\usepackage{algorithmic}\n' },
      ['article.cls', 'amsmath.sty']
    );
    const report = await diagnose({ mainFile: at('main.tex'), engine: 'pdflatex', read: tex.read, lookup: tex.lookup });
    expect(report.findings).toEqual([
      {
        severity: 'error',
        message: `algorithmic.sty is not installed: the package loaded at ${path.join('sections', 'intro.tex')}:2.`,
        file: at('sections/intro.tex'),
        line: 2,
        install: 'algorithms',
      },
    ]);
    expect(report.install).toEqual(['algorithms']);
    expect(report.checked).toBe(3);
    // One batched lookup for the project, with lineno and the kernel checked alongside.
    expect(tex.lookups[0]).toEqual(['article.cls', 'amsmath.sty', 'algorithmic.sty', 'lineno.sty', 'latex.ltx']);
  });

  it('follows a conference class shipped with the project, softly', async () => {
    const tex = fakeTex(
      {
        'main.tex': '\\documentclass{confpaper}\n\\begin{document}\n',
        'confpaper.cls': '\\LoadClass{article}\n\\RequirePackage{times}\n\\ifxetex\\else\\RequirePackage{microtype}\\fi\n',
      },
      ['article.cls', 'times.sty', 'ptmr8t.tfm']
    );
    const report = await diagnose({ mainFile: at('main.tex'), engine: 'pdflatex', read: tex.read, lookup: tex.lookup });
    expect(report.findings.map((f) => [f.severity, f.message])).toEqual([
      ['warning', 'microtype.sty is not installed. confpaper.cls:3 asks for it, maybe only in some cases.'],
    ]);
  });

  it('checks the Times metrics once times.sty is found, only for pdfLaTeX', async () => {
    const files = { 'main.tex': '\\documentclass{article}\n\\usepackage{mathptmx}\n\\usepackage{times}\n' };
    const tex = fakeTex(files, ['article.cls', 'times.sty', 'mathptmx.sty']);
    const pdf = await diagnose({ mainFile: at('main.tex'), engine: 'pdflatex', read: tex.read, lookup: tex.lookup });
    expect(pdf.findings).toHaveLength(1);
    expect(pdf.findings[0].message).toContain('ptmr8t.tfm');
    expect(pdf.install).toEqual(['times']);

    const xe = fakeTex(files, ['article.cls', 'times.sty', 'mathptmx.sty']);
    expect((await diagnose({ mainFile: at('main.tex'), engine: 'xelatex', read: xe.read, lookup: xe.lookup })).findings).toEqual([]);
  });

  it('warns about lineno 5.7 on a kernel from 2025-06 on', async () => {
    const texmf = (version: string, kernel: string) => ({
      [`${TEXMF}/tex/lineno.sty`]: `\\def\\fileversion{v${version}}  \\def\\filedate{2026/01/01}\n`,
      [`${TEXMF}/tex/latex.ltx`]: `\\def\\fmtname{LaTeX2e}\n\\edef\\fmtversion\n   {${kernel}}\n`,
    });
    const run = async (version: string, kernel: string) => {
      const tex = fakeTex({ 'main.tex': '\\documentclass{article}\n' }, ['article.cls', 'lineno.sty', 'latex.ltx'], texmf(version, kernel));
      return (await diagnose({ mainFile: at('main.tex'), engine: 'pdflatex', read: tex.read, lookup: tex.lookup })).findings;
    };
    expect((await run('5.7', '2025-11-01')).map((f) => f.message.slice(0, 22))).toEqual(['lineno 5.7 is installe']);
    expect(await run('5.9', '2025-11-01')).toEqual([]);
    expect(await run('5.7', '2024-11-01')).toEqual([]);
  });

  it('says nothing about lineno it cannot read a version from', async () => {
    const tex = fakeTex({ 'main.tex': '\\documentclass{article}\n' }, ['article.cls', 'lineno.sty', 'latex.ltx'], {
      [`${TEXMF}/tex/lineno.sty`]: '\\ProvidesPackage{lineno}\n',
      [`${TEXMF}/tex/latex.ltx`]: '\\edef\\fmtversion\n   {2026-06-01}\n',
    });
    expect((await diagnose({ mainFile: at('main.tex'), engine: 'pdflatex', read: tex.read, lookup: tex.lookup })).findings).toEqual([]);
  });
});

describe('lineno versions', () => {
  it('reads the header and the kernel date across lines', () => {
    expect(linenoVersion('\\def\\fileversion{v5.4}  \\def\\filedate{2025/01/29}')).toBe('5.4');
    expect(kernelDate('\\edef\\fmtversion\n   {2024-11-01}\n')).toEqual([2024, 11]);
  });

  it('flags exactly 5.7 from June 2025 on', () => {
    expect(linenoMisplacesNumbers('5.7', [2025, 6])).toBe(true);
    expect(linenoMisplacesNumbers('5.7', [2026, 1])).toBe(true);
    expect(linenoMisplacesNumbers('5.7', [2025, 5])).toBe(false);
    expect(linenoMisplacesNumbers('5.75', [2026, 1])).toBe(false);
    expect(linenoMisplacesNumbers('5.9', [2026, 1])).toBe(false);
  });

  it('reads the build log', () => {
    // The shape of a real log (TeX Live 2025): the version comes last on lineno's line.
    const log = (kernel: string, lineno: string) =>
      `LaTeX2e <${kernel}> patch level 2\nL3 programming layer <2026-01-01>\n(lineno.sty\nPackage: lineno ${lineno.replace(/ (v[\d.]+)$/, ' line numbers on paragraphs $1')}\n)\n`;
    expect(linenoLogWarning(log('2026-06-01', '2026/02/16 v5.7'))).toContain('tlmgr update lineno');
    expect(linenoLogWarning(log('2026-06-01', '2026/03/08 v5.9'))).toBeUndefined();
    expect(linenoLogWarning(log('2025-02-01', '2026/02/16 v5.7'))).toBeUndefined();
    expect(linenoLogWarning('LaTeX2e <2024-11-01> patch level 2\nPackage: lineno 2025/01/29 line numbers on paragraphs v5.4\n')).toBeUndefined();
    expect(linenoLogWarning('LaTeX2e <2026-06-01>\nPackage: amsmath 2025/07/09 v2.17z AMS math features\n')).toBeUndefined();
  });
});

describe('install advice', () => {
  it('maps files to TeX Live packages', () => {
    expect(texLivePackage('mathptmx.sty')).toBe('psnfss');
    expect(texLivePackage('acmart.cls')).toBe('acmart');
  });

  it('types sudo only for MacTeX', () => {
    expect(installCommand(['newtx', 'caption'], 'darwin')).toBe('sudo tlmgr install newtx caption');
    expect(installCommand(['newtx'], 'linux')).toBe('tlmgr install newtx');
    expect(installCommand([], 'linux')).toBeUndefined();
  });

  it('formats a clean report', () => {
    expect(formatDoctor({ checked: 4, findings: [], install: [] }, '/p/main.tex', 'linux')).toBe(
      'Packages for main.tex: 4 looked up.\n  Everything the project loads is installed.\n'
    );
  });
});

describe('notification message', () => {
  const err = (install?: string) => ({ severity: 'error' as const, message: '', install });
  const warn = (install?: string) => ({ severity: 'warning' as const, message: '', install });
  const report = (findings: DoctorFinding[], install: string[]) => ({ checked: 9, findings, install });

  it('counts surely missing packages', () => {
    expect(doctorMessage(report([err('a')], ['a']), 'main.tex')).toBe('Overtex: 1 package that main.tex loads is not installed.');
    expect(doctorMessage(report([err('a'), err('b')], ['a', 'b']), 'main.tex')).toBe(
      'Overtex: 2 packages that main.tex loads are not installed.'
    );
  });

  it('says how many the install command covers when some may only be needed', () => {
    expect(doctorMessage(report([err('a'), err('b'), warn('c')], ['a', 'b', 'c']), 'main.tex')).toBe(
      'Overtex: 2 packages that main.tex loads are not installed and 1 more may be needed. Install in Terminal… types one command for all 3.'
    );
    expect(doctorMessage(report([warn('c')], ['c']), 'paper.tex')).toBe('Overtex: 1 package that paper.tex may need is not installed.');
  });

  it('lists problems that are not packages to install', () => {
    expect(doctorMessage(report([warn()], []), 'main.tex')).toBe('Overtex: 1 possible problem with the TeX packages for main.tex.');
    expect(doctorMessage(report([err('a'), warn('c'), warn()], ['a', 'c']), 'main.tex')).toBe(
      'Overtex: 1 package that main.tex loads is not installed, 1 more may be needed and 1 other possible problem. Install in Terminal… types one command for both.'
    );
  });
});
