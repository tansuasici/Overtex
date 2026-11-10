// Source notes: comment threads anchored to a quote in a .tex file, kept in `.overtex/notes.json` at the
// workspace folder's root so they travel with the repository through any git host. No vscode import,
// so it is unit-testable. (PDF notes, pinned to a spot on a PDF page, are a separate feature: see
// src/shared/notes.ts.)

export const SOURCE_NOTES_VERSION = 1;
/** Relative to the workspace folder, posix separators. */
export const SOURCE_NOTES_FILE = '.overtex/notes.json';
/** How much text on each side of the quote is kept to find it again. */
export const CONTEXT_LENGTH = 32;

/** Where a note points. Offsets count characters of the file with `\r\n` read as `\n`. */
export interface Anchor {
  quote: string;
  prefix: string;
  suffix: string;
  offset: number;
}

export interface NoteComment {
  id: string;
  author: string;
  /** ISO 8601. */
  date: string;
  body: string;
}

export interface NoteThread {
  id: string;
  /** Posix path relative to the workspace folder. */
  file: string;
  anchor: Anchor;
  comments: NoteComment[];
  /** When the thread was resolved (ISO 8601). A thread without it is open. */
  resolvedAt?: string;
  resolvedBy?: string;
}

/** Offsets into the `\n`-normalised text, end exclusive. */
export interface Span {
  start: number;
  end: number;
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** The anchor for `[start, end)` of `text`, which must already be `\n`-normalised. */
export function makeAnchor(text: string, start: number, end: number): Anchor {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(end, end + CONTEXT_LENGTH),
    offset: start,
  };
}

/**
 * The text a note made on `[start, end)` should quote. An empty selection (a click on the gutter's +)
 * quotes the line without its indentation. A blank line quotes nothing and is found by its context.
 */
export function quoteSpan(text: string, start: number, end: number): Span {
  if (end > start) {
    return { start, end };
  }
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const next = text.indexOf('\n', start);
  const lineEnd = next < 0 ? text.length : next;
  const line = text.slice(lineStart, lineEnd);
  const lead = line.length - line.trimStart().length;
  const trimmed = line.trim();
  if (!trimmed) {
    return { start, end: start };
  }
  return { start: lineStart + lead, end: lineStart + lead + trimmed.length };
}

function sharedEnd(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) {
    n++;
  }
  return n;
}

function sharedStart(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) {
    n++;
  }
  return n;
}

function contextMatches(text: string, at: number, anchor: Anchor): boolean {
  const before = text.slice(Math.max(0, at - anchor.prefix.length), at);
  const after = text.slice(at + anchor.quote.length, at + anchor.quote.length + anchor.suffix.length);
  return before === anchor.prefix && after === anchor.suffix;
}

function nearest(positions: number[], offset: number): number | undefined {
  let best: number | undefined;
  for (const p of positions) {
    if (best === undefined || Math.abs(p - offset) < Math.abs(best - offset)) {
      best = p;
    }
  }
  return best;
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    found.push(i);
  }
  return found;
}

/** Longest gap between prefix and suffix still taken as the quote after someone edited it. */
function maxEditedLength(quote: string): number {
  return Math.max(quote.length * 2, quote.length + 80);
}

/**
 * Where the anchor's quote is in `text` (`\n`-normalised) now, or undefined when it is gone (the
 * note is orphaned). In order:
 * 1. the quote at its old offset;
 * 2. the nearest occurrence whose prefix and suffix still match, so a note follows its sentence
 *    rather than an identical word close by;
 * 3. the nearest occurrence of the quote;
 * 4. the text between the prefix and the suffix, when the quote itself was edited (a typo fixed).
 */
export function locateAnchor(text: string, anchor: Anchor): Span | undefined {
  const { quote, offset } = anchor;
  if (quote) {
    if (text.startsWith(quote, offset)) {
      return { start: offset, end: offset + quote.length };
    }
    const found = occurrences(text, quote);
    const at = nearest(found.filter((p) => contextMatches(text, p, anchor)), offset) ?? nearest(found, offset);
    if (at !== undefined) {
      return { start: at, end: at + quote.length };
    }
  }
  return betweenContext(text, anchor);
}

function betweenContext(text: string, anchor: Anchor): Span | undefined {
  const { prefix, suffix, quote } = anchor;
  // Too little context to tell one place from another.
  if (prefix.trim().length + suffix.trim().length < 8) {
    return undefined;
  }
  const max = maxEditedLength(quote);
  const candidates: Span[] = [];
  if (prefix) {
    for (const p of occurrences(text, prefix)) {
      const start = p + prefix.length;
      if (!suffix) {
        // The quote was at the end of the file.
        if (text.length - start <= max) {
          candidates.push({ start, end: text.length });
        }
        continue;
      }
      const s = text.indexOf(suffix, start);
      if (s >= 0 && s - start <= max) {
        candidates.push({ start, end: s });
      }
    }
  } else {
    // The quote was at the start of the file.
    const s = text.indexOf(suffix);
    if (s >= 0 && s <= max) {
      candidates.push({ start: 0, end: s });
    }
  }
  const start = nearest(candidates.map((c) => c.start), anchor.offset);
  const span = candidates.find((c) => c.start === start);
  if (!span) {
    return undefined;
  }
  // An edited quote must still look like the old one: share a start or an end with it, or be empty.
  const now = text.slice(span.start, span.end);
  if (quote && now && sharedStart(now, quote) === 0 && sharedEnd(now, quote) === 0) {
    return undefined;
  }
  return span;
}

