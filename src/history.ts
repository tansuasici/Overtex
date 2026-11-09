import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { FileChange, HistoryStore, Snapshot, changesBetween, historyDir } from './latex/history';

const SCHEME = 'overtex-snapshot';

export interface HistoryOptions {
  mainFile: () => string | null;
  /** The build output folder for a main file; it is left out of snapshots. */
  outDir: (main: string) => string;
  showPdf: (pdf: string) => Promise<void>;
  log: (text: string) => void;
}

export interface History {
  /** Takes a snapshot of the main file's sources; returns it, or undefined when nothing changed. */
  record(mainFile: string, pdfFile: string | null, trigger: Snapshot['trigger']): Snapshot | undefined;
  snapshots(): Snapshot[];
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('overtex.history');
}

function when(time: number): string {
  return new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function ago(time: number, now = Date.now()): string {
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function summary(changes: FileChange[]): string {
  const count = (kind: FileChange['kind']) => changes.filter((c) => c.kind === kind).length;
  return [`+${count('added')}`, `~${count('modified')}`, `−${count('deleted')}`].join(' ');
}

class SnapshotItem extends vscode.TreeItem {
  constructor(
    readonly store: HistoryStore,
    readonly snapshot: Snapshot,
    readonly changes: FileChange[]
  ) {
    super(snapshot.label ?? when(snapshot.time), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `${store.dir}:${snapshot.id}`;
    this.description = `${snapshot.label ? `${when(snapshot.time)}  ` : ''}${ago(snapshot.time)}  ${summary(changes)}`;
    this.iconPath = new vscode.ThemeIcon(snapshot.label ? 'bookmark' : snapshot.trigger === 'build' ? 'history' : 'device-camera');
    this.contextValue = snapshot.pdf ? 'snapshot snapshotWithPdf' : 'snapshot';
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${when(snapshot.time)}**${snapshot.label ? ` — ${snapshot.label}` : ''}\n\n`);
    md.appendMarkdown(`${snapshot.trigger === 'build' ? 'After a successful build' : 'Saved by hand'}; ${snapshot.files.length} source file${snapshot.files.length === 1 ? '' : 's'}${snapshot.pdf ? ' and the PDF' : ''}.`);
    this.tooltip = md;
  }
}

class FileItem extends vscode.TreeItem {
  constructor(
    readonly store: HistoryStore,
    readonly snapshot: Snapshot,
    readonly change: FileChange
  ) {
    super(path.posix.basename(change.path), vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(change.path);
    this.description = `${dir === '.' ? '' : `${dir}  `}${change.kind}`;
    this.resourceUri = vscode.Uri.file(change.path);
    this.iconPath = new vscode.ThemeIcon(change.kind === 'added' ? 'diff-added' : change.kind === 'deleted' ? 'diff-removed' : 'diff-modified');
    this.contextValue = change.kind === 'deleted' ? 'snapshotFile.deleted' : 'snapshotFile';
    this.tooltip = change.kind === 'deleted' ? `${change.path} was deleted before this snapshot.` : `${change.path}: compare this snapshot's version with the file now.`;
    this.command = { title: 'Compare with Current', command: 'overtex.history.openFile', arguments: [this] };
  }
}

type Item = SnapshotItem | FileItem;

/** The History panel: snapshots of the main document's sources, newest first. */
export function registerHistory(context: vscode.ExtensionContext, options: HistoryOptions): History {
  const storage = (context.storageUri ?? context.globalStorageUri).fsPath;
  const stores = new Map<string, HistoryStore>();
  const storeFor = (main: string): HistoryStore => {
    const dir = historyDir(storage, main);
    let store = stores.get(path.basename(dir));
    if (!store) {
      store = new HistoryStore(dir);
      stores.set(path.basename(dir), store);
    }
    return store;
  };

  const changed = new vscode.EventEmitter<Item | undefined>();
  const provider: vscode.TreeDataProvider<Item> = {
    onDidChangeTreeData: changed.event,
    getTreeItem: (item) => item,
    getChildren: (item) => {
      if (item instanceof SnapshotItem) {
        return item.changes.map((c) => new FileItem(item.store, item.snapshot, c));
      }
      if (item) {
        return [];
      }
      const main = options.mainFile();
      if (!main) {
        return [];
      }
      const store = storeFor(main);
      const all = store.list();
      return all.map((s, i) => new SnapshotItem(store, s, changesBetween(all[i + 1], s)));
    },
  };
  const refresh = () => changed.fire(undefined);

  /** A snapshot's copy of a file, read-only, named so that the editor picks the right language. */
  const snapshotUri = (store: HistoryStore, snapshot: Snapshot, rel: string, hash: string) =>
    vscode.Uri.from({ scheme: SCHEME, authority: path.basename(store.dir), path: `/${rel}`, query: new URLSearchParams({ hash, time: when(snapshot.time) }).toString() });

  const content: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (uri) => {
      const store = stores.get(uri.authority);
      const hash = new URLSearchParams(uri.query).get('hash');
      return store && hash ? store.read(hash).toString('utf8') : '';
    },
  };

  const record = (mainFile: string, pdfFile: string | null, trigger: Snapshot['trigger']): Snapshot | undefined => {
    const keep = cfg().get<number>('maxSnapshots', 50);
    if (keep <= 0) {
      return undefined;
    }
    try {
      const snapshot = storeFor(mainFile).record({
        mainFile,
        pdfFile: cfg().get<boolean>('keepPdf', true) ? pdfFile : null,
        trigger,
        keep,
        outDir: options.outDir(mainFile),
      });
      refresh();
      return snapshot;
    } catch (err) {
      options.log(`Could not save a history snapshot: ${err instanceof Error ? err.message : String(err)}\n`);
      return undefined;
    }
  };

  /** The snapshot a command acts on: the clicked row, an id from another extension or a test, or one picked from a list. */
  const snapshotOf = async (arg?: Item | string): Promise<{ store: HistoryStore; snapshot: Snapshot } | undefined> => {
    if (arg instanceof SnapshotItem || arg instanceof FileItem) {
      return { store: arg.store, snapshot: arg.snapshot };
    }
    const main = options.mainFile();
    const store = main ? storeFor(main) : undefined;
    const all = store?.list() ?? [];
    if (typeof arg === 'string') {
      const found = all.find((s) => s.id === arg);
      return store && found && { store, snapshot: found };
    }
    if (!store || all.length === 0) {
      void vscode.window.showInformationMessage('Overtex: this document has no snapshots yet. Build it, or save a snapshot.');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      all.map((s) => ({ label: s.label ?? when(s.time), description: s.label ? when(s.time) : ago(s.time), snapshot: s })),
      { title: 'Overtex: choose a snapshot' }
    );
    return pick && { store, snapshot: pick.snapshot };
  };

  const saveSnapshot = async () => {
    const main = options.mainFile();
    if (!main) {
      void vscode.window.showWarningMessage('Overtex: no LaTeX document found to take a snapshot of.');
      return undefined;
    }
    await Promise.all(vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file').map((d) => d.save()));
    if (cfg().get<number>('maxSnapshots', 50) <= 0) {
      void vscode.window.showInformationMessage('Overtex: history is turned off; overtex.history.maxSnapshots is 0.');
      return undefined;
    }
    const snapshot = record(main, null, 'manual');
    vscode.window.setStatusBarMessage(snapshot ? 'Overtex: snapshot saved' : 'Overtex: nothing changed since the last snapshot', 4000);
    return snapshot;
  };

  const openFile = async (item?: FileItem) => {
    if (!(item instanceof FileItem)) {
      return;
    }
    const { store, snapshot, change } = item;
    const main = options.mainFile();
    if (change.kind === 'deleted') {
      const before = store.previous(snapshot) ?? snapshot;
      await vscode.window.showTextDocument(snapshotUri(store, before, change.path, change.hash), { preview: true });
      return;
    }
    const current = main && path.join(path.dirname(main), ...change.path.split('/'));
    const left = snapshotUri(store, snapshot, change.path, change.hash);
    if (current && fs.existsSync(current)) {
      const name = path.posix.basename(change.path);
      await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(current), `${name} (${when(snapshot.time)}) ↔ now`, { preview: true });
    } else {
      await vscode.window.showTextDocument(left, { preview: true });
    }
  };

  const restoreFile = async (item?: FileItem) => {
    const main = options.mainFile();
    if (!(item instanceof FileItem) || item.change.kind === 'deleted' || !main) {
      return;
    }
    const { store, snapshot, change } = item;
    const target = path.join(path.dirname(main), ...change.path.split('/'));
    const answer = await vscode.window.showWarningMessage(
      `Replace ${change.path} with its version from ${when(snapshot.time)}?`,
      { modal: true, detail: 'The change can be undone in the editor.' },
      'Restore'
    );
    if (answer !== 'Restore') {
      return;
    }
    const text = store.read(change.hash).toString('utf8');
    const uri = vscode.Uri.file(target);
    if (fs.existsSync(target)) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
      if (!(await vscode.workspace.applyEdit(edit)) || !(await doc.save())) {
        void vscode.window.showErrorMessage(`Overtex: could not restore ${change.path}.`);
        return;
      }
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    }
    await vscode.window.showTextDocument(uri);
  };

  const openPdf = async (arg?: Item | string) => {
    const picked = await snapshotOf(arg);
    if (!picked) {
      return;
    }
    const { store, snapshot } = picked;
    if (!snapshot.pdf) {
      void vscode.window.showInformationMessage('Overtex: this snapshot has no PDF. Snapshots taken after a build keep it.');
      return;
    }
    // The preview names its tab after the file, so the copy gets a readable name.
    const stamp = new Date(snapshot.time).toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const dir = path.join(os.tmpdir(), 'overtex-history');
    fs.mkdirSync(dir, { recursive: true });
    const pdf = path.join(dir, `${path.basename(snapshot.main, path.extname(snapshot.main))}-${stamp}.pdf`);
    fs.writeFileSync(pdf, store.read(snapshot.pdf));
    await options.showPdf(pdf);
  };

  const compare = async (arg?: Item | string) => {
    const picked = await snapshotOf(arg);
    if (!picked) {
      return undefined;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-snapshot-'));
    try {
      const old = picked.store.materialize(picked.snapshot, tmp);
      return await vscode.commands.executeCommand('overtex.compareVersions', { old: { file: old } });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };

  const label = async (arg?: Item | string) => {
    const picked = await snapshotOf(arg);
    if (!picked) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: 'Name Snapshot',
      prompt: 'Named snapshots are kept however many come after. Leave empty to remove the name.',
      value: picked.snapshot.label ?? '',
      placeHolder: 'Submitted to the journal',
    });
    if (name !== undefined) {
      picked.store.setLabel(picked.snapshot.id, name);
      refresh();
    }
  };

  const remove = async (arg?: Item | string) => {
    const picked = await snapshotOf(arg);
    if (!picked) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(`Delete the snapshot from ${when(picked.snapshot.time)}?`, { modal: true }, 'Delete');
    if (answer === 'Delete') {
      picked.store.remove(picked.snapshot.id);
      refresh();
    }
  };

  const register = vscode.commands.registerCommand;
  context.subscriptions.push(
    changed,
    vscode.window.createTreeView('overtex.history', { treeDataProvider: provider }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, content),
    vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('overtex.latex.mainFile') && refresh()),
    register('overtex.history.snapshot', saveSnapshot),
    register('overtex.history.refresh', refresh),
    register('overtex.history.openFile', openFile),
    register('overtex.history.restoreFile', restoreFile),
    register('overtex.history.openPdf', openPdf),
    register('overtex.history.compare', compare),
    register('overtex.history.label', label),
    register('overtex.history.delete', remove)
  );

  return {
    record,
    snapshots: () => {
      const main = options.mainFile();
      return main ? storeFor(main).list() : [];
    },
  };
}
