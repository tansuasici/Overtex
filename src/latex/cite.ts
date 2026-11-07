// Citation helpers for the \cite hover. No vscode import, so it is unit-testable.
import { BibEntry } from './bibParser';

/** A citation command with its key list: \cite, \citep, \textcite, \parencite*, \cite[p.~3]{...}, ... */
const CITE_COMMAND = /\\[A-Za-z]*cite[A-Za-z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}/g;

export interface CiteKeyRange {
  key: string;
  /** Column of the key's first character. */
  start: number;
  /** Column just past the key's last character. */
  end: number;
}

/** The citation key under `character` on `line`, if the cursor is inside a \cite{...} key list. */
export function citeKeyAt(line: string, character: number): CiteKeyRange | undefined {
  CITE_COMMAND.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_COMMAND.exec(line)) !== null) {
    const listStart = m.index + m[0].length - 1 - m[1].length;
    const listEnd = listStart + m[1].length;
    if (character < listStart || character > listEnd) {
      continue;
    }
    let offset = listStart;
    for (const part of m[1].split(',')) {
      const lead = part.length - part.trimStart().length;
      const key = part.trim();
      const start = offset + lead;
      const end = start + key.length;
      if (key && character >= start && character <= end) {
        return { key, start, end };
      }
      offset += part.length + 1;
    }
    return undefined;
  }
  return undefined;
}

/** "Einstein, Albert and Doe, John" → "Albert Einstein, John Doe"; more than three → "A, B, C et al." */
export function formatAuthors(author: string): string {
  const names = author
    .split(/\s+and\s+/i)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const parts = name.split(',').map((p) => p.trim());
      // "Last, First" or "Last, Jr, First"
      if (parts.length === 2) {
        return `${parts[1]} ${parts[0]}`.trim();
      }
      if (parts.length === 3) {
        return `${parts[2]} ${parts[0]} ${parts[1]}`.trim();
      }
      return name;
    });
  if (names.length > 3) {
    return `${names.slice(0, 3).join(', ')} et al.`;
  }
  return names.join(', ');
}

export const ABSTRACT_LIMIT = 500;

/** Markdown for a citation hover: title, authors and year, entry type, abstract. */
export function citationHoverMarkdown(entry: BibEntry): string {
  const lines = [`**${escapeMarkdown(entry.title || entry.key)}**`];
  const authors = formatAuthors(entry.author);
  const byline = [authors && escapeMarkdown(authors), entry.year && `(${escapeMarkdown(entry.year)})`].filter(Boolean).join(' ');
  if (byline) {
    lines.push(byline);
  }
  lines.push(`\`@${entry.type}{${entry.key}}\``);
  if (entry.abstract) {
    const abstract =
      entry.abstract.length > ABSTRACT_LIMIT ? `${entry.abstract.slice(0, ABSTRACT_LIMIT).trimEnd()}…` : entry.abstract;
    lines.push(`---`, `*${escapeMarkdown(abstract)}*`);
  }
  return lines.join('\n\n');
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
