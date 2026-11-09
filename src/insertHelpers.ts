import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import {
  Segment,
  figureSegments,
  freeName,
  graphicsPath,
  hasPackage,
  isImage,
  isInside,
  isTableFile,
  packageInsertLine,
  safeFileName,
  slug,
  uniqueLabel,
} from './latex/figures';
import { parseDelimited, tableSegments } from './latex/tables';
import { activeTexEditor } from './addCitation';

const TEX_SELECTOR: vscode.DocumentSelector = [{ language: 'latex' }, { language: 'tex' }];
/** Past this many rows a table is more likely a data dump than something to typeset. */
const LARGE_TABLE_ROWS = 200;

export interface InsertHelpersOptions {
  mainFile: () => string | null;
  /** Every \label key in the workspace, so new ones do not clash. */
  labelKeys: () => Promise<string[]>;
}

export interface InsertHelpers {
  /** Inserts what dropping `files` at the cursor of the active editor inserts. For the tests. */
  insertFiles(files: vscode.Uri[]): Promise<boolean>;
}

interface Insertion {
  snippet: vscode.SnippetString;
  /** Adds the packages the snippet needs to the main file's preamble, when they are missing. */
  packages?: vscode.WorkspaceEdit;
  added: string[];
}

/**
 * Overtex: Insert Table from CSV, Overtex: Insert Figure, and dropping images or CSV/TSV files
 * into a .tex file. Images from outside the project are copied to figures/ next to the main file.
 */
export function registerInsertHelpers(context: vscode.ExtensionContext, options: InsertHelpersOptions): InsertHelpers {
  const prepare = (document: vscode.TextDocument, position: vscode.Position, files: string[]) =>
    prepareInsertion(document, position, files, options);

  const dropProvider = {
    async provideDocumentDropEdits(
      document: vscode.TextDocument,
      position: vscode.Position,
      dataTransfer: vscode.DataTransfer,
      token: vscode.CancellationToken
    ): Promise<vscode.DocumentDropEdit | undefined> {
      const files = await droppedFiles(dataTransfer);
      if (!files.some((f) => isImage(f) || isTableFile(f)) || token.isCancellationRequested) {
        return undefined;
      }
      const insertion = await prepare(document, position, files);
      if (!insertion) {
        return undefined;
      }
      const edit = new vscode.DocumentDropEdit(insertion.snippet);
      if (insertion.packages) {
        edit.additionalEdit = insertion.packages;
        announcePackages(insertion.added);
      }
      return edit;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerDocumentDropEditProvider(TEX_SELECTOR, dropProvider),
    vscode.commands.registerCommand('overtex.insertTable', (uri?: vscode.Uri) => insertTable(uri, options, prepare)),
    vscode.commands.registerCommand('overtex.insertFigure', (uri?: vscode.Uri) => insertFigure(uri, prepare))
  );

  return {
    // A test cannot drag files, so it hands the provider what a drop from the Explorer carries.
    insertFiles: async (files) => {
      const editor = activeTexEditor();
      if (!editor) {
        return false;
      }
      const transfer = new vscode.DataTransfer();
      transfer.set('text/uri-list', new vscode.DataTransferItem(files.map((f) => f.toString()).join('\r\n')));
      const token = new vscode.CancellationTokenSource().token;
      const edit = await dropProvider.provideDocumentDropEdits(editor.document, editor.selection.active, transfer, token);
      if (!edit || !(edit.insertText instanceof vscode.SnippetString)) {
        return false;
      }
      if (edit.additionalEdit) {
        await vscode.workspace.applyEdit(edit.additionalEdit);
      }
      return editor.insertSnippet(edit.insertText, editor.selection.active);
    },
  };
}

type Prepare = (document: vscode.TextDocument, position: vscode.Position, files: string[]) => Promise<Insertion | undefined>;

async function insertTable(uri: vscode.Uri | undefined, options: InsertHelpersOptions, prepare: Prepare): Promise<void> {
  const editor = activeTexEditor();
  if (!editor) {
    void vscode.window.showInformationMessage('Overtex: open a .tex file to insert a table into.');
    return;
  }
  // Tab-separated text pasted from a spreadsheet, selected: turn it into a table in place.
  if (!uri && !editor.selection.isEmpty) {
    const data = parseDelimited(editor.document.getText(editor.selection), 2);
    if (data) {
      const label = uniqueLabel('tab', 'table', new Set(await options.labelKeys()));
      const segments = tableSegments(data.rows, { label, decimalComma: data.delimiter === ';' });
      const insertion = await withPackages(editor.document, snippetOf(segments), ['booktabs'], options);
      await apply(editor, insertion, true);
      return;
    }
  }
  const file = uri ?? (await pickFile('Insert Table from CSV', { 'CSV and TSV': ['csv', 'tsv'] }));
  if (file) {
    await insertAt(editor, [file.fsPath], prepare);
  }
}

async function insertFigure(uri: vscode.Uri | undefined, prepare: Prepare): Promise<void> {
  const editor = activeTexEditor();
  if (!editor) {
    void vscode.window.showInformationMessage('Overtex: open a .tex file to insert a figure into.');
    return;
  }
  const file = uri ?? (await pickFile('Insert Figure', { Images: ['png', 'jpg', 'jpeg', 'pdf', 'eps'] }));
  if (file) {
    await insertAt(editor, [file.fsPath], prepare);
  }
}

async function pickFile(title: string, filters: Record<string, string[]>): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({ title, canSelectMany: false, filters, openLabel: 'Insert' });
  return picked?.[0];
}

