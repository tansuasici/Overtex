// Runs inside the VS Code extension host (see run.mjs). Drives build, forward search and inverse
// search through the real PDF viewer webview, using the test hooks enabled by OVERTEX_E2E.
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
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

  await step('slideshow: one page at a time, keys, forward search, Esc', async () => {
    const after = async (act: () => unknown) => {
      const shown = nextMessage(e2e, 'e2e:slide');
      await act();
      return shown;
    };
    const key = (k: string) => after(() => e2e.sendToViewer({ type: 'e2e:key', key: k }));
    let state = await after(() => vscode.commands.executeCommand('overtex.viewer.present'));
    assert.strictEqual(state.presenting, true, 'the slideshow starts');
    assert.strictEqual(state.visible, 1, 'one page is shown');
    assert.ok(state.fits, 'the page fits the preview');
    assert.strictEqual((await key('Home')).slide, 0);
    assert.strictEqual((await key('ArrowRight')).slide, 1);
    assert.strictEqual((await key('ArrowLeft')).slide, 0);
    assert.strictEqual((await key('End')).slide, 2);
    state = await key(' ');
    assert.strictEqual(state.slide, 2, 'stays on the last page');

    await openAt(main, 4);
    const revealed = nextMessage(e2e, 'e2e:revealed');
    state = await after(() => vscode.commands.executeCommand('overtex.forwardSearch'));
    assert.strictEqual(state.slide, 1, 'forward search shows the slide');
    assert.strictEqual(state.visible, 1);
    assert.ok((await revealed).inView, 'the marked line is on the slide');

    state = await key('Escape');
    assert.strictEqual(state.presenting, false, 'Esc ends it');
    // A short window cannot scroll page 2 to the top; then the preview is as far down as it goes.
    const { scrollTop, height, scrollHeight } = state.layout;
    const atBottom = state.position > 0.5 && scrollTop >= scrollHeight - height - 1;
    assert.ok(Math.floor(state.position + 0.01) === 1 || atBottom, `the preview is left at that page (${state.position}, ${JSON.stringify(state.layout)})`);
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

  await step('history keeps a snapshot per build, and compares one with the files now', async () => {
    const before = e2e!.snapshots();
    assert.ok(before.length >= 1, 'the first build left a snapshot');
    assert.ok(before[0].pdf, 'the snapshot kept the PDF');
    assert.ok(before[0].files.some((f) => f.path === 'chapters/part.tex'), 'the snapshot has the \\input file');
    const original = await vscode.workspace.fs.readFile(vscode.Uri.file(part));
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(part), Buffer.concat([Buffer.from(original), Buffer.from('\nA sentence added after the snapshot.\n')]));
      await openAt(main, 0);
      await vscode.commands.executeCommand('overtex.history.snapshot');
      const after = e2e!.snapshots();
      assert.strictEqual(after.length, before.length + 1, 'a new snapshot');
      assert.strictEqual(after[0].trigger, 'manual');
      assert.strictEqual(await vscode.commands.executeCommand('overtex.history.snapshot'), undefined, 'nothing changed, so no snapshot');

      const loaded = nextMessage(e2e!, 'e2e:loaded', 120000);
      await vscode.commands.executeCommand('overtex.history.openPdf', before[0].id);
      assert.strictEqual((await loaded).pages, 3, 'the snapshot PDF opens in the preview');

      const result = await vscode.commands.executeCommand<import('../../src/latex/latexdiff').CompareResult>('overtex.history.compare', before[0].id);
      if (!result) {
        assert.ok(!process.env.OVERTEX_REQUIRE_TEX, 'latexdiff did not run');
      } else {
        assert.strictEqual(result.status, 'built');
        assert.ok(result.status === 'built' && /\\DIFadd\{[^}]*snapshot/.test(result.diffText), 'the added sentence is marked');
      }
    } finally {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(part), original);
    }
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

  await step('review PDF puts open notes in the margin of a numbered copy', async () => {
    const file = path.join(root, 'main.overtex-notes.json');
    // At the forward search results, so that SyncTeX finds lines in main.tex and chapters/part.tex.
    const note = (id: string, target: PageRect, text: string, done?: string) => ({
      id,
      page: target.page,
      x: target.x + (target.width > 0 ? target.width : 40) / 2,
      y: target.y + target.height / 2,
      text,
      createdAt: '2026-11-09T00:00:00.000Z',
      ...(done ? { doneAt: done } : {}),
    });
    const notes = [note('in-main', targets['main.tex'], 'Cite 50% of this'), note('in-part', targets['part.tex'], 'And here'), note('done', targets['main.tex'], 'Old', '2026-11-09T01:00:00.000Z')];
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, notes })}\n`);
    const before = fs.readFileSync(main, 'utf8');
    try {
      await openAt(main, 0);
      // The command builds main.pdf first to place the notes, so the review copy is the last load.
      const seen: E2eFromViewerMessage[] = [];
      const sub = e2e!.onViewerMessage((msg) => seen.push(msg));
      let result: import('../../src/latex/review').ReviewResult | undefined;
      try {
        result = await vscode.commands.executeCommand<import('../../src/latex/review').ReviewResult>('overtex.exportReviewPdf', { lineNumbers: true, notes: true });
        await waitFor('the review copy in the preview, without notes', () => seen.some((m) => m.type === 'e2e:notes' && !m.enabled), 120000);
      } finally {
        sub.dispose();
      }
      assert.ok(result && result.status === 'built', `status: ${result?.status}`);
      assert.strictEqual(result.placed, 2, 'both open notes placed, the done one left out');
      assert.strictEqual(path.basename(result.pdf), 'main-review.pdf');
      assert.ok(result.complete, 'the review copy built without errors');
      const loads = seen.filter((m): m is ViewerMessage<'e2e:loaded'> => m.type === 'e2e:loaded');
      const shown = seen.filter((m): m is ViewerMessage<'e2e:notes'> => m.type === 'e2e:notes');
      assert.ok(loads[loads.length - 1].pages >= 3);
      assert.strictEqual(shown[shown.length - 1].enabled, false, 'the review copy takes no notes');
      assert.strictEqual(fs.readFileSync(main, 'utf8'), before, 'the source is untouched');
    } finally {
      fs.rmSync(file, { force: true });
    }
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

  await step('spelling and grammar check marks a misspelling and fixes it', async () => {
    // A stand-in for LanguageTool's /v2/check, answering for the first "teh" in what it is sent.
    const sent: { language: string; text: string }[] = [];
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/v2/languages')) {
        res.end('[]');
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const pieces = (JSON.parse(form.get('data')!) as { annotation: ({ text: string } | { markup: string })[] }).annotation;
        const joinedText = pieces.map((p) => ('text' in p ? p.text : p.markup)).join('');
        sent.push({ language: form.get('language')!, text: pieces.map((p) => ('text' in p ? p.text : '')).join('') });
        const at = joinedText.indexOf('teh');
        const matches = at < 0 ? [] : [{
          offset: at,
          length: 3,
          message: 'Possible spelling mistake found.',
          replacements: [{ value: 'the' }],
          rule: { id: 'MORFOLOGIK_RULE_EN_GB', issueType: 'misspelling', category: { id: 'TYPOS' } },
        }];
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ matches }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const cfg = () => vscode.workspace.getConfiguration('overtex.grammar');
    try {
      await cfg().update('url', `http://127.0.0.1:${(server.address() as AddressInfo).port}`, vscode.ConfigurationTarget.Global);
      const source = '\\documentclass{article}\n\\usepackage[british]{babel}\n\\begin{document}\nThis is teh text, $x = 1$ % not checked\n\\end{document}\n';
      const doc = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

      const problems = await vscode.commands.executeCommand<unknown[]>('overtex.checkGrammar');
      assert.strictEqual(problems?.length, 1, 'one problem');
      assert.strictEqual(sent[0].language, 'en-GB', 'language from babel');
      assert.ok(!sent[0].text.includes('documentclass') && !sent[0].text.includes('not checked'), `only prose sent: ${sent[0].text}`);
      const diags = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'Overtex grammar');
      assert.strictEqual(diags.length, 1);
      assert.strictEqual(doc.getText(diags[0].range), 'teh', 'the finding sits on the word');

      // An edit before the finding moves it along.
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(3, 0), 'Well. ');
      await vscode.workspace.applyEdit(edit);
      const moved = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'Overtex grammar');
      assert.strictEqual(moved.length, 1);
      assert.strictEqual(doc.getText(moved[0].range), 'teh', 'still on the word after an edit');

      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, moved[0].range);
      const titles = actions.map((a) => a.title);
      assert.ok(titles.includes("Add 'teh' to the dictionary") && titles.some((t) => t.startsWith('Disable the rule')), titles.join(', '));
      const replace = actions.find((a) => a.title === "Replace with 'the'");
      assert.ok(replace?.edit, titles.join(', '));
      await vscode.workspace.applyEdit(replace.edit);
      assert.ok(doc.lineAt(3).text.startsWith('Well. This is the text'), doc.lineAt(3).text);
      assert.strictEqual(vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'Overtex grammar').length, 0, 'the fix clears the finding');
    } finally {
      await cfg().update('url', undefined, vscode.ConfigurationTarget.Global);
      server.closeAllConnections();
      server.close();
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
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

  await step('Papers panel groups the .bib by citation and cites a paper', async () => {
    const bib = path.join(root, 'refs.bib');
    const tex = path.join(root, 'papers-e2e.tex');
    const original = fs.readFileSync(bib, 'utf8');
    try {
      fs.writeFileSync(bib, `${original}\n@article{citedPaper,\n  title = {Cited},\n  year = {2021}\n}\n\n@article{uncitedPaper,\n  title = {Not Cited Yet},\n  year = {2020},\n  eprint = {1706.03762},\n  archivePrefix = {arXiv}\n}\n`);
      fs.writeFileSync(tex, '% \\cite{uncitedPaper}\n\\cite{citedPaper}\n');
      await vscode.commands.executeCommand('overtex.library.refresh');
      const groups = await e2e.paperGroups();
      const group = (name: string) => groups.find((g) => g.group === name)?.keys ?? [];
      assert.ok(group('Cited').includes('citedPaper'), JSON.stringify(groups));
      assert.ok(group('Not cited').includes('uncitedPaper'), JSON.stringify(groups));

      const doc = await vscode.workspace.openTextDocument({ language: 'latex', content: 'See ' });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(0, 4, 0, 4);
      await vscode.commands.executeCommand('overtex.library.cite', 'uncitedPaper');
      assert.ok(doc.getText().includes('\\cite{uncitedPaper}'), doc.getText());
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    } finally {
      fs.writeFileSync(bib, original);
      fs.rmSync(tex, { force: true });
      await vscode.commands.executeCommand('overtex.library.refresh');
    }
  });

  await step('The Labels panel lists labels, finds references and renames across files', async () => {
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const closed = path.join(root, 'labels-closed.tex');
    const opened = path.join(root, 'labels-open.tex');
    try {
      fs.writeFileSync(closed, '\\section{A}\\label{sec:old}\n% \\ref{sec:commented}\n\\begin{figure}\\label{fig:one}\\end{figure}\n');
      fs.writeFileSync(opened, 'See \\cref{sec:old,fig:one} and \\ref{sec:typo}.\n');
      await vscode.commands.executeCommand('overtex.labels.refresh');
      const groups = await e2e.labelGroups();
      const group = (name: string) => groups.find((g) => g.group === name)?.keys ?? [];
      assert.deepStrictEqual(group('Undefined references'), ['sec:typo'], JSON.stringify(groups));
      assert.deepStrictEqual(group('Sections'), ['sec:old'], JSON.stringify(groups));
      assert.deepStrictEqual(group('Figures'), ['fig:one'], JSON.stringify(groups));

      const doc = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(opened), 'latex');
      await vscode.window.showTextDocument(doc);
      const onLabel = new vscode.Position(0, 12);
      const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, onLabel);
      assert.ok(definitions.some((d) => d.uri.fsPath === closed && d.range.start.line === 0), JSON.stringify(definitions));
      const references = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, onLabel);
      assert.strictEqual(references.filter((r) => r.uri.fsPath === opened).length, 1, JSON.stringify(references));

      // The panel's rename reaches a closed file and saves it.
      await vscode.commands.executeCommand('overtex.labels.rename', 'sec:old', 'sec:new');
      assert.ok(doc.getText().includes('\\cref{sec:new,fig:one}'), doc.getText());
      assert.ok(fs.readFileSync(closed, 'utf8').includes('\\label{sec:new}'), fs.readFileSync(closed, 'utf8'));

      // Pointing the undefined reference at a label removes it from the undefined group.
      await vscode.commands.executeCommand('overtex.labels.rename', 'sec:typo', 'sec:new');
      assert.ok(doc.getText().includes('\\ref{sec:new}'), doc.getText());
      assert.strictEqual((await e2e.labelGroups()).some((g) => g.group === 'Undefined references'), false);

      // A label's new name cannot be another label's: nothing changes.
      const before = doc.getText();
      await vscode.commands.executeCommand('overtex.labels.rename', 'fig:one', 'sec:new');
      assert.strictEqual(doc.getText(), before);

      // F2 goes through the rename provider.
      const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, onLabel, 'sec:f2');
      assert.ok(edit.entries().some(([uri]) => uri.fsPath === closed), 'the rename should reach the closed file');

      const editor = vscode.window.activeTextEditor!;
      editor.selection = new vscode.Selection(1, 0, 1, 0);
      await vscode.commands.executeCommand('overtex.labels.insertRef', 'fig:one');
      assert.ok(doc.getText().includes('\\ref{fig:one}\n') || doc.getText().endsWith('\\ref{fig:one}'), doc.getText());
      await vscode.commands.executeCommand('workbench.action.files.save');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      fs.rmSync(closed, { force: true });
      fs.rmSync(opened, { force: true });
      await vscode.commands.executeCommand('overtex.labels.refresh');
    }
  });

  await step('figures and CSV tables go in with their packages, outside images copied', async () => {
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const scratch = path.join(root, 'insert.tex');
    const csv = path.join(root, 'Ölçüm Sonuçları.csv');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-e2e-img-'));
    const image = path.join(outside, 'My Plot.png');
    const mainDoc = await vscode.workspace.openTextDocument(main);
    const mainBefore = mainDoc.getText();
    try {
      fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex'));
      fs.writeFileSync(csv, '\uFEFFÖrnek;Değer\r\nA_1;1,5\r\nB;20\r\n');
      fs.writeFileSync(scratch, '\n');

      // Into the main file itself: the package line goes in above, and the figure still lands at the cursor.
      const diagram = path.join(outside, 'Diagram.png');
      fs.writeFileSync(diagram, Buffer.from('89504e470d0a1a0a', 'hex'));
      const mainEditor = await vscode.window.showTextDocument(mainDoc, vscode.ViewColumn.One);
      mainEditor.selection = new vscode.Selection(2, 0, 2, 0);
      assert.ok(await e2e.insertFiles([vscode.Uri.file(diagram)]), 'the figure should go into main.tex');
      await vscode.commands.executeCommand('leaveSnippet');
      const mainLines = mainDoc.getText().split('\n');
      assert.deepStrictEqual(mainLines.slice(0, 4), ['\\documentclass{article}', '\\usepackage{graphicx}', '\\begin{document}', '\\begin{figure}[htbp]'], mainDoc.getText());
      assert.ok(mainDoc.getText().includes('\\end{figure}\nFirst page.'), mainDoc.getText());
      const undo = new vscode.WorkspaceEdit();
      undo.replace(mainDoc.uri, new vscode.Range(0, 0, mainDoc.lineCount, 0), mainBefore);
      await vscode.workspace.applyEdit(undo);
      fs.rmSync(path.join(root, 'figures'), { recursive: true, force: true });

      const doc = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(scratch), 'latex');
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

      editor.selection = new vscode.Selection(0, 0, 0, 0);
      assert.ok(await e2e.insertFiles([vscode.Uri.file(image)]), 'the figure should go in');
      await vscode.commands.executeCommand('leaveSnippet');
      assert.ok(doc.getText().includes('\\includegraphics[width=0.8\\linewidth]{figures/my-plot.png}'), doc.getText());
      assert.ok(doc.getText().includes('\\label{fig:my-plot}'), doc.getText());
      assert.ok(fs.existsSync(path.join(root, 'figures', 'my-plot.png')), 'the image is copied next to the main file');
      assert.ok(mainDoc.getText().includes('\\documentclass{article}\n\\usepackage{graphicx}\n'), mainDoc.getText());

      const end = doc.lineAt(doc.lineCount - 1).range.end;
      editor.selection = new vscode.Selection(end, end);
      assert.ok(await e2e.insertFiles([vscode.Uri.file(csv)]), 'the table should go in');
      await vscode.commands.executeCommand('leaveSnippet');
      const text = doc.getText();
      assert.ok(text.includes('\\begin{tabular}{lr}'), text);
      assert.ok(text.includes('A\\_1 & 1,5 \\\\'), text);
      assert.ok(text.includes('\\label{tab:olcum-sonuclari}'), text);
      assert.ok(mainDoc.getText().includes('\\usepackage{graphicx}\n\\usepackage{booktabs}\n'), mainDoc.getText());

      // Tab-separated text, as pasted from a spreadsheet, turns into a table in place.
      const pasted = 'x\ty\n1\t2\n';
      const at = doc.lineCount - 1;
      await editor.edit((b) => b.insert(new vscode.Position(at, 0), pasted));
      editor.selection = new vscode.Selection(at, 0, at + 2, 0);
      await vscode.commands.executeCommand('overtex.insertTable');
      await vscode.commands.executeCommand('leaveSnippet');
      assert.ok(!doc.getText().includes('x\ty'), doc.getText());
      assert.ok(doc.getText().includes('    x & y \\\\\n    \\midrule\n    1 & 2 \\\\'), doc.getText());
      assert.ok(doc.getText().includes('\\label{tab:table}'), doc.getText());
      assert.strictEqual(mainDoc.getText().match(/booktabs/g)?.length, 1, 'booktabs is not added twice');

      await vscode.commands.executeCommand('workbench.action.files.save');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      const restore = new vscode.WorkspaceEdit();
      restore.replace(mainDoc.uri, new vscode.Range(0, 0, mainDoc.lineCount, 0), mainBefore);
      await vscode.workspace.applyEdit(restore);
      await mainDoc.save();
      fs.rmSync(scratch, { force: true });
      fs.rmSync(csv, { force: true });
      fs.rmSync(path.join(root, 'figures'), { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // These rearrange the editor groups, so they run last.
  const closeViewer = async () => {
    await api.viewPdf();
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label === 'main.pdf');
    assert.ok(tab, 'the preview tab');
    await vscode.window.tabGroups.close(tab);
    await waitFor('the preview to close', () => e2e!.viewerColumn() === undefined);
  };

  await step('the preview stays in the group it was moved to, and reopens there', async () => {
    await openAt(main, 0);
    const other = await vscode.workspace.openTextDocument(part);
    await vscode.window.showTextDocument(other, { viewColumn: vscode.ViewColumn.Two });
    await api.viewPdf();
    assert.strictEqual(e2e.viewerColumn(), vscode.ViewColumn.Two, 'starts beside the editor');

    await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup');
    await waitFor('the move to group 3', () => e2e.viewerColumn() === vscode.ViewColumn.Three);

    // Hidden behind another editor in its group, then brought forward: it must not move.
    await vscode.window.showTextDocument(other, { viewColumn: vscode.ViewColumn.Three });
    await waitFor('the preview to be hidden', () => vscode.window.tabGroups.all[2]?.activeTab?.label === 'part.tex');
    await openAt(main, 0);
    await api.viewPdf();
    await waitFor('the preview to come forward', () => vscode.window.tabGroups.all[2]?.activeTab?.label === 'main.pdf');
    assert.strictEqual(e2e.viewerColumn(), vscode.ViewColumn.Three, 'still in group 3');

    await closeViewer();
    await openAt(main, 0);
    const loaded = nextMessage(e2e, 'e2e:loaded');
    await api.viewPdf();
    await loaded;
    assert.strictEqual(e2e.viewerColumn(), vscode.ViewColumn.Three, 'reopens in group 3');
  });

  await step('a restored preview gets its PDF back, and a second one is dropped', async () => {
    await closeViewer();
    const restored = vscode.window.createWebviewPanel('overtex.pdfPreview', 'stale title', vscode.ViewColumn.Two, { retainContextWhenHidden: true });
    const loaded = nextMessage(e2e, 'e2e:loaded');
    await e2e.restoreViewer(restored);
    assert.strictEqual((await loaded).pages, 3);
    assert.strictEqual(restored.title, 'main.pdf');

    const second = vscode.window.createWebviewPanel('overtex.pdfPreview', 'second', vscode.ViewColumn.Two);
    let disposed = false;
    second.onDidDispose(() => (disposed = true));
    await e2e.restoreViewer(second);
    assert.ok(disposed, 'the second panel is closed');
    assert.ok(e2e.viewerColumn() !== undefined, 'the first panel stays');
  });

  await step('moves the preview to a new window and keeps the page', async () => {
    // Zoomed in so that the search has to scroll: at fit width page 2 can already be on screen.
    const zoomed = nextMessage(e2e, 'e2e:notes');
    e2e.sendToViewer({ type: 'e2e:zoom', zoom: 3 });
    await zoomed;
    await openAt(main, 4);
    const revealed = nextMessage(e2e, 'e2e:revealed');
    await vscode.commands.executeCommand('overtex.forwardSearch');
    const before = await revealed;
    assert.strictEqual(before.target.page, 2);
    assert.ok(before.position > 0.5, `the search did not scroll (${before.position} pages down)`);
    await new Promise((r) => setTimeout(r, 500)); // The viewer saves its place shortly after scrolling.

    // Only the preview moves, not the source file, and the webview starts over in the new window.
    const settled = nextMessage(e2e, 'e2e:settled');
    await vscode.commands.executeCommand('overtex.viewer.moveToNewWindow');
    const { position } = await settled;
    assert.ok(Math.abs(position - before.position) < 0.02, `the viewer moved from ${before.position} to ${position} pages down`);
    const holding = (label: string) => vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.label === label));
    assert.deepStrictEqual(
      holding('main.pdf')?.tabs.map((t) => t.label),
      ['main.pdf']
    );
    assert.notStrictEqual(holding('main.pdf'), holding('main.tex'));
  });

  if (failed) {
    throw new Error(`${failed} end-to-end step(s) failed`);
  }
}
