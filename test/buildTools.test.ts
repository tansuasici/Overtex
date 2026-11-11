import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuildSettings, Builder, DockerHost, buildCommand, dockerOutDirProblem, isToolMissingMessage, lastErrorLine, tectonicLeftovers, toolPathSetting } from '../src/latex/builder';
import { CompareError, compareVersions, diffCommand } from '../src/latex/latexdiff';

const base: BuildSettings = {
  tool: 'latexmk',
  latexmk: '/opt/latexmk',
  tectonic: '/opt/tectonic',
  docker: '/opt/docker',
  dockerImage: 'some/image:1',
  engine: 'pdflatex',
  outDir: '',
  extraArgs: [],
};
const mac: DockerHost = { platform: 'darwin', uid: 501, gid: 20 };
const linux: DockerHost = { platform: 'linux', uid: 1000, gid: 1001 };
const windows: DockerHost = { platform: 'win32', uid: -1, gid: -1 };

describe('buildCommand', () => {
  it('runs latexmk by default', () => {
    const { command, args, env } = buildCommand('/p/main.tex', base, mac);
    expect(command).toBe('/opt/latexmk');
    expect(args).toContain('-pdf');
    expect(args.at(-1)).toBe('main.tex');
    expect(env.max_print_line).toBe('10000');
  });

  it('runs tectonic with SyncTeX, a kept log and .aux, and no engine flag', () => {
    const { command, args, env } = buildCommand('/p/main.tex', { ...base, tool: 'tectonic', engine: 'lualatex', outDir: 'build', extraArgs: ['--print'] }, mac);
    expect(command).toBe('/opt/tectonic');
    expect(args).toEqual(['-X', 'compile', '--synctex', '--keep-logs', '--keep-intermediates', '--outdir', 'build', '--print', 'main.tex']);
    expect(env.max_print_line).toBe('10000');
  });

  it('cleans what Tectonic left, with the chapters \\include wrote, and nothing outside the output folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-tectonic-'));
    try {
      const aux = path.join(dir, 'main.aux');
      fs.writeFileSync(aux, '\\@input{ch/one.aux}\n\\@input{../escape.aux}\n\\@input{/etc/x.aux}\n\\@input{ch/notes.tex}\n');
      const files = tectonicLeftovers(dir, 'main', aux).map((f) => path.relative(dir, f));
      expect(files).toEqual(expect.arrayContaining(['main.aux', 'main.toc', 'main.log', 'main.synctex.gz', path.join('ch', 'one.aux')]));
      expect(files).not.toContain('main.pdf');
      expect(files.filter((f) => f.startsWith('..') || path.isAbsolute(f) || f.endsWith('.tex'))).toEqual([]);
      expect(tectonicLeftovers(dir, 'main', path.join(dir, 'none.aux'))).toHaveLength(17);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves --outdir out when there is no output directory', () => {
    expect(buildCommand('/p/main.tex', { ...base, tool: 'tectonic' }, mac).args).not.toContain('--outdir');
  });

  const docker: BuildSettings = { ...base, tool: 'docker', workspaceRoot: () => '/work' };

  it('mounts the workspace at its own path and works in the main file folder', () => {
    const { command, args } = buildCommand('/work/paper/main.tex', docker, mac);
    expect(command).toBe('/opt/docker');
    expect(args.slice(0, 5)).toEqual(['run', '--rm', '--init', '--network', 'none']);
    expect(args[args.indexOf('-v') + 1]).toBe('/work:/work');
    expect(args[args.indexOf('-w') + 1]).toBe('/work/paper');
    const image = args.indexOf('some/image:1');
    expect(args[image + 1]).toBe('latexmk');
    expect(args.at(-1)).toBe('main.tex');
    expect(args).toContain('-synctex=1');
  });

  it('passes the log settings into the container, where the parent environment does not reach', () => {
    const { args } = buildCommand('/work/main.tex', docker, mac);
    expect(args).toContain('max_print_line=10000');
    expect(args).toContain('HOME=/tmp');
    expect(args.indexOf('max_print_line=10000')).toBeLessThan(args.indexOf('some/image:1'));
  });

  it('mounts the main file folder when there is no workspace', () => {
    const { args } = buildCommand('/elsewhere/main.tex', { ...base, tool: 'docker' }, mac);
    expect(args[args.indexOf('-v') + 1]).toBe('/elsewhere:/elsewhere');
  });

  it('sets the user only on Linux, where outputs would otherwise belong to root', () => {
    expect(buildCommand('/work/main.tex', docker, mac).args).not.toContain('--user');
    const { args } = buildCommand('/work/main.tex', docker, linux);
    expect(args[args.indexOf('--user') + 1]).toBe('1000:1001');
  });

  it('mounts at /workspace on Windows, with forward slashes in the container', () => {
    const settings: BuildSettings = { ...base, tool: 'docker', workspaceRoot: () => 'C:\\work' };
    const main = 'C:\\work\\paper\\main.tex';
    // path.dirname is the host's, so give the command a cwd only a Windows host would compute.
    const { args } = buildCommand(process.platform === 'win32' ? main : 'C:\\work\\paper/main.tex', settings, windows);
    expect(args[args.indexOf('-v') + 1]).toBe('C:\\work:/workspace');
    expect(args[args.indexOf('-w') + 1]).toBe('/workspace/paper');
    expect(args).not.toContain('--user');
  });
});

