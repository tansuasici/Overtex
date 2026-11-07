import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { checkSubmission, summarize, SubmissionFinding, SubmissionReport } from './latex/submission';
import type { BuildResult } from './latex/builder';

/**
 * Overtex: Check Submission. Builds the project, then looks for what venues and arXiv reject:
 * too many pages, the draft option, `??` references, Type 3 fonts, TODOs and, for double-blind
 * review, author information. Findings go to the Problems panel until the next build.
 */
export class SubmissionCheck implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('overtex-submission');

  constructor(
    private readonly mainFile: () => string | null,
    private readonly build: (main: string) => Promise<BuildResult | undefined>
  ) {}

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }

  /** Returns the report, for tests; undefined when the check could not run. */
  async run(): Promise<SubmissionReport | undefined> {
    const main = this.mainFile();
    if (!main) {
      void vscode.window.showWarningMessage('Overtex: no LaTeX document found to check.');
      return undefined;
    }
    const result = await this.build(main);
    if (!result || result.cancelled) {
      return undefined;
    }
    if (!result.success) {
      void showProblems('error', 'Overtex: fix the build errors before checking the submission.');
      return undefined;
    }
    if (!fs.existsSync(result.flsFile)) {
      void vscode.window.showErrorMessage('Overtex: the build left no recorder (.fls) file, so the inputs are unknown. Is -recorder disabled in latexmk?');
      return undefined;
    }

    const cfg = vscode.workspace.getConfiguration('overtex', vscode.Uri.file(main));
    const pageLimit = Math.max(0, cfg.get<number>('submission.pageLimit', 0));
    const report = checkSubmission({
      log: readOrEmpty(result.logFile),
      fls: fs.readFileSync(result.flsFile, 'utf8'),
      entries: result.entries,
      mainFile: main,
      outDir: path.dirname(result.flsFile),
      pageLimit,
      anonymous: cfg.get<boolean>('submission.anonymous', false),
      exists: (f) => fs.existsSync(f) && fs.statSync(f).isFile(),
      read: (f) => fs.readFileSync(f, 'utf8'),
    });

    this.show(report.findings, main);
    const summary = summarize(report, pageLimit);
    if (report.findings.some((f) => f.severity === 'warning')) {
      void showProblems('warning', `Overtex: ${summary}.`);
    } else {
      void vscode.window.showInformationMessage(summary ? `Overtex: ${summary}. No problems found.` : 'Overtex: no problems found.');
    }
    return report;
  }

  private show(findings: SubmissionFinding[], main: string): void {
    this.collection.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const f of findings) {
      if (f.fromBuild) {
        continue; // the build's own diagnostics already show these
      }
      const file = f.file ?? main;
      const line = Math.max(0, (f.line ?? 0) - 1);
      const d = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        f.message,
        f.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information
      );
      d.source = 'Overtex submission';
      byFile.set(file, [...(byFile.get(file) ?? []), d]);
    }
    for (const [file, list] of byFile) {
      this.collection.set(vscode.Uri.file(file), list);
    }
  }
}

function readOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

async function showProblems(kind: 'error' | 'warning', message: string): Promise<void> {
  const show = kind === 'error' ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
  if (await show(message, 'Show Problems')) {
    await vscode.commands.executeCommand('workbench.actions.view.problems');
  }
}
