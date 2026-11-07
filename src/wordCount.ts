import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

import { parseTexcount, texcountArgs, wordCountDetails, wordCountLabel, WordCount } from './latex/wordCount';

/**
 * Word count in the status bar, from texcount (part of TeX Live and MiKTeX). Counted after each
 * successful build and by Overtex: Count Words; `overtex.wordCount.goal` adds a target.
 */
export class WordCounter implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('overtex.wordCount', vscode.StatusBarAlignment.Left, 49);
  /** First count per main file in this session, for the "+N since this session started" line. */
  private readonly sessionStart = new Map<string, number>();
  private last: { main: string; count: WordCount } | undefined;

  constructor(private readonly mainFile: () => string | null) {
    this.item.name = 'Overtex Word Count';
    this.item.command = 'overtex.countWords';
  }

  /** Recounts silently after a build; hides the item when texcount is missing or counting is off. */
  async update(main: string): Promise<void> {
    if (!enabled()) {
      this.item.hide();
      return;
    }
    const count = await runTexcount(main);
    if (count) {
      this.show(main, count);
    } else {
      this.item.hide();
    }
  }

  /** Overtex: Count Words. Returns the count, for tests. */
  async run(): Promise<WordCount | undefined> {
    const main = this.mainFile();
    if (!main) {
      void vscode.window.showWarningMessage('Overtex: no LaTeX document found to count.');
      return undefined;
    }
    const count = await runTexcount(main);
    if (!count) {
      void vscode.window.showErrorMessage('Overtex: could not run texcount. It comes with TeX Live and MiKTeX; check that it is on PATH.');
      return undefined;
    }
    if (enabled()) {
      this.show(main, count);
    }
    const lines = wordCountDetails(count, goal(), this.sessionStart.get(main));
    void vscode.window.showInformationMessage(`Overtex: ${wordCountLabel(count, goal())} in ${path.basename(main)}. ${lines.join(' ')}`);
    return count;
  }

  /** Redraws with the new goal, or hides the item when counting is turned off. */
  refresh(): void {
    if (!enabled()) {
      this.item.hide();
    } else if (this.last) {
      this.show(this.last.main, this.last.count);
    }
  }

  private show(main: string, count: WordCount): void {
    this.last = { main, count };
    if (!this.sessionStart.has(main)) {
      this.sessionStart.set(main, count.total);
    }
    const g = goal();
    this.item.text = `$(book) ${wordCountLabel(count, g)}`;
    this.item.tooltip = [`Overtex: ${path.basename(main)}, counted with texcount.`, ...wordCountDetails(count, g, this.sessionStart.get(main)), 'Click to count again.'].join('\n');
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

function enabled(): boolean {
  return vscode.workspace.getConfiguration('overtex').get<boolean>('wordCount.enabled', true);
}

function goal(): number {
  return Math.max(0, vscode.workspace.getConfiguration('overtex').get<number>('wordCount.goal', 0));
}

function runTexcount(main: string): Promise<WordCount | null> {
  return new Promise((resolve) => {
    cp.execFile('texcount', texcountArgs(path.basename(main)), { cwd: path.dirname(main), timeout: 15000, maxBuffer: 1024 * 1024 }, (_err, stdout) => {
      // texcount can fail on a missing \input file yet still print the totals, so go by the output.
      resolve(parseTexcount(stdout ?? ''));
    });
  });
}
