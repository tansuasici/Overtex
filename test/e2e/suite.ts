// Runs inside the VS Code extension host (see run.mjs). Drives build, forward search and inverse
// search through the real PDF viewer webview, using the test hooks enabled by OVERTEX_E2E.
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
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
  await step('notes: add, keep through a rebuild and zoom, edit, delete', async () => {
    const file = path.join(root, 'main.overtex-notes.json');
    const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')).notes as { id: string; page: number; x: number; y: number; text: string }[];
    const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1, `${what}: ${a} is not ${b}`);
    try {
      // Mouse events carry whole pixels, so at 100% a click lands within a point of where it was
      // aimed. Fit width would tie that to the window, which on CI makes a pixel about 3 points.
      let shown = nextMessage(e2e, 'e2e:notes');
      e2e.sendToViewer({ type: 'e2e:zoom', zoom: 1 });
      await shown;
      shown = nextMessage(e2e, 'e2e:notes');
      e2e.sendToViewer({ type: 'e2e:addNote', page: 2, x: 100, y: 200, text: 'Check this claim <b>here</b>' });
      let pins = (await shown).pins;
      assert.strictEqual(pins.length, 1, 'one pin');
      const [note] = saved();
      assert.strictEqual(note.page, 2);
      assert.strictEqual(note.text, 'Check this claim <b>here</b>');
      assert.ok(Math.abs(note.x - 100) < 2 && Math.abs(note.y - 200) < 2, `saved at ${note.x}, ${note.y}`);
      near(pins[0].x, note.x, 'pin x');
      near(pins[0].y, note.y, 'pin y');

      shown = nextMessage(e2e, 'e2e:notes');
      e2e.sendToViewer({ type: 'e2e:zoom', zoom: 1.5 });
      pins = (await shown).pins;
      near(pins[0].x, note.x, 'pin x at 150%');
      near(pins[0].y, note.y, 'pin y at 150%');
      shown = nextMessage(e2e, 'e2e:notes');
      e2e.sendToViewer({ type: 'e2e:zoom', zoom: 'page-width' });
      await shown;

      const loaded = nextMessage(e2e, 'e2e:loaded', 120000);
      await openAt(main, 0);
      assert.ok((await api.build(main))?.success, 'rebuild succeeded');
      await loaded;
      shown = nextMessage(e2e, 'e2e:notes');
      e2e.sendToViewer({ type: 'e2e:zoom', zoom: 'page-width' });
      pins = (await shown).pins;
      assert.strictEqual(pins.length, 1, 'the pin is back after the rebuild');
      near(pins[0].y, note.y, 'pin y after the rebuild');

      shown = nextMessage(e2e, 'e2e:notes');
      e2e.sendToViewer({ type: 'e2e:editNote', id: note.id, text: 'Reworded' });
      assert.strictEqual((await shown).pins[0].text, 'Reworded');
      assert.strictEqual(saved()[0].text, 'Reworded');

      // A broken file is left alone rather than replaced by the change.
      const broken = '<<<<<<< HEAD\n';
      fs.writeFileSync(file, broken);
      shown = nextMessage(e2e, 'e2e:notes');
      e2e.sendToViewer({ type: 'e2e:editNote', id: note.id, text: 'Not saved' });
      await shown;
      assert.strictEqual(fs.readFileSync(file, 'utf8'), broken, 'the broken file is untouched');
      fs.writeFileSync(file, `${JSON.stringify({ version: 1, notes: [note] })}\n`);

      // The viewer has no pins after the broken file, so a build brings the note back first.
      const reloaded = nextMessage(e2e, 'e2e:loaded', 120000);
      assert.ok((await api.build(main))?.success, 'rebuild succeeded');
      await reloaded;
      shown = nextMessage(e2e, 'e2e:notes');
      e2e.sendToViewer({ type: 'e2e:editNote', id: note.id, text: null });
      assert.strictEqual((await shown).pins.length, 0, 'no pin after delete');
      assert.ok(!fs.existsSync(file), 'the file goes with the last note');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  await step('notes as todos: mark done, list, hide done, reopen', async () => {
    const file = path.join(root, 'main.overtex-notes.json');
    const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')).notes as { id: string; text: string; doneAt?: string }[];
    const send = async (msg: import('../../src/shared/messages').E2eToViewerMessage) => {
      const shown = nextMessage(e2e, 'e2e:notes');
      e2e.sendToViewer(msg);
      return shown;
    };
    try {
      // At 100%, so that opening the list does not fit the pages to a new width during the jump.
      await send({ type: 'e2e:zoom', zoom: 1 });
      await send({ type: 'e2e:addNote', page: 2, x: 100, y: 200, text: 'First <b>note</b>\nsecond line' });
      let state = await send({ type: 'e2e:addNote', page: 3, x: 120, y: 300, text: 'Second' });
      assert.strictEqual(state.pins.length, 2, 'two pins');
      assert.strictEqual(state.badge, '2');
      const [first, second] = saved();

      state = await send({ type: 'e2e:markDone', id: first.id, done: true, via: 'editor' });
      assert.strictEqual(state.badge, '1');
      assert.strictEqual(state.pins.find((p) => p.id === first.id)?.done, true, 'the first pin shows done');
      assert.strictEqual(state.pins.find((p) => p.id === second.id)?.done, false, 'the second pin stays open');
      assert.strictEqual(typeof saved()[0].doneAt, 'string', 'the date is on disk');
      assert.strictEqual(saved()[1].doneAt, undefined);

      state = await send({ type: 'e2e:toggleList' });
      assert.strictEqual(state.listOpen, true, 'the list opens');
      assert.deepStrictEqual(state.list, [
        { id: first.id, label: 'First <b>note</b>', done: true },
        { id: second.id, label: 'Second', done: false },
      ]);

      const noteShown = nextMessage(e2e, 'e2e:noteShown');
      e2e.sendToViewer({ type: 'e2e:showNote', id: second.id });
      assert.strictEqual((await noteShown).inView, true, 'clicking a row brings its pin into view');

      state = await send({ type: 'e2e:hideDone', hide: true });
      assert.deepStrictEqual(state.pins.map((p) => p.id), [second.id], 'the done pin is hidden');
      assert.deepStrictEqual(state.list.map((r) => r.id), [second.id], 'the done row is hidden');

      state = await send({ type: 'e2e:markDone', id: second.id, done: true, via: 'list' });
      assert.strictEqual(state.badge, '0');
      assert.strictEqual(state.pins.length, 0, 'nothing left to show');
      assert.strictEqual(typeof saved()[1].doneAt, 'string');

      state = await send({ type: 'e2e:hideDone', hide: false });
      assert.strictEqual(state.pins.length, 2, 'both pins are back');

      const doneAt = saved()[1].doneAt;
      state = await send({ type: 'e2e:editNote', id: second.id, text: 'Reworded' });
      assert.strictEqual(saved()[1].text, 'Reworded');
      assert.strictEqual(saved()[1].doneAt, doneAt, 'editing keeps the done date');

      state = await send({ type: 'e2e:markDone', id: first.id, done: false, via: 'list' });
      assert.ok(!('doneAt' in saved()[0]), 'reopening removes the date');
      assert.strictEqual(state.badge, '1');

      state = await send({ type: 'e2e:markDone', id: second.id, done: false, via: 'editor' });
      assert.strictEqual(state.badge, '2');
      assert.ok(!('doneAt' in saved()[1]), 'reopening from the editor removes the date');

      // Typed but not saved: Mark done keeps the text, in the same write order.
      // Two writes, so two reports: wait for the second, or a stale one could answer the next step.
      state = await send({ type: 'e2e:markDone', id: second.id, done: true, via: 'editor', text: 'Typed, then done' });
      while (!state.pins.find((p) => p.id === second.id)?.done) {
        state = await nextMessage(e2e, 'e2e:notes');
      }
      assert.strictEqual(saved()[1].text, 'Typed, then done', 'the typed text is on disk');
      assert.strictEqual(typeof saved()[1].doneAt, 'string', 'the done date is on disk');
      state = await send({ type: 'e2e:markDone', id: second.id, done: false, via: 'editor' });
      assert.strictEqual(state.badge, '2');

      if (state.listOpen) {
        state = await send({ type: 'e2e:toggleList' });
      }
      assert.strictEqual(state.listOpen, false, 'the list closes');
      await send({ type: 'e2e:zoom', zoom: 'page-width' });
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  // Last: these show a notification and open an editor, which would get in the way of the viewer steps above.
  await step('setup check finds latexmk and the engine', async () => {
    const report = await vscode.commands.executeCommand<import('../../src/latex/setup').SetupReport>('overtex.checkSetup');
    assert.ok(report, 'no report returned');
    if (process.env.OVERTEX_REQUIRE_TEX) {
      assert.ok(report.canBuild, `missing: ${report.missingRequired.map((t) => t.name).join(', ')}`);
    }
  });

  await step('submission check reports the page count', async () => {
    const notes = path.join(root, 'main.overtex-notes.json');
    const stored = { page: 1, x: 1, y: 1, createdAt: '2026-11-08T00:00:00.000Z' };
    fs.writeFileSync(notes, JSON.stringify({ version: 1, notes: [{ ...stored, id: 'a', text: 'Still open' }, { ...stored, id: 'b', text: 'Finished', doneAt: '2026-11-09T00:00:00.000Z' }] }));
    try {
      const report = await vscode.commands.executeCommand<import('../../src/latex/submission').SubmissionReport>('overtex.checkSubmission');
      assert.ok(report, 'no report returned');
      assert.ok(report.pages && report.pages > 0, `pages: ${report.pages}`);
      assert.deepStrictEqual(report.findings.filter((f) => f.kind === 'note').map((f) => f.message), ['Open PDF note on page 1: Still open']);
    } finally {
      fs.rmSync(notes, { force: true });
    }
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

  await step('compare versions marks up a change against another file', async () => {
    const old = path.join(root, 'old-version.tex');
    const text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(main))).toString('utf-8');
    await vscode.workspace.fs.writeFile(vscode.Uri.file(old), Buffer.from(text.replace('\\begin{document}', '\\begin{document}\nA sentence only the old version has.\n')));
    await openAt(main, 0);
    const loaded = nextMessage(e2e!, 'e2e:loaded', 120000);
    const notes = nextMessage(e2e!, 'e2e:notes', 120000);
    const result = await vscode.commands.executeCommand<import('../../src/latex/latexdiff').CompareResult>('overtex.compareVersions', { old: { file: old } });
    await vscode.workspace.fs.delete(vscode.Uri.file(old));
    if (!result) {
      // latexdiff is optional; CI installs it, so only a local run can get here.
      loaded.catch(() => undefined);
      notes.catch(() => undefined);
      assert.ok(!process.env.OVERTEX_REQUIRE_TEX, 'latexdiff did not run');
      return;
    }
    assert.strictEqual(result.status, 'built');
    assert.ok((await loaded).pages >= 1);
    assert.strictEqual((await notes).enabled, false, 'the marked-up PDF takes no notes');
  });

  await step('cite from Zotero adds the pick to the .bib and cites it', async () => {
    // A stand-in for Better BibTeX: what a real one sends has not been checked against this.
    const picks = ['@article{einsteinCanQuantum1935,\n  title = {Can Quantum-Mechanical Description of Physical Reality Be Considered Complete?},\n  year = {1935},\n  doi = {10.1103/PhysRev.47.777},\n  file = {/Users/someone/Zotero/storage/ABC/epr.pdf}\n}\n'];
    const requests: URL[] = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push(url);
      res.end(url.searchParams.has('probe') ? 'ready' : picks.shift() ?? '');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const cfg = () => vscode.workspace.getConfiguration('overtex');
    const bib = path.join(root, 'refs.bib');
    const bibBefore = fs.readFileSync(bib, 'utf8');
    try {
      await cfg().update('zotero.url', `http://127.0.0.1:${(server.address() as AddressInfo).port}`, vscode.ConfigurationTarget.Global);
      await openAt(main, 2);
      const lineText = () => vscode.window.activeTextEditor!.document.lineAt(2).text;

      await vscode.commands.executeCommand('overtex.citeFromZotero');
      assert.strictEqual(requests.find((r) => r.searchParams.has('format'))?.searchParams.get('translator'), 'bibtex');
      const added = fs.readFileSync(bib, 'utf8');
      assert.ok(added.startsWith(bibBefore), 'existing entries are kept');
      assert.ok(added.includes('@article{einsteinCanQuantum1935'), 'the entry is in the .bib');
      assert.ok(!added.includes('/Users/someone'), 'no local attachment path');
      assert.ok(lineText().startsWith('\\cite{einsteinCanQuantum1935}'), `line: ${lineText()}`);

      // Same paper again: the entry is reused, not duplicated.
      picks.push('@article{einsteinCanQuantum1935,\n  title = {Can Quantum-Mechanical Description of Physical Reality Be Considered Complete?},\n  year = {1935},\n  doi = {10.1103/PhysRev.47.777}\n}\n');
      await openAt(main, 3);
      await vscode.commands.executeCommand('overtex.citeFromZotero');
      assert.strictEqual(fs.readFileSync(bib, 'utf8'), added, 'nothing appended');
      assert.ok(vscode.window.activeTextEditor!.document.lineAt(3).text.startsWith('\\cite{einsteinCanQuantum1935}'), 'cited again');

      // An empty answer means the picker was cancelled.
      const text = vscode.window.activeTextEditor!.document.getText();
      await vscode.commands.executeCommand('overtex.citeFromZotero');
      assert.strictEqual(vscode.window.activeTextEditor!.document.getText(), text, 'editor unchanged');
      assert.strictEqual(fs.readFileSync(bib, 'utf8'), added, '.bib unchanged');
    } finally {
      await cfg().update('zotero.url', undefined, vscode.ConfigurationTarget.Global);
      server.closeAllConnections();
      server.close();
      await openAt(main, 0);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
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
