import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { BuildResult } from './latex/builder';
import { isHeadingLine } from './shared/headings';
import type { PageRect } from './shared/messages';

const TEX_LANGUAGES = new Set(['latex', 'tex']);
const DEBOUNCE_MS = 200;
const SOURCE = /\.(tex|bib|sty|cls)$/i;

export interface OutlineSyncDeps {
  mainFile(): string | null | undefined;
  pdfFor(main: string): string;
  /** The PDF the preview shows, if it is open. */
  shownPdf(): string | undefined;
  forward(pdf: string, file: string, line: number, column: number): Promise<PageRect | null | undefined>;
  reveal(target: PageRect): void;
  build(main: string): Promise<BuildResult | undefined>;
  isBuilding(): boolean;
  readonly onDidEndBuild: vscode.Event<BuildResult>;
  log(text: string): void;
}

interface Pending {
  file: string;
  line: number;
  version: number;
}

/**
 * Scrolls the preview to a heading when the cursor jumps to one from the Outline view, the
 * breadcrumbs or Go to Symbol. Those moves reach extensions as selection changes that are neither
 * keyboard nor mouse, onto a heading line, with no edit in between.
 */
export class OutlineSync implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lastLine = new Map<string, number>();
  /** When each document was last edited: the cursor moves an edit makes arrive right after it. */
  private readonly editedAt = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** A heading waiting for the build in progress. */
  private afterBuild: Pending | undefined;
  /** The file:version a stale-PDF build last ran for, so a failing document is not rebuilt on every click. */
  private builtFor: string | undefined;
  private suppressed: { file: string; line: number; until: number } | undefined;

  constructor(private readonly deps: OutlineSyncDeps) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) {
          this.editedAt.set(e.document.uri.fsPath, Date.now());
          if (SOURCE.test(e.document.fileName)) {
            // Any source edit makes the PDF stale again, whichever file the next jump lands in.
            this.builtFor = undefined;
          }
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      deps.onDidEndBuild(() => {
        const pending = this.afterBuild;
        this.afterBuild = undefined;
        if (pending) {
          void this.sync(pending, false);
        }
      })
    );
  }

  /** Our own inverse search lands on `file:line`; scrolling the PDF back there would undo the click. */
  suppress(file: string, line: number): void {
    this.suppressed = { file, line, until: Date.now() + 2000 };
  }

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    const doc = e.textEditor.document;
    if (doc.uri.scheme !== 'file' || !TEX_LANGUAGES.has(doc.languageId)) {
      return;
    }
    const file = doc.uri.fsPath;
    const active = e.selections[0].active;
    const previous = this.lastLine.get(file);
    this.lastLine.set(file, active.line);
    if (!vscode.workspace.getConfiguration('overtex').get<boolean>('viewer.followOutline', true)) {
      return;
    }
    if (e.kind === vscode.TextEditorSelectionChangeKind.Keyboard || e.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
      return;
    }
    if (e.selections.length !== 1 || !e.selections[0].isEmpty) {
      return;
    }
    // Typing, formatting or a collaborator's edit moves the cursor too; only a jump counts.
    if (previous === active.line || Date.now() - (this.editedAt.get(file) ?? 0) < 100) {
      return;
    }
    if (!isHeadingLine(doc.lineAt(active.line).text)) {
      return;
    }
    const s = this.suppressed;
    if (s && s.file === file && s.line === active.line && Date.now() < s.until) {
      this.suppressed = undefined;
      return;
    }
    const pending = { file, line: active.line, version: doc.version };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // A cursor that passed over the heading (another extension's motion, a scripted move) has left it by now.
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.fsPath === file && editor.selection.isEmpty && editor.selection.active.line === pending.line) {
        void this.sync(pending, true);
      }
    }, DEBOUNCE_MS);
  }

  private async sync(pending: Pending, mayBuild: boolean): Promise<void> {
    const main = this.deps.mainFile();
    if (!main) {
      return;
    }
    const pdf = this.deps.pdfFor(main);
    // Only follow along in a preview that already shows this document; never open one from a cursor move.
    if (this.deps.shownPdf() !== pdf || !fs.existsSync(pdf)) {
      return;
    }
    if (this.deps.isBuilding()) {
      this.afterBuild = pending;
      return;
    }
    if (mayBuild && this.isStale(pending.file, pdf)) {
      const key = `${pending.file}:${pending.version}:${this.dirtyCount()}`;
      if (this.builtFor !== key) {
        this.builtFor = key;
        this.afterBuild = pending;
        await this.deps.build(main);
        // A finished build has synced it already; one that never started (an untrusted workspace) has not.
        if (this.afterBuild !== pending) {
          return;
        }
        this.afterBuild = undefined;
      }
    }
    try {
      const target = await this.deps.forward(pdf, pending.file, pending.line + 1, 0);
      if (target) {
        this.deps.reveal(target);
      } else {
        void vscode.window.setStatusBarMessage(`Overtex: this heading is not in the PDF yet (${path.basename(pending.file)}:${pending.line + 1})`, 4000);
      }
    } catch (err) {
      this.deps.log(`${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  /** Unsaved sources, or a file saved after the PDF was made. */
  private isStale(file: string, pdf: string): boolean {
    if (this.dirtyCount() > 0) {
      return true;
    }
    try {
      return fs.statSync(file).mtimeMs > fs.statSync(pdf).mtimeMs;
    } catch {
      return false;
    }
  }

  private dirtyCount(): number {
    return vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file' && SOURCE.test(d.fileName)).length;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}
