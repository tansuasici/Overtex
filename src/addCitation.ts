import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { parseBib } from './latex/bibParser';
import {
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
  const editor = vscode.window.activeTextEditor;
  const texEditor = editor && TEX_LANGUAGES.has(editor.document.languageId) ? editor : undefined;

  const clip = (await vscode.env.clipboard.readText()).trim();
  const input = await vscode.window.showInputBox({
    title: 'Add Citation',
    prompt: 'DOI or arXiv ID, e.g. 10.1103/PhysRev.47.777 or arXiv:1706.03762',
    value: clip.length < 200 && parseIdentifier(clip) ? clip : '',
    ignoreFocusOut: true,
    validateInput: (v) => (!v.trim() || parseIdentifier(v) ? undefined : 'Not a DOI or arXiv ID.'),
  });
  const id = input && parseIdentifier(input);
  if (!id) {
    return;
  }

  const main = mainFile();
  const bib = await chooseBibFile(main);
  if (!bib) {
    return;
  }

  let doc = fs.existsSync(bib.fsPath) ? await vscode.workspace.openTextDocument(bib) : undefined;
  const entries = doc ? parseBib(doc.getText()) : [];

  let key: string;
  const existing = findByDoi(entries, id.doi);
  if (existing) {
    key = existing.key;
    void vscode.window.setStatusBarMessage(`Overtex: ${key} is already in ${path.basename(bib.fsPath)}`, 4000);
  } else {
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
      return;
    }

    const entry = prepareEntry(raw, entries.map((e) => e.key));
    key = entry.key;

    if (!doc) {
      await vscode.workspace.fs.writeFile(bib, new Uint8Array());
      doc = await vscode.workspace.openTextDocument(bib);
    }
    const text = doc.getText();
    const separator = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    const edit = new vscode.WorkspaceEdit();
    edit.insert(bib, doc.positionAt(text.length), separator + entry.text);
    if (!(await vscode.workspace.applyEdit(edit)) || !(await doc.save())) {
      void vscode.window.showErrorMessage(`Overtex: could not write ${vscode.workspace.asRelativePath(bib)}.`);
      return;
    }
    if (bib.created) {
      void vscode.window.showInformationMessage(
        `Overtex: created ${vscode.workspace.asRelativePath(bib)}. Add \\bibliography{${path.basename(bib.fsPath, '.bib')}} (or \\addbibresource{${path.basename(bib.fsPath)}}) to your document so it is used.`
      );
    }
  }

  if (texEditor && !texEditor.document.isClosed) {
    const pos = texEditor.selection.active;
    const before = texEditor.document.lineAt(pos.line).text.substring(0, pos.character);
    await texEditor.edit((b) => b.replace(texEditor.selection, citeInsertion(before, key)));
    await vscode.window.showTextDocument(texEditor.document, texEditor.viewColumn);
  } else {
    await vscode.env.clipboard.writeText(`\\cite{${key}}`);
    void vscode.window.showInformationMessage(`Overtex: added ${key}. \\cite{${key}} is on the clipboard.`);
  }
}

/** The .bib files `\bibliography` and `\addbibresource` in the main file name, whether they exist or not. */
export function bibFilesNamedBy(main: string): vscode.Uri[] {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === main);
  const tex = open ? open.getText() : fs.existsSync(main) ? fs.readFileSync(main, 'utf8') : '';
  return bibResourcesIn(tex).map((n) => vscode.Uri.file(path.resolve(path.dirname(main), n)));
}

type BibTarget = vscode.Uri & { created?: boolean };

/**
 * The bibliography the main file names, else the workspace's only .bib, else one the user
 * picks, else a new refs.bib beside the main file.
 */
async function chooseBibFile(main: string | null): Promise<BibTarget | undefined> {
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
    { title: 'Add Citation', placeHolder: 'Which bibliography should the entry go into?' }
  );
  return pick?.uri;
}
