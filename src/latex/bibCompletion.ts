import * as vscode from 'vscode';
import { BibEntry, parseBib } from './bibParser';

const CITE_BEFORE_CURSOR = /\\[A-Za-z]*cite[A-Za-z]*\*?(?:\[[^\]]*\]){0,2}\{[^}]*$/;

/** `\cite{` key completion from the workspace's .bib files, cached until they change. */
export function registerBibCompletion(): vscode.Disposable {
  let cache: Promise<BibEntry[]> | null = null;
  const invalidate = () => {
    cache = null;
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.bib');
  watcher.onDidChange(invalidate);
  watcher.onDidCreate(invalidate);
  watcher.onDidDelete(invalidate);

  const load = async (): Promise<BibEntry[]> => {
    const files = await vscode.workspace.findFiles('**/*.bib', '**/node_modules/**', 200);
    const all = await Promise.all(
      files.map(async (uri) => parseBib(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8')))
    );
    return all.flat();
  };

  const provider = vscode.languages.registerCompletionItemProvider(
    { language: 'latex' },
    {
      async provideCompletionItems(document, position) {
        const before = document.lineAt(position).text.substring(0, position.character);
        if (!CITE_BEFORE_CURSOR.test(before)) {
          return undefined;
        }
        cache ??= load();
        const entries = await cache;
        return entries.map((entry) => {
          const item = new vscode.CompletionItem(entry.key, vscode.CompletionItemKind.Reference);
          item.detail = [entry.author, entry.year].filter(Boolean).join(', ');
          item.documentation = new vscode.MarkdownString().appendMarkdown(
            `**${escape(entry.title || entry.key)}**\n\n${escape(entry.author)}${entry.year ? ` (${entry.year})` : ''}\n\n\`@${entry.type}\``
          );
          // Lets users find a key by typing part of the title or author.
          item.filterText = `${entry.key} ${entry.title} ${entry.author}`;
          return item;
        });
      },
    },
    '{',
    ','
  );

  return vscode.Disposable.from(watcher, provider);
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
