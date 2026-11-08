// Compares two versions of a document with latexdiff and builds the marked-up PDF. No vscode
// import, so it is unit-testable.
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuildSettings, TEX_ENV, latexmkArgs, outputPaths } from './builder';

/** A .tex file as it is on disk, or the main file as it was in a git revision. */
export type Version = { file: string } | { revision: string };

export interface CompareRequest {
  /** The document on disk; a revision is read at this file's path, and the PDF goes beside its build output. */
  mainFile: string;
  old: Version;
  new: Version;
  latexdiff: string;
  build: BuildSettings;
  signal?: AbortSignal;
  log?: (text: string) => void;
}

export type CompareResult =
  | { status: 'identical' }
  /** `complete` is false when TeX reported errors and the PDF may be missing something. */
  | { status: 'built'; pdf: string; complete: boolean; diffText: string };

export type CompareErrorKind = 'latexdiff-missing' | 'latexdiff-failed' | 'build-failed' | 'not-in-revision';

export class CompareError extends Error {
  constructor(
    readonly kind: CompareErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'CompareError';
  }
}

export interface Commit {
  hash: string;
  shortHash: string;
  date: string;
  subject: string;
  /** Branches and tags pointing at the commit, e.g. "HEAD -> main, tag: v0.2.1". */
  refs: string;
}

const LOG_FORMAT = '%H%x1f%h%x1f%ad%x1f%D%x1f%s';
const MAX_COMMITS = 100;

/** What latexdiff --flatten can pull in through \input and \include. */
const SOURCE_EXTENSIONS = new Set(['.tex', '.ltx', '.tikz', '.pgf', '.inc', '.txt']);
const SKIP_DIRS = new Set(['node_modules', 'out', 'build']);
const MAX_COPIED_FILES = 5000;
const MAX_COPIED_BYTES = 5 * 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;

export function latexdiffArgs(oldFile: string, newFile: string): string[] {
  return ['--flatten', oldFile, newFile];
}

/** latexdiff's preamble defines the \DIF macros, so only the body says whether anything was marked. */
export function hasDifferences(diffText: string): boolean {
  const body = diffText.indexOf('\\begin{document}');
  return /\\DIF(add|del)begin\b/.test(body < 0 ? diffText : diffText.slice(body));
}

export function parseGitLog(output: string): Commit[] {
  const commits: Commit[] = [];
  for (const line of output.split('\n')) {
    const [hash, shortHash, date, refs, subject] = line.split('\x1f');
    if (hash && subject !== undefined) {
      commits.push({ hash, shortHash, date, refs, subject });
    }
  }
  return commits;
}

/** The regular files in `git ls-tree -r -z` output; skips symlinks, submodules and unsafe paths. */
export function parseLsTree(output: string): string[] {
  const files: string[] = [];
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const [mode, type] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    const unsafe = file.startsWith('/') || file.split('/').includes('..');
    if (type === 'blob' && mode !== '120000' && !unsafe) {
      files.push(file);
    }
  }
  return files;
}

/**
 * Which files a snapshot keeps. A .bbl is never kept: latexdiff --flatten pastes one in place of
 * \bibliography, so a .bbl on only one side would mark the whole bibliography as changed.
 */
export function keepInSnapshot(file: string, sourcesOnly: boolean): boolean {
  const ext = path.extname(file).toLowerCase();
  return ext !== '.bbl' && (!sourcesOnly || SOURCE_EXTENSIONS.has(ext));
}

/** The latexmk command line for the diff, with paths relative to the folder it runs in. */
export function diffBuildArgs(texFile: string, buildDir: string, settings: BuildSettings): string[] {
  const args = latexmkArgs(texFile, { ...settings, outDir: buildDir });
  args.pop();
  // Carry on past TeX errors: deleted text can use a macro only the old preamble defined.
  return ['-f', ...args, `${buildDir}/${path.basename(texFile)}`];
}

function run(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; timeout?: number }): Promise<{ stdout: Buffer; stderr: string; failure?: cp.ExecFileException }> {
  return new Promise((resolve, reject) => {
    cp.execFile(command, args, { ...options, encoding: 'buffer', maxBuffer: MAX_OUTPUT_BYTES }, (err, stdout, stderr) => {
      if (err && (err.name === 'AbortError' || err.code === 'ENOENT')) {
        reject(err);
      } else {
        resolve({ stdout, stderr: stderr.toString('utf-8'), failure: err ?? undefined });
      }
    });
  });
}

async function git(args: string[], cwd: string, signal?: AbortSignal): Promise<Buffer | undefined> {
  try {
    const result = await run('git', args, { cwd, signal });
    return result.failure ? undefined : result.stdout;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw err;
    }
    return undefined;
  }
}

/** The repository holding `file`, or undefined when there is none or git is not installed. */
export async function gitRoot(file: string, signal?: AbortSignal): Promise<string | undefined> {
  const output = await git(['rev-parse', '--show-toplevel'], path.dirname(file), signal);
  const root = output?.toString('utf-8').trim();
  return root ? fs.realpathSync(root) : undefined;
}

/** Recent commits touching the folder of `file`, newest first. */
export async function listCommits(file: string): Promise<Commit[]> {
  const output = await git(['log', `-n${MAX_COMMITS}`, `--format=${LOG_FORMAT}`, '--date=short', '--', '.'], path.dirname(file));
  return output ? parseGitLog(output.toString('utf-8')) : [];
}