async function insertAt(editor: vscode.TextEditor, files: string[], prepare: Prepare): Promise<boolean> {
  const insertion = await prepare(editor.document, editor.selection.active, files);
  if (!insertion) {
    return false;
  }
  await apply(editor, insertion);
  return true;
}

/**
 * The package lines go in first: they sit above the cursor, so the editor moves the selection
 * down with them and the snippet still lands where it was asked for.
 */
async function apply(editor: vscode.TextEditor, insertion: Insertion, replaceSelection = false): Promise<void> {
  if (insertion.packages) {
    await vscode.workspace.applyEdit(insertion.packages);
    announcePackages(insertion.added);
  }
  await editor.insertSnippet(insertion.snippet, replaceSelection ? editor.selection : editor.selection.active);
}

function announcePackages(added: string[]): void {
  if (added.length) {
    void vscode.window.setStatusBarMessage(`Overtex: added ${added.map((p) => `\\usepackage{${p}}`).join(', ')} to the preamble`, 5000);
  }
}

/** Local files in a drop, from the Explorer or the OS. */
async function droppedFiles(dataTransfer: vscode.DataTransfer): Promise<string[]> {
  const list = await dataTransfer.get('text/uri-list')?.asString();
  if (!list) {
    return [];
  }
  return list
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => vscode.Uri.parse(l))
    .filter((u) => u.scheme === 'file')
    .map((u) => u.fsPath);
}

async function prepareInsertion(
  document: vscode.TextDocument,
  position: vscode.Position,
  files: string[],
  options: InsertHelpersOptions
): Promise<Insertion | undefined> {
  const main = options.mainFile();
  const mainDir = main ? path.dirname(main) : path.dirname(document.uri.fsPath);
  const taken = new Set(await options.labelKeys());
  const snippet = new vscode.SnippetString();
  const packages = new Set<string>();

  // Start on a line of its own when dropped after text.
  if (document.lineAt(position.line).text.substring(0, position.character).trim()) {
    snippet.appendText('\n');
  }

  let first = true;
  for (const file of files) {
    let segments: Segment[] | undefined;
    if (isImage(file)) {
      const target = await reachableImage(file, mainDir);
      if (!target) {
        continue;
      }
      const label = uniqueLabel('fig', slug(path.basename(file)), taken);
      taken.add(label);
      segments = figureSegments({ file: graphicsPath(target, mainDir), label });
      packages.add('graphicx');
    } else if (isTableFile(file)) {
      segments = await tableFromFile(file, taken);
      if (segments) {
        packages.add('booktabs');
      }
    }
    if (!segments) {
      continue;
    }
    if (!first) {
      snippet.appendText('\n');
    }
    first = false;
    appendSegments(snippet, segments);
  }
  if (first) {
    return undefined;
  }
  return withPackages(document, snippet, [...packages], options);
}

