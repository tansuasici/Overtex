import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { Baseline, HistoryStore, collectSources, historyDir, isSourceFile } from './latex/history';
import { Hunk, acceptHunk, hunkKey, hunkText, hunks, splitLines, wordChanges } from './latex/trackChanges';

const SCHEME = 'overtex-baseline';
const CONTEXT_KEY = 'overtex.trackingChanges';
/** Hunks longer than this are marked line by line, without the word-level marks. */
const WORD_MARK_MAX_LINES = 40;
/** How much of a deletion the strikethrough shows in the text; the hover has all of it. */
const DELETED_PREVIEW = 80;
const REFRESH_DELAY = 250;

export interface TrackChangesOptions {
  mainFile: () => string | null;
  /** The build output folder for a main file; it is not tracked. */
  outDir: (main: string) => string;
  requireTrust: (action: string) => boolean;
}

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface ChangedFile {
  /** Relative to the main file's folder, with forward slashes. */
  path: string;
  kind: ChangeKind;
  /** How many hunks the file has; 0 for a deleted file. */
  hunks: number;
}

export interface TrackChanges {
  active(): boolean;
  changedFiles(): ChangedFile[];
  hunks(file: string): Hunk[];
  /** What the editor shows for a file: inserted lines and words, and the deleted text. */
  marks(file: string): { insertedLines: number; insertedWords: number; deleted: string[] } | undefined;
}

interface Tracked {
  main: string;
  root: string;
  store: HistoryStore;
  baseline: Baseline;
}

/** Arguments the per-file commands accept: a Changes row, a file, or nothing for the active editor. */
type FileArg = ChangeItem | vscode.Uri | string | undefined;

interface ConfirmOption {
  /** Skips the modal question; for tests and other extensions. */
  force?: boolean;
}

class ChangeItem extends vscode.TreeItem {
  constructor(
    readonly change: ChangedFile,
    readonly uri: vscode.Uri
  ) {
    super(path.posix.basename(change.path), vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(change.path);
    const detail = change.kind === 'modified' ? `${change.hunks} change${change.hunks === 1 ? '' : 's'}` : change.kind;
    this.id = `change:${change.path}`;
    this.description = `${dir === '.' ? '' : `${dir}  `}${detail}`;
    this.resourceUri = uri;
    this.iconPath = new vscode.ThemeIcon(change.kind === 'added' ? 'diff-added' : change.kind === 'deleted' ? 'diff-removed' : 'diff-modified');
    this.contextValue = `trackedChange.${change.kind}`;
    this.tooltip =
      change.kind === 'added'
        ? `${change.path} is new since tracking started.`
        : change.kind === 'deleted'
          ? `${change.path} was deleted since tracking started.`
          : `${change.path}: compare with the text when tracking started.`;
    this.command = { title: 'Show Changes', command: 'overtex.trackChanges.openChange', arguments: [this] };
  }
}

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, '↵ ');
}

function preview(text: string): string {
  const flat = oneLine(text);
  return flat.length > DELETED_PREVIEW ? `${flat.slice(0, DELETED_PREVIEW - 1)}…` : flat;
}

function hoverFor(text: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString('Deleted since tracking started:\n');
  md.appendCodeblock(text.replace(/\r?\n$/, ''), 'latex');
  return md;
}

/** Character offsets of the start of each line, with one more for the end. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (const l of splitLines(text)) {
    starts.push(starts[starts.length - 1] + l.length);
  }
  return starts;
}

/**
 * Track Changes: a baseline copy of the sources, taken when tracking starts and kept with the
 * history snapshots (nothing is written into the project). The editor marks what changed since,
 * and each change can be accepted into the baseline or rejected back to it.
 */