function write(target: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}

/** Writes a revision's files under `dest`. Returns where the main file landed. */
async function snapshotRevision(request: CompareRequest, revision: string, dest: string, sourcesOnly: boolean): Promise<string> {
  const notFound = new CompareError('not-in-revision', `${path.basename(request.mainFile)} is not in ${revision}.`);
  const main = fs.realpathSync(request.mainFile);
  const root = await gitRoot(main, request.signal);
  const tree = root && !revision.startsWith('-') ? await git(['ls-tree', '-r', '-z', revision], root, request.signal) : undefined;
  if (!root || !tree) {
    throw notFound;
  }
  const relMain = path.relative(root, main).split(path.sep).join('/');
  const files = parseLsTree(tree.toString('utf-8'));
  if (!files.includes(relMain)) {
    throw notFound;
  }
  for (const file of files) {
    if (file === relMain || keepInSnapshot(file, sourcesOnly)) {
      const data = await git(['show', `${revision}:${file}`], root, request.signal);
      if (data) {
        write(path.join(dest, file), data);
      }
    }
  }
  return path.join(dest, relMain);
}

/** Copies the sources around `file`, from its repository's root if it has one. Returns the copy of `file`. */
async function snapshotFile(file: string, dest: string, signal?: AbortSignal): Promise<string> {
  const real = fs.realpathSync(file);
  const root = (await gitRoot(real, signal)) ?? path.dirname(real);
  let copied = 0;
  const walk = (dir: string, depth: number): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
          walk(full, depth + 1);
        }
      } else if (entry.isFile() && copied < MAX_COPIED_FILES && keepInSnapshot(entry.name, true) && fs.statSync(full).size <= MAX_COPIED_BYTES) {
        write(path.join(dest, path.relative(root, full)), fs.readFileSync(full));
        copied++;
      }
    }
  };
  walk(root, 0);
  const copy = path.join(dest, path.relative(root, real));
  write(copy, fs.readFileSync(real));
  return copy;
}

function snapshot(request: CompareRequest, version: Version, dest: string, sourcesOnly: boolean): Promise<string> {
  return 'revision' in version ? snapshotRevision(request, version.revision, dest, sourcesOnly) : snapshotFile(version.file, dest, request.signal);
}

async function runLatexdiff(request: CompareRequest, oldFile: string, newFile: string, cwd: string): Promise<Buffer> {
  let result;
  try {
    result = await run(request.latexdiff, latexdiffArgs(oldFile, newFile), { cwd, signal: request.signal });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CompareError('latexdiff-missing', `could not run ${request.latexdiff}.`);
    }
    throw err;
  }
  request.log?.(result.stderr);
  if (result.failure) {
    throw new CompareError('latexdiff-failed', result.stderr.trim().split('\n').pop() || 'latexdiff failed.');
  }
  return result.stdout;
}

/**
 * Builds the diff from a temporary folder inside `cwd`, so that figures, the bibliography and
 * .latexmkrc are found as in a normal build and no absolute path reaches TeX.
 */
async function buildDiff(request: CompareRequest, diff: Buffer, cwd: string): Promise<{ pdf: string; complete: boolean }> {
  const base = `${path.basename(request.mainFile, path.extname(request.mainFile))}-diff`;
  const scratch = fs.mkdtempSync(path.join(cwd, 'overtex-diff-'));
  try {
    const tex = path.join(scratch, `${base}.tex`);
    fs.writeFileSync(tex, diff);
    const result = await run(request.build.latexmk, diffBuildArgs(tex, path.basename(scratch), request.build), {
      cwd,
      signal: request.signal,
      env: { ...process.env, ...TEX_ENV },
      timeout: BUILD_TIMEOUT_MS,
    });
    request.log?.(result.stdout.toString('utf-8') + result.stderr);
    const built = path.join(scratch, `${base}.pdf`);
    if (!fs.existsSync(built)) {
      throw new CompareError('build-failed', 'the marked-up document did not build.');
    }
    const outDir = outputPaths(request.mainFile, request.build.outDir).dir;
    fs.mkdirSync(outDir, { recursive: true });
    const pdf = path.join(outDir, `${base}.pdf`);
    fs.copyFileSync(built, pdf);
    return { pdf, complete: !result.failure };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Runs latexdiff on the two versions and, if they differ, builds `<main>-diff.pdf`. */
export async function compareVersions(request: CompareRequest): Promise<CompareResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-diff-'));
  try {
    const newIsRevision = 'revision' in request.new;
    const oldFile = await snapshot(request, request.old, path.join(tmp, 'old'), true);
    // A revision is built from its snapshot, so that one needs its figures and .bib files too.
    const newFile = await snapshot(request, request.new, path.join(tmp, 'new'), !newIsRevision);
    const diff = await runLatexdiff(request, oldFile, newFile, tmp);
    const diffText = diff.toString('utf-8');
    if (!hasDifferences(diffText)) {
      return { status: 'identical' };
    }
    const cwd = 'file' in request.new ? path.dirname(request.new.file) : path.dirname(newFile);
    return { status: 'built', diffText, ...(await buildDiff(request, diff, cwd)) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
