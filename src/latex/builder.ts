import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseAux } from './aux';
import { LogEntry, parseLog, parseTectonicLog } from './logParser';
import { withEngineHint } from './engineHint';
import { DEFAULT_LOOP_LIMITS, DEFAULT_STALL_TIMEOUT_SECONDS, LoopLimits, LoopWatch, loopMessage, silenceMessage } from './stall';

export type Engine = 'pdflatex' | 'xelatex' | 'lualatex';

/** What runs the build: latexmk on this machine, Tectonic, or latexmk inside a Docker image. */
export type BuildTool = 'latexmk' | 'tectonic' | 'docker';

export interface BuildSettings {
  tool: BuildTool;
  latexmk: string;
  tectonic: string;
  docker: string;
  dockerImage: string;
  engine: Engine;
  /** Relative to the main file's directory; '' means next to it. */
  outDir: string;
  extraArgs: string[];
  /** The workspace folder holding a path; Docker mounts it so that \input{../x} still resolves. */
  workspaceRoot?: (file: string) => string | undefined;
  /** Seconds without output before a build is stopped as stuck; 0 turns stall and loop detection off. */
  stallTimeout?: number;
}

export interface ToolCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** What a Docker command line depends on besides the settings. */
export interface DockerHost {
  platform: NodeJS.Platform;
  uid: number;
  gid: number;
}

export interface BuildResult {
  mainFile: string;
  success: boolean;
  cancelled: boolean;
  /** Present whenever a PDF exists after the build, even if TeX reported errors. */
  pdfFile: string | null;
  logFile: string;
  /** Recorder file listing every input TeX read; used by arXiv export. */
  flsFile: string;
  entries: LogEntry[];
  durationMs: number;
}

const ENGINE_FLAG: Record<Engine, string> = {
  pdflatex: '-pdf',
  xelatex: '-pdfxe',
  lualatex: '-pdflua',
};

// Stop TeX from wrapping log lines at 79 columns, which breaks log parsing.
export const TEX_ENV = { max_print_line: '10000', error_line: '254', half_error_line: '238' };

export function outputPaths(mainFile: string, outDir: string) {
  const dir = path.resolve(path.dirname(mainFile), outDir || '.');
  const base = path.basename(mainFile, path.extname(mainFile));
  return {
    dir,
    pdf: path.join(dir, `${base}.pdf`),
    log: path.join(dir, `${base}.log`),
    fls: path.join(dir, `${base}.fls`),
    aux: path.join(dir, `${base}.aux`),
  };
}

export function latexmkArgs(mainFile: string, settings: BuildSettings): string[] {
  const args = [
    ENGINE_FLAG[settings.engine],
    '-interaction=nonstopmode',
    '-file-line-error',
    '-synctex=1',
    '-recorder',
  ];
  if (settings.outDir) {
    args.push(`-outdir=${settings.outDir}`);
  }
  args.push(...settings.extraArgs, path.basename(mainFile));
  return args;
}

/** `input` is relative to the folder Tectonic runs in. It always uses XeTeX, so the engine setting does not apply. */
export function tectonicArgs(input: string, settings: BuildSettings): string[] {
  // --keep-intermediates keeps the .aux, which the reference hover reads numbers from.
  return ['-X', 'compile', '--synctex', '--keep-logs', '--keep-intermediates', ...(settings.outDir ? ['--outdir', settings.outDir] : []), ...settings.extraArgs, input];
}

/** What a Tectonic build leaves next to the PDF besides it: \include'd chapters write their own .aux. */
export function tectonicLeftovers(dir: string, base: string, mainAux: string): string[] {
  const files = TECTONIC_INTERMEDIATES.map((ext) => path.join(dir, base + ext));
  let text: string | undefined;
  try {
    text = fs.readFileSync(mainAux, 'latin1');
  } catch {
    // No build yet.
  }
  for (const input of text === undefined ? [] : parseAux(text).inputs) {
    const file = path.resolve(dir, input);
    const rel = path.relative(dir, file);
    // Only .aux files inside the output folder, whatever the .aux says.
    if (file.endsWith('.aux') && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
      files.push(file);
    }
  }
  return files;
}

const TECTONIC_INTERMEDIATES = ['.log', '.blg', '.synctex.gz', '.aux', '.toc', '.lof', '.lot', '.out', '.bbl', '.bcf', '.run.xml', '.nav', '.snm', '.vrb', '.idx', '.ind', '.ilg'];

