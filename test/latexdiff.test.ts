// The end of this file runs the real git, latexdiff and latexmk, and is skipped when they are not installed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuildSettings } from '../src/latex/builder';
import { CompareError, compareVersions, diffBuildArgs, hasDifferences, keepInSnapshot, latexdiffArgs, parseGitLog, parseLsTree, Version } from '../src/latex/latexdiff';

const settings: BuildSettings = { tool: 'latexmk', latexmk: 'latexmk', tectonic: 'tectonic', docker: 'docker', dockerImage: 'texlive/texlive:latest', engine: 'pdflatex', outDir: '', extraArgs: [] };

describe('arguments', () => {
  it('flattens, so that changes in \\input files are marked', () => {
    expect(latexdiffArgs('old.tex', 'new.tex')).toEqual(['--flatten', 'old.tex', 'new.tex']);
  });

  it('builds into the temporary folder through a relative path', () => {
    const args = diffBuildArgs('/p/overtex-diff-1/main-diff.tex', 'overtex-diff-1', { ...settings, engine: 'xelatex', outDir: 'ignored', extraArgs: ['-shell-escape'] });
    expect(args[0]).toBe('-f');
    expect(args).toContain('-pdfxe');
    expect(args).toContain('-outdir=overtex-diff-1');
    expect(args).toContain('-shell-escape');
    expect(args).not.toContain('-outdir=ignored');
    expect(args[args.length - 1]).toBe('overtex-diff-1/main-diff.tex');
  });
});

describe('hasDifferences', () => {
  it('ignores the macro definitions in the preamble', () => {
    const preamble = '\\providecommand{\\DIFaddbegin}{}\n\\providecommand{\\DIFdelbegin}{}\n\\begin{document}\n';
    expect(hasDifferences(`${preamble}Same text.\n\\end{document}`)).toBe(false);
    expect(hasDifferences(`${preamble}A \\DIFaddbegin \\DIFadd{word}\\DIFaddend.\n\\end{document}`)).toBe(true);
    expect(hasDifferences(`${preamble}\\DIFdelbegin \\DIFdel{gone}\\DIFdelend\n\\end{document}`)).toBe(true);
  });
});

describe('git output', () => {
  it('reads commits, including subjects with odd characters and no refs', () => {
    const log = 'aaaa\x1fa\x1f2026-01-02\x1fHEAD -> main, tag: v1\x1fFix: tab\there\nbbbb\x1fb\x1f2026-01-01\x1f\x1fFirst\n';
    expect(parseGitLog(log)).toEqual([
      { hash: 'aaaa', shortHash: 'a', date: '2026-01-02', refs: 'HEAD -> main, tag: v1', subject: 'Fix: tab\there' },
      { hash: 'bbbb', shortHash: 'b', date: '2026-01-01', refs: '', subject: 'First' },
    ]);
    expect(parseGitLog('')).toEqual([]);
  });

  it('lists only regular files with safe paths', () => {
    const tree = [
      '100644 blob 1111\tmain.tex',
      '100755 blob 2222\tchapters/my part.tex',
      '120000 blob 3333\tlink.tex',
      '160000 commit 4444\tvendor',
      '100644 blob 5555\t../evil.tex',
      '100644 blob 6666\t/abs.tex',
      '',
    ].join('\0');
    expect(parseLsTree(tree)).toEqual(['main.tex', 'chapters/my part.tex']);
  });
});

describe('keepInSnapshot', () => {
  it('keeps what latexdiff can \\input, or everything but the .bbl for a built snapshot', () => {
    expect(keepInSnapshot('ch/a.TEX', true)).toBe(true);
    expect(keepInSnapshot('fig.png', true)).toBe(false);
    expect(keepInSnapshot('refs.bib', true)).toBe(false);
    expect(keepInSnapshot('fig.png', false)).toBe(true);
    expect(keepInSnapshot('main.bbl', true)).toBe(false);
    expect(keepInSnapshot('main.bbl', false)).toBe(false);
  });
});

