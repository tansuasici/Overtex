import * as vscode from 'vscode';
import * as fs from 'fs';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';

import { findExecutable } from './executable';
import { texEnv } from './texEnv';
import {
  TEXLAB_EXTENSION_ID,
  texlabCannotOpen,
  texlabOptions,
  texlabStartDecision,
  texlabUri,
  withoutBuildLogDiagnostics,
} from './texlabConfig';

const HINT_DISMISSED_KEY = 'overtex.texlabMissingHintDismissed';
const INSTALL_URL = 'https://github.com/latex-lsp/texlab#installation';

const sendable = (uri: vscode.Uri): boolean => uri.scheme !== 'file' || !texlabCannotOpen(uri.fsPath);

/**
 * Runs the TexLab language server for live diagnostics, completion, hover and navigation.
 * Optional: without texlab Overtex keeps working with its own `\cite` completion.
 */
export class Texlab implements vscode.Disposable {
  private client: LanguageClient | undefined;
  private starting: Promise<void> | undefined;
  /** Set by the first start(); until then trust and setting changes must not start TexLab. */
  private wanted = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (text: string) => void
  ) {
    this.disposables.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.restart()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('overtex.texlab') || e.affectsConfiguration('overtex.latex.outDir')) {
          void this.restart();
        }
      })
    );
  }

  get isRunning(): boolean {
    return this.client?.isRunning() ?? false;
  }

  start(): Promise<void> {
    this.wanted = true;
    this.starting ??= this.doStart().finally(() => (this.starting = undefined));
    return this.starting;
  }

  async restart(): Promise<void> {
    if (!this.wanted) {
      return;
    }
    await this.starting;
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      await client.stop().catch(() => undefined);
    }
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
    void this.stop();
  }

  private async doStart(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('overtex');
    const decision = texlabStartDecision({
      enabled: cfg.get<boolean>('texlab.enabled', true),
      workspaceTrusted: vscode.workspace.isTrusted,
      officialExtensionInstalled: vscode.extensions.getExtension(TEXLAB_EXTENSION_ID) !== undefined,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    });
    if (decision !== 'start') {
      this.log(`TexLab: not started (${decision}).\n`);
      if (decision === 'bracket-path') {
        this.warnBracketPath();
      }
      return;
    }

    const configured = cfg.get<string>('texlab.path') || 'texlab';
    const env = texEnv();
    const command = findExecutable(configured, env, process.platform, (p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!command) {
      this.log(`TexLab: "${configured}" not found; live diagnostics and completion are off.\n`);
      this.showInstallHint();
      return;
    }

    const options = () =>
      texlabOptions({
        outDir: vscode.workspace.getConfiguration('overtex').get<string>('latex.outDir', ''),
        chktex: vscode.workspace.getConfiguration('overtex').get<boolean>('texlab.chktex', false),
      });

    // texlab runs kpsewhich and chktex, which must be found too.
    const serverOptions: ServerOptions = { command, args: [], options: { env } };
    const clientOptions: LanguageClientOptions = {
      documentSelector: [
        { scheme: 'file', language: 'latex' },
        { scheme: 'file', language: 'bibtex' },
        { scheme: 'untitled', language: 'latex' },
        { scheme: 'untitled', language: 'bibtex' },
      ],
      initializationOptions: options(),
      outputChannelName: 'Overtex: TexLab',
      uriConverters: {
        code2Protocol: (uri) => texlabUri(uri.toString()),
        protocol2Code: (value) => vscode.Uri.parse(value),
      },
      middleware: {
        // texlab pulls its "texlab" section; Overtex has no such settings, so answer with its own.
        workspace: {
          configuration: (params) => params.items.map((item) => (item.section === 'texlab' ? options() : null)),
        },
        handleDiagnostics: (uri, diagnostics, next) => next(uri, withoutBuildLogDiagnostics(diagnostics)),
        // texlab crashes on a path with [ or ]; such a file opened from outside the workspace is not sent.
        didOpen: (doc, next) => (sendable(doc.uri) ? next(doc) : this.warnBracketPath()),
        didChange: (event, next) => (sendable(event.document.uri) ? next(event) : Promise.resolve()),
        didSave: (doc, next) => (sendable(doc.uri) ? next(doc) : Promise.resolve()),
        didClose: (doc, next) => (sendable(doc.uri) ? next(doc) : Promise.resolve()),
      },
    };

    const client = new LanguageClient('overtex.texlab', 'TexLab', serverOptions, clientOptions);
    try {
      await client.start();
      this.client = client;
      this.log(`TexLab: started (${command}).\n`);
    } catch (err) {
      this.log(`TexLab: failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
      await client.dispose().catch(() => undefined);
    }
  }

  private bracketWarned = false;

  /** Once per session: say why TexLab is off for a folder whose name has [ or ]. */
  private warnBracketPath(): Promise<void> {
    if (!this.bracketWarned) {
      this.bracketWarned = true;
      this.log('TexLab: skipped a path with [ or ]; texlab cannot read such paths.\n');
      void vscode.window.showWarningMessage(
        'Overtex: TexLab cannot check files in a folder whose name contains [ or ], so live error checking and completion are off there. Renaming the folder turns them back on.'
      );
    }
    return Promise.resolve();
  }

  private showInstallHint(): void {
    if (this.context.globalState.get(HINT_DISMISSED_KEY)) {
      return;
    }
    const install = 'How to Install';
    const dismiss = "Don't Show Again";
    void vscode.window
      .showInformationMessage(
        'Overtex: install TexLab for live error checking and smarter completion (labels, commands, citations).',
        install,
        dismiss
      )
      .then(async (choice) => {
        if (choice === install) {
          void vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
        } else if (choice === dismiss) {
          await this.context.globalState.update(HINT_DISMISSED_KEY, true);
        }
      });
  }
}
