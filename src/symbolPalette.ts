import * as fs from 'fs';
import * as vscode from 'vscode';

import { activeTexEditor } from './addCitation';
import { addPackagesEdit } from './insertHelpers';
import { findMathSpans, mathAt } from './latex/math';
import { symbolPackageLoaded } from './latex/symbolPackages';
import type { MathRenderer } from './mathPreview';
import type { FromPaletteMessage, PaletteSymbol, ToPaletteMessage } from './shared/symbolMessages';
import { MathSymbol, SYMBOLS, searchSymbols } from './shared/symbols';

const USAGE_KEY = 'overtex.symbolUsage';
const VIEW_ID = 'overtex.symbols';

export interface InsertSymbolOptions {
  /** What to do about a missing package without asking: add it, or leave it. For the tests. */
  addPackage?: boolean;
}

export interface InsertSymbolResult {
  inserted: boolean;
  /** The package the symbol needs and the preamble lacks, if any. */
  missingPackage?: string;
  /** Whether \usepackage for it was added. */
  packageAdded?: boolean;
}

export interface SymbolPalette {
  search(query: string): string[];
  insert(cmd: string, options?: InsertSymbolOptions): Promise<InsertSymbolResult>;
  /** Whether the palette's webview has loaded and shown its symbols. */
  ready(): boolean;
  /** What the palette's search box finds, as the webview shows it. */
  webviewSearch(query: string): Promise<string[]>;
}

/**
 * Overtex: Math Symbols — a palette of Greek letters, operators, arrows, relations and sets in the
 * Overtex side bar, rendered with MathJax and searchable by command, character or name. Clicking
 * one inserts it at the cursor of the last .tex editor, wrapped in $…$ outside math.
 */
export function registerSymbolPalette(
  context: vscode.ExtensionContext,
  renderer: MathRenderer,
  mainFile: () => string | null
): SymbolPalette {
  let lastEditor: vscode.TextEditor | undefined = activeTexEditor();
  let view: vscode.WebviewView | undefined;
  let isReady = false;
  let pendingSearch: ((cmds: string[]) => void) | undefined;
  let rendered: PaletteSymbol[] | undefined;

  const usage = () => context.globalState.get<Record<string, number>>(USAGE_KEY, {});
  const post = (msg: ToPaletteMessage) => void view?.webview.postMessage(msg);

  const symbols = (): PaletteSymbol[] =>
    (rendered ??= SYMBOLS.map((s) => ({
      cmd: s.cmd,
      name: s.name,
      category: s.category,
      ...(s.pkg && { pkg: s.pkg }),
      svg: renderer.svg(s.tex) ?? '',
    })));

  const targetEditor = (): vscode.TextEditor | undefined => {
    const active = activeTexEditor();
    if (active) {
      return active;
    }
    // The palette has focus, so look for the last .tex editor among the visible ones.
    const doc = lastEditor?.document;
    if (!doc || doc.isClosed) {
      return undefined;
    }
    return vscode.window.visibleTextEditors.find((e) => e.document === doc) ?? lastEditor;
  };

  const insert = async (cmd: string, options: InsertSymbolOptions = {}): Promise<InsertSymbolResult> => {
    const sym = SYMBOLS.find((s) => s.cmd === cmd);
    const target = targetEditor();
    if (!sym || !target) {
      if (!target) {
        void vscode.window.showInformationMessage('Overtex: open a .tex file to insert a symbol into.');
      }
      return { inserted: false };
    }
    const editor = await vscode.window.showTextDocument(target.document, { viewColumn: target.viewColumn, preserveFocus: false });
    editor.selections = target.selections;
    const inserted = await editor.insertSnippet(snippetFor(sym, editor), editor.selections);
    if (!inserted) {
      return { inserted: false };
    }
    await context.globalState.update(USAGE_KEY, { ...usage(), [cmd]: (usage()[cmd] ?? 0) + 1 });
    post({ type: 'usage', usage: usage() });

    const missingPackage = sym.pkg && (await missing(sym, editor.document, mainFile()));
    if (!missingPackage) {
      return { inserted: true };
    }
    let add = options.addPackage;
    if (add === undefined) {
      const choice = await vscode.window.showInformationMessage(
        `Overtex: ${sym.cmd} needs \\usepackage{${missingPackage}}, which the preamble does not load.`,
        `Add \\usepackage{${missingPackage}}`
      );
      add = choice !== undefined;
    }
    let packageAdded = false;
    if (add) {
      const target = await preambleDocument(editor.document, mainFile());
      const edit = target && addPackagesEdit(target, [missingPackage]);
      packageAdded = !!edit && (await vscode.workspace.applyEdit(edit));
    }
    return { inserted: true, missingPackage, packageAdded };
  };

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      view = webviewView;
      isReady = false;
      const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview');
      webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
      webviewView.webview.html = html(webviewView.webview, mediaRoot);
      webviewView.webview.onDidReceiveMessage((msg: FromPaletteMessage) => {
        switch (msg.type) {
          case 'ready':
            post({ type: 'symbols', symbols: symbols(), usage: usage() });
            return;
          case 'shown':
            isReady = true;
            return;
          case 'insert':
            void insert(msg.cmd);
            return;
          case 'searched':
            pendingSearch?.(msg.cmds);
            pendingSearch = undefined;
            return;
        }
      });
      webviewView.onDidDispose(() => {
        view = undefined;
        isReady = false;
      });
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && activeTexEditor() === editor) {
        lastEditor = editor;
      }
    }),
    vscode.commands.registerCommand('overtex.showSymbols', () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
    vscode.commands.registerCommand('overtex.insertSymbol', async (cmd?: string) => {
      if (typeof cmd === 'string') {
        await insert(cmd);
        return;
      }
      const picked = await pickSymbol(usage());
      if (picked) {
        await insert(picked);
      }
    })
  );

  return {
    search: (query) => searchSymbols(query, usage()).map((s) => s.cmd),
    insert,
    ready: () => isReady,
    webviewSearch: (query) =>
      new Promise((resolve) => {
        if (!view) {
          resolve([]);
          return;
        }
        pendingSearch = resolve;
        post({ type: 'search', query });
      }),
  };
}