function installed(command: string, arg: string): boolean {
  try {
    cp.execFileSync(command, [arg], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasTools = installed('git', '--version') && installed('latexdiff', '--version') && installed('latexmk', '-v');

describe.skipIf(!hasTools)('compareVersions (real git, latexdiff and latexmk)', () => {
  let root: string;
  let main: string;
  let first: string;
  let second: string;

  const git = (...args: string[]) => cp.execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: root, encoding: 'utf-8' }).trim();
  const compare = (old: Version, next: Version) => compareVersions({ mainFile: main, old, new: next, latexdiff: 'latexdiff', build: settings });
  const source = (text: string) => `\\documentclass{article}\n\\begin{document}\n${text}\n\\input{chapters/part}\n\\end{document}\n`;

  function write(file: string, text: string): void {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-latexdiff-')));
    main = path.join(root, 'paper', 'main.tex');
    git('init', '-q');
    write('paper/main.tex', source('First version.'));
    write('paper/chapters/part.tex', 'Old chapter.\n');
    git('add', '.');
    git('commit', '-qm', 'one');
    first = git('rev-parse', 'HEAD');
    write('paper/main.tex', source('Second version.'));
    git('add', '.');
    git('commit', '-qm', 'two');
    second = git('rev-parse', 'HEAD');
    write('paper/chapters/part.tex', 'New chapter.\n');
  }, 60000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('marks changes between a commit and the files on disk, \\input files included', async () => {
    const result = await compare({ revision: first }, { file: main });
    if (result.status !== 'built') {
      throw new Error(`status: ${result.status}`);
    }
    expect(result.complete).toBe(true);
    expect(result.pdf).toBe(path.join(root, 'paper', 'main-diff.pdf'));
    expect(fs.existsSync(result.pdf)).toBe(true);
    // latexdiff groups neighbouring words in one mark, so these match inside it.
    expect(result.diffText).toMatch(/\\DIFdel\{[^}]*First/);
    expect(result.diffText).toMatch(/\\DIFdel\{[^}]*Old/);
    expect(result.diffText).toMatch(/\\DIFadd\{[^}]*New/);
    // Nothing left behind in the project but the PDF.
    expect(fs.readdirSync(path.dirname(main)).filter((f) => f.startsWith('overtex-diff-'))).toEqual([]);
  }, 120000);

  it('compares two commits', async () => {
    const result = await compare({ revision: first }, { revision: second });
    expect(result.status === 'built' && result.diffText).toContain('\\DIFadd{Second');
    expect(result.status === 'built' && result.diffText).not.toContain('New chapter');
  }, 120000);

  it('compares two files', async () => {
    const other = path.join(root, 'paper', 'draft.tex');
    fs.writeFileSync(other, source('Draft version.'));
    const result = await compare({ file: other }, { file: main });
    expect(result.status === 'built' && result.diffText).toContain('\\DIFdel{Draft');
    fs.rmSync(other);
  }, 120000);

  it('does not mark the bibliography as changed because one side has a .bbl', async () => {
    const bibSource = (text: string) => `\\documentclass{article}\n\\begin{document}\n${text} \\cite{k}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n`;
    const saved = fs.readFileSync(main);
    write('paper/refs.bib', '@misc{k, title = {T}, year = 2000}\n');
    write('paper/draft.tex', bibSource('Old words.'));
    write('paper/main.tex', bibSource('New words.'));
    write('paper/main.bbl', '\\begin{thebibliography}{1}\\bibitem{k} T.\\end{thebibliography}\n');
    const result = await compare({ file: path.join(root, 'paper', 'draft.tex') }, { file: main });
    if (result.status !== 'built') {
      throw new Error(`status: ${result.status}`);
    }
    expect(result.diffText).toContain('\\bibliography{refs}');
    expect(result.diffText).not.toContain('thebibliography');
    fs.writeFileSync(main, saved);
    for (const file of ['draft.tex', 'main.bbl', 'refs.bib']) {
      fs.rmSync(path.join(root, 'paper', file));
    }
  }, 120000);

  it('builds nothing when only comments changed', async () => {
    const other = path.join(root, 'paper', 'same.tex');
    fs.writeFileSync(other, `% a comment\n${fs.readFileSync(main, 'utf-8')}`);
    expect((await compare({ file: other }, { file: main })).status).toBe('identical');
    fs.rmSync(other);
  }, 60000);

  it('reports a revision without the main file', async () => {
    write('paper/late.tex', source('Late.'));
    const late = path.join(root, 'paper', 'late.tex');
    const err = await compareVersions({ mainFile: late, old: { revision: first }, new: { file: late }, latexdiff: 'latexdiff', build: settings }).catch((e) => e);
    expect(err).toBeInstanceOf(CompareError);
    expect((err as CompareError).kind).toBe('not-in-revision');
    fs.rmSync(late);
  }, 60000);

  // Windows short names (RUNNER~1) make the same mismatch between git's path and ours; this is
  // how to get one on a case-insensitive disk.
  it('finds the main file when its path is spelled differently from what git reports', async () => {
    const respelled = path.join(path.dirname(root), path.basename(root).toUpperCase(), 'paper', 'main.tex');
    if (!fs.existsSync(respelled)) {
      return;
    }
    const result = await compareVersions({ mainFile: respelled, old: { revision: first }, new: { revision: second }, latexdiff: 'latexdiff', build: settings });
    expect(result.status === 'built' && result.diffText).toContain('\\DIFadd{Second');
    const onDisk = await compareVersions({ mainFile: respelled, old: { file: respelled }, new: { file: main }, latexdiff: 'latexdiff', build: settings });
    expect(onDisk.status).toBe('identical');
  }, 120000);

  it('reports a missing latexdiff', async () => {
    const err = await compareVersions({ mainFile: main, old: { revision: first }, new: { file: main }, latexdiff: 'no-such-latexdiff', build: settings }).catch((e) => e);
    expect((err as CompareError).kind).toBe('latexdiff-missing');
  }, 60000);
});
