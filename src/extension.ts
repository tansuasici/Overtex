import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import type { OvertexApi } from './api';
import { buildSettings, settings } from './config';
import { registerBibCompletion } from './latex/bibCompletion';
import { BuildResult, Builder, outputPaths } from './latex/builder';
import { BuildDiagnostics } from './latex/diagnostics';
import { findMainFile } from './latex/mainFile';
import { BuildStatus } from './statusBar';
import { SyncTex } from './synctex/synctex';
import { PdfPanel } from './viewer/pdfPanel';

const TEX_LANGUAGES = new Set(['latex', 'tex']);

export function activate(context: vscode.ExtensionContext): OvertexApi {
  const output = vscode.window.createOutputChannel('Overtex');
  const log = (text: string) => output.append(text);

  const builder = new Builder(buildSettings, log);
  const diagnostics = new BuildDiagnostics();
  const status = new BuildStatus();
  const synctex = new SyncTex(settings.synctexPath);
  const onDidStartBuild = new vscode.EventEmitter<{ mainFile: string }>();
  const onDidEndBuild = new vscode.EventEmitter<BuildResult>();

  const pdfPanel = new PdfPanel(context.extensionUri, (pdfFile, page, x, y) => void inverseSearch(pdfFile, page, x, y), log);

  context.subscriptions.push(output, diagnostics, status, pdfPanel, onDidStartBuild, onDidEndBuild, registerBibCompletion());

  // ---- Main file and output paths ----

  function mainFile(): string | null {
    const editor = vscode.window.activeTextEditor;
    const active =
      editor && TEX_LANGUAGES.has(editor.document.languageId) && editor.document.uri.scheme === 'file'
        ? { path: editor.document.uri.fsPath, text: editor.document.getText() }
        : undefined;
    const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : vscode.workspace.workspaceFolders?.[0];
    return findMainFile({
      workspaceRoot: folder?.uri.fsPath,
      configured: settings.mainFile(),
      active,
    });
  }

  function pdfFor(main: string): string {
    return outputPaths(main, buildSettings().outDir).pdf;
  }

  // ---- Build ----

  let savingForBuild = false;

  async function build(target?: string): Promise<BuildResult | undefined> {
    const main = target ?? mainFile();
    if (!main) {
      void vscode.window.showWarningMessage('Overtex: no LaTeX document found to build.');
      return undefined;
    }

    // Unsaved edits in other files would otherwise be missing from the PDF.
    savingForBuild = true;
    try {
      await Promise.all(
        vscode.workspace.textDocuments
          .filter((d) => d.isDirty && d.uri.scheme === 'file' && /\.(tex|bib|sty|cls)$/i.test(d.fileName))
          .map((d) => d.save())
      );
    } finally {
      savingForBuild = false;
    }

    status.building();
    onDidStartBuild.fire({ mainFile: main });
    const result = await builder.build(main);
    status.finished(result);
    diagnostics.update(result.entries, main);
    onDidEndBuild.fire(result);

    if (result.cancelled) {
      return result;
    }
    if (result.pdfFile) {
      if (pdfPanel.isOpen) {
        await pdfPanel.refresh(result.pdfFile);
      } else if (result.success && settings.autoOpenViewer()) {
        await pdfPanel.show(result.pdfFile);
      }
    }
    if (!result.success) {
      const errors = result.entries.filter((e) => e.severity === 'error');
      const first = errors[0]?.message ?? 'see the build log';
      const choice = await vscode.window.showErrorMessage(`Overtex: build failed: ${first}`, 'Show Problems', 'Show Log');
      if (choice === 'Show Problems') {
        void vscode.commands.executeCommand('workbench.actions.view.problems');
      } else if (choice === 'Show Log') {
        output.show(true);
      }
    }
    return result;
  }

  // ---- PDF and SyncTeX ----

  async function viewPdf(): Promise<void> {
    const main = mainFile();
    if (!main) {
      void vscode.window.showWarningMessage('Overtex: no LaTeX document found.');
      return;
    }
    const pdf = pdfFor(main);
    if (fs.existsSync(pdf)) {
      await pdfPanel.show(pdf, false);
    } else {
      await build(main);
    }
  }

  async function forwardSearch(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const main = mainFile();
    if (!editor || !main) {
      return;
    }
    const pdf = pdfFor(main);
    if (!fs.existsSync(pdf)) {
      void vscode.window.showInformationMessage('Overtex: build the project first.');
      return;
    }
    if (pdfPanel.currentPdf !== pdf) {
      await pdfPanel.show(pdf);
    }
    const pos = editor.selection.active;
    try {
      const target = await synctex.forward(pdf, editor.document.uri.fsPath, pos.line + 1, pos.character);
      if (target) {
        pdfPanel.reveal(target);
      } else {
        log(`SyncTeX: no PDF location for ${path.basename(editor.document.fileName)}:${pos.line + 1}\n`);
      }
    } catch (err) {
      reportSynctexError(err);
    }
  }

  async function inverseSearch(pdfFile: string, page: number, x: number, y: number): Promise<void> {
    try {
      const source = await synctex.inverse(pdfFile, page, x, y);
      if (!source) {
        return;
      }
      const doc = await vscode.workspace.openTextDocument(source.file);
      const position = new vscode.Position(source.line - 1, source.column);
      const viewColumn =
        vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === doc.uri.fsPath)?.viewColumn ??
        vscode.window.visibleTextEditors.find((e) => TEX_LANGUAGES.has(e.document.languageId))?.viewColumn ??
        vscode.ViewColumn.One;
      const editor = await vscode.window.showTextDocument(doc, { viewColumn, selection: new vscode.Range(position, position) });
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (err) {
      reportSynctexError(err);
    }
  }

  function reportSynctexError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    log(`${message}\n`);
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT' || /ENOENT/.test(message)) {
      void vscode.window.showErrorMessage('Overtex: could not run synctex. Install TeX Live/MiKTeX or set overtex.synctex.path.');
    }
  }

  // ---- Commands ----

  context.subscriptions.push(
    vscode.commands.registerCommand('overtex.build', () => build()),
    vscode.commands.registerCommand('overtex.cancelBuild', () => builder.cancel()),
    vscode.commands.registerCommand('overtex.viewPdf', viewPdf),
    vscode.commands.registerCommand('overtex.forwardSearch', forwardSearch),
    vscode.commands.registerCommand('overtex.showLog', () => output.show()),
    vscode.commands.registerCommand('overtex.clean', async () => {
      const main = mainFile();
      if (main) {
        await builder.clean(main);
        diagnostics.clear();
        void vscode.window.setStatusBarMessage('Overtex: auxiliary files removed', 3000);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const isSource = TEX_LANGUAGES.has(doc.languageId) || doc.languageId === 'bibtex';
      if (isSource && doc.uri.scheme === 'file' && !savingForBuild && settings.buildOnSave()) {
        void build();
      }
    })
  );

  // ---- Status bar only in LaTeX workspaces ----

  const updateStatusVisibility = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && TEX_LANGUAGES.has(editor.document.languageId)) {
      status.show();
    }
  };
  updateStatusVisibility();
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusVisibility));

  warnAboutLatexWorkshop(context);

  return {
    version: 1,
    build: (main?: string) => build(main),
    onDidStartBuild: onDidStartBuild.event,
    onDidEndBuild: onDidEndBuild.event,
    viewPdf,
    forwardSearch,
  };
}

/** Both extensions building on save would run TeX twice on every save. */
function warnAboutLatexWorkshop(context: vscode.ExtensionContext): void {
  const key = 'overtex.latexWorkshopWarningDismissed';
  if (!vscode.extensions.getExtension('James-Yu.latex-workshop') || context.globalState.get(key)) {
    return;
  }
  void vscode.window
    .showWarningMessage(
      'Overtex: LaTeX Workshop is also installed. Both will build on save; consider disabling one of them for this workspace.',
      "Don't Show Again"
    )
    .then((choice) => {
      if (choice) {
        void context.globalState.update(key, true);
      }
    });
}

export function deactivate(): void {}
