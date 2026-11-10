/** A word clicked in the PDF, with the text around it on the page to tell repeats of it apart. */
export interface ClickedWord {
  word: string;
  before: string;
  after: string;
  /** The PDF broke the word with a hyphen at the end of a line, so `word` is only its start. */
  hyphenated: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const WORDS = /[\p{L}\p{N}]+/gu;
/** How much text around the word is kept and compared. */
const CONTEXT = 40;

/** The word in `text` at `index`, as the PDF shows it; ligatures such as "ﬁ" are spelled out. */
export function wordAt(text: string, index: number): ClickedWord | undefined {
  // Normalize piece by piece so `index` still points into the same characters.
  const left = text.slice(0, index).normalize('NFKC');
  const right = text.slice(index).normalize('NFKC');
  const all = left + right;
  let start = left.length;
  let end = left.length;
  while (start > 0 && WORD_CHAR.test(all[start - 1])) {
    start--;
  }
  while (end < all.length && WORD_CHAR.test(all[end])) {
    end++;
  }
  if (start === end) {
    return undefined;
  }
  return {
    word: all.slice(start, end),
    before: all.slice(Math.max(0, start - CONTEXT), start),
    after: all.slice(end, end + CONTEXT),
    hyphenated: /^-\s*$/.test(all.slice(end)),
  };
}

/** Whether a value from the viewer is a ClickedWord of sane size. */
export function isClickedWord(value: unknown): value is ClickedWord {
  const w = value as ClickedWord;
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
  return typeof w === 'object' && w !== null && text(w.word, 200) && w.word.length > 0 && text(w.before, 200) && text(w.after, 200) && typeof w.hyphenated === 'boolean';
}

/** Letters and digits only, lowercased, with TeX commands such as `\emph` left out. */
function plain(text: string): string {
  return text
    .replace(/\\[A-Za-z@]+/g, ' ')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) {
    n++;
  }
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) {
    n++;
  }
  return n;
}

/** How many lines before the one SyncTeX names are searched: it often names a paragraph's last line. */
const LINES_BEFORE = 5;

/**
 * Where the clicked word is in the source, near `line` (0-based), which SyncTeX gave. The occurrence
 * whose surrounding text best matches the PDF's wins; ties go to the one nearest `line`.
 */
export function findWord(lines: string[], line: number, clicked: ClickedWord): { line: number; column: number } | undefined {
  const wanted = clicked.word.toLowerCase();
  const pdfBefore = plain(clicked.before);
  const pdfAfter = plain(clicked.after);
  let best: { line: number; column: number; score: number; distance: number } | undefined;
  for (let l = Math.max(0, line - LINES_BEFORE); l <= Math.min(lines.length - 1, line + 1); l++) {
    const text = lines[l];
    const comment = text.search(/(?<!\\)%/);
    for (const m of text.matchAll(WORDS)) {
      if (comment >= 0 && m.index! > comment) {
        break;
      }
      const found = m[0].toLowerCase();
      if (!(clicked.hyphenated ? found.startsWith(wanted) : found === wanted)) {
        continue;
      }
      const start = m.index!;
      // A word right after a backslash is a command name, not text.
      if (text[start - 1] === '\\') {
        continue;
      }
      const before = plain([lines[l - 1] ?? '', text.slice(0, start)].join(' '));
      const after = plain([text.slice(start + m[0].length), lines[l + 1] ?? ''].join(' '));
      const score = commonSuffix(before, pdfBefore) + commonPrefix(after, pdfAfter);
      const distance = Math.abs(l - line);
      if (!best || score > best.score || (score === best.score && distance < best.distance)) {
        best = { line: l, column: start, score, distance };
      }
    }
  }
  return best && { line: best.line, column: best.column };
}
