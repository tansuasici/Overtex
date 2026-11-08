import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LogEntry, parseLog } from './logParser';

export type Engine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface BuildSettings {
  latexmk: string;
  engine: Engine;
  /** Relative to the main file's directory; '' means next to it. */
  outDir: string;
  extraArgs: string[];
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

/**
 * Runs latexmk, one build at a time. A build requested while another is
 * running is coalesced into a single follow-up build of the latest request.
 */
export class Builder {
  private running: cp.ChildProcess | null = null;
  private cancelled = false;
  private current: Promise<BuildResult> | null = null;
  private queued: { mainFile: string; promise: Promise<BuildResult> } | null = null;

  constructor(
    private readonly settings: () => BuildSettings,
    private readonly onOutput: (text: string) => void = () => {}
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
    const args = ['-c', ...(s.outDir ? [`-outdir=${s.outDir}`] : []), path.basename(mainFile)];
    await new Promise<void>((resolve) => {
      cp.execFile(s.latexmk, args, { cwd: path.dirname(mainFile) }, () => resolve());
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
    const args = latexmkArgs(mainFile, settings);
    const startedAt = Date.now();
    this.cancelled = false;

    this.onOutput(`> ${settings.latexmk} ${args.join(' ')}\n`);

    return new Promise<BuildResult>((resolve) => {
      const proc = cp.spawn(settings.latexmk, args, {
        cwd,
        env: { ...process.env, ...TEX_ENV },
        // Own process group on POSIX so cancel() can kill the engine latexmk spawned.
        detached: process.platform !== 'win32',
      });
      this.running = proc;

      proc.stdout?.on('data', (d: Buffer) => this.onOutput(d.toString()));
      proc.stderr?.on('data', (d: Buffer) => this.onOutput(d.toString()));

      const finish = (exitCode: number | null, spawnError?: Error) => {
        this.running = null;
        let entries: LogEntry[] = [];
        if (!spawnError) {
          try {
            entries = parseLog(fs.readFileSync(out.log, 'utf-8'), cwd);
          } catch {
            // No log: latexmk failed before TeX ran.
          }
        }
        if (spawnError) {
          entries = [{ severity: 'error', message: spawnErrorMessage(settings.latexmk, spawnError), file: mainFile, line: 0 }];
        }
        const success = exitCode === 0 && !entries.some((e) => e.severity === 'error');
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
        this.onOutput(`\n${this.cancelled ? 'Build cancelled' : success ? 'Build succeeded' : 'Build failed'} in ${result.durationMs} ms\n`);
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

function spawnErrorMessage(executable: string, err: Error): string {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    return `Could not run "${executable}". Install a TeX distribution (TeX Live, MacTeX or MiKTeX) or set overtex.latex.latexmkPath.`;
  }
  return `Could not run "${executable}": ${err.message}`;
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
