import * as vscode from 'vscode';
import * as fs from 'fs';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';

import { findExecutable } from './executable';
import { TEXLAB_EXTENSION_ID, texlabOptions, texlabStartDecision, withoutBuildLogDiagnostics } from './texlabConfig';

const HINT_DISMISSED_KEY = 'overtex.texlabMissingHintDismissed';
const INSTALL_URL = 'https://github.com/latex-lsp/texlab#installation';

/**
 * Runs the TexLab language server for live diagnostics, completion, hover and navigation.
 * Optional: without texlab Overtex keeps working with its own `\cite` completion.
 */
export class Texlab implements vscode.Disposable {
  private client: LanguageClient | undefined;
  private starting: Promise<void> | undefined;
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
    this.starting ??= this.doStart().finally(() => (this.starting = undefined));
    return this.starting;
  }

  async restart(): Promise<void> {
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
    });
    if (decision !== 'start') {
      this.log(`TexLab: not started (${decision}).\n`);
      return;
    }

    const configured = cfg.get<string>('texlab.path') || 'texlab';
    const command = findExecutable(configured, process.env, process.platform, (p) => fs.existsSync(p) && fs.statSync(p).isFile());
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

    const serverOptions: ServerOptions = { command, args: [] };
    const clientOptions: LanguageClientOptions = {
      documentSelector: [
        { scheme: 'file', language: 'latex' },
        { scheme: 'file', language: 'bibtex' },
        { scheme: 'untitled', language: 'latex' },
        { scheme: 'untitled', language: 'bibtex' },
      ],
      initializationOptions: options(),
      outputChannelName: 'Overtex: TexLab',
      middleware: {
        // texlab pulls its "texlab" section; Overtex has no such settings, so answer with its own.
        workspace: {
          configuration: (params) => params.items.map((item) => (item.section === 'texlab' ? options() : null)),
        },
        handleDiagnostics: (uri, diagnostics, next) => next(uri, withoutBuildLogDiagnostics(diagnostics)),
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
