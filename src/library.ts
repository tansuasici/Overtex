import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { activeTexEditor, addByIdentifier, appendToBib, askForIdentifier, chooseBibFile, citeKeys, readBibEntries } from './addCitation';
import { arxivIdOf } from './latex/bibCheck';
import { BibIndex, IndexedEntry } from './latex/bibIndex';
import { parseBib } from './latex/bibParser';
import { citationHoverMarkdown } from './latex/cite';
import { CitationNotFoundError } from './latex/citationImport';
import {
  CitedKeys,
  PaperSort,
  citedKeys,
  fetchArxivPdf,
  findPdf,
  groupPapers,
  mergeCited,
  paperPdfPath,
  paperUrl,
  paperYear,
  plainTex,
  shortAuthors,
} from './latex/library';
import { mergePicks } from './latex/zotero';

const TEX_LANGUAGES = new Set(['latex', 'tex']);
const SORT_STATE = 'overtex.papers.sort';
const SORTS: { sort: PaperSort; label: string }[] = [
  { sort: 'year', label: 'Year (newest first)' },
  { sort: 'author', label: 'First author' },
  { sort: 'title', label: 'Title' },
];

class GroupItem extends vscode.TreeItem {
  constructor(
    readonly group: string,
    readonly papers: PaperItem[]
  ) {
    super(group, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `overtex.papers.${group}`;
    this.description = String(papers.length);
    this.contextValue = 'group';
  }
}

class PaperItem extends vscode.TreeItem {
  constructor(
    readonly paper: IndexedEntry,
    readonly pdf: string | undefined
  ) {
    super(plainTex(paper.rawTitle ?? paper.title) || paper.key);
    this.description = [shortAuthors(paper.rawAuthor ?? paper.author), paperYear(paper)].filter(Boolean).join(', ');
    this.tooltip = new vscode.MarkdownString(citationHoverMarkdown(paper));
    this.iconPath = new vscode.ThemeIcon(pdf ? 'file-pdf' : 'book');
    this.contextValue = [
      'paper',
      pdf ? 'pdf' : arxivIdOf(paper) ? 'download' : '',
      paperUrl(paper) ? 'web' : '',
    ].filter(Boolean).join(' ');
    this.command = { command: 'overtex.library.open', title: 'Open', arguments: [paper.key] };
  }
}

type Node = GroupItem | PaperItem;

/** Which keys the workspace's .tex files cite, keeping closed files' answers until they change. */
class CitationScan implements vscode.Disposable {
  private readonly closed = new Map<string, CitedKeys>();
  private readonly watcher = vscode.workspace.createFileSystemWatcher('**/*.tex');
  private readonly subscriptions: vscode.Disposable[];

  constructor(onChange: () => void) {
    const forget = (uri: vscode.Uri) => {
      this.closed.delete(uri.fsPath);
      onChange();
    };
    this.subscriptions = [
      this.watcher,
      this.watcher.onDidChange(forget),
      this.watcher.onDidCreate(forget),
      this.watcher.onDidDelete(forget),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0 && TEX_LANGUAGES.has(e.document.languageId)) {
          onChange();
        }
      }),
      // Closing without saving leaves the file as it was on disk, not as the editor had it.
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (TEX_LANGUAGES.has(doc.languageId)) {
          forget(doc.uri);
        }
      }),
    ];
  }

  async cited(): Promise<CitedKeys> {
    const files = await vscode.workspace.findFiles('**/*.tex', '**/node_modules/**', 2000);
    const open = new Map(vscode.workspace.textDocuments.map((doc) => [doc.uri.fsPath, doc]));
    return mergeCited(
      await Promise.all(
        files.map(async (file) => {
          const doc = open.get(file.fsPath);
          if (doc) {
            return citedKeys(doc.getText());
          }
          let found = this.closed.get(file.fsPath);
          if (!found) {
            try {
              found = citedKeys(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf-8'));
            } catch {
              return { keys: new Set<string>(), all: false };
            }
            this.closed.set(file.fsPath, found);
          }
          return found;
        })
      )
    );
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
  }
}

class PapersProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly index: BibIndex,
    private readonly scan: CitationScan,
    private readonly sort: () => PaperSort
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  async groups(): Promise<GroupItem[]> {
    const [entries, cited] = await Promise.all([this.index.entries(), this.scan.cited()]);
    return groupPapers(entries, cited, this.sort()).map(
      ({ group, papers }) => new GroupItem(group, papers.map((p) => new PaperItem(p, pdfOf(p))))
    );
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.groups();
    }
    return node instanceof GroupItem ? node.papers : [];
  }
}

function pdfOf(paper: IndexedEntry): string | undefined {
  return findPdf(paper, paper.file.fsPath, (file) => fs.existsSync(file));
}

export interface LibraryOptions {
  index: BibIndex;
  mainFile: () => string | null;
  userAgent: string;
  showPdf: (pdfFile: string) => void | Promise<void>;
}

export interface Library {
  groups(): Promise<{ group: string; keys: string[] }[]>;
}

