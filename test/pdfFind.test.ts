import { describe, expect, it } from 'vitest';
import { findCounter, findInPage, normalizeQuery, pageText, stepMatch, type FindItem, type FindOptions } from '../src/shared/pdfFind';

const plain: FindOptions = { caseSensitive: false, wholeWord: false };
const run = (str: string, hasEOL = false): FindItem => ({ str, hasEOL });
const find = (items: FindItem[], query: string, options: FindOptions = plain) => findInPage(pageText(items, options.caseSensitive), query, options);

describe('pageText', () => {
  it('joins runs as they are and makes a line end a space', () => {
    expect(pageText([run('The equation'), run(' '), run('E'), run('', true), run('Next line')], true).text).toBe('The equation E Next line');
  });

  it('makes runs of spaces one', () => {
    expect(pageText([run('a  '), run(' ', true), run('', true), run('b')], false).text).toBe('a b');
  });

  it('joins a word broken with a hyphen at a line end', () => {
    expect(pageText([run('an exam-', true), run('ple here')], false).text).toBe('an example here');
    expect(pageText([run('page 3 -', true), run('4')], false).text).toBe('page 3 - 4');
  });
});

describe('findInPage', () => {
  it('finds every match, ignoring case by default', () => {
    expect(find([run('Overtex and overtex and OVERTEX')], 'overtex')).toEqual([
      [{ item: 0, start: 0, end: 7 }],
      [{ item: 0, start: 12, end: 19 }],
      [{ item: 0, start: 24, end: 31 }],
    ]);
  });

  it('matches case when asked', () => {
    expect(find([run('Overtex and overtex')], 'overtex', { caseSensitive: true, wholeWord: false })).toEqual([[{ item: 0, start: 12, end: 19 }]]);
  });

  it('finds a word spelled with a ligature, pointing at the ligature', () => {
    expect(find([run('the ﬁrst ﬁgure')], 'first')).toEqual([[{ item: 0, start: 4, end: 8 }]]);
    expect(find([run('the ﬁrst')], 'ﬁrst')).toHaveLength(1);
  });

  it('folds Turkish dotted and dotless i without case', () => {
    expect(find([run('İstanbul ISPARTA ılık')], 'istanbul')).toHaveLength(1);
    expect(find([run('İstanbul ISPARTA ılık')], 'ısparta')).toHaveLength(1);
    expect(find([run('İstanbul ISPARTA ılık')], 'ILIK')).toHaveLength(1);
    expect(find([run('İstanbul')], 'istanbul', { caseSensitive: true, wholeWord: false })).toHaveLength(0);
  });

  it('finds a match over several runs, one span per run', () => {
    expect(find([run('The equation'), run(' '), run('E'), run(' '), run('=')], 'equation e')).toEqual([
      [
        { item: 0, start: 4, end: 12 },
        { item: 1, start: 0, end: 1 },
        { item: 2, start: 0, end: 1 },
      ],
    ]);
  });

  it('finds a match across a line end, leaving the line end out', () => {
    expect(find([run('main', true), run('file')], 'main file')).toEqual([
      [
        { item: 0, start: 0, end: 4 },
        { item: 1, start: 0, end: 4 },
      ],
    ]);
  });

  it('finds a word hyphenated over two lines, with the hyphen in no span', () => {
    expect(find([run('an exam-', true), run('ple')], 'example')).toEqual([
      [
        { item: 0, start: 3, end: 7 },
        { item: 1, start: 0, end: 3 },
      ],
    ]);
  });

  it('matches whole words with letters beyond ASCII', () => {
    const items = [run('şu kuşu ve şu')];
    expect(find(items, 'şu', { caseSensitive: false, wholeWord: true })).toEqual([
      [{ item: 0, start: 0, end: 2 }],
      [{ item: 0, start: 11, end: 13 }],
    ]);
    expect(find(items, 'şu')).toHaveLength(3);
    expect(find([run('x (a) y')], '(a)', { caseSensitive: false, wholeWord: true })).toHaveLength(1);
  });

  it('treats the query as text, not a pattern', () => {
    expect(find([run('cost $5.00 (a+b)*c')], '$5.00 (a+b)*')).toHaveLength(1);
    expect(find([run('abc')], 'a.c')).toHaveLength(0);
  });

  it('finds nothing for an empty or blank query', () => {
    expect(find([run('text')], '')).toEqual([]);
    expect(find([run('text')], '   ')).toEqual([]);
  });
});

describe('normalizeQuery', () => {
  it('folds the query like the page and makes its spaces one', () => {
    expect(normalizeQuery('  Main   File ', false)).toBe('main file');
    expect(normalizeQuery('ﬁ', true)).toBe('fi');
  });
});

describe('stepMatch', () => {
  it('wraps around at both ends', () => {
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});

describe('findCounter', () => {
  it('shows the place, no results, or a wait', () => {
    expect(findCounter(0, 12, false, 'x')).toBe('1 / 12');
    expect(findCounter(-1, 0, false, 'x')).toBe('No results');
    expect(findCounter(0, 12, true, 'x')).toBe('…');
    expect(findCounter(-1, 0, false, '')).toBe('');
  });
});