export function registerTrackChanges(context: vscode.ExtensionContext, options: TrackChangesOptions): TrackChanges {
  const storage = (context.storageUri ?? context.globalStorageUri).fsPath;
  let tracked: Tracked | undefined;
  const blobs = new Map<string, string>();
  const hunkCache = new Map<string, { version: number; hunks: Hunk[] }>();
  const lastMarks = new Map<string, { insertedLines: number; insertedWords: number; deleted: string[] }>();

  const load = (): Tracked | undefined => {
    const main = options.mainFile();
    if (!main) {
      return undefined;
    }
    const store = new HistoryStore(historyDir(storage, main));
    const baseline = store.baseline();
    return baseline && baseline.main === path.basename(main) ? { main, root: path.dirname(main), store, baseline } : undefined;
  };

  const relOf = (uri: vscode.Uri, t = tracked): string | undefined => {
    if (!t || uri.scheme !== 'file' || !isSourceFile(uri.fsPath)) {
      return undefined;
    }
    const rel = path.relative(t.root, uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return undefined;
    }
    const out = path.resolve(options.outDir(t.main));
    if (out !== path.resolve(t.root) && (uri.fsPath + path.sep).startsWith(out + path.sep)) {
      return undefined;
    }
    return rel.split(path.sep).join('/');
  };

  const fileUri = (t: Tracked, rel: string) => vscode.Uri.file(path.join(t.root, ...rel.split('/')));

  const baselineText = (rel: string, t = tracked): string | undefined => {
    const f = t?.baseline.files.find((x) => x.path === rel);
    if (!t || !f) {
      return undefined;
    }
    let text = blobs.get(f.hash);
    if (text === undefined) {
      text = t.store.read(f.hash).toString('utf8');
      blobs.set(f.hash, text);
    }
    return text;
  };

  const openDoc = (uri: vscode.Uri) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());

  /** The file's text as it stands, unsaved edits included; undefined when it does not exist. */
  const currentText = (t: Tracked, rel: string): string | undefined => {
    const uri = fileUri(t, rel);
    const doc = openDoc(uri);
    if (doc) {
      return doc.getText();
    }
    try {
      return fs.readFileSync(uri.fsPath, 'utf8');
    } catch {
      return undefined;
    }
  };

  const hunksOf = (doc: vscode.TextDocument): Hunk[] => {
    const rel = relOf(doc.uri);
    if (!rel) {
      return [];
    }
    const key = doc.uri.toString();
    const cached = hunkCache.get(key);
    if (cached && cached.version === doc.version) {
      return cached.hunks;
    }
    const result = hunks(baselineText(rel) ?? '', doc.getText());
    hunkCache.set(key, { version: doc.version, hunks: result });
    return result;
  };

  const changedFiles = (): ChangedFile[] => {
    const t = tracked;
    if (!t) {
      return [];
    }
    const present = new Set(collectSources(t.root, options.outDir(t.main)));
    for (const doc of vscode.workspace.textDocuments) {
      const rel = relOf(doc.uri, t);
      if (rel) {
        present.add(rel);
      }
    }
    const inBaseline = new Set(t.baseline.files.map((f) => f.path));
    const out: ChangedFile[] = [];
    for (const rel of [...new Set([...present, ...inBaseline])].sort()) {
      const current = present.has(rel) ? currentText(t, rel) : undefined;
      if (current === undefined) {
        if (inBaseline.has(rel)) {
          out.push({ path: rel, kind: 'deleted', hunks: 0 });
        }
        continue;
      }
      if (!inBaseline.has(rel)) {
        out.push({ path: rel, kind: 'added', hunks: current ? 1 : 0 });
        continue;
      }
      const base = baselineText(rel, t) ?? '';
      if (base !== current) {
        out.push({ path: rel, kind: 'modified', hunks: hunks(base, current).length });
      }
    }
    return out;
  };

  // ---- Editor marks ----

  const insertedLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  const insertedText = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
  });
  const deletedText = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    before: {
      textDecoration: 'line-through',
      color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
      backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    },
  });

  const decorate = (editor: vscode.TextEditor) => {
    const doc = editor.document;
    const rel = relOf(doc.uri);
    if (!rel) {
      editor.setDecorations(insertedLine, []);
      editor.setDecorations(insertedText, []);
      editor.setDecorations(deletedText, []);
      lastMarks.delete(doc.uri.toString());
      return;
    }
    const text = doc.getText();
    const starts = lineStarts(text);
    const lines: vscode.Range[] = [];
    const words: vscode.Range[] = [];
    const deleted: vscode.DecorationOptions[] = [];
    const deletedTexts: string[] = [];
    const markDeleted = (offset: number, removed: string) => {
      const at = doc.positionAt(offset);
      deleted.push({ range: new vscode.Range(at, at), hoverMessage: hoverFor(removed), renderOptions: { before: { contentText: preview(removed) } } });
      deletedTexts.push(removed);
    };
    for (const h of hunksOf(doc)) {
      const start = starts[Math.min(h.newStart, starts.length - 1)];
      for (let i = 0; i < h.newLines.length; i++) {
        lines.push(doc.lineAt(Math.min(h.newStart + i, doc.lineCount - 1)).range);
      }
      const oldText = hunkText(h.oldLines);
      const newText = hunkText(h.newLines);
      if (!oldText) {
        continue;
      }
      if (!newText || h.oldLines.length > WORD_MARK_MAX_LINES || h.newLines.length > WORD_MARK_MAX_LINES) {
        markDeleted(start, oldText);
        continue;
      }
      const w = wordChanges(oldText, newText);
      for (const r of w.inserted) {
        if (newText.slice(r.start, r.end).trim()) {
          words.push(new vscode.Range(doc.positionAt(start + r.start), doc.positionAt(start + r.end)));
        }
      }
      for (const d of w.deleted) {
        if (d.text.trim()) {
          markDeleted(start + d.at, d.text);
        }
      }
    }
    editor.setDecorations(insertedLine, lines);
    editor.setDecorations(insertedText, words);
    editor.setDecorations(deletedText, deleted);
    lastMarks.set(doc.uri.toString(), { insertedLines: lines.length, insertedWords: words.length, deleted: deletedTexts });
  };

  const decorateAll = () => vscode.window.visibleTextEditors.forEach(decorate);

  // ---- CodeLens ----

  const lensesChanged = new vscode.EventEmitter<void>();
  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensesChanged.event,
    provideCodeLenses: (doc) => {
      if (!tracked || !relOf(doc.uri)) {
        return [];
      }
      return hunksOf(doc).flatMap((h) => {
        const line = Math.min(h.newStart, doc.lineCount - 1);
        const range = new vscode.Range(line, 0, line, 0);
        const args = [doc.uri.toString(), hunkKey(h)];
        return [
          new vscode.CodeLens(range, { title: '$(check) Accept', tooltip: 'Keep this change', command: 'overtex.trackChanges.accept', arguments: args }),
          new vscode.CodeLens(range, { title: '$(discard) Reject', tooltip: 'Put back the text from when tracking started', command: 'overtex.trackChanges.reject', arguments: args }),
        ];
      });
    },
  };

  // ---- The Changes view and the status bar ----

  const treeChanged = new vscode.EventEmitter<void>();
  let lastChanges: ChangedFile[] = [];
  const tree: vscode.TreeDataProvider<ChangeItem> = {
    onDidChangeTreeData: treeChanged.event,
    getTreeItem: (item) => item,
    getChildren: (item) => {
      const t = tracked;
      if (item || !t) {
        return [];
      }
      return lastChanges.map((c) => new ChangeItem(c, fileUri(t, c.path)));
    },
  };
  const view = vscode.window.createTreeView('overtex.changes', { treeDataProvider: tree });
  const status = vscode.window.createStatusBarItem('overtex.trackChanges', vscode.StatusBarAlignment.Left, 40);
  status.name = 'Overtex Track Changes';
  status.command = 'overtex.changes.focus';

  const updateList = () => {
    lastChanges = changedFiles();
    const count = lastChanges.length;
    view.badge = tracked && count ? { value: count, tooltip: `${count} changed file${count === 1 ? '' : 's'}` } : undefined;
    if (tracked) {
      status.text = `$(diff) ${count}`;
      status.tooltip = `Overtex is tracking changes since ${new Date(tracked.baseline.started).toLocaleString()}: ${count} changed file${count === 1 ? '' : 's'}.`;
      status.show();
    } else {
      status.hide();
    }
    treeChanged.fire();
  };

  let listTimer: NodeJS.Timeout | undefined;
  const scheduleList = () => {
    clearTimeout(listTimer);
    listTimer = setTimeout(updateList, REFRESH_DELAY * 2);
  };

  /** Reads the baseline again and redraws everything. */
  const refresh = () => {
    tracked = load();
    hunkCache.clear();
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, !!tracked);
    decorateAll();
    lensesChanged.fire();
    updateList();
  };

  const timers = new Map<string, NodeJS.Timeout>();
  const onEdit = (doc: vscode.TextDocument) => {
    if (!tracked || !relOf(doc.uri)) {
      return;
    }
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        vscode.window.visibleTextEditors.filter((e) => e.document === doc).forEach(decorate);
        lensesChanged.fire();
        scheduleList();
      }, REFRESH_DELAY)
    );
  };

  // ---- The baseline's copy of a file, read-only ----

  const baselineUri = (t: Tracked, rel: string) =>
    vscode.Uri.from({ scheme: SCHEME, authority: path.basename(t.store.dir), path: `/${rel}`, query: `started=${t.baseline.started}` });

  const content: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (uri) => {
      const t = tracked;
      return t && uri.authority === path.basename(t.store.dir) ? (baselineText(uri.path.slice(1), t) ?? '') : '';
    },
  };

  // ---- Commands ----

  const needTracking = (): Tracked | undefined => {
    if (!tracked) {
      void vscode.window.showInformationMessage('Overtex: Track Changes is off. Start it to mark what changes from now on.');
    }
    return tracked;
  };

  const start = async (): Promise<boolean> => {
    const main = options.mainFile();
    if (!main) {
      void vscode.window.showWarningMessage('Overtex: no LaTeX document found to track.');
      return false;
    }
    if (load()) {
      refresh();
      void vscode.window.showInformationMessage('Overtex: changes to this document are already tracked.');
      return true;
    }
    const store = new HistoryStore(historyDir(storage, main));
    store.startBaseline(main, options.outDir(main));
    // Unsaved edits are part of the text as it stands now.
    const t = load();
    for (const doc of vscode.workspace.textDocuments) {
      const rel = t && doc.isDirty ? relOf(doc.uri, t) : undefined;
      if (rel) {
        store.setBaselineFile(rel, Buffer.from(doc.getText(), 'utf8'));
      }
    }
    refresh();
    vscode.window.setStatusBarMessage('Overtex: tracking changes from now on', 4000);
    return true;
  };

  const stop = async (opts?: ConfirmOption): Promise<boolean> => {
    const t = needTracking();
    if (!t) {
      return false;
    }
    if (!opts?.force) {
      const answer = await vscode.window.showWarningMessage(
        'Stop tracking changes?',
        { modal: true, detail: 'The text stays as it is. The marks go away, and so does the copy of the text from when tracking started.' },
        'Stop Tracking'
      );
      if (answer !== 'Stop Tracking') {
        return false;
      }
    }
    t.store.clearBaseline();
    blobs.clear();
    refresh();
    return true;
  };

  /** The hunk a command acts on: the one it was offered for, by key or index, or the one at the cursor. */
  const hunkOf = async (uriArg?: string | vscode.Uri, which?: string | number): Promise<{ doc: vscode.TextDocument; rel: string; hunk: Hunk } | undefined> => {
    if (!needTracking()) {
      return undefined;
    }
    const uri = typeof uriArg === 'string' ? vscode.Uri.parse(uriArg) : uriArg ?? vscode.window.activeTextEditor?.document.uri;
    const rel = uri && relOf(uri);
    if (!uri || !rel) {
      void vscode.window.showInformationMessage('Overtex: this file is not part of the tracked document.');
      return undefined;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const all = hunksOf(doc);
    let hunk: Hunk | undefined;
    if (typeof which === 'number') {
      hunk = all[which];
    } else if (typeof which === 'string') {
      hunk = all.find((h) => hunkKey(h) === which);
    } else {
      const line = vscode.window.activeTextEditor?.document === doc ? vscode.window.activeTextEditor.selection.active.line : -1;
      hunk = all.find((h) => line >= h.newStart && line < h.newStart + Math.max(h.newLines.length, 1));
    }
    if (!hunk) {
      void vscode.window.showInformationMessage(which === undefined ? 'Overtex: there is no tracked change at the cursor.' : 'Overtex: that change has moved or gone; try again from its new place.');
      return undefined;
    }
    return { doc, rel, hunk };
  };

  const setBaseline = (t: Tracked, rel: string, text: string | undefined) => {
    t.store.setBaselineFile(rel, text === undefined ? undefined : Buffer.from(text, 'utf8'));
    refresh();
  };

  const accept = async (uriArg?: string | vscode.Uri, which?: string | number): Promise<boolean> => {
    const found = await hunkOf(uriArg, which);
    const t = tracked;
    if (!found || !t) {
      return false;
    }
    setBaseline(t, found.rel, acceptHunk(baselineText(found.rel) ?? '', found.hunk));
    return true;
  };

  const reject = async (uriArg?: string | vscode.Uri, which?: string | number): Promise<boolean> => {
    const found = await hunkOf(uriArg, which);
    if (!found) {
      return false;
    }
    const { doc, hunk } = found;
    const starts = lineStarts(doc.getText());
    const start = starts[Math.min(hunk.newStart, starts.length - 1)];
    const end = start + hunkText(hunk.newLines).length;
    // One edit in the document, so Undo brings the change back.
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)), hunkText(hunk.oldLines));
    return vscode.workspace.applyEdit(edit);
  };

  const fileOf = (arg: FileArg): { t: Tracked; rel: string; uri: vscode.Uri } | undefined => {
    const t = needTracking();
    if (!t) {
      return undefined;
    }
    const uri = arg instanceof ChangeItem ? arg.uri : typeof arg === 'string' ? vscode.Uri.parse(arg) : arg ?? vscode.window.activeTextEditor?.document.uri;
    const rel = uri && relOf(uri, t);
    if (!uri || !rel) {
      void vscode.window.showInformationMessage('Overtex: this file is not part of the tracked document.');
      return undefined;
    }
    return { t, rel, uri };
  };

  const acceptFile = async (arg?: FileArg): Promise<boolean> => {
    const f = fileOf(arg);
    if (!f) {
      return false;
    }
    setBaseline(f.t, f.rel, currentText(f.t, f.rel));
    return true;
  };

  const rejectFile = async (arg?: FileArg, opts?: ConfirmOption): Promise<boolean> => {
    const f = fileOf(arg);
    if (!f) {
      return false;
    }
    const { t, rel, uri } = f;
    const base = baselineText(rel, t);
    const current = currentText(t, rel);
    if (base === current) {
      return true;
    }
    const confirm = async (message: string, detail: string, button: string) =>
      opts?.force || (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button;

    if (base === undefined) {
      if (!(await confirm(`Delete ${rel}?`, 'The file is new since tracking started. Undo in the editor brings it back.', 'Delete'))) {
        return false;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(uri, { ignoreIfNotExists: true });
      const ok = await vscode.workspace.applyEdit(edit);
      refresh();
      return ok;
    }
    if (current === undefined) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(base, 'utf8'));
      refresh();
      return true;
    }
    if (!(await confirm(`Reject every change in ${rel}?`, 'Its text goes back to how it was when tracking started. Undo in the editor brings the changes back.', 'Reject All'))) {
      return false;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), base);
    const ok = (await vscode.workspace.applyEdit(edit)) && (await doc.save());
    refresh();
    return ok;
  };

  const openChange = async (arg?: FileArg) => {
    const f = fileOf(arg);
    if (!f) {
      return;
    }
    const { t, rel, uri } = f;
    const inBaseline = baselineText(rel, t) !== undefined;
    const exists = currentText(t, rel) !== undefined;
    if (inBaseline && exists) {
      const name = path.posix.basename(rel);
      await vscode.commands.executeCommand('vscode.diff', baselineUri(t, rel), uri, `${name} (when tracking started) ↔ now`, { preview: true });
    } else {
      await vscode.window.showTextDocument(inBaseline ? baselineUri(t, rel) : uri, { preview: true });
    }
  };

  /** The PDF that latexdiff marks up: the baseline against the sources now. */
  const showMarkedPdf = async () => {
    const t = needTracking();
    if (!t || !options.requireTrust('Showing the marked-up PDF')) {
      return undefined;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-baseline-'));
    try {
      const old = t.store.materializeBaseline(t.baseline, tmp);
      return await vscode.commands.executeCommand('overtex.compareVersions', { old: { file: old } });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{tex,ltx,bib,sty,cls,bst,tikz,pgf,inc}');
  const register = vscode.commands.registerCommand;
  context.subscriptions.push(
    insertedLine,
    insertedText,
    deletedText,
    lensesChanged,
    treeChanged,
    view,
    status,
    watcher,
    { dispose: () => [listTimer, ...timers.values()].forEach((x) => clearTimeout(x)) },
    watcher.onDidCreate(() => tracked && scheduleList()),
    watcher.onDidDelete(() => tracked && scheduleList()),
    watcher.onDidChange(() => tracked && scheduleList()),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lenses),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, content),
    vscode.workspace.onDidChangeTextDocument((e) => onEdit(e.document)),
    vscode.window.onDidChangeVisibleTextEditors(() => tracked && decorateAll()),
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (load()?.main !== tracked?.main) {
        refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('overtex.latex.mainFile') && refresh()),
    register('overtex.trackChanges.start', start),
    register('overtex.trackChanges.stop', stop),
    register('overtex.trackChanges.accept', accept),
    register('overtex.trackChanges.reject', reject),
    register('overtex.trackChanges.acceptFile', acceptFile),
    register('overtex.trackChanges.rejectFile', rejectFile),
    register('overtex.trackChanges.openChange', openChange),
    register('overtex.trackChanges.showMarkedPdf', showMarkedPdf),
    register('overtex.trackChanges.refresh', refresh)
  );
  refresh();

  return {
    active: () => !!tracked,
    changedFiles,
    hunks: (file) => {
      const doc = openDoc(vscode.Uri.file(file));
      if (doc) {
        return hunksOf(doc);
      }
      const t = tracked;
      const rel = relOf(vscode.Uri.file(file));
      return t && rel ? hunks(baselineText(rel) ?? '', currentText(t, rel) ?? '') : [];
    },
    marks: (file) => lastMarks.get(vscode.Uri.file(file).toString()),
  };
}
