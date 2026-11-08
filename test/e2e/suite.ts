// Runs inside the VS Code extension host (see run.mjs). Drives build, forward search and inverse
// search through the real PDF viewer webview, using the test hooks enabled by OVERTEX_E2E.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { OvertexApi, OvertexE2e } from '../../src/api';
import type { E2eFromViewerMessage, PageRect } from '../../src/shared/messages';

type ViewerMessage<T extends E2eFromViewerMessage['type']> = Extract<E2eFromViewerMessage, { type: T }>;

function nextMessage<T extends E2eFromViewerMessage['type']>(e2e: OvertexE2e, type: T, timeoutMs = 30000): Promise<ViewerMessage<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);
    const sub = e2e.onViewerMessage((msg) => {
      if (msg.type === type) {
        clearTimeout(timer);
        sub.dispose();
        resolve(msg as ViewerMessage<T>);
      }
    });
  });
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 15000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function openAt(file: string, line: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(file);
  const pos = new vscode.Position(line, 0);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(pos, pos) });
}

function cursorAt(file: string, line: number): boolean {
  const editor = vscode.window.activeTextEditor;
  return editor?.document.uri.fsPath === file && editor.selection.active.line === line;
}

export async function run(): Promise<void> {
  const api = await vscode.extensions.getExtension<OvertexApi>('tansuasici.overtex')!.activate();
  const e2e = api.e2e;
  assert.ok(e2e, 'OVERTEX_E2E hooks are missing');

  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const main = path.join(root, 'main.tex');
  const part = path.join(root, 'chapters', 'part.tex');
  const targets: Record<string, PageRect> = {};
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

  async function forward(file: string, line: number, expectedPage: number): Promise<void> {
    await openAt(file, line);
    const revealed = nextMessage(e2e!, 'e2e:revealed');
    await vscode.commands.executeCommand('overtex.forwardSearch');
    const msg = await revealed;
    assert.strictEqual(msg.target.page, expectedPage, 'page');
    assert.ok(msg.inView, 'the target box is scrolled into view');
    targets[path.basename(file)] = msg.target;
  }

  async function inverse(target: PageRect | undefined, file: string, line: number): Promise<void> {
    assert.ok(target, 'needs the forward search result');
    const width = target.width > 0 ? target.width : 40;
    e2e!.sendToViewer({ type: 'e2e:click', page: target.page, x: target.x + width / 2, y: target.y + target.height / 2 });
    const where = () => {
      const e = vscode.window.activeTextEditor;
      return e ? `${e.document.uri.fsPath}:${e.selection.active.line + 1}` : 'no editor';
    };
    await waitFor(`the cursor at ${path.basename(file)}:${line + 1}`, () => cursorAt(file, line)).catch((err: Error) => {
      throw new Error(`${err.message} (cursor is at ${where()}; clicked ${JSON.stringify(target)})`);
    });
  }

  console.log('Overtex end-to-end');

  await step('builds and shows the PDF in the preview', async () => {
    await openAt(main, 0);
    const loaded = nextMessage(e2e, 'e2e:loaded', 120000);
    const result = await api.build(main);
    assert.ok(result?.success, 'build succeeded');
    assert.strictEqual((await loaded).pages, 3);
  });

  await step('forward search: main file line -> page 2', () => forward(main, 4, 2));
  await step('forward search: \\input file line -> page 3', () => forward(part, 1, 3));
  await step('inverse search: click on page 2 -> main.tex:5', () => inverse(targets['main.tex'], main, 4));
  await step('inverse search: click on page 3 -> chapters/part.tex:2', () => inverse(targets['part.tex'], part, 1));
  // Last: these show a notification and open an editor, which would get in the way of the viewer steps above.
  await step('setup check finds latexmk and the engine', async () => {
    const report = await vscode.commands.executeCommand<import('../../src/latex/setup').SetupReport>('overtex.checkSetup');
    assert.ok(report, 'no report returned');
    if (process.env.OVERTEX_REQUIRE_TEX) {
      assert.ok(report.canBuild, `missing: ${report.missingRequired.map((t) => t.name).join(', ')}`);
    }
  });

  await step('submission check reports the page count', async () => {
    const report = await vscode.commands.executeCommand<import('../../src/latex/submission').SubmissionReport>('overtex.checkSubmission');
    assert.ok(report, 'no report returned');
    assert.ok(report.pages && report.pages > 0, `pages: ${report.pages}`);
  });

  await step('count words with texcount', async () => {
    const count = await vscode.commands.executeCommand<import('../../src/latex/wordCount').WordCount>('overtex.countWords');
    assert.ok(count && count.total > 0, `count: ${JSON.stringify(count)}`);
  });

  await step('dark mode setting and toggle reach the preview', async () => {
    const cfg = () => vscode.workspace.getConfiguration('overtex');
    try {
      let applied = nextMessage(e2e!, 'e2e:colorScheme');
      await cfg().update('viewer.colorScheme', 'dark', vscode.ConfigurationTarget.Global);
      assert.strictEqual((await applied).dark, true, 'dark setting');
      applied = nextMessage(e2e!, 'e2e:colorScheme');
      await vscode.commands.executeCommand('overtex.viewer.toggleDarkMode');
      assert.strictEqual((await applied).dark, false, 'after toggle');
      assert.strictEqual(cfg().get('viewer.colorScheme'), 'light');
    } finally {
      await cfg().update('viewer.colorScheme', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  await step('bibliography check runs on the project .bib (offline)', async () => {
    // No DOI or arXiv ID, so nothing is looked up online.
    const bib = vscode.Uri.file(path.join(root, 'refs.bib'));
    const entry = '@article{einstein1905,\n  author = {Albert Einstein},\n  title = {Zur Elektrodynamik bewegter K{\\"o}rper},\n  journal = {Annalen der Physik},\n  year = 1905\n}\n';
    await vscode.workspace.fs.writeFile(bib, Buffer.from(entry));
    const reports = await vscode.commands.executeCommand<Map<string, import('../../src/latex/bibCheck').BibCheckReport>>('overtex.checkBibliography', bib);
    const report = reports?.get(bib.fsPath);
    assert.ok(report, 'no report returned');
    assert.strictEqual(report.entries, 1);
    assert.strictEqual(report.checked, 0);
    assert.deepStrictEqual(report.findings, []);
  });

  await step('getting started walkthrough is registered', async () => {
    await vscode.commands.executeCommand('overtex.gettingStarted');
  });

  await step('math hover renders with a macro from the file', async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\newcommand{\\R}{\\mathbb{R}}\nLet $x \\in \\R$.' });
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(1, 6));
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    const data = /data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/.exec(text);
    assert.ok(data, 'hover has an SVG image');
    // An image must be one SVG document: MathJax's inline line breaking would make several.
    const svg = Buffer.from(data[1], 'base64').toString('utf8');
    assert.strictEqual(svg.match(/<svg\b/g)?.length, 1, 'one <svg> element');
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), 'nothing outside the <svg> element');
  });

  if (failed) {
    throw new Error(`${failed} end-to-end step(s) failed`);
  }
}
