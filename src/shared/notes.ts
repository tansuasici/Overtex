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
    typeof n.createdAt === 'string'
  );
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

/** Keeps notes in reading order, so a new note is a small diff if the file is in git. */
export function serializeNotes(notes: readonly Note[]): string {
  const sorted = [...notes].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  return `${JSON.stringify({ version: NOTES_VERSION, notes: sorted }, null, 2)}\n`;
}
