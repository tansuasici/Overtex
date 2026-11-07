// Runs the real latexmk and synctex. Skipped when no TeX distribution is installed.
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
const settings: BuildSettings = { latexmk: 'latexmk', engine: 'pdflatex', outDir: '', extraArgs: [] };

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
