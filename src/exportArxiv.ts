import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { buildSettings } from './config';
import { createZip, packArxiv } from './latex/arxiv';
import type { BuildResult } from './latex/builder';

/**
 * Overtex: Export for arXiv. Builds the project, then zips the files TeX actually read (plus the
 * generated .bbl) with comments removed, as `<main>-arxiv.zip` beside the main file.
 */
export async function exportArxiv(
  mainFile: () => string | null,
  build: (main: string) => Promise<BuildResult | undefined>
): Promise<void> {
  const main = mainFile();
  if (!main) {
    void vscode.window.showWarningMessage('Overtex: no LaTeX document found to export.');
    return;
  }

  const result = await build(main);
  if (!result || result.cancelled) {
    return;
  }
  if (!result.success) {
    void vscode.window.showErrorMessage('Overtex: fix the build errors before exporting for arXiv.', 'Show Problems').then((choice) => {
      if (choice) {
        void vscode.commands.executeCommand('workbench.actions.view.problems');
      }
    });
    return;
  }
  if (!fs.existsSync(result.flsFile)) {
    void vscode.window.showErrorMessage('Overtex: the build left no recorder (.fls) file, so the inputs are unknown. Is -recorder disabled in latexmk?');
    return;
  }

  const settings = buildSettings();
  const pkg = packArxiv({
    fls: fs.readFileSync(result.flsFile, 'utf8'),
    mainFile: main,
    outDir: path.dirname(result.flsFile),
    engine: settings.engine,
    workspaceRoot: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(main))?.uri.fsPath,
    exists: (f) => fs.existsSync(f) && fs.statSync(f).isFile(),
    read: (f) => fs.readFileSync(f),
  });

  const zipFile = path.join(path.dirname(main), `${path.basename(main, path.extname(main))}-arxiv.zip`);
  try {
    fs.writeFileSync(zipFile, createZip(pkg.entries));
  } catch (err) {
    void vscode.window.showErrorMessage(`Overtex: could not write ${zipFile}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const summary = `Overtex: wrote ${path.basename(zipFile)} with ${pkg.entries.length} file${pkg.entries.length === 1 ? '' : 's'}.`;
  const reveal = process.platform === 'darwin' ? 'Reveal in Finder' : 'Reveal in File Explorer';
  const show = pkg.warnings.length
    ? vscode.window.showWarningMessage(`${summary} ${pkg.warnings.join(' ')}`, reveal)
    : vscode.window.showInformationMessage(summary, reveal);
  if (await show) {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(zipFile));
  }
}
