import { describe, expect, it } from 'vitest';
import { findHighlights } from '../src/latex/highlights';

const r = (startLine: number, startChar: number, endLine: number, endChar: number) => ({ startLine, startChar, endLine, endChar });

describe('findHighlights: TODOs', () => {
  it('highlights a TODO comment from the word to the end of the line', () => {
    expect(findHighlights('Text. % TODO: cite this').todos).toEqual([r(0, 8, 0, 23)]);
  });

  it('highlights \\todo with its arguments', () => {
    const line = 'A claim \\todo[inline]{check {this}} and more.';
    expect(findHighlights(line).todos).toEqual([r(0, 8, 0, 35)]);
  });

  it('ignores lowercase words and escaped percent signs; \\todo in a comment is not a command', () => {
    expect(findHighlights('todo list, 50\\% TODO').todos).toEqual([]);
    expect(findHighlights('% \\todo{x} FIXME').todos).toEqual([r(0, 11, 0, 16)]);
  });
});

describe('findHighlights: inactive blocks', () => {
  it('dims \\iffalse … \\fi across lines, with nested conditionals', () => {
    const tex = ['before', '\\iffalse', '\\ifdraft x \\fi', 'old text', '\\fi after'].join('\n');
    expect(findHighlights(tex).inactive).toEqual([r(1, 0, 4, 3)]);
  });

  it('dims a comment environment and a block closed on the same line', () => {
    const tex = ['\\begin{comment}', '% TODO hidden', '\\end{comment}', 'x \\iffalse y \\fi z'].join('\n');
    const h = findHighlights(tex);
    expect(h.inactive).toEqual([r(0, 0, 2, 13), r(3, 2, 3, 16)]);
    expect(h.todos).toEqual([]);
  });

  it('ignores \\iffalse in comments and runs an unclosed block to the end', () => {
    expect(findHighlights('% \\iffalse\ntext').inactive).toEqual([]);
    expect(findHighlights('\\iffalse\nnever closed').inactive).toEqual([r(0, 0, 1, 12)]);
  });
});
