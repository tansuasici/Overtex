// Runs the real latexmk and synctex. Skipped when no TeX distribution is installed (unless OVERTEX_REQUIRE_TEX is set).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Builder, BuildResult, BuildSettings } from '../src/latex/builder';
import { SyncTex } from '../src/synctex/synctex';

const hasTex = (() => {
  try {
    cp.execFileSync('latexmk', ['-v'], { stdio: 'ignore' });
    cp.execFileSync('synctex', ['help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const tmp = path.resolve(__dirname, '.tmp');
const settings: BuildSettings = { tool: 'latexmk', latexmk: 'latexmk', tectonic: 'tectonic', docker: 'docker', dockerImage: 'texlive/texlive:latest', engine: 'pdflatex', outDir: '', extraArgs: [] };

// CI sets OVERTEX_REQUIRE_TEX so a broken TeX install fails the run instead of silently skipping.
if (!hasTex && process.env.OVERTEX_REQUIRE_TEX) {
  throw new Error('OVERTEX_REQUIRE_TEX is set but latexmk/synctex are not on PATH.');
}

describe.skipIf(!hasTex)('build + synctex (real TeX)', () => {
  let result: BuildResult;
  const project = path.join(tmp, 'project');
  const main = path.join(project, 'main.tex');
  const intro = path.join(project, 'chapters', 'intro.tex');
  const synctex = new SyncTex(() => 'synctex');

  beforeAll(async () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(path.resolve(__dirname, 'fixtures'), tmp, { recursive: true });
    result = await new Builder(() => settings).build(main);
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('builds the PDF, synctex and recorder files, running BibTeX on the way', () => {
    expect(result.success).toBe(true);
    expect(result.pdfFile).toBe(path.join(project, 'main.pdf'));
    expect(fs.existsSync(path.join(project, 'main.synctex.gz'))).toBe(true);
    expect(fs.readFileSync(result.flsFile, 'utf-8')).toContain('chapters/intro.tex');
    expect(fs.existsSync(path.join(project, 'main.bbl'))).toBe(true);
    expect(result.entries.filter((e) => e.severity === 'error')).toEqual([]);
  });

  it('round-trips forward and inverse search through an \\input file', async () => {
    const target = await synctex.forward(result.pdfFile!, intro, 3, 0);
    expect(target).not.toBeNull();
    expect(target!.page).toBe(1);

    const source = await synctex.inverse(result.pdfFile!, target!.page, target!.x + target!.width / 2, target!.y + target!.height / 2);
    expect(source).not.toBeNull();
    expect(fs.realpathSync(source!.file)).toBe(fs.realpathSync(intro));
    expect(source!.line).toBe(3);
  });

  it('finds the main file in the PDF', async () => {
    const target = await synctex.forward(result.pdfFile!, main, 12, 0);
    expect(target).not.toBeNull();
    expect(target!.page).toBe(1);
  });

  it('finds the main file when another tool built with an absolute path', async () => {
    const other = path.join(tmp, 'other');
    fs.cpSync(project, other, { recursive: true });
    const otherMain = path.join(other, 'main.tex');
    cp.execFileSync('latexmk', ['-pdf', '-synctex=1', '-interaction=nonstopmode', otherMain], {
      cwd: other,
      stdio: 'ignore',
    });
    const target = await synctex.forward(path.join(other, 'main.pdf'), otherMain, 12, 0);
    expect(target).not.toBeNull();
    expect(target!.page).toBe(1);
  });

  it('reports errors with file and line, and still keeps a PDF', async () => {
    const broken = await new Builder(() => settings).build(path.join(tmp, 'broken.tex'));
    expect(broken.success).toBe(false);
    const error = broken.entries.find((e) => e.severity === 'error')!;
    expect(error.message).toContain('Undefined control sequence');
    expect(error.line).toBe(5);
    expect(fs.realpathSync(error.file)).toBe(fs.realpathSync(path.join(tmp, 'broken.tex')));
    expect(broken.pdfFile).not.toBeNull();
  });

  it('coalesces builds requested while one is running', async () => {
    let runs = 0;
    const builder = new Builder(() => settings, (text) => {
      if (text.startsWith('> latexmk')) {
        runs++;
      }
    });
    await Promise.all([builder.build(main), builder.build(main), builder.build(main), builder.build(main)]);
    expect(runs).toBe(2);
  });

  it('reports a missing latexmk instead of throwing', async () => {
    const missing = await new Builder(() => ({ ...settings, latexmk: 'definitely-not-latexmk' })).build(main);
    expect(missing.success).toBe(false);
    expect(missing.entries[0].message).toContain('Could not run');
  });
});
