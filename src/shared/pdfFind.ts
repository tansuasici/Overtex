/**
 * Find in the PDF preview: matching a query against a page's text runs, as pdf.js's getTextContent
 * gives them. The viewer turns the spans found here into highlight boxes on the page.
 */

/** A text run from pdf.js: its text, and whether a line ends after it. */
export interface FindItem {
  str: string;
  hasEOL: boolean;
}

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** Part of a match inside one text run: `start` to `end` (exclusive) are UTF-16 offsets in its `str`. */
export interface FindSpan {
  item: number;
  start: number;
  end: number;
}

/**
 * A page's text, normalized for searching, with each character of `text` traced back to the run
 * and the characters it came from. Line ends and joins are spaces with `item` -1.
 */
export interface PageText {
  text: string;
  item: number[];
  start: number[];
  end: number[];
}

/**
 * NFKC spells out ligatures such as "ﬁ"; without case, dotted and dotless i fold together too, so a
 * Turkish "ı" or "İ" is found by either spelling, as a search box is expected to be lenient.
 */
function fold(char: string, caseSensitive: boolean): string {
  const out = char.normalize('NFKC');
  if (caseSensitive) {
    return out;
  }
  return out.replace(/[İIı]/g, 'i').toLowerCase().replace(/i̇/g, 'i');
}

const SPACE = /\s/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Joins a page's runs into one searchable string. Runs are joined as they are, since TeX output
 * already has its spaces as runs of their own and can split one word over several; a line end is a
 * space, except after a hyphen that breaks a word, which is dropped so the word is found whole.
 */
export function pageText(items: readonly FindItem[], caseSensitive: boolean): PageText {
  const out: PageText = { text: '', item: [], start: [], end: [] };
  let text = '';
  const push = (chars: string, item: number, start: number, end: number) => {
    for (const c of chars) {
      if (SPACE.test(c)) {
        if (text === '' || text.endsWith(' ')) {
          continue;
        }
        text += ' ';
        out.item.push(item);
        out.start.push(start);
        out.end.push(end);
        continue;
      }
      // A character can fold to more than one UTF-16 unit; each unit points back to the same source.
      for (let k = 0; k < c.length; k++) {
        out.item.push(item);
        out.start.push(start);
        out.end.push(end);
      }
      text += c;
    }
  };
  items.forEach((it, index) => {
    const str = it.str;
    // A word broken over lines: "exam-" at the end of a line, a letter before the hyphen.
    const brokenWord = it.hasEOL && /[\p{L}]-$/u.test(str);
    let offset = 0;
    for (const char of str) {
      const next = offset + char.length;
      if (!(brokenWord && next === str.length)) {
        push(fold(char, caseSensitive), index, offset, next);
      }
      offset = next;
    }
    if (it.hasEOL && !brokenWord) {
      push(' ', -1, 0, 0);
    }
  });
  out.text = text;
  return out;
}

/** The query as it is matched: folded like the page text, with runs of spaces made one. */
export function normalizeQuery(query: string, caseSensitive: boolean): string {
  let out = '';
  for (const char of query) {
    out += fold(char, caseSensitive);
  }
  return out.replace(/\s+/gu, ' ').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every match of `query` in a page, in reading order, each as the spans of the runs it covers.
 * Whole word means no letter or digit right before or after the match; `\b` would miss "ş" or "ı".
 */
export function findInPage(page: PageText, query: string, options: FindOptions): FindSpan[][] {
  const needle = normalizeQuery(query, options.caseSensitive);
  if (!needle) {
    return [];
  }
  let source = escapeRegExp(needle);
  if (options.wholeWord) {
    const first = needle[0];
    const last = needle[needle.length - 1];
    source = `${WORD_CHAR.test(first) ? '(?<![\\p{L}\\p{N}])' : ''}${source}${WORD_CHAR.test(last) ? '(?![\\p{L}\\p{N}])' : ''}`;
  }
  const pattern = new RegExp(source, 'gu');
  const matches: FindSpan[][] = [];
  for (const m of page.text.matchAll(pattern)) {
    const spans = spansOf(page, m.index, m.index + m[0].length);
    if (spans.length) {
      matches.push(spans);
    }
  }
  return matches;
}

/** The runs a stretch of the page text covers, one span per run, in order. */
function spansOf(page: PageText, from: number, to: number): FindSpan[] {
  const spans: FindSpan[] = [];
  for (let i = from; i < to; i++) {
    const item = page.item[i];
    if (item < 0) {
      continue;
    }
    const last = spans[spans.length - 1];
    if (last && last.item === item) {
      last.start = Math.min(last.start, page.start[i]);
      last.end = Math.max(last.end, page.end[i]);
    } else {
      spans.push({ item, start: page.start[i], end: page.end[i] });
    }
  }
  return spans;
}

/** Steps through `total` matches from `current`, wrapping around at either end. */
export function stepMatch(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) {
    return -1;
  }
  if (current < 0) {
    return direction > 0 ? 0 : total - 1;
  }
  return (current + direction + total) % total;
}

/** "3 / 12", "No results", or "…" while pages are still being read, so an old count never shows. */
export function findCounter(current: number, total: number, pending: boolean, query: string): string {
  if (pending) {
    return '…';
  }
  if (!query.trim()) {
    return '';
  }
  return total === 0 ? 'No results' : `${current + 1} / ${total}`;
}
