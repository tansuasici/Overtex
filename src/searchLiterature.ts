import * as vscode from 'vscode';
import * as path from 'path';

import { addByIdentifier, chooseBibFile, readBibEntries } from './addCitation';
import { BibEntry } from './latex/bibParser';
import { SearchHit, bibliographyMatcher, hitIdentifier, searchLiterature } from './latex/literature';

export interface SearchOptions {
  mainFile: () => string | null;
  userAgent: string;
  /** Every entry in the workspace's .bib files, to mark papers already there. */
  entries: () => Promise<BibEntry[]>;
  /** Called after papers were written to a .bib file. */
  onAdded: () => void;
}

interface HitItem extends vscode.QuickPickItem {
  hit: SearchHit;
  existing?: string;
}

/**
 * Overtex: Search Papers. Asks OpenAlex and arXiv, lets the user pick results, and adds
 * their BibTeX (fetched from doi.org, never built from search data) to the bibliography.
 */
export async function searchPapers(options: SearchOptions, initial?: string): Promise<void> {
  const query = await vscode.window.showInputBox({
    title: 'Search Papers',
    prompt: 'Words from the title, authors or topic. OpenAlex and arXiv are searched.',
    value: initial ?? selectedText(),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length > 300 ? 'Use a shorter search.' : undefined),
  });
  if (!query?.trim()) {
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Overtex: searching for “${query.trim()}”…`, cancellable: true },
    async (_progress, token) => {
      const abort = new AbortController();
      const sub = token.onCancellationRequested(() => abort.abort());
      try {
        const found = await searchLiterature(query, { userAgent: options.userAgent, signal: abort.signal });
        return abort.signal.aborted ? undefined : found;
      } finally {
        sub.dispose();
      }
    }
  );
  if (!result) {
    return;
  }
  if (result.hits.length === 0) {
    const why = result.failures.length ? ` ${result.failures.join('. ')}.` : '';
    const show = result.failures.length ? vscode.window.showErrorMessage : vscode.window.showInformationMessage;
    void show(`Overtex: no papers found for “${query.trim()}”.${why}`);
    return;
  }
  if (result.failures.length) {
    void vscode.window.showWarningMessage(`Overtex: ${result.failures.join('. ')}. Showing the other results.`);
  }

  const inBib = bibliographyMatcher(await options.entries());
  const items: HitItem[] = result.hits.map((hit) => hitItem(hit, inBib(hit)?.key));
  const picks = await vscode.window.showQuickPick(items, {
    title: `Search Papers: ${result.hits.length} found`,
    placeHolder: 'Pick the papers to add to your bibliography',
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  const wanted = picks?.filter((p) => !p.existing) ?? [];
  if (wanted.length === 0) {
    if (picks?.length) {
      void vscode.window.setStatusBarMessage('Overtex: those papers are already in your bibliography', 4000);
    }
    return;
  }

  const bib = await chooseBibFile(options.mainFile());
  if (!bib) {
    return;
  }
  const added: string[] = [];
  // One at a time: each key is picked against what the previous one wrote.
  for (const { hit } of wanted) {
    const id = hitIdentifier(hit);
    // The chosen file may have the paper even when the workspace index did not.
    const before = new Set((await readBibEntries(bib)).map((e) => e.key));
    const key = id ? await addByIdentifier(id, bib, hit.arxiv) : undefined;
    if (key && !before.has(key)) {
      added.push(key);
    }
  }
  if (added.length) {
    options.onAdded();
    void vscode.window.setStatusBarMessage(`Overtex: added ${added.join(', ')} to ${path.basename(bib.fsPath)}`, 6000);
  }
}

function selectedText(): string {
  const editor = vscode.window.activeTextEditor;
  const text = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).replace(/\s+/g, ' ').trim() : '';
  return text.length <= 200 ? text : '';
}

/** Text from a remote service, so `$(…)` cannot turn into an icon. */
function plain(s: string): string {
  return s.replace(/\$\(/g, '$\u200b(');
}

function hitItem(hit: SearchHit, existing: string | undefined): HitItem {
  const authors = hit.authors.length > 3 ? `${hit.authors.slice(0, 3).join(', ')} et al.` : hit.authors.join(', ');
  const detail = [
    hit.doi ? `DOI ${hit.doi}` : '',
    hit.arxiv ? `arXiv:${hit.arxiv}` : '',
    hit.citedBy !== undefined ? `cited by ${hit.citedBy.toLocaleString('en-US')}` : '',
    existing ? `in your bibliography as ${existing}` : '',
  ].filter(Boolean);
  return {
    label: `${existing ? '$(check) ' : ''}${plain(hit.title)}`,
    description: plain([authors, hit.year ? String(hit.year) : '', hit.venue ?? ''].filter(Boolean).join(' · ')),
    detail: plain(detail.join(' · ')),
    hit,
    existing,
  };
}