describe('dockerOutDirProblem', () => {
  const docker: BuildSettings = { ...base, tool: 'docker', workspaceRoot: () => '/work' };

  it('accepts output inside the mount', () => {
    expect(dockerOutDirProblem('/work/paper/main.tex', docker, 'darwin')).toBeUndefined();
    expect(dockerOutDirProblem('/work/paper/main.tex', { ...docker, outDir: 'build' }, 'darwin')).toBeUndefined();
    expect(dockerOutDirProblem('/work/paper/main.tex', { ...docker, outDir: '../build' }, 'darwin')).toBeUndefined();
    expect(dockerOutDirProblem('/work/paper/main.tex', { ...docker, outDir: '..foo' }, 'darwin')).toBeUndefined();
  });

  it('rejects output the mount does not reach', () => {
    expect(dockerOutDirProblem('/work/main.tex', { ...docker, outDir: '../build' }, 'darwin')).toContain('/work');
    expect(dockerOutDirProblem('/work/main.tex', { ...docker, outDir: '/tmp/out' }, 'darwin')).toContain('overtex.latex.outDir');
  });
});

describe('diffCommand', () => {
  it('keeps going past TeX errors and finds project files from the folder below', () => {
    const { command, args } = diffCommand('/p/overtex-diff-1/main-diff.tex', 'overtex-diff-1', '/p', undefined, { ...base, tool: 'tectonic' });
    expect(command).toBe('/opt/tectonic');
    expect(args).toEqual(['-X', 'compile', '--synctex', '--keep-logs', '--keep-intermediates', '--outdir', 'overtex-diff-1', '-Z', 'continue-on-errors', '-Z', 'search-path=/p', 'overtex-diff-1/main-diff.tex']);
  });

  it('runs latexmk -f in the container, mounting the snapshot it is given', () => {
    const { command, args } = diffCommand('/tmp/s/new/overtex-diff-1/main-diff.tex', 'overtex-diff-1', '/tmp/s/new/paper', '/tmp/s/new', { ...base, tool: 'docker', workspaceRoot: () => '/work' }, mac);
    expect(command).toBe('/opt/docker');
    expect(args[args.indexOf('-w') + 1]).toBe('/tmp/s/new/paper');
    expect(args[args.indexOf('-v') + 1]).toBe('/tmp/s/new:/tmp/s/new');
    expect(args.slice(args.indexOf('latexmk'), args.indexOf('latexmk') + 2)).toEqual(['latexmk', '-f']);
    expect(args.at(-1)).toBe('overtex-diff-1/main-diff.tex');
  });

  it('mounts the snapshot at /workspace on Windows', () => {
    const { args } = diffCommand('C:\\s\\new\\overtex-diff-1\\main-diff.tex', 'overtex-diff-1', 'C:\\s\\new\\paper', 'C:\\s\\new', { ...base, tool: 'docker' }, windows);
    expect(args[args.indexOf('-v') + 1]).toBe('C:\\s\\new:/workspace');
    expect(args[args.indexOf('-w') + 1]).toBe('/workspace/paper');
  });

  it('runs latexmk on the host otherwise', () => {
    const { command, args } = diffCommand('/p/d/main-diff.tex', 'd', '/p', undefined, base);
    expect(command).toBe('/opt/latexmk');
    expect(args[0]).toBe('-f');
  });
});

describe('messages', () => {
  it('names the setting for each tool', () => {
    expect(toolPathSetting('latexmk')).toBe('overtex.latex.latexmkPath');
    expect(toolPathSetting('tectonic')).toBe('overtex.tectonic.path');
    expect(toolPathSetting('docker')).toBe('overtex.docker.path');
  });

  it('skips the pointer docker prints after its error', () => {
    const stderr = "docker: Error response from daemon: pull access denied.\n\nRun 'docker run --help' for more information\n";
    expect(lastErrorLine(stderr)).toBe('docker: Error response from daemon: pull access denied.');
    expect(lastErrorLine('\n\n')).toBeUndefined();
  });

  it('tells a missing tool from a TeX error that mentions running something', () => {
    expect(isToolMissingMessage('Could not run "docker". Install Docker or set overtex.docker.path.')).toBe(true);
    expect(isToolMissingMessage('Could not run "docker": permission denied')).toBe(false);
    expect(isToolMissingMessage('Undefined control sequence')).toBe(false);
  });
});

