import * as vscode from 'vscode';
import type { LogEntry } from './logParser';

const SEVERITY: Record<LogEntry['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/** Shows build log entries in the Problems panel. */
export class BuildDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('overtex');

  update(entries: LogEntry[], mainFile: string): void {
    this.collection.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const seen = new Set<string>();

    for (const entry of entries) {
      const file = entry.file || mainFile;
      const key = `${file}:${entry.line}:${entry.message}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const line = Math.max(0, entry.line - 1);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        entry.message,
        SEVERITY[entry.severity]
      );
      diagnostic.source = 'LaTeX';
      const list = byFile.get(file) ?? [];
      list.push(diagnostic);
      byFile.set(file, list);
    }

    for (const [file, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.file(file), diagnostics);
    }
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
