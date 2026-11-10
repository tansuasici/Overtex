import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  NoteComment,
  NoteThread,
  SOURCE_NOTES_FILE,
  addReply,
  addThread,
  deleteComment,
  deleteThread,
  inFileOrder,
  locateAnchor,
  makeAnchor,
  newId,
  normalizeNewlines,
  offsetAt,
  parseSourceNotes,
  positionAt,
  quoteSpan,
  quoteSummary,
  serializeSourceNotes,
  setResolved,
} from './latex/sourceNotes';

const TEX_LANGUAGES = new Set(['latex', 'tex']);
const CONTROLLER_ID = 'overtex.notes';

/** Notes of one workspace folder, as last read from its `.overtex/notes.json`. */
interface FolderNotes {
  folder: vscode.WorkspaceFolder;
  threads: NoteThread[];
  /** Why the file could not be read; changes are refused until it can. */
  error?: string;
}

interface ThreadRef {
  folder: string;
  id: string;
}

type Placement = { uri: vscode.Uri; range: vscode.Range } | undefined;

function notesPath(folder: vscode.WorkspaceFolder): string {
  return path.join(folder.uri.fsPath, ...SOURCE_NOTES_FILE.split('/'));
}

function fileUri(folder: vscode.WorkspaceFolder, file: string): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, ...file.split('/'));
}

function relativeFile(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
}

function isNoteable(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file' && TEX_LANGUAGES.has(doc.languageId) && vscode.workspace.getWorkspaceFolder(doc.uri) !== undefined;
}

/** One note in a VS Code comment thread. */
class NoteCommentView implements vscode.Comment {
  readonly mode = vscode.CommentMode.Preview;
  readonly author: vscode.CommentAuthorInformation;
  readonly body: vscode.MarkdownString;
  readonly timestamp?: Date;
  readonly contextValue = 'overtex.noteComment';

  constructor(
    readonly note: NoteComment,
    readonly parent: vscode.CommentThread
  ) {
    this.author = { name: note.author || 'Unknown' };
    // Notes come from co-authors through git: never trusted, no HTML.
    this.body = new vscode.MarkdownString(note.body);
    const time = new Date(note.date);
    this.timestamp = Number.isNaN(time.getTime()) ? undefined : time;
  }
}

/**
 * Notes on the text of `.tex` files, shown with the Comments API and saved in `.overtex/notes.json`
 * in each workspace folder, so they are shared through git like the sources. The file is written only
 * when a note is added, answered, resolved or deleted; a note found somewhere else after an edit is
 * moved on screen only, so editing never touches the notes file.
 */
