import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import type { OvertexApi, OvertexE2e } from './api';
import { BibIndex } from './latex/bibIndex';
import { registerLabels } from './labels';
import { registerInsertHelpers } from './insertHelpers';
import { registerLibrary } from './library';
import type { E2eFromViewerMessage } from './shared/messages';
import { buildSettings, settings } from './config';
import { registerBibCompletion } from './latex/bibCompletion';
import { BuildResult, Builder, isToolMissingMessage, outputPaths } from './latex/builder';
import { LATEX_WORKSHOP_ID, LW_AUTOBUILD_SETTING, hasBuildConflict } from './latex/conflicts';
import { BuildDiagnostics } from './latex/diagnostics';
import { findMainFile } from './latex/mainFile';
import { Texlab } from './latex/texlab';
import { TEXLAB_EXTENSION_ID } from './latex/texlabConfig';
import { BuildStatus } from './statusBar';
import { toWorkspacePath } from './synctex/paths';
import { SyncTex } from './synctex/synctex';
import { PdfPanel } from './viewer/pdfPanel';
import { notesFilePath } from './shared/notes';
import { checkSetupCommand, nudgeIfSetupMissing, openWalkthrough } from './setupCheck';
import { TEMPLATES, placeTemplate } from './latex/templates';
import { addCitation } from './addCitation';
import { citeFromZotero } from './citeFromZotero';
import { CompareArgs, compareVersionsCommand } from './compareVersions';
import { ReviewArgs, exportReviewPdfCommand } from './reviewPdf';
import { exportArxiv } from './exportArxiv';
import { SubmissionCheck } from './checkSubmission';
import { BibliographyCheck } from './checkBib';
import { WordCounter } from './wordCount';
import { Highlighter } from './highlighter';
import { registerMathPreview } from './mathPreview';

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
    settings.viewerColorScheme,
    context.workspaceState,
    e2eEvents && ((msg) => e2eEvents.fire(msg))
  );
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(PdfPanel.viewType, {
      deserializeWebviewPanel: (panel) => pdfPanel.restore(panel),
    })
  );
  if (e2eEvents) {
    context.subscriptions.push(e2eEvents);
  }

  texlab = new Texlab(context, log);
  const server = texlab;
  // TexLab completes citations too; the built-in completion is the fallback when it is not running.
  const bibIndex = new BibIndex();
  const bibCompletion = registerBibCompletion(bibIndex, () => !server.isRunning);

  context.subscriptions.push(output, diagnostics, status, pdfPanel, onDidStartBuild, onDidEndBuild, texlab, bibIndex, bibCompletion);
  // Submission findings describe one build; the next build clears them.
  const submission = new SubmissionCheck(mainFile, build);
  const version = (context.extension.packageJSON as { version?: string }).version ?? '';
  const userAgent = `Overtex/${version} (https://github.com/tansuasici/Overtex)`;
  const bibCheck = new BibliographyCheck(mainFile, userAgent);
  const papers = registerLibrary(context, { index: bibIndex, mainFile, userAgent, showPdf: (pdf) => pdfPanel.show(pdf) });
  const labels = registerLabels(context, {
    useFallbackProviders: () => !server.isRunning && !vscode.extensions.getExtension(TEXLAB_EXTENSION_ID),
  });
  const insertHelpers = registerInsertHelpers(context, {
    mainFile,
    labelKeys: async () => (await labels.groups()).flatMap((g) => g.keys),
  });
  context.subscriptions.push(bibCheck);
  context.subscriptions.push(submission, onDidStartBuild.event(() => submission.clear()));
  const words = new WordCounter(mainFile);
  context.subscriptions.push(
    words,
    onDidEndBuild.event((result) => result.success && void words.update(result.mainFile)),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('overtex.wordCount') && words.refresh())
  );
  context.subscriptions.push(new Highlighter(), registerMathPreview(context.extensionPath, mainFile));
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

  /** Unsaved edits in other files would otherwise be missing from the PDF. */
  async function saveSources(): Promise<void> {
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

    await saveSources();

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
        await pdfPanel.refresh(result.pdfFile, notesFilePath(main));
      } else if (result.success && settings.autoOpenViewer()) {
        await pdfPanel.show(result.pdfFile, true, notesFilePath(main));
      }
    }
    if (!result.success) {
      const errors = result.entries.filter((e) => e.severity === 'error');
      const first = errors[0]?.message ?? 'see the build log';
      // A missing build tool shows up as a spawn error; point at the setup check instead of the log.
      const notInstalled = errors.some((e) => isToolMissingMessage(e.message));
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
      await pdfPanel.show(pdf, false, notesFilePath(main));
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
      await pdfPanel.show(pdf, true, notesFilePath(main));
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
    vscode.commands.registerCommand('overtex.viewer.moveToNewWindow', async () => {
      if (!pdfPanel.isOpen) {
        await viewPdf();
      }
      await pdfPanel.moveToNewWindow();
    }),
    vscode.commands.registerCommand('overtex.viewer.present', async () => {
      if (!pdfPanel.isOpen) {
        await viewPdf();
      }
      pdfPanel.present();
    }),
    vscode.commands.registerCommand('overtex.forwardSearch', forwardSearch),
    vscode.commands.registerCommand('overtex.showLog', () => output.show()),
    vscode.commands.registerCommand('overtex.checkSetup', () => checkSetupCommand(output)),
    vscode.commands.registerCommand('overtex.gettingStarted', openWalkthrough),
    vscode.commands.registerCommand('overtex.newDocument', newDocument),
    vscode.commands.registerCommand('overtex.addCitation', () => addCitation(mainFile)),
    vscode.commands.registerCommand('overtex.citeFromZotero', () => citeFromZotero(mainFile)),
    vscode.commands.registerCommand('overtex.exportArxiv', () => exportArxiv(mainFile, build)),
    vscode.commands.registerCommand('overtex.checkSubmission', () => submission.run()),
    vscode.commands.registerCommand('overtex.checkBibliography', (uri?: vscode.Uri) => bibCheck.run(uri instanceof vscode.Uri ? uri : undefined)),
    vscode.commands.registerCommand('overtex.countWords', () => words.run()),
    vscode.commands.registerCommand('overtex.compareVersions', (args?: CompareArgs) =>
      requireTrust('Comparing versions')
        ? compareVersionsCommand({ mainFile, saveSources, showPdf: (pdf) => pdfPanel.show(pdf), log, showLog: () => output.show() }, args)
        : undefined
    ),
    vscode.commands.registerCommand('overtex.exportReviewPdf', (args?: ReviewArgs) =>
      requireTrust('Exporting a review PDF')
        ? exportReviewPdfCommand(
            {
              mainFile,
              build,
              inverse: (pdf, page, x, y) => synctex.inverse(pdf, page, x, y),
              saveSources,
              showPdf: (pdf) => pdfPanel.show(pdf),
              log,
              showLog: () => output.show(),
            },
            args
          )
        : undefined
    ),
    vscode.commands.registerCommand('overtex.viewer.toggleDarkMode', () => pdfPanel.toggleColorScheme()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('overtex.viewer.colorScheme')) {
        pdfPanel.updateColorScheme();
      }
    }),
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
    viewerColumn: () => pdfPanel.column,
    restoreViewer: (panel) => pdfPanel.restore(panel),
    paperGroups: () => papers.groups(),
    labelGroups: () => labels.groups(),
    insertFiles: (files) => insertHelpers.insertFiles(files),
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
  const pick = await vscode.window.showQuickPick(
    TEMPLATES.map((t) => ({ label: t.label, description: t.description, template: t })),
    { title: 'New LaTeX Document', placeHolder: 'Choose a template' }
  );
  if (!pick) {
    return;
  }
  const template = pick.template;

  let root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const openAfter = !root;
  if (!root) {
    if (template.files.length === 1) {
      const doc = await vscode.workspace.openTextDocument({ language: 'latex', content: template.files[0].content });
      await vscode.window.showTextDocument(doc);
      return;
    }
    const chosen = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      openLabel: 'Create Project Here',
      title: `New ${template.label}: choose a folder`,
    });
    if (!chosen?.[0]) {
      return;
    }
    root = chosen[0];
  }

  const base = root;
  const dir = placeTemplate(template, (rel) => fs.existsSync(path.join(base.fsPath, ...rel.split('/'))));
  const projectDir = dir ? vscode.Uri.joinPath(base, dir) : base;
  for (const file of template.files) {
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(projectDir, ...file.path.split('/')), Buffer.from(file.content, 'utf8'));
  }

  if (openAfter) {
    await vscode.commands.executeCommand('vscode.openFolder', projectDir);
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.joinPath(projectDir, template.main));
  if (dir) {
    void vscode.window.setStatusBarMessage(`Overtex: created the ${template.label.toLowerCase()} in ${dir}/`, 5000);
  }
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
