// Runs inside the VS Code extension host (see run.mjs), in a workspace whose path has the characters
// VS Code and texlab spell differently in a file URI ("Drive'ım (1)"), with TexLab on.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { OvertexApi } from '../../src/api';

async function waitFor(what: string, check: () => boolean, timeoutMs = 30000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const texlabMessages = (uri: vscode.Uri): string[] =>
  vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.source === 'texlab')
    .map((d) => `${d.range.start.line + 1}: ${d.message}`);

export async function run(): Promise<void> {
  const api = await vscode.extensions.getExtension<OvertexApi>('tansuasici.overtex')!.activate();
  const e2e = api.e2e;
  assert.ok(e2e, 'OVERTEX_E2E hooks are missing');
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  assert.ok(root.includes("Drive'ım (1)"), `workspace path: ${root}`);
  let failed = 0;

  async function step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}\n    ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await step('TexLab starts', () => waitFor('TexLab to start', () => e2e.texlabRunning()));

  await step("references and citations resolve across files in a folder with ' ( ) in its name", async () => {
    const main = vscode.Uri.file(path.join(root, 'main.tex'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(main));
    // The one undefined reference shows that TexLab checked the file; it must be the only finding.
    await waitFor('the undefined reference on line 7', () => texlabMessages(main).some((m) => m.startsWith('7: ')));
    await new Promise((r) => setTimeout(r, 1500)); // Let a second, cross-file pass land.
    assert.deepStrictEqual(texlabMessages(main), ['7: Undefined reference']);
  });

  await step('a file in a folder with [ ] is not sent to TexLab, which keeps running', async () => {
    const outside = vscode.Uri.file(path.join(path.dirname(path.dirname(root)), 'draft [v2]', 'notes.tex'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(outside));
    await new Promise((r) => setTimeout(r, 3000));
    assert.ok(e2e.texlabRunning(), 'TexLab still running');
    assert.deepStrictEqual(texlabMessages(outside), []);
  });

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  if (failed) {
    throw new Error(`${failed} TexLab end-to-end step(s) failed`);
  }
}