export class SourceNotes implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Overtex Notes');
  private readonly folders = new Map<string, FolderNotes>();
  private readonly shown = new Map<string, vscode.CommentThread>();
  private readonly refs = new WeakMap<vscode.CommentThread, ThreadRef>();
  private readonly orphans = new Map<string, Set<string>>();
  private readonly authors = new Map<string, Promise<string>>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly reported = new Set<string>();
  /** Renders run one at a time, so two of them never create a thread for the same note. */
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    this.controller.options = { prompt: 'Add a note for your co-authors', placeHolder: 'Write a note' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => (isNoteable(doc) ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : []),
    };
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${SOURCE_NOTES_FILE}`);
    const reload = (uri: vscode.Uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder && notesPath(folder) === uri.fsPath) {
        void this.load(folder);
      }
    };
    this.subscriptions.push(
      this.controller,
      this.changed,
      watcher,
      watcher.onDidChange(reload),
      watcher.onDidCreate(reload),
      watcher.onDidDelete(reload),
      vscode.workspace.onDidChangeTextDocument((e) => e.contentChanges.length > 0 && this.scheduleRelocate(e.document)),
      vscode.workspace.onDidOpenTextDocument((doc) => isNoteable(doc) && this.scheduleRelocate(doc)),
      // A file edited and closed without saving is back to what is on disk.
      vscode.workspace.onDidCloseTextDocument((doc) => isNoteable(doc) && this.scheduleRelocate(doc)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.loadAll()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.authors.clear())
    );
    void this.loadAll();
  }

  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.shown.forEach((t) => t.dispose());
    this.subscriptions.forEach((d) => d.dispose());
  }

  // ---- Reading ----

  private async loadAll(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    const keep = new Set(folders.map((f) => f.uri.fsPath));
    for (const key of [...this.folders.keys()]) {
      if (!keep.has(key)) {
        this.folders.delete(key);
        await this.render(key);
      }
    }
    await Promise.all(folders.map((f) => this.load(f)));
  }

  private read(folder: vscode.WorkspaceFolder): FolderNotes {
    let content: string;
    try {
      content = fs.readFileSync(notesPath(folder), 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { folder, threads: [] };
      }
      return { folder, threads: [], error: e instanceof Error ? e.message : String(e) };
    }
    try {
      return { folder, threads: parseSourceNotes(content) };
    } catch (e) {
      return { folder, threads: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async load(folder: vscode.WorkspaceFolder): Promise<void> {
    const state = this.read(folder);
    const key = folder.uri.fsPath;
    const previous = this.folders.get(key);
    // Keep showing what could last be read while the file has a conflict in it.
    this.folders.set(key, state.error && previous ? { ...previous, error: state.error } : state);
    if (state.error) {
      this.reportUnreadable(folder, state.error);
    } else {
      this.reported.delete(key);
    }
    await this.render(key);
  }

  private reportUnreadable(folder: vscode.WorkspaceFolder, error: string): void {
    const key = folder.uri.fsPath;
    if (this.reported.has(key)) {
      return;
    }
    this.reported.add(key);
    void vscode.window
      .showWarningMessage(
        `Overtex: ${SOURCE_NOTES_FILE} in ${folder.name} could not be read (${error}). Notes are read-only until it is fixed, so nothing in it is lost.`,
        'Open File'
      )
      .then((choice) => choice && vscode.window.showTextDocument(vscode.Uri.file(notesPath(folder))));
  }

  /** The file's text as the editor has it, unsaved edits included, else as on disk. */
  private async textOf(uri: vscode.Uri): Promise<string | undefined> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) {
      return normalizeNewlines(doc.getText());
    }
    try {
      return normalizeNewlines(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8'));
    } catch {
      return undefined;
    }
  }

  // ---- Showing ----

  private async place(state: FolderNotes, thread: NoteThread): Promise<Placement> {
    const uri = fileUri(state.folder, thread.file);
    const text = await this.textOf(uri);
    const span = text === undefined ? undefined : locateAnchor(text, thread.anchor);
    if (!span || text === undefined) {
      return undefined;
    }
    const s = positionAt(text, span.start);
    const e = positionAt(text, span.end);
    return { uri, range: new vscode.Range(s.line, s.char, e.line, e.char) };
  }

  /** Shows a folder's notes, only those of `file` when given. */
  private render(key: string, file?: string): Promise<void> {
    const run = this.queue.then(() => this.renderNow(key, file));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async renderNow(key: string, file?: string): Promise<void> {
    const state = this.folders.get(key);
    const threads = state?.threads ?? [];
    const ids = new Set(threads.map((t) => `${key}\n${t.id}`));
    for (const [id, shown] of this.shown) {
      if (id.startsWith(`${key}\n`) && !ids.has(id)) {
        shown.dispose();
        this.shown.delete(id);
      }
    }
    const orphans = this.orphans.get(key) ?? new Set<string>();
    for (const id of [...orphans]) {
      if (!ids.has(`${key}\n${id}`)) {
        orphans.delete(id);
      }
    }
    this.orphans.set(key, orphans);
    if (state) {
      for (const thread of threads) {
        if (file !== undefined && thread.file !== file) {
          continue;
        }
        const placement = await this.place(state, thread);
        this.show(key, thread, placement);
        if (placement) {
          orphans.delete(thread.id);
        } else {
          orphans.add(thread.id);
        }
      }
    }
    this.changed.fire();
  }

  private show(key: string, thread: NoteThread, placement: Placement): void {
    const id = `${key}\n${thread.id}`;
    let shown = this.shown.get(id);
    if (shown && (!placement || shown.uri.toString() !== placement.uri.toString())) {
      shown.dispose();
      this.shown.delete(id);
      shown = undefined;
    }
    if (!placement) {
      return;
    }
    if (!shown) {
      shown = this.controller.createCommentThread(placement.uri, placement.range, []);
      shown.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      this.shown.set(id, shown);
      this.refs.set(shown, { folder: key, id: thread.id });
    } else if (!shown.range || !shown.range.isEqual(placement.range)) {
      shown.range = placement.range;
    }
    const target = shown;
    target.comments = thread.comments.map((c) => new NoteCommentView(c, target));
    const resolved = thread.resolvedAt !== undefined;
    target.state = resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    target.contextValue = resolved ? 'overtex.note.resolved' : 'overtex.note.open';
    target.label = resolved ? `Resolved${thread.resolvedBy ? ` by ${thread.resolvedBy}` : ''}` : undefined;
    target.canReply = true;
  }

  private scheduleRelocate(doc: vscode.TextDocument): void {
    const folder = isNoteable(doc) ? vscode.workspace.getWorkspaceFolder(doc.uri) : undefined;
    if (!folder) {
      return;
    }
    const key = folder.uri.fsPath;
    const file = relativeFile(folder, doc.uri);
    if (!this.folders.get(key)?.threads.some((t) => t.file === file)) {
      return;
    }
    const timerKey = doc.uri.toString();
    clearTimeout(this.timers.get(timerKey));
    this.timers.set(
      timerKey,
      setTimeout(() => {
        this.timers.delete(timerKey);
        void this.render(key, file);
      }, 300)
    );
  }

  // ---- Changing ----

  private async author(folder: vscode.WorkspaceFolder): Promise<string> {
    const key = folder.uri.fsPath;
    let name = this.authors.get(key);
    if (!name) {
      name = gitUserName(folder.uri.fsPath).then((n) => n ?? osUserName());
      this.authors.set(key, name);
    }
    return name;
  }

  /**
   * Reads the notes file again, applies `change` and writes it back, so a note a co-author pulled in a
   * moment ago is kept. Refuses when the file cannot be read.
   */
  private async update(folder: vscode.WorkspaceFolder, change: (threads: NoteThread[]) => NoteThread[]): Promise<boolean> {
    const state = this.read(folder);
    if (state.error) {
      this.reported.delete(folder.uri.fsPath);
      this.reportUnreadable(folder, state.error);
      return false;
    }
    const next = change(state.threads);
    try {
      fs.mkdirSync(path.dirname(notesPath(folder)), { recursive: true });
      fs.writeFileSync(notesPath(folder), serializeSourceNotes(next), 'utf-8');
    } catch (e) {
      void vscode.window.showErrorMessage(`Overtex: the note could not be saved: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    this.folders.set(folder.uri.fsPath, { folder, threads: next });
    await this.render(folder.uri.fsPath);
    return true;
  }

  private folderOf(ref: ThreadRef): vscode.WorkspaceFolder | undefined {
    return this.folders.get(ref.folder)?.folder;
  }

  private threadOf(ref: ThreadRef): NoteThread | undefined {
    return this.folders.get(ref.folder)?.threads.find((t) => t.id === ref.id);
  }

  /** A ref from a comment thread, a comment in one, or a row of the Notes view. */
  refOf(target: unknown): ThreadRef | undefined {
    if (target instanceof NoteCommentView) {
      return this.refs.get(target.parent);
    }
    if (target instanceof NoteItem) {
      return target.ref;
    }
    return target ? this.refs.get(target as vscode.CommentThread) : undefined;
  }

  async create(reply: vscode.CommentReply): Promise<void> {
    const draft = reply.thread;
    const body = reply.text.trim();
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === draft.uri.toString());
    const folder = vscode.workspace.getWorkspaceFolder(draft.uri);
    if (!body || !doc || !folder || !draft.range) {
      return;
    }
    const text = normalizeNewlines(doc.getText());
    const r = draft.range;
    const span = quoteSpan(text, offsetAt(text, r.start.line, r.start.character), offsetAt(text, r.end.line, r.end.character));
    const now = new Date();
    const thread: NoteThread = {
      id: newId(now),
      file: relativeFile(folder, doc.uri),
      anchor: makeAnchor(text, span.start, span.end),
      comments: [{ id: newId(now), author: await this.author(folder), date: now.toISOString(), body }],
    };
    if (await this.update(folder, (threads) => addThread(threads, thread))) {
      draft.dispose();
    }
  }

  async reply(reply: vscode.CommentReply): Promise<void> {
    const ref = this.refOf(reply.thread);
    const folder = ref && this.folderOf(ref);
    const body = reply.text.trim();
    if (!ref || !folder || !body) {
      return;
    }
    const now = new Date();
    const comment = { id: newId(now), author: await this.author(folder), date: now.toISOString(), body };
    await this.update(folder, (threads) => addReply(threads, ref.id, comment));
  }

  async resolve(target: unknown, resolved: boolean): Promise<void> {
    const ref = this.refOf(target);
    const folder = ref && this.folderOf(ref);
    if (!ref || !folder) {
      return;
    }
    const by = await this.author(folder);
    await this.update(folder, (threads) => setResolved(threads, ref.id, resolved, by, new Date().toISOString()));
  }

  async deleteThread(target: unknown): Promise<void> {
    const ref = this.refOf(target);
    const folder = ref && this.folderOf(ref);
    const thread = ref && this.threadOf(ref);
    if (!ref || !folder || !thread) {
      return;
    }
    const replies = thread.comments.length - 1;
    const detail = replies > 0 ? ` and its ${replies} ${replies === 1 ? 'reply' : 'replies'}` : '';
    const choice = await vscode.window.showWarningMessage(
      `Delete this note${detail} for everyone who pulls the change?`,
      { modal: true, detail: quoteSummary(thread.comments[0].body, 120) },
      'Delete'
    );
    if (choice === 'Delete') {
      await this.update(folder, (threads) => deleteThread(threads, ref.id));
    }
  }

  async deleteComment(comment: unknown): Promise<void> {
    if (!(comment instanceof NoteCommentView)) {
      return;
    }
    const ref = this.refOf(comment);
    const folder = ref && this.folderOf(ref);
    if (!ref || !folder) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      'Delete this comment for everyone who pulls the change?',
      { modal: true, detail: quoteSummary(comment.note.body, 120) },
      'Delete'
    );
    if (choice === 'Delete') {
      await this.update(folder, (threads) => deleteComment(threads, ref.id, comment.note.id));
    }
  }

  /** Points an orphaned note (or any note) at the text selected in the editor. */
  async attachToSelection(target: unknown): Promise<void> {
    const ref = this.refOf(target);
    const folder = ref && this.folderOf(ref);
    const editor = vscode.window.activeTextEditor;
    if (!ref || !folder) {
      return;
    }
    if (!editor || !isNoteable(editor.document) || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Overtex: select the text in a .tex file to attach the note to, then run this again.');
      return;
    }
    if (vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath !== ref.folder) {
      void vscode.window.showInformationMessage('Overtex: the note belongs to another workspace folder.');
      return;
    }
    const text = normalizeNewlines(editor.document.getText());
    const s = editor.selection;
    const start = offsetAt(text, s.start.line, s.start.character);
    const end = offsetAt(text, s.end.line, s.end.character);
    const file = relativeFile(folder, editor.document.uri);
    await this.update(folder, (threads) =>
      threads.map((t) => (t.id === ref.id ? { ...t, file, anchor: makeAnchor(text, start, end) } : t))
    );
  }

  async open(ref: ThreadRef): Promise<void> {
    const folder = this.folderOf(ref);
    const thread = this.threadOf(ref);
    if (!folder || !thread) {
      return;
    }
    const shown = this.shown.get(`${ref.folder}\n${ref.id}`);
    if (shown?.range) {
      shown.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      await vscode.window.showTextDocument(shown.uri, { selection: shown.range });
      return;
    }
    const uri = fileUri(folder, thread.file);
    const text = await this.textOf(uri);
    if (text !== undefined) {
      const p = positionAt(text, thread.anchor.offset);
      await vscode.window.showTextDocument(uri, { selection: new vscode.Range(p.line, p.char, p.line, p.char) });
    }
    const quote = thread.anchor.quote ? `“${quoteSummary(thread.anchor.quote, 80)}”` : 'the blank line it was on';
    const choice = await vscode.window.showInformationMessage(
      `Overtex: the text this note was on, ${quote}, is no longer in ${thread.file}. Select the text it belongs to and choose Attach to Selection, or delete the note.`,
      'Attach to Selection',
      'Delete Note'
    );
    if (choice === 'Attach to Selection') {
      await this.attachToSelection(new NoteItem(ref, thread, 'orphan'));
    } else if (choice === 'Delete Note') {
      await this.deleteThread(new NoteItem(ref, thread, 'orphan'));
    }
  }

  /** Every note, with whether it could be placed, for the Notes view. */
  entries(): { ref: ThreadRef; thread: NoteThread; folder: vscode.WorkspaceFolder; orphaned: boolean }[] {
    const all: { ref: ThreadRef; thread: NoteThread; folder: vscode.WorkspaceFolder; orphaned: boolean }[] = [];
    for (const [key, state] of this.folders) {
      const orphans = this.orphans.get(key);
      for (const thread of inFileOrder(state.threads)) {
        all.push({ ref: { folder: key, id: thread.id }, thread, folder: state.folder, orphaned: orphans?.has(thread.id) ?? false });
      }
    }
    return all;
  }
}