/** The folder Docker mounts for a build running in `cwd`. */
export function dockerRoot(cwd: string, settings: BuildSettings): string {
  return settings.workspaceRoot?.(cwd) ?? cwd;
}

function thisHost(): DockerHost {
  const user = os.userInfo();
  return { platform: process.platform, uid: user.uid, gid: user.gid };
}

/**
 * Mounts `root` at its own path, so the paths in the log, the .fls and the SyncTeX data mean the
 * same on the host. A Windows path cannot exist in the container, so there it goes under /workspace.
 */
function containerPath(hostPath: string, root: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') {
    return hostPath;
  }
  const relative = path.win32.relative(root, hostPath).split('\\').join('/');
  return relative ? `/workspace/${relative}` : '/workspace';
}

function isInside(root: string, target: string, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const relative = p.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative);
}

/**
 * Runs latexmk in the image. TEX_ENV must be passed with -e: the environment of the docker command
 * itself does not reach the container. The network is off because a build only needs the mount.
 */
export function dockerCommand(cwd: string, root: string, latexmk: string[], settings: BuildSettings, host: DockerHost = thisHost()): ToolCommand {
  const args = ['run', '--rm', '--init', '--network', 'none'];
  // Docker Desktop maps file ownership itself; on Linux the outputs would otherwise belong to root.
  if (host.platform === 'linux') {
    args.push('--user', `${host.uid}:${host.gid}`);
  }
  args.push('-e', 'HOME=/tmp');
  for (const [name, value] of Object.entries(TEX_ENV)) {
    args.push('-e', `${name}=${value}`);
  }
  args.push('-v', `${root}:${containerPath(root, root, host.platform)}`, '-w', containerPath(cwd, root, host.platform));
  args.push(settings.dockerImage, 'latexmk', ...latexmk);
  return { command: settings.docker, args, env: process.env };
}

/** Why Docker cannot build this document, or undefined: output outside the mount would stay in the container. */
export function dockerOutDirProblem(mainFile: string, settings: BuildSettings, platform: NodeJS.Platform = process.platform): string | undefined {
  const cwd = path.dirname(mainFile);
  const root = dockerRoot(cwd, settings);
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (isInside(root, p.resolve(cwd, settings.outDir || '.'), platform)) {
    return undefined;
  }
  return `overtex.latex.outDir must stay inside ${root} when building with Docker, which only mounts that folder.`;
}

/** The outDir as latexmk in the container must see it. */
function dockerSettings(cwd: string, settings: BuildSettings, platform: NodeJS.Platform): BuildSettings {
  if (platform !== 'win32' || !settings.outDir) {
    return settings;
  }
  return { ...settings, outDir: path.win32.relative(cwd, path.win32.resolve(cwd, settings.outDir)).split('\\').join('/') || '.' };
}

/** The command that builds `mainFile`, run from the main file's folder. */
export function buildCommand(mainFile: string, settings: BuildSettings, host: DockerHost = thisHost()): ToolCommand {
  const env = { ...process.env, ...TEX_ENV };
  if (settings.tool === 'tectonic') {
    return { command: settings.tectonic, args: tectonicArgs(path.basename(mainFile), settings), env };
  }
  if (settings.tool === 'docker') {
    const cwd = path.dirname(mainFile);
    return dockerCommand(cwd, dockerRoot(cwd, settings), latexmkArgs(mainFile, dockerSettings(cwd, settings, host.platform)), settings, host);
  }
  return { command: settings.latexmk, args: latexmkArgs(mainFile, settings), env };
}

/** The setting that names the executable of a build tool. */
export function toolPathSetting(tool: BuildTool): string {
  return { latexmk: 'overtex.latex.latexmkPath', tectonic: 'overtex.tectonic.path', docker: 'overtex.docker.path' }[tool];
}

/** Docker's own failures: 125 it could not start the container, 126 and 127 it could not start the command in it. */
function dockerDidNotBuild(settings: BuildSettings, exitCode: number | null): boolean {
  return settings.tool === 'docker' && exitCode !== null && exitCode >= 125 && exitCode <= 127;
}

/** The line of a failed tool's stderr that says why; docker ends with a pointer to its --help. */
export function lastErrorLine(stderr: string): string | undefined {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Run 'docker"))
    .pop();
}

function failureMessage(settings: BuildSettings, exitCode: number | null, stderr: string): string | undefined {
  if (settings.tool === 'docker' && exitCode === 127) {
    return `The image "${settings.dockerImage}" has no latexmk. Set overtex.docker.image to one that does.`;
  }
  return lastErrorLine(stderr);
}

