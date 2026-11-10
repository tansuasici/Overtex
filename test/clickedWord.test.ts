import { describe, expect, it } from 'vitest';
import { findWord, isClickedWord, wordAt } from '../src/shared/clickedWord';

describe('wordAt', () => {
  it('finds the word around an index, with the text beside it', () => {
    expect(wordAt('The quick brown fox', 6)).toEqual({ word: 'quick', before: 'The ', after: ' brown fox', hyphenated: false });
    expect(wordAt('The quick brown fox', 4)?.word).toBe('quick');
    expect(wordAt('The quick brown fox', 8)?.word).toBe('quick');
  });

  it('returns nothing between words', () => {
    expect(wordAt('a , b', 2)).toBeUndefined();
  });

  it('spells out ligatures and notices a hyphen at the end of the line', () => {
    expect(wordAt('the ﬁrst exam-', 5)?.word).toBe('first');
    expect(wordAt('the first exam-', 12)).toMatchObject({ word: 'exam', hyphenated: true });
    expect(wordAt('a well-known fact', 3)).toMatchObject({ word: 'well', hyphenated: false });
  });

  it('checks what the viewer sent', () => {
    expect(isClickedWord(wordAt('a word', 3))).toBe(true);
    expect(isClickedWord({ word: '', before: '', after: '', hyphenated: false })).toBe(false);
    expect(isClickedWord({ word: 'x'.repeat(500), before: '', after: '', hyphenated: false })).toBe(false);
    expect(isClickedWord('word')).toBe(false);
  });
});

describe('findWord', () => {
  const source = [
    '\\section{Results}', // 0
    'The model is fast. We tested the', // 1
    '\\emph{model} on two sets, and the model', // 2
    'held up. % the model in a comment', // 3
    'Then the \\model command.', // 4
  ];

  it('picks the occurrence whose surroundings match the PDF', () => {
    const clicked = wordAt('We tested the model on two sets, and the model held up.', 14)!;
    expect(clicked.word).toBe('model');
    expect(findWord(source, 3, clicked)).toEqual({ line: 2, column: 6 });
    const last = wordAt('We tested the model on two sets, and the model held up.', 42)!;
    expect(findWord(source, 3, last)).toEqual({ line: 2, column: 34 });
  });

  it('prefers the line SyncTeX gave when nothing else tells repeats apart', () => {
    expect(findWord(['word', 'word', 'word'], 1, { word: 'word', before: '', after: '', hyphenated: false })).toEqual({ line: 1, column: 0 });
  });

  it('skips command names, comments and lines far from the one SyncTeX gave', () => {
    expect(findWord(source, 4, { word: 'command', before: '', after: '', hyphenated: false })).toEqual({ line: 4, column: 16 });
    expect(findWord(['x \\model y'], 0, { word: 'model', before: '', after: '', hyphenated: false })).toBeUndefined();
    expect(findWord(['x % comment'], 0, { word: 'comment', before: '', after: '', hyphenated: false })).toBeUndefined();
    expect(findWord(['target', '', '', '', '', '', '', 'x'], 7, { word: 'target', before: '', after: '', hyphenated: false })).toBeUndefined();
  });

  it('matches the start of a word the PDF hyphenated, ignoring case', () => {
    expect(findWord(['An Example here.'], 0, { word: 'exam', before: 'An ', after: '-', hyphenated: true })).toEqual({ line: 0, column: 3 });
  });
});
