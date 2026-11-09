import * as vscode from 'vscode';

const TEX_LANGUAGES = new Set(['latex', 'tex']);

/** Something read from each of the workspace's .tex files, keeping closed files' answers until they change. */
export class TexFiles<T> implements vscode.Disposable {
  private readonly closed = new Map<string, T>();
  private readonly watcher = vscode.workspace.createFileSystemWatcher('**/*.tex');
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly read: (text: string) => T,
    onChange: () => void
  ) {
    const forget = (uri: vscode.Uri) => {
      this.closed.delete(uri.fsPath);
      onChange();
    };
    this.subscriptions = [
      this.watcher,
      this.watcher.onDidChange(forget),
      this.watcher.onDidCreate(forget),
      this.watcher.onDidDelete(forget),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0 && TEX_LANGUAGES.has(e.document.languageId)) {
          onChange();
        }
      }),
      // Closing without saving leaves the file as it was on disk, not as the editor had it.
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (TEX_LANGUAGES.has(doc.languageId)) {
          forget(doc.uri);
        }
      }),
    ];
  }

  /** Each file's answer; open documents are read as they stand, unsaved edits included. Unreadable files are left out. */
  async all(): Promise<{ file: vscode.Uri; value: T }[]> {
    const files = await vscode.workspace.findFiles('**/*.tex', '**/node_modules/**', 2000);
    const open = new Map(vscode.workspace.textDocuments.map((doc) => [doc.uri.fsPath, doc]));
    const read = await Promise.all(
      files.map(async (file) => {
        const doc = open.get(file.fsPath);
        if (doc) {
          return { file, value: this.read(doc.getText()) };
        }
        let value = this.closed.get(file.fsPath);
        if (value === undefined) {
          try {
            value = this.read(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf-8'));
          } catch {
            return undefined;
          }
          this.closed.set(file.fsPath, value);
        }
        return { file, value };
      })
    );
    return read.filter((r) => r !== undefined);
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
  }
}
