import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { toStandaloneArrayBuffer } from '../shared/bytes';
import { isE2eMessage } from '../shared/messages';
import { isNote, parseNotes, serializeNotes } from '../shared/notes';
import { toggledScheme } from '../shared/colorScheme';
import type { ColorScheme } from '../shared/colorScheme';
import type { E2eFromViewerMessage, E2eToViewerMessage, FromViewerMessage, PageRect, ToViewerMessage } from '../shared/messages';
import type { Note } from '../shared/notes';

/** A single PDF preview tab rendered with PDF.js inside a webview. */
export class PdfPanel implements vscode.Disposable {
  private static readonly viewType = 'overtex.pdfPreview';

  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private pdfFile: string | undefined;
  private pendingReveal: PageRect | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly mediaRoot: vscode.Uri;
  /** Set when the setting could not be written; the preview shows it until the setting changes. */
  private schemeOverride: ColorScheme | undefined;
  /** Where the open PDF's notes are saved; undefined for a PDF that has none. */
  private notesFile: string | undefined;
  /** Runs note changes one at a time, since each one reads and rewrites the file. */
  private notesQueue: Promise<void> = Promise.resolve();
  /** The unreadable notes file already warned about, so that each rebuild does not warn again. */
  private warnedNotesFile: string | undefined;

  constructor(
    extensionUri: vscode.Uri,
    private readonly onInverseSearch: (pdfFile: string, page: number, x: number, y: number) => void,
    private readonly log: (text: string) => void,
    private readonly colorScheme: () => ColorScheme,
    /** Receives the viewer's test messages; set only by the end-to-end tests. */
    private readonly onE2eMessage?: (msg: E2eFromViewerMessage) => void
  ) {
    this.mediaRoot = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
  }

  get currentPdf(): string | undefined {
    return this.panel ? this.pdfFile : undefined;
  }

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** Opens the preview (or brings it forward) and loads `pdfFile`. */
  async show(pdfFile: string, preserveFocus = true, notesFile?: string): Promise<void> {
    if (!this.panel) {
      this.create();
    } else if (!this.panel.visible) {
      this.panel.reveal(vscode.ViewColumn.Beside, preserveFocus);
    }
    this.notesFile = notesFile;
    await this.load(pdfFile);
  }

  /** Reloads the PDF if the preview is open. Keeps the viewer's scroll and zoom. */
  async refresh(pdfFile: string, notesFile?: string): Promise<void> {
    if (this.panel) {
      this.notesFile = notesFile;
      await this.load(pdfFile);
    }
  }

