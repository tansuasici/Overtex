import * as vscode from 'vscode';
import type { BuildResult } from './latex/builder';

export class BuildStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('overtex.build', vscode.StatusBarAlignment.Left, 50);

  constructor() {
    this.item.name = 'Overtex Build';
    this.idle();
  }

  show(): void {
    this.item.show();
  }

  building(): void {
    this.item.text = '$(sync~spin) Building…';
    this.item.tooltip = 'Overtex: building. Click to cancel.';
    this.item.command = 'overtex.cancelBuild';
    this.item.backgroundColor = undefined;
  }

  finished(result: BuildResult): void {
    const errors = result.entries.filter((e) => e.severity === 'error').length;
    const warnings = result.entries.filter((e) => e.severity === 'warning').length;
    if (result.cancelled) {
      this.idle();
      return;
    }
    if (result.success) {
      this.item.text = `$(check) ${(result.durationMs / 1000).toFixed(1)}s`;
      this.item.tooltip = `Overtex: built in ${result.durationMs} ms, ${warnings} warning(s). Click to show the log.`;
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = errors ? `$(error) ${errors} error${errors === 1 ? '' : 's'}` : '$(error) Build failed';
      this.item.tooltip = 'Overtex: build failed. Click to show the log.';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    this.item.command = 'overtex.showLog';
  }

  private idle(): void {
    this.item.text = '$(file-pdf) Overtex';
    this.item.tooltip = 'Overtex: click to build.';
    this.item.command = 'overtex.build';
    this.item.backgroundColor = undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
