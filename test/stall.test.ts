import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Builder, BuildSettings } from '../src/latex/builder';
import { LoopWatch, loopMessage, silenceMessage } from '../src/latex/stall';

describe('LoopWatch', () => {
  const limits = { lines: 20, ms: 1000 };

  it('reports a line that keeps repeating for long enough', () => {
    const watch = new LoopWatch(limits);
    let found: string | undefined;
    for (let i = 0; i < 100 && !found; i++) {
      found = watch.feed('! Undefined control sequence.\n', i * 100);
    }
    expect(found).toBe('! Undefined control sequence.');
  });

  it('reports a repeating block of a few lines, ignoring blank lines', () => {
    const watch = new LoopWatch(limits);
    let found: string | undefined;
    for (let i = 0; i < 100 && !found; i++) {
      found = watch.feed('LaTeX Warning: Label(s) may have changed.\n\n(./main.aux)\n', i * 100);
    }
    expect(found).toBeDefined();
  });

  it('ignores a short burst of identical warnings', () => {
    const watch = new LoopWatch(limits);
    // Many repeats, but all within a moment: TeX does this legitimately.
    expect(watch.feed('Overfull \\hbox (1.0pt too wide)\n'.repeat(500), 0)).toBeUndefined();
    expect(watch.feed('[1] [2]\n', 50)).toBeUndefined();
  });

  it('ignores output that keeps changing', () => {
    const watch = new LoopWatch(limits);
    for (let i = 0; i < 1000; i++) {
      expect(watch.feed(`[${i}]\n`, i * 100)).toBeUndefined();
    }
  });

  it('joins lines split across chunks', () => {
    const watch = new LoopWatch({ lines: 3, ms: 0 });
    expect(watch.feed('loo', 0)).toBeUndefined();
    expect(watch.feed('p\nloop\nlo', 1)).toBeUndefined();
    expect(watch.feed('op\nloop\nloop\n', 2)).toBe('loop');
  });

  it('says why and how to change it', () => {
    expect(silenceMessage(300)).toContain('no output for 300 s');
    expect(silenceMessage(300)).toContain('overtex.build.stallTimeout');
    expect(loopMessage('x'.repeat(500)).length).toBeLessThan(250);
  });
});

// A fake latexmk: a shell script that ignores its arguments. POSIX only.
describe.skipIf(process.platform === 'win32')('Builder stops a stuck build', () => {
  const tmp = path.resolve(__dirname, '.tmp-stall');
  const main = path.join(tmp, 'main.tex');

  const fake = (name: string, body: string): string => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const settings = (latexmk: string, stallTimeout: number): BuildSettings => ({
    tool: 'latexmk',
    latexmk,
    tectonic: 'tectonic',
    docker: 'docker',
    dockerImage: 'texlive/texlive:latest',
    engine: 'pdflatex',
    outDir: '',
    extraArgs: [],
    stallTimeout,
  });

  beforeAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(main, '\\documentclass{article}\\begin{document}x\\end{document}\n');
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stops a build that goes silent and says why', async () => {
    const output: string[] = [];
    const result = await new Builder(() => settings(fake('silent.sh', 'echo start; sleep 30'), 1), (t) => output.push(t)).build(main);
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.entries[0].message).toBe(silenceMessage(1));
    expect(result.durationMs).toBeLessThan(10_000);
    expect(output.join('')).toContain('Build stopped');
  });

  it('stops a build that loops', async () => {
    const latexmk = fake('loop.sh', 'while :; do echo "! Same old error."; done');
    const result = await new Builder(() => settings(latexmk, 60), () => {}, { lines: 200, ms: 200 }).build(main);
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.entries[0].message).toBe(loopMessage('! Same old error.'));
  });

  it('lets a slow build that keeps talking finish', async () => {
    const latexmk = fake('slow.sh', 'for i in 1 2 3 4; do echo "pass $i"; sleep 0.5; done');
    const result = await new Builder(() => settings(latexmk, 1)).build(main);
    expect(result.success).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it('never stops a build when the timeout is 0', async () => {
    const result = await new Builder(() => settings(fake('quiet.sh', 'sleep 1.5'), 0), () => {}, { lines: 1, ms: 0 }).build(main);
    expect(result.success).toBe(true);
  });
});
