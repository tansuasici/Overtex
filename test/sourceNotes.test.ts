import { describe, expect, it } from 'vitest';
import {
  Anchor,
  NoteThread,
  SOURCE_NOTES_VERSION,
  addReply,
  deleteComment,
  deleteThread,
  isRelativePosixPath,
  locateAnchor,
  makeAnchor,
  newId,
  normalizeNewlines,
  offsetAt,
  parseSourceNotes,
  positionAt,
  quoteSpan,
  serializeSourceNotes,
  setResolved,
} from '../src/latex/sourceNotes';

const TEXT = [
  '\\section{Introduction}',
  'We study the model in detail. The model is simple.',
  'Results follow in Section 3, where the model is tested.',
  '',
  'Conclusion: the approach works.',
].join('\n');

function anchorOn(text: string, quote: string, nth = 0): Anchor {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = text.indexOf(quote, at + 1);
  }
  expect(at).toBeGreaterThanOrEqual(0);
  return makeAnchor(text, at, at + quote.length);
}

function quoted(text: string, anchor: Anchor): string | undefined {
  const span = locateAnchor(text, anchor);
  return span && text.slice(span.start, span.end);
}

const thread = (id: string, file: string, date: string, extra: Partial<NoteThread> = {}): NoteThread => ({
  id,
  file,
  anchor: { quote: 'q', prefix: 'p', suffix: 's', offset: 3 },
  comments: [{ id: `${id}-1`, author: 'Ada', date, body: `note ${id}` }],
  ...extra,
});

describe('locateAnchor', () => {
  it('finds the quote where it was', () => {
    const a = anchorOn(TEXT, 'in detail');
    expect(locateAnchor(TEXT, a)).toEqual({ start: a.offset, end: a.offset + 'in detail'.length });
  });

  it('follows the quote when text before it is added or removed', () => {
    const a = anchorOn(TEXT, 'The model is simple.');
    const edited = `% a new comment line\n${TEXT.replace('We study', 'Here we carefully study')}`;
    const span = locateAnchor(edited, a)!;
    expect(edited.slice(span.start, span.end)).toBe('The model is simple.');
    expect(span.start).toBe(edited.indexOf('The model is simple.'));
  });

  it('keeps a short, repeated quote on the occurrence with the same context', () => {
    // The second "the model" (in "where the model is tested"), not the nearer first one.
    const a = anchorOn(TEXT, 'the model', 1);
    const edited = TEXT.replace('Results follow in Section 3, where', 'Results, after a long new paragraph of explanation that shifts everything, follow in Section 3, where');
    const span = locateAnchor(edited, a)!;
    expect(span.start).toBe(edited.indexOf('the model is tested'));
  });

  it('picks the nearest occurrence when the context changed everywhere', () => {
    const text = 'aaa word bbb\nccc word ddd\neee word fff';
    const a = makeAnchor(text, text.indexOf('word', 15), text.indexOf('word', 15) + 4);
    const edited = 'xxx word yyy\nzzz word www\nqqq word rrr';
    expect(locateAnchor(edited, { ...a, offset: a.offset + 1 })!.start).toBe(edited.indexOf('word', 15));
  });

  it('finds an edited quote between its old prefix and suffix', () => {
    const a = anchorOn(TEXT, 'The model is simple.');
    const edited = TEXT.replace('The model is simple.', 'The model is very simple.');
    expect(quoted(edited, a)).toBe('The model is very simple.');
  });

  it('orphans a note whose text and surroundings are gone', () => {
    const a = anchorOn(TEXT, 'The model is simple.');
    const edited = TEXT.replace(/We study.*\n/, 'Rewritten from scratch.\n');
    expect(locateAnchor(edited, a)).toBeUndefined();
  });

  it('orphans rather than grabbing unrelated text between the old context', () => {
    const a = anchorOn(TEXT, 'in detail');
    const edited = TEXT.replace('in detail', 'xyzzy');
    expect(locateAnchor(edited, a)).toBeUndefined();
  });

  it('finds a note on a blank line by its context', () => {
    const at = TEXT.indexOf('\n\n') + 1;
    const a = makeAnchor(TEXT, at, at);
    const edited = `Title\n${TEXT}`;
    expect(locateAnchor(edited, a)).toEqual({ start: at + 6, end: at + 6 });
  });

  it('finds a quote at the start and at the end of the file after an edit inside it', () => {
    const start = makeAnchor(TEXT, 0, '\\section{Introduction}'.length);
    expect(quoted(TEXT.replace('Introduction', 'Intro'), start)).toBe('\\section{Intro}');
    const end = anchorOn(TEXT, 'the approach works.');
    expect(quoted(TEXT.replace('approach works.', 'approach works well.'), end)).toBe('the approach works well.');
  });

  it('works on files with Windows line endings once normalised', () => {
    const a = anchorOn(TEXT, 'Results follow in Section 3');
    const crlf = TEXT.replace(/\n/g, '\r\n');
    expect(quoted(normalizeNewlines(crlf), a)).toBe('Results follow in Section 3');
  });
});

