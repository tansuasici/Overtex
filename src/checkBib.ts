import * as vscode from 'vscode';
import * as fs from 'fs';

import { bibFilesNamedBy } from './addCitation';
import { showProblems } from './checkSubmission';
import { parseBib } from './latex/bibParser';
import { BibCheckReport, BibFinding, checkBibliography, isCancellation, summarizeBibCheck } from './latex/bibCheck';

/**
 * Overtex: Check Bibliography. Lists entries missing fields their type needs, DOIs that do not
 * exist or point at another paper, and arXiv preprints that have since been published. Uses
 * doi.org and the arXiv API, only when run. Findings go to the Problems panel on the .bib file.
 */
export class BibliographyCheck implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('overtex-bibliography');

  constructor(
    private readonly mainFile: () => string | null,
    private readonly userAgent: string
  ) {}

  dispose(): void {
    this.collection.dispose();
  }

  /** Returns the reports by file, for tests; undefined when nothing was checked. */
  async run(target?: vscode.Uri): Promise<Map<string, BibCheckReport> | undefined> {
    const files = target ? [target] : await this.chooseFiles();
    if (!files || files.length === 0) {
      return undefined;
    }

    const reports = new Map<string, BibCheckReport>();
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Overtex: checking the bibliography', cancellable: true },
      async (progress, token) => {
        const ctl = new AbortController();
        const sub = token.onCancellationRequested(() => ctl.abort());
        try {
          for (const file of files) {
            const doc = await vscode.workspace.openTextDocument(file);
            const name = vscode.workspace.asRelativePath(file);
            let reported = 0;
            const report = await checkBibliography(parseBib(doc.getText()), {
              signal: ctl.signal,
              userAgent: this.userAgent,
              onProgress: (done, total) => {
                const pct = total ? (done / total) * (100 / files.length) : 0;
                progress.report({ message: `${name}: ${done}/${total}`, increment: pct - reported });
                reported = pct;
              },
            });
            reports.set(file.fsPath, report);
            this.show(file, report.findings);
          }
          return true;
        } catch (err) {
          if (isCancellation(err)) {
            return false;
          }
          throw err;
        } finally {
          sub.dispose();
        }
      }
    );
    if (!ok) {
      return undefined;
    }

    const all = [...reports.values()];
    const summary = all.map(summarizeBibCheck).join('; ');
    if (all.some((r) => r.findings.length > 0)) {
      void showProblems('warning', `Overtex: ${summary}.`);
    } else {
      void vscode.window.showInformationMessage(`Overtex: ${summary}. No problems found.`);
    }
    return reports;
  }

  private show(file: vscode.Uri, findings: BibFinding[]): void {
    this.collection.set(
      file,
      findings.map((f) => {
        const d = new vscode.Diagnostic(
          new vscode.Range(f.line, 0, f.line, Number.MAX_SAFE_INTEGER),
          f.message,
          f.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : f.severity === 'warning'
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information
        );
        d.source = 'Overtex bibliography';
        if (f.link) {
          d.code = { value: 'notice', target: vscode.Uri.parse(f.link) };
        }
        return d;
      })
    );
  }

  /** The .bib in the active editor, else those the main file names, else the workspace's (picked if several). */
  private async chooseFiles(): Promise<vscode.Uri[] | undefined> {
    const active = vscode.window.activeTextEditor?.document;
    if (active && (active.languageId === 'bibtex' || active.fileName.toLowerCase().endsWith('.bib'))) {
      return [active.uri];
    }
    const main = this.mainFile();
    const named = main ? bibFilesNamedBy(main).filter((u) => fs.existsSync(u.fsPath)) : [];
    if (named.length) {
      return named;
    }
    const found = await vscode.workspace.findFiles('**/*.bib', '**/node_modules/**', 50);
    if (found.length <= 1) {
      if (!found.length) {
        void vscode.window.showWarningMessage('Overtex: no .bib file found to check.');
      }
      return found;
    }
    const picks = await vscode.window.showQuickPick(
      found.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
      { title: 'Check Bibliography', placeHolder: 'Which bibliographies should be checked?', canPickMany: true }
    );
    return picks?.map((p) => p.uri);
  }
}
