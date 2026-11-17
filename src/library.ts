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
  CitationUses,
  PaperSort,
  citationCounts,
  citationUses,
  fetchArxivPdf,
  findPdf,
  groupPapers,
  paperPdfPath,
  paperUrl,
  paperYear,
  plainTex,
  shortAuthors,
} from './latex/library';
import { mergePicks } from './latex/zotero';
import { TexFiles } from './texFiles';

const TEX_LANGUAGES = new Set(['latex', 'tex']);
const SORT_STATE = 'overtex.papers.sort';
const UNCITED_STATE = 'overtex.papers.uncitedOnly';
/** How many SyncTeX lookups for page numbers run at once. */
const PAGE_LOOKUPS = 4;
const PAGE_TIMEOUT_MS = 10000;
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

/** Where a paper is cited: a 0-based line and column of a .tex file, under a heading if one comes before it. */
export interface PaperUse {
  file: string;
  line: number;
  column: number;
  section?: string;
}

class PaperItem extends vscode.TreeItem {
  constructor(
    readonly paper: IndexedEntry,
    readonly pdf: string | undefined,
    readonly uses: PaperUse[],
    group: string,
    nth = 0
  ) {
    super(
      plainTex(paper.rawTitle ?? paper.title) || paper.key,
      uses.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    // Keys can repeat across .bib files, so the file is part of the id; a key repeated
    // inside one file gets its occurrence number, so the tree never sees an id twice.
    this.id = `overtex.papers.${group}.${paper.file.toString()}#${paper.key}${nth ? `~${nth}` : ''}`;
    const byline = [shortAuthors(paper.rawAuthor ?? paper.author), paperYear(paper)].filter(Boolean).join(', ');
    this.description = uses.length ? [`${uses.length}×`, byline].filter(Boolean).join(' · ') : byline;
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

class UseItem extends vscode.TreeItem {
  constructor(use: PaperUse, page: number | undefined, parent: string) {
    super(use.section ?? path.basename(use.file));
    this.id = `${parent}@${use.file}:${use.line}:${use.column}`;
    const where = `${vscode.workspace.asRelativePath(use.file, false)}:${use.line + 1}`;
    this.description = page ? `${where} · page ${page}` : where;
    this.tooltip = page ? `Cited in ${where}, on page ${page} of the PDF` : `Cited in ${where}`;
    this.iconPath = new vscode.ThemeIcon('references');
    this.contextValue = 'use';
    const at = new vscode.Position(use.line, use.column);
    this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(use.file), { selection: new vscode.Range(at, at) }] };
  }
}

type Node = GroupItem | PaperItem | UseItem;

class PapersProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly index: BibIndex,
    private readonly scan: TexFiles<CitationUses>,
    private readonly sort: () => PaperSort,
    private readonly uncitedOnly: () => boolean,
    private readonly pageOf: (use: PaperUse) => Promise<number | undefined>
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  async groups(): Promise<GroupItem[]> {
    const [entries, scanned] = await Promise.all([this.index.entries(), this.scan.all()]);
    const uses = new Map<string, PaperUse[]>();
    for (const { file, value } of scanned) {
      for (const [key, list] of value) {
        const all = uses.get(key) ?? [];
        all.push(...list.map((use) => ({ file: file.fsPath, ...use })));
        uses.set(key, all);
      }
    }
    const seen = new Map<string, number>();
    const nth = (p: IndexedEntry): number => {
      const id = `${p.file.toString()}#${p.key}`;
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      return n;
    };
    return groupPapers(entries, citationCounts(scanned.map((s) => s.value)), this.sort())
      .filter(({ group }) => !this.uncitedOnly() || group === 'Not cited')
      .map(({ group, papers }) => new GroupItem(group, papers.map((p) => new PaperItem(p, pdfOf(p), uses.get(p.key) ?? [], group, nth(p)))));
  }

  /** Where the paper is cited, each with its page in the PDF when SyncTeX can tell. */
  async uses(paper: PaperItem): Promise<{ use: PaperUse; page?: number }[]> {
    return Promise.all(paper.uses.map(async (use) => ({ use, page: await this.pageOf(use) })));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.groups();
    }
    if (node instanceof GroupItem) {
      return node.papers;
    }
    if (node instanceof PaperItem) {
      return (await this.uses(node)).map(({ use, page }) => new UseItem(use, page, node.id ?? node.paper.key));
    }
    return [];
  }
}

