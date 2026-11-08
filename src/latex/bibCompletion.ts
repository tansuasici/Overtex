import * as vscode from 'vscode';
import { BibIndex } from './bibIndex';
import { citationHoverMarkdown, citeKeyAt, escapeMarkdown as escape } from './cite';

const CITE_BEFORE_CURSOR = /\\[A-Za-z]*cite[A-Za-z]*\*?(?:\[[^\]]*\]){0,2}\{[^}]*$/;

/**
 * `\cite{` key completion and citation hovers from the workspace's .bib files.
 * Both stay off while `isEnabled` is false (TexLab running), so the two never show twice.
 */
export function registerBibCompletion(index: BibIndex, isEnabled: () => boolean = () => true): vscode.Disposable {
  const provider = vscode.languages.registerCompletionItemProvider(
    { language: 'latex' },
    {
      async provideCompletionItems(document, position) {
        if (!isEnabled()) {
          return undefined;
        }
        const before = document.lineAt(position).text.substring(0, position.character);
        if (!CITE_BEFORE_CURSOR.test(before)) {
          return undefined;
        }
        const entries = await index.entries();
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

  const hover = vscode.languages.registerHoverProvider(
    { language: 'latex' },
    {
      async provideHover(document, position) {
        if (!isEnabled()) {
          return undefined;
        }
        const cite = citeKeyAt(document.lineAt(position).text, position.character);
        if (!cite) {
          return undefined;
        }
        const entry = (await index.entries()).find((e) => e.key === cite.key);
        if (!entry) {
          return undefined;
        }
        const range = new vscode.Range(position.line, cite.start, position.line, cite.end);
        return new vscode.Hover(new vscode.MarkdownString(citationHoverMarkdown(entry)), range);
      },
    }
  );

  return vscode.Disposable.from(provider, hover);
}