  reveal(target: PageRect): void {
    if (!this.panel) {
      return;
    }
    if (!this.panel.visible) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    }
    if (this.ready) {
      this.post({ type: 'reveal', target });
    } else {
      this.pendingReveal = target;
    }
  }

  /** Sends the current `overtex.viewer.colorScheme` to the open preview. */
  updateColorScheme(): void {
    this.schemeOverride = undefined;
    this.post({ type: 'colorScheme', scheme: this.currentScheme() });
  }

  private currentScheme(): ColorScheme {
    return this.schemeOverride ?? this.colorScheme();
  }

  /**
   * Flips the preview between light and dark pages by writing `overtex.viewer.colorScheme`,
   * in the workspace when it is set there, else in the user settings. If the setting cannot be
   * written (VS Code does not know it until the window is reloaded after an update), the open
   * preview still flips.
   */
  async toggleColorScheme(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('overtex');
    const inspected = cfg.inspect('viewer.colorScheme');
    const kind = vscode.window.activeColorTheme.kind;
    const themeIsDark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
    const next = toggledScheme(this.currentScheme(), themeIsDark);
    const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    try {
      await cfg.update('viewer.colorScheme', next, target);
    } catch (err) {
      this.log(`Could not save overtex.viewer.colorScheme: ${err instanceof Error ? err.message : String(err)}\n`);
      this.schemeOverride = next;
      this.post({ type: 'colorScheme', scheme: next });
      void vscode.window
        .showWarningMessage('Overtex could not save the page color setting. Reload the window to fix this.', 'Reload Window')
        .then((choice) => choice && vscode.commands.executeCommand('workbench.action.reloadWindow'));
    }
  }

  /** End-to-end tests only. */
  postE2e(msg: E2eToViewerMessage): void {
    this.post(msg);
  }

  private create(): void {
    this.ready = false;
    this.panel = vscode.window.createWebviewPanel(
      PdfPanel.viewType,
      'PDF Preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.mediaRoot],
      }
    );
    this.panel.iconPath = new vscode.ThemeIcon('file-pdf');
    this.panel.webview.html = this.html(this.panel.webview);

    this.panel.webview.onDidReceiveMessage((msg: FromViewerMessage) => this.onMessage(msg), null, this.disposables);
    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.ready = false;
      },
      null,
      this.disposables
    );
  }

  private async load(pdfFile: string): Promise<void> {
    this.pdfFile = pdfFile;
    if (!this.panel) {
      return;
    }
    this.panel.title = path.basename(pdfFile);
    if (!this.ready) {
      return; // Sent once the viewer reports ready.
    }
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(pdfFile));
      const notes = await this.notesForViewer();
      this.post({ type: 'load', data: toStandaloneArrayBuffer(data), fileName: path.basename(pdfFile), notes });
    } catch (err) {
      this.log(`Could not read ${pdfFile}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  private async notesForViewer(): Promise<Note[] | null> {
    const file = this.notesFile;
    if (!file) {
      return null;
    }
    try {
      const notes = await readNotes(file);
      this.warnedNotesFile = undefined;
      return notes;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`Could not read PDF notes from ${file}: ${reason}\n`);
      if (this.warnedNotesFile !== file) {
        this.warnedNotesFile = file;
        void vscode.window.showWarningMessage(`Overtex could not read the PDF notes in ${path.basename(file)}, so they are not shown. Fix the file to get them back.`);
      }
      return [];
    }
  }

  /** Applies a change to the notes on disk, so that notes changed by git or by hand are kept. */
  private changeNotes(change: (notes: Note[]) => Note[], text?: string): void {
    const file = this.notesFile;
    if (!file) {
      return;
    }
    this.notesQueue = this.notesQueue.then(async () => {
      try {
        await writeNotes(file, change(await readNotes(file)));
      } catch (err) {
        // The editor has closed by now, so the log is the only place left that has the text.
        this.log(`Could not save PDF notes to ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
        if (text !== undefined) {
          this.log(`The note that was not saved:\n${text}\n`);
        }
        void vscode.window.showWarningMessage(`Overtex could not save the note to ${path.basename(file)}. The note's text is in the build log.`);
      }
      if (this.notesFile === file) {
        this.post({ type: 'notes', notes: await this.notesForViewer() });
      }
    });
  }

  private async onMessage(msg: FromViewerMessage): Promise<void> {
    if (isE2eMessage(msg)) {
      this.onE2eMessage?.(msg);
      return;
    }
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        if (this.pdfFile) {
          await this.load(this.pdfFile);
        }
        if (this.pendingReveal) {
          this.post({ type: 'reveal', target: this.pendingReveal });
          this.pendingReveal = undefined;
        }
        break;
      case 'inverseSearch':
        if (this.pdfFile) {
          this.onInverseSearch(this.pdfFile, msg.page, msg.x, msg.y);
        }
        break;
      case 'error':
        this.log(`PDF viewer: ${msg.message}\n`);
        break;
      case 'toggleColorScheme':
        await this.toggleColorScheme();
        break;
      case 'addNote': {
        const { page, x, y, text } = msg;
        const note: Note = { id: randomUUID(), page, x, y, text, createdAt: new Date().toISOString() };
        // A note that fails this would make the whole file unreadable on the next load.
        if (isNote(note)) {
          this.changeNotes((notes) => [...notes, note], text);
        }
        break;
      }
      case 'updateNote':
        if (typeof msg.text === 'string') {
          this.changeNotes((notes) => notes.map((n) => (n.id === msg.id ? { ...n, text: msg.text } : n)), msg.text);
        }
        break;
      case 'deleteNote':
        this.changeNotes((notes) => notes.filter((n) => n.id !== msg.id));
        break;
    }
  }

  private post(msg: ToViewerMessage): void {
    void this.panel?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, name)).toString();
    const nonce = createNonce();
    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} blob: data:`,
      `font-src ${webview.cspSource} blob: data:`,
      `worker-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource} blob: data:`,
    ].join('; ');
    const isMac = process.platform === 'darwin';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('pdfViewer.css')}">
  <title>PDF Preview</title>
</head>
<body
  data-worker="${asset('pdf.worker.min.mjs')}"
  data-cmaps="${asset('cmaps/')}"
  data-fonts="${asset('standard_fonts/')}"
  data-wasm="${asset('wasm/')}"
  data-modifier="${isMac ? 'meta' : 'ctrl'}"
  data-scheme="${this.currentScheme()}"${this.onE2eMessage ? ' data-e2e' : ''}>
  <div class="toolbar" role="toolbar">
    <button id="zoom-out" title="Zoom out" aria-label="Zoom out">&minus;</button>
    <select id="zoom" aria-label="Zoom">
      <option value="page-width">Fit width</option>
      <option value="page-fit">Fit page</option>
      <option value="0.75">75%</option>
      <option value="1">100%</option>
      <option value="1.25">125%</option>
      <option value="1.5">150%</option>
      <option value="2">200%</option>
    </select>
    <button id="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
    <button id="dark-mode" title="Dark pages" aria-label="Dark pages" aria-pressed="false">&#9680;</button>
    <button id="toggle-notes" title="Hide notes" aria-label="Show notes" aria-pressed="true">&#9998;</button>
    <span class="spacer"></span>
    <span id="page-info" aria-live="polite"></span>
    <span id="notes-hint" class="hint">Double-click to add a note</span>
    <span class="hint">${isMac ? '⌘' : 'Ctrl'}+click to jump to source</span>
  </div>
  <div id="viewer" tabindex="0"><div id="pages"></div><p id="empty">Build the project to see the PDF.</p></div>
  <script type="module" nonce="${nonce}" src="${asset('pdfViewer.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

async function readNotes(file: string): Promise<Note[]> {
  let data: Uint8Array;
  try {
    data = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
      return [];
    }
    throw err;
  }
  return parseNotes(Buffer.from(data).toString('utf-8'));
}

/**
 * Replaces the file in one step, so that a failed write cannot leave half of it. Removes it when no
 * notes are left. Uses Node's fs: renaming over the file with `workspace.fs` makes the Explorer drop
 * it from the tree until the folder is reloaded.
 */
async function writeNotes(file: string, notes: Note[]): Promise<void> {
  if (notes.length === 0) {
    await fs.rm(file, { force: true });
    return;
  }
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, serializeNotes(notes));
  await fs.rename(temp, file);
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