describe('quoteSpan', () => {
  it('keeps a selection as it is', () => {
    expect(quoteSpan(TEXT, 3, 9)).toEqual({ start: 3, end: 9 });
  });

  it('quotes the trimmed line for a click without a selection', () => {
    const text = 'first\n   indented line  \nlast';
    const at = text.indexOf('indented');
    const span = quoteSpan(text, at - 3, at - 3);
    expect(text.slice(span.start, span.end)).toBe('indented line');
  });

  it('quotes nothing on a blank line', () => {
    const at = TEXT.indexOf('\n\n') + 1;
    expect(quoteSpan(TEXT, at, at)).toEqual({ start: at, end: at });
  });
});

describe('offsets and positions', () => {
  it('convert both ways', () => {
    const at = TEXT.indexOf('Results');
    const p = positionAt(TEXT, at);
    expect(p).toEqual({ line: 2, char: 0 });
    expect(offsetAt(TEXT, p.line, p.char)).toBe(at);
    expect(offsetAt(TEXT, 1, 9999)).toBe(TEXT.indexOf('\nResults'));
    expect(offsetAt(TEXT, 99, 0)).toBe(TEXT.length);
  });
});

describe('notes file', () => {
  it('reads back what it wrote', () => {
    const threads = [thread('a', 'main.tex', '2026-11-10T10:00:00.000Z'), thread('b', 'chapters/intro.tex', '2026-11-10T09:00:00.000Z')];
    const parsed = parseSourceNotes(serializeSourceNotes(threads));
    expect(parsed).toHaveLength(2);
    expect(parsed).toEqual(expect.arrayContaining(threads));
  });

  it('keeps markup, quotes and line breaks in notes as they are', () => {
    const t = thread('a', 'main.tex', '2026-11-10T10:00:00.000Z');
    t.comments[0].body = '<img src=x onerror=alert(1)>\n"quoted" ğüş **bold**';
    t.anchor.quote = '\\emph{x}\n% y';
    expect(parseSourceNotes(serializeSourceNotes([t]))).toEqual([t]);
  });

  it('writes threads by file and start date, not by position, so edits do not reorder them', () => {
    const threads = [
      thread('c', 'main.tex', '2026-11-10T12:00:00.000Z', { anchor: { quote: 'q', prefix: '', suffix: '', offset: 1 } }),
      thread('b', 'main.tex', '2026-11-10T11:00:00.000Z', { anchor: { quote: 'q', prefix: '', suffix: '', offset: 500 } }),
      thread('a', 'appendix.tex', '2026-11-10T13:00:00.000Z'),
    ];
    const out = JSON.parse(serializeSourceNotes(threads)) as { version: number; threads: NoteThread[] };
    expect(out.version).toBe(SOURCE_NOTES_VERSION);
    expect(out.threads.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(serializeSourceNotes(threads).endsWith('}\n')).toBe(true);
  });

  it('refuses git conflict markers, other versions and invalid notes rather than dropping them', () => {
    const good = serializeSourceNotes([thread('a', 'main.tex', '2026-11-10T10:00:00.000Z')]);
    expect(() => parseSourceNotes(`<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> other\n`)).toThrow();
    expect(() => parseSourceNotes(JSON.stringify({ version: 2, threads: [] }))).toThrow(/version/);
    expect(() => parseSourceNotes(JSON.stringify({ version: 1, threads: [{ id: 'x' }] }))).toThrow(/not valid/);
    expect(() => parseSourceNotes(JSON.stringify({ version: 1, threads: [{ ...thread('a', 'main.tex', 'd'), comments: [] }] }))).toThrow();
    const twice = [thread('a', 'main.tex', 'd'), thread('a', 'other.tex', 'd')];
    expect(() => parseSourceNotes(JSON.stringify({ version: 1, threads: twice }))).toThrow(/two notes/);
  });

  it('accepts only paths inside the folder', () => {
    expect(isRelativePosixPath('chapters/intro.tex')).toBe(true);
    expect(isRelativePosixPath('../secret.tex')).toBe(false);
    expect(isRelativePosixPath('/etc/passwd')).toBe(false);
    expect(isRelativePosixPath('C:/x.tex')).toBe(false);
    expect(isRelativePosixPath('a\\b.tex')).toBe(false);
    expect(() => parseSourceNotes(JSON.stringify({ version: 1, threads: [thread('a', '../x.tex', 'd')] }))).toThrow();
  });

  it('reads an empty list', () => {
    expect(parseSourceNotes('{"version":1,"threads":[]}')).toEqual([]);
  });
});

describe('changes', () => {
  const base = [thread('a', 'main.tex', '2026-11-10T10:00:00.000Z'), thread('b', 'main.tex', '2026-11-10T11:00:00.000Z')];

  it('adds a reply to one thread only', () => {
    const next = addReply(base, 'a', { id: 'r', author: 'Bo', date: '2026-11-10T12:00:00.000Z', body: 'agreed' });
    expect(next[0].comments.map((c) => c.body)).toEqual(['note a', 'agreed']);
    expect(next[1]).toBe(base[1]);
    expect(base[0].comments).toHaveLength(1);
  });

  it('resolves and reopens, keeping the first resolution', () => {
    const once = setResolved(base, 'a', true, 'Ada', '2026-11-10T12:00:00.000Z');
    expect(once[0]).toMatchObject({ resolvedAt: '2026-11-10T12:00:00.000Z', resolvedBy: 'Ada' });
    expect(setResolved(once, 'a', true, 'Bo', 'later')[0]).toMatchObject({ resolvedAt: '2026-11-10T12:00:00.000Z', resolvedBy: 'Ada' });
    const reopened = setResolved(once, 'a', false, 'Bo', 'later')[0];
    expect(reopened.resolvedAt).toBeUndefined();
    expect('resolvedBy' in reopened).toBe(false);
  });

  it('deletes a thread, and a thread whose last comment is deleted', () => {
    expect(deleteThread(base, 'a').map((t) => t.id)).toEqual(['b']);
    expect(deleteComment(base, 'a', 'a-1').map((t) => t.id)).toEqual(['b']);
    const withReply = addReply(base, 'a', { id: 'r', author: 'Bo', date: 'd', body: 'x' });
    expect(deleteComment(withReply, 'a', 'r')[0].comments.map((c) => c.id)).toEqual(['a-1']);
  });

  it('makes ids that differ', () => {
    const now = new Date('2026-11-10T10:00:00Z');
    let n = 0;
    const ids = new Set(Array.from({ length: 50 }, () => newId(now, () => (n++ % 50) / 50)));
    expect(ids.size).toBe(50);
  });
});