/**
 * Runs the build tool, one build at a time. A build requested while another is
 * running is coalesced into a single follow-up build of the latest request.
 */
export class Builder {
  private running: cp.ChildProcess | null = null;
  private cancelled = false;
  private current: Promise<BuildResult> | null = null;
  private queued: { mainFile: string; promise: Promise<BuildResult> } | null = null;

  constructor(
    private readonly settings: () => BuildSettings,
    private readonly onOutput: (text: string) => void = () => {},
    private readonly loopLimits: LoopLimits = DEFAULT_LOOP_LIMITS
  ) {}

  get isBuilding(): boolean {
    return this.current !== null;
  }

  build(mainFile: string): Promise<BuildResult> {
    if (!this.current) {
      return this.start(mainFile);
    }
    if (this.queued) {
      this.queued.mainFile = mainFile;
      return this.queued.promise;
    }
    const queued = { mainFile, promise: undefined as unknown as Promise<BuildResult> };
    queued.promise = this.current.then(() => {
      this.queued = null;
      return this.start(queued.mainFile);
    });
    this.queued = queued;
    return queued.promise;
  }

  cancel(): void {
    if (this.running?.pid) {
      this.cancelled = true;
      killTree(this.running.pid);
    }
  }

  async clean(mainFile: string): Promise<void> {
    const s = this.settings();
    if (s.tool === 'tectonic') {
      // Tectonic has no clean mode, and only what --keep-logs, --keep-intermediates and --synctex
      // ask for stays behind.
      const { dir, aux } = outputPaths(mainFile, s.outDir);
      for (const file of tectonicLeftovers(dir, path.basename(mainFile, path.extname(mainFile)), aux)) {
        fs.rmSync(file, { force: true });
      }
      return;
    }
    const cwd = path.dirname(mainFile);
    const args = ['-c', ...(s.outDir ? [`-outdir=${s.outDir}`] : []), path.basename(mainFile)];
    if (s.tool === 'docker' && dockerOutDirProblem(mainFile, s)) {
      return;
    }
    const command = s.tool === 'docker' ? dockerCommand(cwd, dockerRoot(cwd, s), args, s) : { command: s.latexmk, args };
    await new Promise<void>((resolve) => {
      cp.execFile(command.command, command.args, { cwd }, () => resolve());
    });
  }

  private start(mainFile: string): Promise<BuildResult> {
    const promise = this.run(mainFile).finally(() => {
      this.current = null;
    });
    this.current = promise;
    return promise;
  }

