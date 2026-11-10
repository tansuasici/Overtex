import { describe, expect, it } from 'vitest';
import { findHighlights, findTodoCommands } from '../src/latex/highlights';

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

describe('findTodoCommands', () => {
  it('reads the text and options of \\todo and \\fixme', () => {
    const todos = findTodoCommands('Text \\todo{Check this}. More \\todo[inline, color=red]{Add a figure} and \\fixme{x}');
    expect(todos.map((t) => [t.command, t.text, t.options])).toEqual([
      ['todo', 'Check this', undefined],
      ['todo', 'Add a figure', 'inline, color=red'],
      ['fixme', 'x', undefined],
    ]);
    expect(todos[0].range).toEqual({ startLine: 0, startChar: 5, endLine: 0, endChar: 22 });
  });

  it('reads an argument over several lines, with nested braces, skipping comments in it', () => {
    const text = 'a \\todo{First line\n  with \\emph{nested} text % not this\n  and more} b';
    const [t] = findTodoCommands(text);
    expect(t.text).toBe('First line with \\emph{nested} text and more');
    expect(t.range).toMatchObject({ startLine: 0, startChar: 2, endLine: 2, endChar: 11 });
  });

  it('keeps escaped braces and percent signs', () => {
    expect(findTodoCommands('\\todo{50\\% of \\{x\\}}')[0].text).toBe('50\\% of \\{x\\}');
  });

  it('accepts the argument on the next line', () => {
    expect(findTodoCommands('\\todo\n{later}')[0]).toMatchObject({ text: 'later', range: { endLine: 1, endChar: 7 } });
  });

  it('leaves out commands in comments and inactive blocks, and TODO words', () => {
    const text = ['% \\todo{commented}', '% TODO plain word', '\\iffalse \\todo{hidden} \\fi', '\\begin{comment}', '\\todo{hidden}', '\\end{comment}', '\\todo{shown}'].join('\n');
    expect(findTodoCommands(text).map((t) => t.text)).toEqual(['shown']);
  });

  it('does not match longer command names, and handles a missing argument', () => {
    expect(findTodoCommands('\\todostyle{x} \\todos')).toEqual([]);
    expect(findTodoCommands('\\todo')).toMatchObject([{ command: 'todo', text: '' }]);
    expect(findTodoCommands('\\todo{never closed\nstill going')).toMatchObject([{ text: '' }]);
  });
});
