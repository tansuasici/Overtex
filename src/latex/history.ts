// Project history: snapshots of a document's sources, and its PDF, taken after each successful
// build. Files are stored once by content hash, so an unchanged chapter costs nothing per
// snapshot. No vscode import, so it is unit-testable.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** What a snapshot keeps: the files a build reads as text. Figures are left out; they are large and rarely edited. */
const SOURCE_EXTENSIONS = new Set(['.tex', '.ltx', '.bib', '.sty', '.cls', '.bst', '.tikz', '.pgf', '.inc']);
const SKIP_DIRS = new Set(['node_modules', 'out', 'build']);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_DEPTH = 8;
const INDEX = 'index.json';

export interface SnapshotFile {
  /** Relative to the snapshot's root, with forward slashes. */
  path: string;
  hash: string;
}

export interface Snapshot {
  id: string;
  /** Milliseconds since the epoch. */
  time: number;
  /** The main file, relative to the root. */
  main: string;
  files: SnapshotFile[];
  /** The PDF's hash, when one was kept. */
  pdf?: string;
  /** A name the user gave it; named snapshots are never pruned. */
  label?: string;
  trigger: 'build' | 'manual';
}

export interface RecordOptions {
  mainFile: string;
  /** The build's PDF, if it should be kept with the sources. */
  pdfFile?: string | null;
  trigger: Snapshot['trigger'];
  /** How many unnamed snapshots to keep; older ones are removed. */
  keep: number;
  /** The build output folder, left out of the snapshot. Absolute. */
  outDir?: string;
  time?: number;
}

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface FileChange {
  path: string;
  kind: ChangeKind;
  /** The file in the snapshot; for a deleted file, in the snapshot before. */
  hash: string;
}

/** The folder a project's history lives in, under `storage`; one per main file. */
export function historyDir(storage: string, mainFile: string): string {
  const key = crypto.createHash('sha256').update(path.resolve(mainFile)).digest('hex').slice(0, 16);
  return path.join(storage, 'history', key);
}

