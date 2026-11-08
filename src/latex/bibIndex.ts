import * as vscode from 'vscode';
import { BibEntry, parseBib } from './bibParser';

export interface IndexedEntry extends BibEntry {
  /** The .bib file the entry is in. */
  file: vscode.Uri;
}

/** The entries of the workspace's .bib files, cached until one of them changes on disk. */
export class BibIndex implements vscode.Disposable {
  private cache: Promise<IndexedEntry[]> | null = null;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly watcher = vscode.workspace.createFileSystemWatcher('**/*.bib');

  readonly onDidChange = this.changed.event;

  constructor() {
    this.watcher.onDidChange(() => this.invalidate());
    this.watcher.onDidCreate(() => this.invalidate());
    this.watcher.onDidDelete(() => this.invalidate());
  }

  entries(): Promise<IndexedEntry[]> {
    this.cache ??= this.load();
    return this.cache;
  }

  invalidate(): void {
    this.cache = null;
    this.changed.fire();
  }

  dispose(): void {
    this.watcher.dispose();
    this.changed.dispose();
  }

  private async load(): Promise<IndexedEntry[]> {
    const files = await vscode.workspace.findFiles('**/*.bib', '**/node_modules/**', 200);
    const all = await Promise.all(
      files.map(async (file) => {
        try {
          const text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf-8');
          return parseBib(text).map((entry) => ({ ...entry, file }));
        } catch {
          // Deleted since the search, or unreadable: the other files still count.
          return [];
        }
      })
    );
    return all.flat();
  }
}