  private run(mainFile: string): Promise<BuildResult> {
    const settings = this.settings();
    const out = outputPaths(mainFile, settings.outDir);
    const cwd = path.dirname(mainFile);
    const startedAt = Date.now();
    this.cancelled = false;

    const failed = (message: string): BuildResult => ({
      mainFile,
      success: false,
      cancelled: false,
      pdfFile: fs.existsSync(out.pdf) ? out.pdf : null,
      logFile: out.log,
      flsFile: out.fls,
      entries: [{ severity: 'error', message, file: mainFile, line: 0 }],
      durationMs: Date.now() - startedAt,
    });
    const problem = settings.tool === 'docker' ? dockerOutDirProblem(mainFile, settings) : undefined;
    if (problem) {
      this.onOutput(`${problem}\n`);
      return Promise.resolve(failed(problem));
    }
    if (settings.tool === 'tectonic') {
      // --outdir must exist, and a log from an earlier build must not pass for this one's.
      fs.mkdirSync(out.dir, { recursive: true });
      fs.rmSync(out.log, { force: true });
    }

    const { command, args, env } = buildCommand(mainFile, settings);
    this.onOutput(`> ${command} ${args.join(' ')}\n`);

    return new Promise<BuildResult>((resolve) => {
      const proc = cp.spawn(command, args, {
        cwd,
        env,
        // Own process group on POSIX so cancel() can kill the engine latexmk spawned.
        detached: process.platform !== 'win32',
      });
      this.running = proc;

      // Stop a build that prints nothing for a long time or keeps printing the same lines.
      const timeout = settings.stallTimeout ?? DEFAULT_STALL_TIMEOUT_SECONDS;
      const watching = timeout > 0;
      const loops = new LoopWatch(this.loopLimits);
      let stalled: string | undefined;
      let silence: NodeJS.Timeout | undefined;
      const stop = (reason: string) => {
        if (stalled === undefined && !this.cancelled && proc.pid) {
          stalled = reason;
          clearTimeout(silence);
          killTree(proc.pid);
        }
      };
      // Docker may pull a large image first, with long quiet gaps; only time the build itself.
      let timing = settings.tool !== 'docker';
      const heard = (text: string, fromStdout: boolean) => {
        if (!watching || stalled !== undefined) {
          return;
        }
        timing ||= fromStdout || /Latexmk/.test(text);
        clearTimeout(silence);
        if (timing) {
          silence = setTimeout(() => stop(silenceMessage(timeout)), timeout * 1000);
        }
        const repeated = loops.feed(text, Date.now());
        if (repeated !== undefined) {
          stop(loopMessage(repeated));
        }
      };
      if (watching && timing) {
        silence = setTimeout(() => stop(silenceMessage(timeout)), timeout * 1000);
      }

      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => {
        const text = d.toString();
        this.onOutput(text);
        heard(text, true);
      });
      proc.stderr?.on('data', (d: Buffer) => {
        const text = d.toString();
        stderr = (stderr + text).slice(-4096);
        this.onOutput(text);
        heard(text, false);
      });

      const finish = (exitCode: number | null, spawnError?: Error) => {
        this.running = null;
        clearTimeout(silence);
        let entries: LogEntry[] = [];
        let logRead = false;
        // When Docker itself failed, the log on disk is from an earlier build.
        if (!spawnError && !dockerDidNotBuild(settings, exitCode)) {
          try {
            const log = fs.readFileSync(out.log, 'utf-8');
            entries = settings.tool === 'tectonic' ? parseTectonicLog(log, cwd) : parseLog(log, cwd);
            entries = withEngineHint(entries, log, settings.tool, settings.engine);
            logRead = true;
          } catch {
            // No log: the tool failed before TeX ran.
          }
        }
        if (spawnError) {
          entries = [{ severity: 'error', message: spawnErrorMessage(settings, command, spawnError), file: mainFile, line: 0 }];
        } else if (!logRead && exitCode !== 0 && !this.cancelled && stalled === undefined) {
          const message = failureMessage(settings, exitCode, stderr);
          entries = message ? [{ severity: 'error', message, file: mainFile, line: 0 }] : [];
        }
        if (stalled !== undefined) {
          // First, so the error notification names the reason rather than whatever the partial log holds.
          entries = [{ severity: 'error', message: stalled, file: mainFile, line: 0 }, ...entries];
        }
        const success = stalled === undefined && exitCode === 0 && !entries.some((e) => e.severity === 'error');
        const result: BuildResult = {
          mainFile,
          success,
          cancelled: this.cancelled,
          pdfFile: fs.existsSync(out.pdf) ? out.pdf : null,
          logFile: out.log,
          flsFile: out.fls,
          entries,
          durationMs: Date.now() - startedAt,
        };
        if (stalled !== undefined) {
          this.onOutput(`\n${stalled}\n`);
        }
        const outcome = this.cancelled ? 'Build cancelled' : stalled !== undefined ? 'Build stopped' : success ? 'Build succeeded' : 'Build failed';
        this.onOutput(`\n${outcome} in ${result.durationMs} ms\n`);
        resolve(result);
      };

      let settled = false;
      proc.on('error', (err) => {
        if (!settled) {
          settled = true;
          finish(null, err);
        }
      });
      proc.on('close', (code) => {
        if (!settled) {
          settled = true;
          finish(code);
        }
      });
    });
  }
}

const INSTALL_ADVICE: Record<BuildTool, string> = {
  latexmk: 'a TeX distribution (TeX Live, MacTeX or MiKTeX)',
  tectonic: 'Tectonic',
  docker: 'Docker',
};

function spawnErrorMessage(settings: BuildSettings, executable: string, err: Error): string {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    return `Could not run "${executable}". Install ${INSTALL_ADVICE[settings.tool]} or set ${toolPathSetting(settings.tool)}.`;
  }
  return `Could not run "${executable}": ${err.message}`;
}

/** Whether a build error says the build tool is not installed, as opposed to TeX reporting something. */
export function isToolMissingMessage(message: string): boolean {
  return /^Could not run ".*"\. Install /.test(message);
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      cp.execFile('taskkill', ['/pid', String(pid), '/T', '/F']);
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    // Already exited.
  }
}