async function tableFromFile(file: string, taken: Set<string>): Promise<Segment[] | undefined> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    void vscode.window.showErrorMessage(`Overtex: could not read ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  const data = parseDelimited(text);
  if (!data) {
    void vscode.window.showWarningMessage(`Overtex: ${path.basename(file)} has no rows to put in a table.`);
    return undefined;
  }
  if (data.rows.length > LARGE_TABLE_ROWS) {
    const go = await vscode.window.showWarningMessage(
      `Overtex: ${path.basename(file)} has ${data.rows.length} rows. Insert them all as a table?`,
      { modal: true },
      'Insert'
    );
    if (go !== 'Insert') {
      return undefined;
    }
  }
  const label = uniqueLabel('tab', slug(path.basename(file)), taken);
  taken.add(label);
  return tableSegments(data.rows, { label, decimalComma: data.delimiter === ';' });
}

/**
 * The image itself when the build can reach it, else a copy in figures/ next to the main file.
 * \includegraphics paths are relative to the main file's folder, where the build runs.
 */
async function reachableImage(file: string, mainDir: string): Promise<string | undefined> {
  if (isInside(file, mainDir)) {
    return file;
  }
  const dir = path.join(mainDir, 'figures');
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const name = freeName(safeFileName(path.basename(file)), (n) => fs.existsSync(path.join(dir, n)));
    const target = path.join(dir, name);
    await fs.promises.copyFile(file, target);
    return target;
  } catch (err) {
    void vscode.window.showErrorMessage(`Overtex: could not copy ${path.basename(file)} into the project: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Adds the edit that loads `needed` packages the main file (or this file, if it has a preamble) lacks. */
async function withPackages(
  document: vscode.TextDocument,
  snippet: vscode.SnippetString,
  needed: string[],
  options: Pick<InsertHelpersOptions, 'mainFile'>
): Promise<Insertion> {
  const main = options.mainFile();
  let target: vscode.TextDocument | undefined;
  try {
    target = main ? await vscode.workspace.openTextDocument(vscode.Uri.file(main)) : document;
  } catch {
    target = undefined;
  }
  if (!target) {
    return { snippet, added: [] };
  }
  const text = target.getText();
  const missing = needed.filter((p) => !hasPackage(text, p));
  const line = packageInsertLine(text);
  if (!missing.length || line === undefined) {
    return { snippet, added: [] };
  }
  const edit = new vscode.WorkspaceEdit();
  const at = line < target.lineCount ? new vscode.Position(line, 0) : target.lineAt(target.lineCount - 1).range.end;
  const eol = target.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const lines = missing.map((p) => `\\usepackage{${p}}`).join(eol);
  edit.insert(target.uri, at, line < target.lineCount ? `${lines}${eol}` : `${eol}${lines}`);
  return { snippet, packages: edit, added: missing };
}

function snippetOf(segments: Segment[]): vscode.SnippetString {
  const snippet = new vscode.SnippetString();
  appendSegments(snippet, segments);
  return snippet;
}

/** Only appendText and appendPlaceholder: LaTeX is full of the `\`, `$` and `}` a raw snippet would read as syntax. */
function appendSegments(snippet: vscode.SnippetString, segments: Segment[]): void {
  for (const s of segments) {
    if (typeof s === 'string') {
      snippet.appendText(s);
    } else {
      snippet.appendPlaceholder(s.placeholder);
    }
  }
}
