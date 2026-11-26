import * as vscode from 'vscode';

/** Languages that make a window a LaTeX window, matching the old onLanguage activation events. */
const LATEX_LANGUAGES = new Set(['latex', 'tex', 'bibtex']);

export function isLatexLanguage(languageId: string): boolean {
  return LATEX_LANGUAGES.has(languageId);
}

/**
 * Overtex activates in every window so Pending Invitations can show up anywhere, but LaTeX
 * tooling (TexLab, setup warnings, the sync status item) waits until the window turns out to
 * hold LaTeX: a .tex file in the workspace or a LaTeX/BibTeX document opened.
 */
export class LatexWorkspace implements vscode.Disposable {
  private seen = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];
  private readonly watcher = vscode.workspace.createFileSystemWatcher('**/*.tex', false, true, true);

  /** Fires once, when the window first turns out to be a LaTeX window. */
  readonly onDidBecomeLatex = this.emitter.event;

  constructor() {
    this.subscriptions = [
      this.emitter,
      this.watcher,
      this.watcher.onDidCreate(() => this.mark()),
      vscode.workspace.onDidOpenTextDocument((doc) => isLatexLanguage(doc.languageId) && this.mark()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.look()),
    ];
    void this.look();
  }

  get active(): boolean {
    return this.seen;
  }

  /** Runs `run` once: now if this is already a LaTeX window, otherwise when it becomes one. */
  whenLatex(run: () => void): void {
    if (this.seen) {
      run();
      return;
    }
    const once = this.onDidBecomeLatex(() => {
      once.dispose();
      run();
    });
    this.subscriptions.push(once);
  }

  dispose(): void {
    vscode.Disposable.from(...this.subscriptions).dispose();
  }

  private async look(): Promise<void> {
    if (this.seen) {
      return;
    }
    if (vscode.workspace.textDocuments.some((d) => isLatexLanguage(d.languageId))) {
      this.mark();
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      return;
    }
    try {
      const found = await vscode.workspace.findFiles('**/*.tex', '**/node_modules/**', 1);
      if (found.length) {
        this.mark();
      }
    } catch {
      // A failed search leaves the window as it is; opening a .tex file still marks it.
    }
  }

  private mark(): void {
    if (this.seen) {
      return;
    }
    this.seen = true;
    this.emitter.fire();
  }
}
