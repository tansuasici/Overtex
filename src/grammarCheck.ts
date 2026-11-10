import * as fs from 'fs';
import * as vscode from 'vscode';

import {
  checkLatex,
  DEFAULT_LANGUAGETOOL_URL,
  GrammarProblem,
  LanguageToolUnavailableError,
  UnsupportedLanguageError,
} from './latex/grammar';

const TEX_LANGUAGES = new Set(['latex', 'tex']);
const SOURCE = 'Overtex grammar';

interface Entry {
  /** Offsets into the document as it is now; edits move them. */
  offset: number;
  length: number;
  problem: GrammarProblem;
  diagnostic: vscode.Diagnostic;
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('overtex.grammar');
}

/**
 * Overtex: Check Spelling and Grammar. Sends the active file's prose to a LanguageTool server,
 * a local one unless the user points `overtex.grammar.url` elsewhere, and lists what it finds in
 * the Problems panel with quick fixes.
 */
export class GrammarCheck implements vscode.Disposable, vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  private readonly collection = vscode.languages.createDiagnosticCollection('overtex-grammar');
  private readonly entries = new Map<string, Entry[]>();
  private readonly disposables: vscode.Disposable[] = [];
  private running?: AbortController;
  /** Checks on save say once that the server is missing, not on every save. */
  private warnedUnavailable = false;

  /** `mainFile` finds the root document, whose preamble names the language of a chapter file. */
  constructor(private readonly mainFile: () => string | null = () => null) {
    this.disposables.push(
      this.collection,
      vscode.languages.registerCodeActionsProvider([...TEX_LANGUAGES].map((language) => ({ language })), this, {
        providedCodeActionKinds: GrammarCheck.providedCodeActionKinds,
      }),
      vscode.commands.registerCommand('overtex.grammar.addToDictionary', (word: string) => this.addToDictionary(word)),
      vscode.commands.registerCommand('overtex.grammar.disableRule', (ruleId: string) => this.disableRule(ruleId)),
      vscode.workspace.onDidChangeTextDocument((e) => this.shift(e)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.forget(doc.uri)),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (TEX_LANGUAGES.has(doc.languageId) && cfg().get<boolean>('checkOnSave', false)) {
          void this.check(doc, true);
        }
      })
    );
  }

  dispose(): void {
    this.running?.abort();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  /** Checks the active LaTeX file. Returns the problems, for tests; undefined when nothing ran. */
  async run(): Promise<GrammarProblem[] | undefined> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !TEX_LANGUAGES.has(doc.languageId)) {
      void vscode.window.showInformationMessage('Overtex: open a LaTeX file to check its spelling and grammar.');
      return undefined;
    }
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Overtex: checking spelling and grammar' },
      () => this.check(doc, false)
    );
  }

  private async check(doc: vscode.TextDocument, quiet: boolean): Promise<GrammarProblem[] | undefined> {
    this.running?.abort();
    const ctl = new AbortController();
    this.running = ctl;
    const url = cfg().get<string>('url') || DEFAULT_LANGUAGETOOL_URL;
    const version = doc.version;
    let problems: GrammarProblem[];
    try {
      problems = await checkLatex(doc.getText(), {
        url,
        language: cfg().get<string>('language', 'auto'),
        root: this.rootText(doc),
        disabledRules: cfg().get<string[]>('disabledRules', []),
        dictionary: cfg().get<string[]>('dictionary', []),
        signal: ctl.signal,
      });
    } catch (err) {
      if (ctl.signal.aborted) {
        return undefined;
      }
      this.report(err, url, quiet);
      return undefined;
    } finally {
      if (this.running === ctl) {
        this.running = undefined;
      }
    }
    // An edit while the server worked moves the text under the answers; the next check catches up.
    if (doc.version !== version || doc.isClosed) {
      return undefined;
    }
    this.show(doc, problems);
    if (!quiet) {
      const n = problems.length;
      vscode.window.setStatusBarMessage(n === 0 ? 'Overtex: no spelling or grammar issues' : `Overtex: ${n} spelling and grammar issue${n === 1 ? '' : 's'}`, 5000);
    }
    return problems;
  }

  /** The root document's text when `doc` is a file it includes; open editors win over the disk. */
  private rootText(doc: vscode.TextDocument): string | undefined {
    const main = this.mainFile();
    if (!main || main === doc.uri.fsPath) {
      return undefined;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === main);
    if (open) {
      return open.getText();
    }
    try {
      return fs.readFileSync(main, 'utf8');
    } catch {
      return undefined;
    }
  }

  private report(err: unknown, url: string, quiet: boolean): void {
    if (err instanceof UnsupportedLanguageError) {
      if (!quiet) {
        void vscode.window.showInformationMessage(`Overtex: LanguageTool cannot check ${err.language}, so this document is not checked.`);
      }
      return;
    }
    if (err instanceof LanguageToolUnavailableError) {
      if (quiet && this.warnedUnavailable) {
        return;
      }
      this.warnedUnavailable = true;
      const settingsAction = 'Open Settings';
      void vscode.window
        .showWarningMessage(
          `Overtex: no LanguageTool server answers at ${url}. Install and start one, for example with \`brew install languagetool\` and \`brew services start languagetool\`, or set overtex.grammar.url.`,
          settingsAction
        )
        .then((choice) => choice === settingsAction && vscode.commands.executeCommand('workbench.action.openSettings', 'overtex.grammar'));
      return;
    }
    void vscode.window.showErrorMessage(`Overtex: the spelling and grammar check failed. ${err instanceof Error ? err.message : String(err)}`);
  }

  private show(doc: vscode.TextDocument, problems: GrammarProblem[]): void {
    const entries = problems.map((problem): Entry => {
      const range = new vscode.Range(doc.positionAt(problem.offset), doc.positionAt(problem.offset + problem.length));
      const diagnostic = new vscode.Diagnostic(
        range,
        problem.message,
        problem.misspelling ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information
      );
      diagnostic.source = SOURCE;
      diagnostic.code = problem.ruleId;
      return { offset: problem.offset, length: problem.length, problem, diagnostic };
    });
    this.entries.set(doc.uri.toString(), entries);
    this.collection.set(doc.uri, entries.map((e) => e.diagnostic));
  }

  private forget(uri: vscode.Uri): void {
    this.entries.delete(uri.toString());
    this.collection.delete(uri);
  }

  /** Moves the findings after an edit and drops the ones it touched. */
  private shift(e: vscode.TextDocumentChangeEvent): void {
    const key = e.document.uri.toString();
    let entries = this.entries.get(key);
    if (!entries || e.contentChanges.length === 0) {
      return;
    }
    // Each change's offsets are in the document before the event, so later ones go first.
    const changes = [...e.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);
    for (const c of changes) {
      const end = c.rangeOffset + c.rangeLength;
      const delta = c.text.length - c.rangeLength;
      // An edit that touches a finding, even at its edge, changes the word; that one goes.
      entries = entries.flatMap((entry) => {
        if (entry.offset + entry.length < c.rangeOffset) {
          return [entry];
        }
        if (entry.offset > end) {
          return [{ ...entry, offset: entry.offset + delta }];
        }
        return [];
      });
    }
    for (const entry of entries) {
      entry.diagnostic.range = new vscode.Range(e.document.positionAt(entry.offset), e.document.positionAt(entry.offset + entry.length));
    }
    this.entries.set(key, entries);
    this.collection.set(e.document.uri, entries.map((x) => x.diagnostic));
  }

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const entries = this.entries.get(doc.uri.toString()) ?? [];
    const actions: vscode.CodeAction[] = [];
    for (const d of context.diagnostics) {
      if (d.source !== SOURCE) {
        continue;
      }
      const entry = entries.find((e) => e.diagnostic.range.isEqual(d.range) && e.diagnostic.message === d.message);
      if (!entry) {
        continue;
      }
      const { problem } = entry;
      problem.replacements.forEach((value, i) => {
        const action = new vscode.CodeAction(`Replace with '${value}'`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(doc.uri, d.range, value);
        action.diagnostics = [d];
        action.isPreferred = i === 0;
        actions.push(action);
      });
      if (problem.misspelling) {
        const word = doc.getText(d.range);
        const action = new vscode.CodeAction(`Add '${word}' to the dictionary`, vscode.CodeActionKind.QuickFix);
        action.command = { title: action.title, command: 'overtex.grammar.addToDictionary', arguments: [word] };
        action.diagnostics = [d];
        actions.push(action);
      }
      const disable = new vscode.CodeAction(`Disable the rule ${problem.ruleId}`, vscode.CodeActionKind.QuickFix);
      disable.command = { title: disable.title, command: 'overtex.grammar.disableRule', arguments: [problem.ruleId] };
      disable.diagnostics = [d];
      actions.push(disable);
    }
    return actions;
  }

  private async addToDictionary(word: string): Promise<void> {
    const words = cfg().get<string[]>('dictionary', []);
    if (!words.includes(word)) {
      await cfg().update('dictionary', [...words, word], vscode.ConfigurationTarget.Global);
    }
    this.drop((e, doc) => e.problem.misspelling && doc.getText(e.diagnostic.range) === word);
  }

  private async disableRule(ruleId: string): Promise<void> {
    const rules = cfg().get<string[]>('disabledRules', []);
    if (!rules.includes(ruleId)) {
      await cfg().update('disabledRules', [...rules, ruleId], vscode.ConfigurationTarget.Global);
    }
    this.drop((e) => e.problem.ruleId === ruleId);
  }

  private drop(matches: (entry: Entry, doc: vscode.TextDocument) => boolean): void {
    for (const doc of vscode.workspace.textDocuments) {
      const key = doc.uri.toString();
      const entries = this.entries.get(key);
      if (!entries) {
        continue;
      }
      const kept = entries.filter((e) => !matches(e, doc));
      this.entries.set(key, kept);
      this.collection.set(doc.uri, kept.map((e) => e.diagnostic));
    }
  }
}
