import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { BibEntry, parseBib } from './latex/bibParser';
import {
  CitationId,
  CitationNotFoundError,
  bibResourcesIn,
  citeInsertion,
  fetchBibtex,
  findByDoi,
  parseIdentifier,
  prepareEntry,
} from './latex/citationImport';

const TEX_LANGUAGES = new Set(['latex', 'tex']);

/**
 * Overtex: Add Citation from DOI or arXiv. Fetches BibTeX from doi.org, appends it to the
 * project's bibliography (or reuses the entry already there) and cites it at the cursor.
 */
export async function addCitation(mainFile: () => string | null): Promise<void> {
  const texEditor = activeTexEditor();

  const id = await askForIdentifier('Add Citation');
  if (!id) {
    return;
  }

  const bib = await chooseBibFile(mainFile());
  if (!bib) {
    return;
  }

  const key = await addByIdentifier(id, bib);
  if (key) {
    await citeKeys(texEditor, [key]);
  }
}

/** Asks for a DOI or arXiv ID, offering the clipboard when it holds one. */
export async function askForIdentifier(title: string): Promise<CitationId | undefined> {
  const clip = (await vscode.env.clipboard.readText()).trim();
  const input = await vscode.window.showInputBox({
    title,
    prompt: 'DOI or arXiv ID, e.g. 10.1103/PhysRev.47.777 or arXiv:1706.03762',
    value: clip.length < 200 && parseIdentifier(clip) ? clip : '',
    ignoreFocusOut: true,
    validateInput: (v) => (!v.trim() || parseIdentifier(v) ? undefined : 'Not a DOI or arXiv ID.'),
  });
  return input ? parseIdentifier(input) : undefined;
}

/** The paper's key in the bibliography, fetching and appending its BibTeX unless the DOI is already there. */
export async function addByIdentifier(id: CitationId, bib: BibTarget): Promise<string | undefined> {
  const entries = await readBibEntries(bib);

  const existing = findByDoi(entries, id.doi);
  if (existing) {
    void vscode.window.setStatusBarMessage(`Overtex: ${existing.key} is already in ${path.basename(bib.fsPath)}`, 4000);
    return existing.key;
  }

  let raw: string;
  try {
    raw = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Overtex: fetching ${id.kind === 'arxiv' ? 'arXiv:' : ''}${id.id}…` },
      () => fetchBibtex(id.doi)
    );
  } catch (err) {
    const message =
      err instanceof CitationNotFoundError
        ? err.message
        : `Could not fetch ${id.id}: ${err instanceof Error && err.name === 'TimeoutError' ? 'doi.org did not answer in time' : String(err instanceof Error ? err.message : err)}.`;
    void vscode.window.showErrorMessage(`Overtex: ${message}`);
    return undefined;
  }

  const entry = prepareEntry(raw, entries.map((e) => e.key));
  return (await appendToBib(bib, entry.text)) ? entry.key : undefined;
}

export function activeTexEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor && TEX_LANGUAGES.has(editor.document.languageId) ? editor : undefined;
}

export async function readBibEntries(bib: vscode.Uri): Promise<BibEntry[]> {
  return fs.existsSync(bib.fsPath) ? parseBib((await vscode.workspace.openTextDocument(bib)).getText()) : [];
}

/** Adds entries to the end of the bibliography, creating it if needed. False if it could not be written. */
export async function appendToBib(bib: BibTarget, entries: string): Promise<boolean> {
  if (!fs.existsSync(bib.fsPath)) {
    await vscode.workspace.fs.writeFile(bib, new Uint8Array());
  }
  const doc = await vscode.workspace.openTextDocument(bib);
  const text = doc.getText();
  const separator = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  const edit = new vscode.WorkspaceEdit();
  edit.insert(bib, doc.positionAt(text.length), separator + entries);
  if (!(await vscode.workspace.applyEdit(edit)) || !(await doc.save())) {
    void vscode.window.showErrorMessage(`Overtex: could not write ${vscode.workspace.asRelativePath(bib)}.`);
    return false;
  }
  if (bib.created) {
    void vscode.window.showInformationMessage(
      `Overtex: created ${vscode.workspace.asRelativePath(bib)}. Add \\bibliography{${path.basename(bib.fsPath, '.bib')}} (or \\addbibresource{${path.basename(bib.fsPath)}}) to your document so it is used.`
    );
  }
  return true;
}

/** Cites the keys at the cursor, or puts the `\cite` on the clipboard when no LaTeX editor is open. */
export async function citeKeys(texEditor: vscode.TextEditor | undefined, keys: string[]): Promise<void> {
  const joined = keys.join(', ');
  if (texEditor && !texEditor.document.isClosed) {
    const pos = texEditor.selection.active;
    const before = texEditor.document.lineAt(pos.line).text.substring(0, pos.character);
    await texEditor.edit((b) => b.replace(texEditor.selection, citeInsertion(before, joined)));
    await vscode.window.showTextDocument(texEditor.document, texEditor.viewColumn);
  } else {
    await vscode.env.clipboard.writeText(`\\cite{${joined}}`);
    void vscode.window.showInformationMessage(`Overtex: added ${joined}. \\cite{${joined}} is on the clipboard.`);
  }
}

/** The .bib files `\bibliography` and `\addbibresource` in the main file name, whether they exist or not. */
export function bibFilesNamedBy(main: string): vscode.Uri[] {
  return bibResourcesIn(mainFileText(main)).map((n) => vscode.Uri.file(path.resolve(path.dirname(main), n)));
}

/** The main file as the editor has it, unsaved changes included. */
export function mainFileText(main: string): string {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === main);
  return open ? open.getText() : fs.existsSync(main) ? fs.readFileSync(main, 'utf8') : '';
}

export type BibTarget = vscode.Uri & { created?: boolean };

/**
 * The bibliography the main file names, else the workspace's only .bib, else one the user
 * picks, else a new refs.bib beside the main file.
 */
export async function chooseBibFile(main: string | null): Promise<BibTarget | undefined> {
  if (main) {
    const named = bibFilesNamedBy(main);
    const present = named.filter((u) => fs.existsSync(u.fsPath));
    if (present.length === 1) {
      return present[0];
    }
    if (present.length > 1) {
      return pickBib(present);
    }
    if (named.length > 0) {
      return Object.assign(named[0], { created: true });
    }
  }

  const found = await vscode.workspace.findFiles('**/*.bib', '**/node_modules/**', 50);
  if (found.length === 1) {
    return found[0];
  }
  if (found.length > 1) {
    return pickBib(found);
  }

  const dir = main ? path.dirname(main) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!dir) {
    void vscode.window.showErrorMessage('Overtex: open a folder or a .tex file to add citations to.');
    return undefined;
  }
  return Object.assign(vscode.Uri.file(path.join(dir, 'refs.bib')), { created: true });
}

async function pickBib(uris: vscode.Uri[]): Promise<vscode.Uri | undefined> {
  const pick = await vscode.window.showQuickPick(
    uris.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
    { title: 'Choose Bibliography', placeHolder: 'Which bibliography should the entry go into?' }
  );
  return pick?.uri;
}