/** Runs at most `limit` of the tasks at once. */
function limiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (running >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

function pdfOf(paper: IndexedEntry): string | undefined {
  return findPdf(paper, paper.file.fsPath, (file) => fs.existsSync(file));
}

export interface LibraryOptions {
  index: BibIndex;
  mainFile: () => string | null;
  userAgent: string;
  showPdf: (pdfFile: string) => void | Promise<void>;
  /** The PDF a build of the main file writes. */
  pdfFor: (mainFile: string) => string;
  /** SyncTeX's page for a 1-based line of a source file. */
  forward: (pdf: string, file: string, line: number, column: number) => Promise<{ page: number } | null>;
  /** Fires when a build ends, so page numbers can be looked up again. */
  onDidBuild: vscode.Event<unknown>;
}

export interface Library {
  groups(): Promise<{ group: string; keys: string[]; counts: number[] }[]>;
  /** Where the paper with this key is cited, as its rows in the panel show it. */
  uses(key: string): Promise<{ file: string; line: number; section?: string; page?: number }[]>;
}

/** The Papers panel: what the workspace's .bib files hold, cited or not, and what can be done with each paper. */
export function registerLibrary(context: vscode.ExtensionContext, options: LibraryOptions): Library {
  const { index, mainFile, userAgent, showPdf } = options;
  const sort = () => context.workspaceState.get<PaperSort>(SORT_STATE, 'year');
  const uncitedOnly = () => context.workspaceState.get<boolean>(UNCITED_STATE, false);
  const pageOf = pageLookup(options);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const refreshSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => provider.refresh(), 500);
  };
  const scan = new TexFiles<CitationUses>((text) => citationUses(text), refreshSoon);
  const provider = new PapersProvider(index, scan, sort, uncitedOnly, pageOf);
  const view = vscode.window.createTreeView('overtex.papers', { treeDataProvider: provider, showCollapseAll: true });
  const showUncited = async (on: boolean) => {
    await context.workspaceState.update(UNCITED_STATE, on);
    await vscode.commands.executeCommand('setContext', UNCITED_STATE, on);
    view.message = on ? 'Showing only papers the project does not cite.' : undefined;
    provider.refresh();
  };
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
    options.onDidBuild(refreshSoon),
    view,
    register('overtex.library.showUncited', () => showUncited(true)),
    register('overtex.library.showAll', () => showUncited(false)),
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
  void showUncited(uncitedOnly());

  return {
    groups: async () =>
      (await provider.groups()).map((g) => ({
        group: g.group,
        keys: g.papers.map((p) => p.paper.key),
        counts: g.papers.map((p) => p.uses.length),
      })),
    uses: async (key) => {
      const paper = (await provider.groups()).flatMap((g) => g.papers).find((p) => p.paper.key === key);
      return paper ? (await provider.uses(paper)).map(({ use, page }) => ({ file: use.file, line: use.line, section: use.section, page })) : [];
    },
  };
}

/**
 * The PDF page a citation lands on, from SyncTeX. Nothing is built for it: with no PDF, or one
 * older than the source (or an unsaved source), there is no page. Answers are kept per PDF build.
 */
function pageLookup(options: LibraryOptions): (use: PaperUse) => Promise<number | undefined> {
  const limit = limiter(PAGE_LOOKUPS);
  const cache = new Map<string, Promise<number | undefined>>();
  return async (use) => {
    const main = options.mainFile();
    if (!main) {
      return undefined;
    }
    const pdf = options.pdfFor(main);
    const [pdfStat, sourceStat] = await Promise.all([fs.promises.stat(pdf).catch(() => null), fs.promises.stat(use.file).catch(() => null)]);
    const dirty = vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.fsPath === use.file);
    if (!pdfStat || !sourceStat || dirty || pdfStat.mtimeMs < sourceStat.mtimeMs) {
      return undefined;
    }
    const key = `${pdf}\0${pdfStat.mtimeMs}\0${use.file}\0${use.line}\0${use.column}`;
    let page = cache.get(key);
    if (!page) {
      if (cache.size > 2000) {
        cache.clear();
      }
      page = limit(async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), PAGE_TIMEOUT_MS)));
        try {
          const rect = await Promise.race([options.forward(pdf, use.file, use.line + 1, use.column).catch(() => null), timeout]);
          return rect?.page;
        } finally {
          clearTimeout(timer);
        }
      });
      cache.set(key, page);
    }
    return page;
  };
}

function downloadError(id: string, err: unknown): string {
  if (err instanceof CitationNotFoundError) {
    return err.message;
  }
  const reason = err instanceof Error && err.name === 'AbortError' ? 'arXiv did not answer in time' : err instanceof Error ? err.message : String(err);
  return `Could not download arXiv:${id}: ${reason}.`;
}