// The real spawn path, with a script standing in for the tool.
describe.skipIf(process.platform === 'win32')('Builder with a failing tool', () => {
  let dir: string;
  let main: string;

  /** A stand-in for docker or tectonic. */
  function stub(body: string): string {
    const file = path.join(dir, 'tool.sh');
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-tools-'));
    main = path.join(dir, 'main.tex');
    fs.writeFileSync(main, '\\documentclass{article}');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const staleLog = '! Stale error from the build before.\nl.1 x\n';

  it('reports a missing image rather than the log of an earlier build', async () => {
    fs.writeFileSync(path.join(dir, 'main.log'), staleLog);
    const docker = stub(`echo "docker: Error: pull access denied for nope." >&2\necho >&2\necho "Run 'docker run --help' for more information" >&2\nexit 125`);
    const result = await new Builder(() => ({ ...base, tool: 'docker', docker })).build(main);
    expect(result.success).toBe(false);
    expect(result.entries.map((e) => e.message)).toEqual(['docker: Error: pull access denied for nope.']);
  });

  it('says so when the image has no latexmk', async () => {
    fs.writeFileSync(path.join(dir, 'main.log'), staleLog);
    const docker = stub('echo "[FATAL tini (7)] exec latexmk failed: No such file or directory" >&2\nexit 127');
    const result = await new Builder(() => ({ ...base, tool: 'docker', docker })).build(main);
    expect(result.entries.map((e) => e.message)).toEqual(['The image "some/image:1" has no latexmk. Set overtex.docker.image to one that does.']);
  });

  it('reads the log when TeX ran in the container and failed', async () => {
    const log = './main.tex:1: Undefined control sequence.\n';
    const docker = stub(`printf '%s' '${log}' > main.log\nexit 12`);
    const result = await new Builder(() => ({ ...base, tool: 'docker', docker })).build(main);
    expect(result.success).toBe(false);
    expect(result.entries.some((e) => e.message.includes('Undefined control sequence'))).toBe(true);
  });

  it('does not take an old log for a Tectonic failure that wrote none', async () => {
    fs.writeFileSync(path.join(dir, 'main.log'), staleLog);
    const tectonic = stub('echo "error: failed to download a bundle file" >&2\nexit 1');
    const result = await new Builder(() => ({ ...base, tool: 'tectonic', tectonic })).build(main);
    expect(result.success).toBe(false);
    expect(result.entries.map((e) => e.message)).toEqual(['error: failed to download a bundle file']);
  });

  it('creates the output directory Tectonic is told to use', async () => {
    const tectonic = stub('touch build/main.pdf');
    const result = await new Builder(() => ({ ...base, tool: 'tectonic', tectonic, outDir: 'build' })).build(main);
    expect(result.success).toBe(true);
    expect(result.pdfFile).toBe(path.join(dir, 'build', 'main.pdf'));
  });

  it('says what to install when the tool is not there', async () => {
    const result = await new Builder(() => ({ ...base, tool: 'tectonic', tectonic: path.join(dir, 'nope') })).build(main);
    expect(result.success).toBe(false);
    expect(isToolMissingMessage(result.entries[0].message)).toBe(true);
    expect(result.entries[0].message).toContain('overtex.tectonic.path');
  });

  it('refuses a Docker build whose output would stay in the container', async () => {
    const docker = stub('touch ran');
    const result = await new Builder(() => ({ ...base, tool: 'docker', docker, outDir: '../elsewhere' })).build(main);
    expect(result.success).toBe(false);
    expect(result.entries[0].message).toContain('overtex.latex.outDir');
    expect(fs.existsSync(path.join(dir, 'ran'))).toBe(false);
  });

  it('removes only what Tectonic leaves behind on clean', async () => {
    for (const name of ['main.log', 'main.synctex.gz', 'main.pdf']) {
      fs.writeFileSync(path.join(dir, name), '');
    }
    await new Builder(() => ({ ...base, tool: 'tectonic' })).clean(main);
    expect(fs.existsSync(path.join(dir, 'main.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'main.synctex.gz'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'main.pdf'))).toBe(true);
    expect(fs.existsSync(main)).toBe(true);
  });

  it('gives Compare Versions a build failure when the tool is missing', async () => {
    const latexdiff = stub('echo "\\\\begin{document}\\\\DIFaddbegin x\\\\end{document}"');
    const other = path.join(dir, 'old.tex');
    fs.writeFileSync(other, '\\documentclass{article}');
    const error = await compareVersions({
      mainFile: main,
      old: { file: other },
      new: { file: main },
      latexdiff,
      build: { ...base, tool: 'docker', docker: path.join(dir, 'nope') },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompareError);
    expect((error as CompareError).kind).toBe('build-failed');
    expect((error as CompareError).message).toContain('could not run');
  });
});