/** The symbol as snippet text for `editor`'s cursor: in $…$ outside math, spaced from a following letter. */
function snippetFor(sym: MathSymbol, editor: vscode.TextEditor): vscode.SnippetString {
  const doc = editor.document;
  const offset = doc.offsetAt(editor.selection.start);
  const inMath = !!mathAt(findMathSpans(doc.getText()), offset);
  let snippet = sym.snippet;
  const next = doc.getText(new vscode.Range(editor.selection.end, editor.selection.end.translate(0, 1)));
  if (/[A-Za-z]$/.test(sym.cmd) && sym.snippet === sym.snippet.replace(/\$\d/g, '') && /^[A-Za-z]/.test(next)) {
    snippet += ' ';
  }
  return new vscode.SnippetString(inMath ? snippet : `\\$${snippet}\\$`);
}

/** The document whose preamble \usepackage goes in: the main file, else this one. */
async function preambleDocument(document: vscode.TextDocument, main: string | null): Promise<vscode.TextDocument | undefined> {
  try {
    return main ? await vscode.workspace.openTextDocument(vscode.Uri.file(main)) : document;
  } catch {
    return undefined;
  }
}

async function missing(sym: MathSymbol, document: vscode.TextDocument, main: string | null): Promise<string | undefined> {
  if (!sym.pkg) {
    return undefined;
  }
  const open = main && vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === main);
  let text: string;
  if (!main) {
    text = document.getText();
  } else if (open) {
    text = open.getText();
  } else {
    try {
      text = await fs.promises.readFile(main, 'utf8');
    } catch {
      return undefined;
    }
  }
  return symbolPackageLoaded(text, sym.pkg) ? undefined : sym.pkg;
}

/** Overtex: Insert Math Symbol without the side bar: a quick pick of every symbol, most used first. */
async function pickSymbol(usage: Record<string, number>): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { cmd: string };
  const items: Item[] = searchSymbols('', usage).map((s) => ({
    label: s.char ? `${s.char}  ${s.cmd}` : s.cmd,
    description: s.name,
    detail: [s.category, ...(s.pkg ? [`needs ${s.pkg}`] : []), ...s.keywords].join(' · '),
    cmd: s.cmd,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Insert Math Symbol',
    placeHolder: 'Search by command, character or name, e.g. leq, ≤ or less or equal',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.cmd;
}

function html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, name)).toString();
  const nonce = createNonce();
  const csp = [`default-src 'none'`, `script-src 'nonce-${nonce}' ${webview.cspSource}`, `style-src ${webview.cspSource}`].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('symbolPalette.css')}">
  <title>Math Symbols</title>
</head>
<body>
  <input id="search" type="search" placeholder="Search: leq, ≤, less or equal" aria-label="Search symbols" spellcheck="false">
  <div id="symbols" role="list"></div>
  <script nonce="${nonce}" type="module" src="${asset('symbolPalette.js')}"></script>
</body>
</html>`;
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
