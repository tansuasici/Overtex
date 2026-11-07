import * as vscode from 'vscode';

import { findHighlights, TextRange } from './latex/highlights';

const LANGUAGES = new Set(['latex', 'tex']);

/**
 * Editor highlights for LaTeX: TODO notes stand out (and show in the scroll bar), and text TeX
 * skips, \iffalse … \fi and comment environments, is dimmed.
 */
export class Highlighter implements vscode.Disposable {
  private readonly todo = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('overtex.todoBackground'),
    overviewRulerColor: new vscode.ThemeColor('overtex.todoBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private readonly inactive = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
  private readonly subscriptions: vscode.Disposable[];
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    this.subscriptions = [
      vscode.window.onDidChangeVisibleTextEditors(() => this.updateAll()),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('overtex.highlights') && this.updateAll()),
    ];
    this.updateAll();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subscriptions.forEach((d) => d.dispose());
    this.todo.dispose();
    this.inactive.dispose();
  }

  private schedule(doc: vscode.TextDocument): void {
    if (!LANGUAGES.has(doc.languageId)) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === doc) {
          this.update(editor);
        }
      }
    }, 200);
  }

  private updateAll(): void {
    vscode.window.visibleTextEditors.forEach((e) => this.update(e));
  }

  private update(editor: vscode.TextEditor): void {
    const doc = editor.document;
    if (!LANGUAGES.has(doc.languageId)) {
      return;
    }
    const enabled = vscode.workspace.getConfiguration('overtex', doc.uri).get<boolean>('highlights.enabled', true);
    const h = enabled ? findHighlights(doc.getText()) : { todos: [], inactive: [] };
    editor.setDecorations(this.todo, h.todos.map(toRange));
    editor.setDecorations(this.inactive, h.inactive.map(toRange));
  }
}

function toRange(r: TextRange): vscode.Range {
  return new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar);
}
