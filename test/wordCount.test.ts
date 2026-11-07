import { describe, expect, it } from 'vitest';
import { parseTexcount, texcountArgs, wordCountDetails, wordCountLabel } from '../src/latex/wordCount';

const REPORT = `Total
Words in text: 1229
Words in headers: 9
Words outside text (captions, etc.): 12
Number of headers: 4
Number of floats/tables/figures: 1
Number of math inlines: 1
Number of math displayed: 0
Files: 2
`;

describe('word count', () => {
  it('runs texcount over included files', () => {
    expect(texcountArgs('main.tex')).toEqual(['-inc', '-utf8', '-total', 'main.tex']);
  });

  it('parses the total report', () => {
    expect(parseTexcount(REPORT)).toEqual({ text: 1229, headers: 9, captions: 12, total: 1250 });
  });

  it('keeps counting when texcount also reports a missing file', () => {
    expect(parseTexcount(`!!! File chapters/intro not found in path [./]. !!!\n${REPORT}(errors:1)`)?.total).toBe(1250);
  });

  it('returns null for output without counts', () => {
    expect(parseTexcount('texcount: command not found')).toBeNull();
  });

  it('labels the count with and without a goal', () => {
    const count = parseTexcount(REPORT)!;
    expect(wordCountLabel(count, 0)).toBe('1,250 words');
    expect(wordCountLabel(count, 5000)).toBe('1,250 / 5,000 words');
    expect(wordCountLabel({ text: 1, headers: 0, captions: 0, total: 1 }, 0)).toBe('1 word');
  });

  it('describes progress toward the goal and the session', () => {
    const count = parseTexcount(REPORT)!;
    expect(wordCountDetails(count, 5000, 1000)).toEqual([
      '1,229 in text, 9 in headings, 12 in captions',
      '25% of the 5,000 word goal, 3,750 to go.',
      '+250 since this session started.',
    ]);
    expect(wordCountDetails(count, 1000)[1]).toBe('Goal of 1,000 words reached (125%).');
    expect(wordCountDetails(count, 0, 1250)).toHaveLength(1);
  });
});
