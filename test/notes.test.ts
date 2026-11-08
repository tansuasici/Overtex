import { describe, expect, it } from 'vitest';
import { inReadingOrder, isDone, notesFilePath, noteSummary, parseNotes, serializeNotes, withDone } from '../src/shared/notes';
import type { Note } from '../src/shared/notes';

const note = (id: string, page: number, y: number, x = 10): Note => ({ id, page, x, y, text: `note ${id}`, createdAt: '2026-11-08T00:00:00.000Z' });

describe('notesFilePath', () => {
  it('sits beside the main file', () => {
    expect(notesFilePath('/proj/main.tex')).toBe('/proj/main.overtex-notes.json');
    expect(notesFilePath('C:\\proj\\main.tex')).toBe('C:\\proj\\main.overtex-notes.json');
  });

  it('replaces only the extension of the file', () => {
    expect(notesFilePath('/proj.v2/main.v1.tex')).toBe('/proj.v2/main.v1.overtex-notes.json');
    expect(notesFilePath('/proj.v2/main')).toBe('/proj.v2/main.overtex-notes.json');
  });
});

describe('notes file', () => {
  it('reads back what it wrote', () => {
    const notes = [note('a', 1, 20), note('b', 2, 30)];
    expect(parseNotes(serializeNotes(notes))).toEqual(notes);
  });

  it('keeps text that looks like markup or has line breaks as it is', () => {
    const notes = [{ ...note('a', 1, 20), text: '<img src=x onerror=alert(1)>\n"quoted" ğüş' }];
    expect(parseNotes(serializeNotes(notes))).toEqual(notes);
  });

  it('writes notes in reading order', () => {
    const notes = [note('c', 2, 5), note('b', 1, 90), note('a', 1, 20, 50), note('z', 1, 20, 5)];
    expect(parseNotes(serializeNotes(notes)).map((n) => n.id)).toEqual(['z', 'a', 'b', 'c']);
  });

  it('does not change the list it is given', () => {
    const notes = [note('b', 2, 5), note('a', 1, 5)];
    serializeNotes(notes);
    expect(notes.map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('reads back a done note, and a file from before notes could be done', () => {
    const notes = [{ ...note('a', 1, 20), doneAt: '2026-11-09T00:00:00.000Z' }];
    expect(parseNotes(serializeNotes(notes))).toEqual(notes);
    const old = '{"version":1,"notes":[{"id":"a","page":1,"x":1,"y":2,"text":"t","createdAt":"c"}]}';
    expect(isDone(parseNotes(old)[0])).toBe(false);
  });

  // A save rewrites the whole file, so anything read as "no notes" here would be lost on the next save.
  it.each([
    ['a git conflict', '<<<<<<< HEAD\n{"version":1,"notes":[]}\n=======\n{"version":1,"notes":[]}\n>>>>>>> other\n'],
    ['an empty file', ''],
    ['null', 'null'],
    ['a newer version', '{"version":2,"notes":[]}'],
    ['no version', '{"notes":[]}'],
    ['no list', '{"version":1}'],
    ['one bad note among good ones', JSON.stringify({ version: 1, notes: [note('a', 1, 1), { id: 'b', page: 0, x: 1, y: 1, text: '', createdAt: '' }] })],
    ['a coordinate that is not a number', JSON.stringify({ version: 1, notes: [{ ...note('a', 1, 1), x: '1' }] })],
    ['a page that is not whole', JSON.stringify({ version: 1, notes: [{ ...note('a', 1, 1), page: 1.5 }] })],
    ['a done date that is null', JSON.stringify({ version: 1, notes: [{ ...note('a', 1, 1), doneAt: null }] })],
    ['a done date that is a number', JSON.stringify({ version: 1, notes: [{ ...note('a', 1, 1), doneAt: 1 }] })],
  ])('refuses %s', (_name, content) => {
    expect(() => parseNotes(content)).toThrow();
  });
});

describe('withDone', () => {
  it('marks a note done and open again, leaving no trace in the file', () => {
    const open = note('a', 1, 20);
    const done = withDone(open, true, 'now');
    expect(done.doneAt).toBe('now');
    expect(withDone(done, false, 'later')).toEqual(open);
    expect(JSON.stringify(withDone(done, false, 'later'))).not.toContain('doneAt');
  });

  it('keeps the first date when a done note is marked again', () => {
    expect(withDone(withDone(note('a', 1, 20), true, 'first'), true, 'second').doneAt).toBe('first');
  });

  it('keeps fields a newer version may have added', () => {
    const newer = { ...note('a', 1, 20), color: 'red' };
    expect(withDone(newer, true, 'now')).toMatchObject({ color: 'red' });
  });
});

describe('noteSummary', () => {
  it('takes the first line with text', () => {
    expect(noteSummary('\n  \r\n  Check this  \nand that')).toBe('Check this');
    expect(noteSummary('   ')).toBe('');
  });

  it('cuts to the length asked for', () => {
    expect(noteSummary('abcdef', 4)).toBe('abc…');
    expect(noteSummary('abcd', 4)).toBe('abcd');
  });
});

describe('inReadingOrder', () => {
  it('goes by page, then down the page, and leaves the list alone', () => {
    const notes = [note('c', 2, 5), note('b', 1, 90), note('a', 1, 20)];
    expect(inReadingOrder(notes).map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(notes[0].id).toBe('c');
  });
});
