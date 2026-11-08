// Notes a user pins on PDF pages. They live in a JSON file beside the main .tex rather than in the
// PDF, which every build replaces, or in the build folder, which Clean empties.

/** A note on a PDF page. `x` and `y` are in PDF points, origin at the top-left corner, like `PageRect`. */
export interface Note {
  id: string;
  page: number;
  x: number;
  y: number;
  text: string;
  createdAt: string;
  /** When the note was marked done. A note without it is still open. */
  doneAt?: string;
}

export const NOTES_VERSION = 1;

export function notesFilePath(mainFile: string): string {
  return `${mainFile.replace(/\.[^./\\]*$/, '')}.overtex-notes.json`;
}

export function isNote(value: unknown): value is Note {
  const n = value as Partial<Note> | null;
  return (
    typeof n === 'object' &&
    n !== null &&
    typeof n.id === 'string' &&
    n.id.length > 0 &&
    Number.isInteger(n.page) &&
    (n.page as number) >= 1 &&
    Number.isFinite(n.x) &&
    Number.isFinite(n.y) &&
    typeof n.text === 'string' &&
    typeof n.createdAt === 'string' &&
    (n.doneAt === undefined || typeof n.doneAt === 'string')
  );
}

export function isDone(note: Note): boolean {
  return note.doneAt !== undefined;
}

/** Marks a note done or open. A note that is already done keeps the date it was first marked. */
export function withDone(note: Note, done: boolean, now: string): Note {
  const { doneAt, ...rest } = note;
  return done ? { ...rest, doneAt: doneAt ?? now } : rest;
}

/** The note's first line with text, cut to `max` characters when given. */
export function noteSummary(text: string, max = Infinity): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Reads a notes file. Throws on anything it does not fully understand, such as git conflict markers
 * or a newer version: the next save rewrites the whole file, so dropping what could not be read would
 * lose those notes for good.
 */
export function parseNotes(content: string): Note[] {
  const data = JSON.parse(content) as { version?: unknown; notes?: unknown } | null;
  if (typeof data !== 'object' || data === null || data.version !== NOTES_VERSION) {
    throw new Error(`expected version ${NOTES_VERSION}`);
  }
  if (!Array.isArray(data.notes) || !data.notes.every(isNote)) {
    throw new Error('the notes list is not valid');
  }
  return data.notes;
}

/** Top to bottom through the document. */
export function inReadingOrder(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
}

/** Keeps notes in reading order, so a new note is a small diff if the file is in git. */
export function serializeNotes(notes: readonly Note[]): string {
  return `${JSON.stringify({ version: NOTES_VERSION, notes: inReadingOrder(notes) }, null, 2)}\n`;
}