function gitUserName(cwd: string): Promise<string | undefined> {
  // Git reads the repository's own config, which an untrusted folder could have written.
  if (!vscode.workspace.isTrusted) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    execFile('git', ['config', 'user.name'], { cwd, timeout: 5000, windowsHide: true }, (error, stdout) => {
      const name = error ? '' : stdout.trim();
      resolve(name || undefined);
    });
  });
}

function osUserName(): string {
  try {
    return os.userInfo().username || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

// ---- The Notes view ----

type NoteKind = 'open' | 'resolved' | 'orphan';

class NoteGroup extends vscode.TreeItem {
  constructor(
    label: string,
    readonly notes: NoteItem[],
    id: string,
    icon?: vscode.ThemeIcon
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = id;
    this.description = String(notes.length);
    this.iconPath = icon;
    this.contextValue = 'group';
  }
}

class NoteItem extends vscode.TreeItem {
  constructor(
    readonly ref: ThreadRef,
    thread: NoteThread,
    kind: NoteKind
  ) {
    const first = thread.comments[0];
    super(quoteSummary(first.body, 80) || '(empty note)');
    this.id = `overtex.sourceNotes.${ref.folder}.${ref.id}`;
    const replies = thread.comments.length - 1;
    const quote = thread.anchor.quote ? `“${quoteSummary(thread.anchor.quote, 40)}”` : '';
    this.description = [first.author, quote, replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : '']
      .filter(Boolean)
      .join(' · ');
    this.iconPath =
      kind === 'orphan'
        ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
        : new vscode.ThemeIcon(kind === 'resolved' ? 'pass' : 'comment');
    this.contextValue = `note.${kind}`;
    const tooltip = new vscode.MarkdownString();
    for (const c of thread.comments) {
      tooltip.appendMarkdown(`**${escapeMarkdown(c.author)}** · ${escapeMarkdown(c.date.slice(0, 10))}\n\n`).appendText(`${c.body}\n\n`);
    }
    if (kind === 'orphan') {
      tooltip.appendMarkdown('*The text this note was on is gone. Select where it belongs and choose Attach to Selection.*');
    }
    this.tooltip = tooltip;
    this.command = { command: 'overtex.notes.open', title: 'Open', arguments: [this] };
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

type NotesNode = NoteGroup | NoteItem;

class NotesProvider implements vscode.TreeDataProvider<NotesNode> {
  readonly onDidChangeTreeData: vscode.Event<void>;

  constructor(private readonly notes: SourceNotes) {
    this.onDidChangeTreeData = notes.onDidChange;
  }

  getTreeItem(node: NotesNode): vscode.TreeItem {
    return node;
  }

  getChildren(node?: NotesNode): NotesNode[] {
    if (node instanceof NoteGroup) {
      return node.notes;
    }
    if (node) {
      return [];
    }
    const entries = this.notes.entries();
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const groups: NoteGroup[] = [];
    const orphans = entries.filter((e) => e.orphaned);
    if (orphans.length) {
      groups.push(
        new NoteGroup(
          'Orphaned',
          orphans.map((e) => new NoteItem(e.ref, e.thread, 'orphan')),
          'overtex.sourceNotes.orphaned',
          new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
        )
      );
    }
    const byFile = new Map<string, NoteItem[]>();
    for (const e of entries) {
      if (e.orphaned) {
        continue;
      }
      const label = multiRoot ? `${e.folder.name}/${e.thread.file}` : e.thread.file;
      const items = byFile.get(label) ?? [];
      items.push(new NoteItem(e.ref, e.thread, e.thread.resolvedAt ? 'resolved' : 'open'));
      byFile.set(label, items);
    }
    for (const [label, items] of byFile) {
      groups.push(new NoteGroup(label, items, `overtex.sourceNotes.file.${label}`, vscode.ThemeIcon.File));
    }
    return groups;
  }
}

export function registerSourceNotes(context: vscode.ExtensionContext): SourceNotes {
  const notes = new SourceNotes();
  const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(`overtex.notes.${id}`, run);
  context.subscriptions.push(
    notes,
    vscode.window.createTreeView('overtex.sourceNotes', { treeDataProvider: new NotesProvider(notes) }),
    command('create', (reply: vscode.CommentReply) => notes.create(reply)),
    command('reply', (reply: vscode.CommentReply) => notes.reply(reply)),
    command('cancel', (thread: vscode.CommentThread) => thread.dispose()),
    command('resolve', (target: unknown) => notes.resolve(target, true)),
    command('reopen', (target: unknown) => notes.resolve(target, false)),
    command('deleteThread', (target: unknown) => notes.deleteThread(target)),
    command('deleteComment', (comment: unknown) => notes.deleteComment(comment)),
    command('attachToSelection', (target: unknown) => notes.attachToSelection(target)),
    command('open', (item: NoteItem) => notes.open(item.ref)),
    command('add', () => vscode.commands.executeCommand('workbench.action.addComment'))
  );
  return notes;
}