function hashOf(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * The source files under `root`, relative and sorted. Hidden folders, build output and the
 * scratch folders Compare Versions makes are skipped.
 */
export function collectSources(root: string, outDir?: string): string[] {
  const found: string[] = [];
  const skip = outDir && path.resolve(outDir) !== path.resolve(root) ? path.resolve(outDir) : undefined;
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) {
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const skipped = entry.name.startsWith('.') || entry.name.startsWith('overtex-diff-') || SKIP_DIRS.has(entry.name) || full === skip;
        if (depth < MAX_DEPTH && !skipped) {
          walk(full, depth + 1);
        }
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(root, 0);
  return found.sort();
}

/** What changed from `before` to `after`, sorted by path. Everything is added when there is no `before`. */
export function changesBetween(before: Snapshot | undefined, after: Snapshot): FileChange[] {
  const old = new Map((before?.files ?? []).map((f) => [f.path, f.hash]));
  const changes: FileChange[] = [];
  for (const f of after.files) {
    const prev = old.get(f.path);
    if (prev === undefined) {
      changes.push({ path: f.path, kind: 'added', hash: f.hash });
    } else if (prev !== f.hash) {
      changes.push({ path: f.path, kind: 'modified', hash: f.hash });
    }
    old.delete(f.path);
  }
  for (const [p, hash] of old) {
    changes.push({ path: p, kind: 'deleted', hash });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function sameFiles(a: SnapshotFile[], b: SnapshotFile[]): boolean {
  return a.length === b.length && a.every((f, i) => f.path === b[i].path && f.hash === b[i].hash);
}

/** The snapshots left after dropping unnamed ones past the newest `keep`. Named ones always stay. */
export function prune(snapshots: Snapshot[], keep: number): Snapshot[] {
  let unnamed = 0;
  return snapshots.filter((s) => s.label !== undefined || ++unnamed <= Math.max(keep, 1));
}

/**
 * The snapshots of one document, in a folder of its own: `index.json` lists them, newest first,
 * and `blobs/` holds each file's contents under its hash.
 */
export class HistoryStore {
  constructor(readonly dir: string) {}

  list(): Snapshot[] {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.dir, INDEX), 'utf8')) as { snapshots?: Snapshot[] };
      return Array.isArray(data.snapshots) ? data.snapshots : [];
    } catch {
      return [];
    }
  }

  get(id: string): Snapshot | undefined {
    return this.list().find((s) => s.id === id);
  }

  /** The snapshot taken before `snapshot`, which its changes are measured against. */
  previous(snapshot: Snapshot): Snapshot | undefined {
    const all = this.list();
    const i = all.findIndex((s) => s.id === snapshot.id);
    return i < 0 ? undefined : all[i + 1];
  }

  blobPath(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`not a snapshot hash: ${hash}`);
    }
    return path.join(this.dir, 'blobs', hash.slice(0, 2), hash);
  }

  read(hash: string): Buffer {
    return fs.readFileSync(this.blobPath(hash));
  }

  /**
   * Takes a snapshot of the sources in the main file's folder. Returns undefined when they are as
   * in the newest snapshot, or when there is nothing to keep.
   */
  record(options: RecordOptions): Snapshot | undefined {
    const root = path.dirname(options.mainFile);
    const main = path.basename(options.mainFile);
    const files: SnapshotFile[] = [];
    for (const rel of collectSources(root, options.outDir)) {
      const full = path.join(root, rel);
      let data: Buffer;
      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) {
          continue;
        }
        data = fs.readFileSync(full);
      } catch {
        continue;
      }
      files.push({ path: rel, hash: this.store(data) });
    }
    if (!files.some((f) => f.path === main)) {
      return undefined;
    }

    const snapshots = this.list();
    const latest = snapshots[0];
    const pdf = this.storePdf(options.pdfFile);
    if (latest && latest.main === main && sameFiles(latest.files, files)) {
      // Same sources, built again: keep the newest PDF with the snapshot that has them.
      if (pdf && latest.pdf !== pdf) {
        latest.pdf = pdf;
        this.save(snapshots);
        this.collect(snapshots);
      }
      return undefined;
    }
    const time = options.time ?? Date.now();
    const snapshot: Snapshot = { id: `${time.toString(36)}-${crypto.randomBytes(3).toString('hex')}`, time, main, files, trigger: options.trigger };
    if (pdf) {
      snapshot.pdf = pdf;
    }
    const kept = prune([snapshot, ...snapshots], options.keep);
    this.save(kept);
    if (kept.length !== snapshots.length + 1) {
      this.collect(kept);
    }
    return snapshot;
  }

  /** Names a snapshot, or clears its name when `label` is empty. */
  setLabel(id: string, label: string): void {
    const snapshots = this.list();
    const s = snapshots.find((x) => x.id === id);
    if (!s) {
      return;
    }
    const trimmed = label.trim();
    if (trimmed) {
      s.label = trimmed;
    } else {
      delete s.label;
    }
    this.save(snapshots);
  }

  remove(id: string): void {
    const snapshots = this.list().filter((s) => s.id !== id);
    this.save(snapshots);
    this.collect(snapshots);
  }

  /** Writes a snapshot's sources under `dest`. Returns where the main file landed. */
  materialize(snapshot: Snapshot, dest: string): string {
    for (const f of snapshot.files) {
      const target = path.join(dest, ...f.path.split('/'));
      if (!path.resolve(target).startsWith(path.resolve(dest) + path.sep)) {
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, this.read(f.hash));
    }
    return path.join(dest, snapshot.main);
  }

  private store(data: Buffer): string {
    const hash = hashOf(data);
    const blob = this.blobPath(hash);
    if (!fs.existsSync(blob)) {
      fs.mkdirSync(path.dirname(blob), { recursive: true });
      const tmp = `${blob}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, blob);
    }
    return hash;
  }

  private storePdf(pdfFile: string | null | undefined): string | undefined {
    if (!pdfFile) {
      return undefined;
    }
    try {
      if (fs.statSync(pdfFile).size > MAX_PDF_BYTES) {
        return undefined;
      }
      return this.store(fs.readFileSync(pdfFile));
    } catch {
      return undefined;
    }
  }

  private save(snapshots: Snapshot[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, INDEX);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, snapshots }, null, 1));
    fs.renameSync(tmp, file);
  }

  /** Deletes the blobs no snapshot in `snapshots` refers to. */
  private collect(snapshots: Snapshot[]): void {
    const used = new Set<string>();
    for (const s of snapshots) {
      s.files.forEach((f) => used.add(f.hash));
      if (s.pdf) {
        used.add(s.pdf);
      }
    }
    const blobs = path.join(this.dir, 'blobs');
    let dirs: string[];
    try {
      dirs = fs.readdirSync(blobs);
    } catch {
      return;
    }
    for (const d of dirs) {
      const sub = path.join(blobs, d);
      for (const name of fs.readdirSync(sub)) {
        if (!used.has(name)) {
          fs.rmSync(path.join(sub, name), { force: true });
        }
      }
    }
  }
}
