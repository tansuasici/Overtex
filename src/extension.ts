import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import type { OvertexApi, OvertexE2e } from './api';
import type { E2eFromViewerMessage } from './shared/messages';
import { buildSettings, settings } from './config';
import { registerBibCompletion } from './latex/bibCompletion';
import { BuildResult, Builder, outputPaths } from './latex/builder';
import { LATEX_WORKSHOP_ID, LW_AUTOBUILD_SETTING, hasBuildConflict } from './latex/conflicts';
import { BuildDiagnostics } from './latex/diagnostics';
import { findMainFile } from './latex/mainFile';
import { Texlab } from './latex/texlab';
import { BuildStatus } from './statusBar';
import { toWorkspacePath } from './synctex/paths';
import { SyncTex } from './synctex/synctex';
import { PdfPanel } from './viewer/pdfPanel';
import { checkSetupCommand, nudgeIfSetupMissing, openWalkthrough } from './setupCheck';
import { NEW_DOCUMENT_TEMPLATE } from './latex/setup';

const TEX_LANGUAGES = new Set(['latex', 'tex']);

let texlab: Texlab | undefined;

export function activate(context: vscode.ExtensionContext): OvertexApi {
  const output = vscode.window.createOutputChannel('Overtex');
  const log = (text: string) => output.append(text);

  const builder = new Builder(buildSettings, log);
  const diagnostics = new BuildDiagnostics();
  const status = new BuildStatus();
  const synctex = new SyncTex(settings.synctexPath);
  const onDidStartBuild = new vscode.EventEmitter<{ mainFile: string }>();
  const onDidEndBuild = new vscode.EventEmitter<BuildResult>();

  // OVERTEX_E2E is set only by the end-to-end test runner (test/e2e).
  const e2eEvents = process.env.OVERTEX_E2E ? new vscode.EventEmitter<E2eFromViewerMessage>() : undefined;
  const pdfPanel = new PdfPanel(
    context.extensionUri,
    (pdfFile, page, x, y) => void inverseSearch(pdfFile, page, x, y),
    log,
    e2eEvents && ((msg) => e2eEvents.fire(msg))
  );
  if (e2eEvents) {
    context.subscriptions.push(e2eEvents);
  }

  texlab = new Texlab(context, log);
  const server = texlab;
  // TexLab completes citations too; the built-in completion is the fallback when it is not running.
  const bibCompletion = registerBibCompletion(() => !server.isRunning);

  context.subscriptions.push(output, diagnostics, status, pdfPanel, onDidStartBuild, onDidEndBuild, texlab, bibCompletion);
  void texlab.start();

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

  /** latexmk can run arbitrary Perl from a project's .latexmkrc, so never run it in an untrusted workspace. */
  function requireTrust(action: string): boolean {
    if (vscode.workspace.isTrusted) {
      return true;
    }
    void vscode.window
      .showWarningMessage(`Overtex: ${action} is disabled because this workspace is not trusted.`, 'Manage Workspace Trust')
      .then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand('workbench.trust.manage');
        }
      });
    return false;
  }

  async function build(target?: string): Promise<BuildResult | undefined> {
    if (!requireTrust('Building')) {
      return undefined;
    }
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
      // A missing latexmk shows up as a spawn error; point at the setup check instead of the log.
      const notInstalled = errors.some((e) => e.message.startsWith('Could not run "') && e.message.includes('Install a TeX distribution'));
      const buttons = notInstalled ? ['Check Setup', 'Show Log'] : ['Show Problems', 'Show Log'];
      const choice = await vscode.window.showErrorMessage(`Overtex: build failed: ${first}`, ...buttons);
      if (choice === 'Check Setup') {
        void vscode.commands.executeCommand('overtex.checkSetup');
      } else if (choice === 'Show Problems') {
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
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const doc = await vscode.workspace.openTextDocument(toWorkspacePath(source.file, folders, fs.realpathSync.native));
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
      void vscode.window
        .showErrorMessage('Overtex: could not run synctex. Install TeX Live/MiKTeX or set overtex.synctex.path.', 'Check Setup')
        .then((choice) => choice && vscode.commands.executeCommand('overtex.checkSetup'));
    }
  }

  // ---- Commands ----

  context.subscriptions.push(
    vscode.commands.registerCommand('overtex.build', () => build()),
    vscode.commands.registerCommand('overtex.cancelBuild', () => builder.cancel()),
    vscode.commands.registerCommand('overtex.viewPdf', viewPdf),
    vscode.commands.registerCommand('overtex.forwardSearch', forwardSearch),
    vscode.commands.registerCommand('overtex.showLog', () => output.show()),
    vscode.commands.registerCommand('overtex.checkSetup', () => checkSetupCommand(output)),
    vscode.commands.registerCommand('overtex.gettingStarted', openWalkthrough),
    vscode.commands.registerCommand('overtex.newDocument', newDocument),
    vscode.commands.registerCommand('overtex.clean', async () => {
      const main = mainFile();
      if (main && requireTrust('Cleaning')) {
        await builder.clean(main);
        diagnostics.clear();
        void vscode.window.setStatusBarMessage('Overtex: auxiliary files removed', 3000);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const isSource = TEX_LANGUAGES.has(doc.languageId) || doc.languageId === 'bibtex';
      // Untrusted workspaces skip build-on-save silently instead of warning on every save.
      if (isSource && doc.uri.scheme === 'file' && !savingForBuild && vscode.workspace.isTrusted && settings.buildOnSave()) {
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
  nudgeIfSetupMissing(context);

  const e2e: OvertexE2e | undefined = e2eEvents && {
    onViewerMessage: e2eEvents.event,
    sendToViewer: (msg) => pdfPanel.postE2e(msg),
  };

  return {
    version: 1,
    ...(e2e && { e2e }),
    build: (main?: string) => build(main),
    onDidStartBuild: onDidStartBuild.event,
    onDidEndBuild: onDidEndBuild.event,
    viewPdf,
    forwardSearch,
  };
}

/** Creates main.tex in the first workspace folder, or an untitled document when no folder is open. */
async function newDocument(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    const doc = await vscode.workspace.openTextDocument({ language: 'latex', content: NEW_DOCUMENT_TEMPLATE });
    await vscode.window.showTextDocument(doc);
    return;
  }
  let target = vscode.Uri.joinPath(folder.uri, 'main.tex');
  for (let n = 2; fs.existsSync(target.fsPath); n++) {
    target = vscode.Uri.joinPath(folder.uri, `main-${n}.tex`);
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(NEW_DOCUMENT_TEMPLATE, 'utf8'));
  await vscode.window.showTextDocument(target);
}

/**
 * Both extensions building on save would run TeX twice on every save. Offer to turn off one
 * of the two auto-builds; stays quiet once either is off.
 */
function warnAboutLatexWorkshop(context: vscode.ExtensionContext): void {
  const key = 'overtex.latexWorkshopWarningDismissed';
  if (context.globalState.get(key)) {
    return;
  }
  const lw = vscode.workspace.getConfiguration('latex-workshop');
  const conflict = hasBuildConflict({
    latexWorkshopInstalled: vscode.extensions.getExtension(LATEX_WORKSHOP_ID) !== undefined,
    latexWorkshopAutoBuild: lw.get<string>(LW_AUTOBUILD_SETTING),
    overtexBuildOnSave: settings.buildOnSave(),
  });
  if (!conflict) {
    return;
  }
  const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const disableLw = 'Turn Off LaTeX Workshop Auto-Build';
  const disableOvertex = 'Turn Off Overtex Build on Save';
  const dismiss = "Don't Show Again";
  void vscode.window
    .showWarningMessage(
      'Overtex: LaTeX Workshop also builds on save, so every save would run TeX twice. Turn off one of them?',
      disableLw,
      disableOvertex,
      dismiss
    )
    .then(async (choice) => {
      if (choice === disableLw) {
        await lw.update(LW_AUTOBUILD_SETTING, 'never', target);
      } else if (choice === disableOvertex) {
        await vscode.workspace.getConfiguration('overtex').update('build.onSave', false, target);
      } else if (choice === dismiss) {
        await context.globalState.update(key, true);
      }
    });
}

export function deactivate(): Promise<void> | undefined {
  return texlab?.stop();
}