/** The Papers panel: what the workspace's .bib files hold, cited or not, and what can be done with each paper. */
export function registerLibrary(context: vscode.ExtensionContext, options: LibraryOptions): Library {
  const { index, mainFile, userAgent, showPdf } = options;
  const sort = () => context.workspaceState.get<PaperSort>(SORT_STATE, 'year');

  let timer: ReturnType<typeof setTimeout> | undefined;
  const refreshSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => provider.refresh(), 500);
  };
  const scan = new CitationScan(refreshSoon);
  const provider = new PapersProvider(index, scan, sort);
  const pdfWatcher = vscode.workspace.createFileSystemWatcher('**/papers/*.pdf');

  /** A row of the panel, or a key from a command run by another extension or a test. */
  const paperOf = async (arg?: PaperItem | string): Promise<IndexedEntry | undefined> => {
    if (arg instanceof PaperItem) {
      return arg.paper;
    }
    return arg ? (await index.entries()).find((e) => e.key === arg) : undefined;
  };

  const reveal = async (paper: IndexedEntry) => {
    const position = new vscode.Position(paper.line, 0);
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(paper.file), {
      selection: new vscode.Range(position, position),
    });
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  };

  const cite = async (paper: IndexedEntry) => {
    // A focused PDF preview leaves no active text editor, while the draft is still on screen.
    const editor = activeTexEditor() ?? vscode.window.visibleTextEditors.find((e) => TEX_LANGUAGES.has(e.document.languageId));
    if (editor) {
      await citeKeys(editor, [paper.key]);
    } else {
      await vscode.env.clipboard.writeText(`\\cite{${paper.key}}`);
      void vscode.window.showInformationMessage(`Overtex: \\cite{${paper.key}} is on the clipboard.`);
    }
  };

  const download = async (paper: IndexedEntry) => {
    const existing = pdfOf(paper);
    if (existing) {
      await showPdf(existing);
      return;
    }
    const id = arxivIdOf(paper);
    if (!id) {
      void vscode.window.showErrorMessage(`Overtex: ${paper.key} has no arXiv ID to download from.`);
      return;
    }
    const target = paperPdfPath(paper.file.fsPath, paper.key);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Overtex: downloading arXiv:${id}…`, cancellable: true },
      async (_, token) => {
        const abort = new AbortController();
        const cancel = token.onCancellationRequested(() => abort.abort());
        try {
          const data = await fetchArxivPdf(id, { userAgent, signal: abort.signal });
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target)));
          await vscode.workspace.fs.writeFile(vscode.Uri.file(target), data);
          provider.refresh();
          await showPdf(target);
        } catch (err) {
          if (!token.isCancellationRequested) {
            void vscode.window.showErrorMessage(`Overtex: ${downloadError(id, err)}`);
          }
        } finally {
          cancel.dispose();
        }
      }
    );
  };

  const addPaper = async () => {
    const clip = await vscode.env.clipboard.readText();
    const pasted = parseBib(clip);
    if (pasted.length > 0) {
      const keys = pasted.slice(0, 3).map((e) => e.key).join(', ') + (pasted.length > 3 ? ', …' : '');
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Add BibTeX from Clipboard', description: keys, clipboard: true },
          { label: 'Enter DOI or arXiv ID…', clipboard: false },
        ],
        { title: 'Add Paper' }
      );
      if (!pick) {
        return;
      }
      if (pick.clipboard) {
        const bib = await chooseBibFile(mainFile());
        if (bib) {
          const merged = mergePicks(clip, await readBibEntries(bib));
          if (!merged.text || (await appendToBib(bib, merged.text))) {
            index.invalidate();
          }
        }
        return;
      }
    }
    const id = await askForIdentifier('Add Paper');
    const bib = id && (await chooseBibFile(mainFile()));
    if (id && bib && (await addByIdentifier(id, bib))) {
      index.invalidate();
    }
  };

  const withPaper = (run: (paper: IndexedEntry) => unknown) => async (arg?: PaperItem | string) => {
    const paper = await paperOf(arg);
    if (paper) {
      await run(paper);
    }
  };

  const openPdf = async (paper: IndexedEntry) => {
    const pdf = pdfOf(paper);
    if (pdf) {
      await showPdf(pdf);
    }
  };

  const register = vscode.commands.registerCommand;
  context.subscriptions.push(
    { dispose: () => clearTimeout(timer) },
    scan,
    pdfWatcher,
    pdfWatcher.onDidCreate(refreshSoon),
    pdfWatcher.onDidDelete(refreshSoon),
    index.onDidChange(refreshSoon),
    vscode.window.createTreeView('overtex.papers', { treeDataProvider: provider, showCollapseAll: true }),
    register('overtex.library.open', withPaper((paper) => (pdfOf(paper) ? openPdf(paper) : reveal(paper)))),
    register('overtex.library.cite', withPaper(cite)),
    register('overtex.library.reveal', withPaper(reveal)),
    register('overtex.library.openPdf', withPaper(openPdf)),
    register('overtex.library.downloadPdf', withPaper(download)),
    register('overtex.library.openPage', withPaper((paper) => {
      const url = paperUrl(paper);
      return url ? vscode.env.openExternal(vscode.Uri.parse(url, true)) : undefined;
    })),
    register('overtex.library.add', addPaper),
    register('overtex.library.refresh', () => index.invalidate()),
    register('overtex.library.sort', async (choice?: PaperSort) => {
      const next =
        choice ??
        (
          await vscode.window.showQuickPick(
            SORTS.map((s) => ({ ...s, description: s.sort === sort() ? 'current' : undefined })),
            { title: 'Sort Papers' }
          )
        )?.sort;
      if (next) {
        await context.workspaceState.update(SORT_STATE, next);
        provider.refresh();
      }
    })
  );
  void vscode.commands.executeCommand('setContext', 'overtex.active', true);

  return {
    groups: async () =>
      (await provider.groups()).map((g) => ({ group: g.group, keys: g.papers.map((p) => p.paper.key) })),
  };
}

function downloadError(id: string, err: unknown): string {
  if (err instanceof CitationNotFoundError) {
    return err.message;
  }
  const reason = err instanceof Error && err.name === 'AbortError' ? 'arXiv did not answer in time' : err instanceof Error ? err.message : String(err);
  return `Could not download arXiv:${id}: ${reason}.`;
}
