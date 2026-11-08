import * as vscode from 'vscode';
import * as path from 'path';

import { activeTexEditor, appendToBib, chooseBibFile, citeKeys, mainFileText, readBibEntries } from './addCitation';
import { DEFAULT_ZOTERO_URL, ZoteroUnavailableError, mergePicks, pickFromZotero, probeZotero, translatorFor } from './latex/zotero';

const BETTER_BIBTEX_URL = 'https://retorque.re/zotero-better-bibtex/';

/**
 * Overtex: Cite from Zotero. Opens Zotero's picker through Better BibTeX, adds what was picked to
 * the project's bibliography (or reuses the entries already there) and cites it at the cursor.
 */
export async function citeFromZotero(mainFile: () => string | null): Promise<void> {
  const texEditor = activeTexEditor();
  const url = vscode.workspace.getConfiguration('overtex').get<string>('zotero.url') || DEFAULT_ZOTERO_URL;

  // Before asking which bibliography, so nobody answers that only to learn Zotero is closed.
  try {
    await probeZotero(url);
  } catch (err) {
    await reportUnavailable(err, url);
    return;
  }

  const main = mainFile();
  const bib = await chooseBibFile(main);
  if (!bib) {
    return;
  }

  let raw: string;
  try {
    raw = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Overtex: pick references in Zotero…', cancellable: true },
      (_, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        return pickFromZotero(url, translatorFor(main ? mainFileText(main) : ''), abort.signal);
      }
    );
  } catch (err) {
    if (!(err instanceof Error && err.name === 'AbortError')) {
      void vscode.window.showErrorMessage(`Overtex: could not get the references from Zotero: ${err instanceof Error ? err.message : String(err)}.`);
    }
    return;
  }
  if (!raw) {
    return;
  }

  // Read after the pick: the file may have changed while the picker was open.
  const { keys, text } = mergePicks(raw, await readBibEntries(bib));
  if (keys.length === 0) {
    void vscode.window.showErrorMessage('Overtex: Zotero did not return any BibTeX entries.');
    return;
  }
  if (text) {
    if (!(await appendToBib(bib, text))) {
      return;
    }
  } else {
    void vscode.window.setStatusBarMessage(`Overtex: already in ${path.basename(bib.fsPath)}`, 4000);
  }

  await citeKeys(texEditor, keys);
}

async function reportUnavailable(err: unknown, url: string): Promise<void> {
  if (err instanceof ZoteroUnavailableError && err.reason === 'no-better-bibtex') {
    const open = 'Get Better BibTeX';
    const choice = await vscode.window.showErrorMessage('Overtex: Zotero answered, but without Better BibTeX, the add-on this command needs.', open);
    if (choice === open) {
      await vscode.env.openExternal(vscode.Uri.parse(BETTER_BIBTEX_URL));
    }
    return;
  }
  void vscode.window.showErrorMessage(`Overtex: could not reach Zotero at ${url}. Start Zotero with Better BibTeX on the computer running this window's extensions, or set overtex.zotero.url.`);
}