// ---- The notes file ----

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isAnchor(value: unknown): value is Anchor {
  const a = value as Partial<Anchor> | null;
  return (
    typeof a === 'object' &&
    a !== null &&
    isString(a.quote) &&
    isString(a.prefix) &&
    isString(a.suffix) &&
    Number.isInteger(a.offset) &&
    (a.offset as number) >= 0
  );
}

function isComment(value: unknown): value is NoteComment {
  const c = value as Partial<NoteComment> | null;
  return typeof c === 'object' && c !== null && isString(c.id) && c.id.length > 0 && isString(c.author) && isString(c.date) && isString(c.body);
}

export function isNoteThread(value: unknown): value is NoteThread {
  const t = value as Partial<NoteThread> | null;
  return (
    typeof t === 'object' &&
    t !== null &&
    isString(t.id) &&
    t.id.length > 0 &&
    isString(t.file) &&
    isRelativePosixPath(t.file) &&
    isAnchor(t.anchor) &&
    Array.isArray(t.comments) &&
    t.comments.length > 0 &&
    t.comments.every(isComment) &&
    (t.resolvedAt === undefined || isString(t.resolvedAt)) &&
    (t.resolvedBy === undefined || isString(t.resolvedBy))
  );
}

/** A path inside the folder: no drive, no leading slash, no backslashes, no `..` segment. */
export function isRelativePosixPath(file: string): boolean {
  return file.length > 0 && !file.startsWith('/') && !file.includes('\\') && !/^[a-zA-Z]:/.test(file) && !file.split('/').includes('..');
}

/**
 * Reads the notes file. Throws on anything it does not fully understand, such as git conflict markers
 * or a newer version: every change rewrites the whole file, so dropping what could not be read would
 * lose those notes for everyone once the change is pushed.
 */
export function parseSourceNotes(content: string): NoteThread[] {
  const data = JSON.parse(content) as { version?: unknown; threads?: unknown } | null;
  if (typeof data !== 'object' || data === null || data.version !== SOURCE_NOTES_VERSION) {
    throw new Error(`expected version ${SOURCE_NOTES_VERSION}`);
  }
  if (!Array.isArray(data.threads) || !data.threads.every(isNoteThread)) {
    throw new Error('the list of notes is not valid');
  }
  const ids = new Set<string>();
  for (const t of data.threads) {
    if (ids.has(t.id)) {
      throw new Error(`two notes have the id ${t.id}`);
    }
    ids.add(t.id);
  }
  return data.threads;
}

/**
 * A stable order (file, then when the thread was started), so a change by one co-author is a small
 * diff and two co-authors adding notes rarely touch the same lines.
 */
export function inFileOrder(threads: readonly NoteThread[]): NoteThread[] {
  const started = (t: NoteThread) => t.comments[0]?.date ?? '';
  return [...threads].sort((a, b) => cmp(a.file, b.file) || cmp(started(a), started(b)) || cmp(a.id, b.id));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function serializeSourceNotes(threads: readonly NoteThread[]): string {
  return `${JSON.stringify({ version: SOURCE_NOTES_VERSION, threads: inFileOrder(threads) }, null, 2)}\n`;
}

// ---- Changes ----

export function newId(now: Date, random: () => number = Math.random): string {
  return `${now.getTime().toString(36)}-${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`;
}

export function addThread(threads: readonly NoteThread[], thread: NoteThread): NoteThread[] {
  return [...threads, thread];
}

export function addReply(threads: readonly NoteThread[], threadId: string, comment: NoteComment): NoteThread[] {
  return threads.map((t) => (t.id === threadId ? { ...t, comments: [...t.comments, comment] } : t));
}

/** Resolves or reopens a thread. A thread resolved again keeps who resolved it first and when. */
export function setResolved(threads: readonly NoteThread[], threadId: string, resolved: boolean, by: string, now: string): NoteThread[] {
  return threads.map((t) => {
    if (t.id !== threadId) {
      return t;
    }
    const { resolvedAt, resolvedBy, ...rest } = t;
    return resolved ? { ...rest, resolvedAt: resolvedAt ?? now, resolvedBy: resolvedBy ?? by } : rest;
  });
}

export function deleteThread(threads: readonly NoteThread[], threadId: string): NoteThread[] {
  return threads.filter((t) => t.id !== threadId);
}

/** Removes one comment; a thread left with none is removed too. */
export function deleteComment(threads: readonly NoteThread[], threadId: string, commentId: string): NoteThread[] {
  return threads.flatMap((t) => {
    if (t.id !== threadId) {
      return [t];
    }
    const comments = t.comments.filter((c) => c.id !== commentId);
    return comments.length ? [{ ...t, comments }] : [];
  });
}

/** The quote on one line, cut to `max` characters, for lists. */
export function quoteSummary(quote: string, max = 60): string {
  const line = quote.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The offset of a zero-based line and character in `\n`-normalised text, clamped to the text. */
export function offsetAt(text: string, line: number, char: number): number {
  let at = 0;
  for (let l = 0; l < line; l++) {
    const next = text.indexOf('\n', at);
    if (next < 0) {
      return text.length;
    }
    at = next + 1;
  }
  const next = text.indexOf('\n', at);
  const lineEnd = next < 0 ? text.length : next;
  return Math.min(at + char, lineEnd);
}

/** The zero-based line and character of an offset in `\n`-normalised text. */
export function positionAt(text: string, offset: number): { line: number; char: number } {
  const before = text.slice(0, Math.min(offset, text.length));
  const line = before.split('\n').length - 1;
  return { line, char: before.length - (before.lastIndexOf('\n') + 1) };
}
