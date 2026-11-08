import { describe, expect, it } from 'vitest';
import { ABSTRACT_LIMIT, citationHoverMarkdown, citeKeyAt, formatAuthors } from '../src/latex/cite';
import { BibEntry } from '../src/latex/bibParser';

describe('citeKeyAt', () => {
  it('finds the key under the cursor in a key list', () => {
    const line = 'See \\cite{alpha, beta} here.';
    const at = line.indexOf('beta') + 2;
    expect(citeKeyAt(line, at)).toEqual({ key: 'beta', start: line.indexOf('beta'), end: line.indexOf('beta') + 4 });
    expect(citeKeyAt(line, line.indexOf('alpha'))?.key).toBe('alpha');
  });

  it('handles optional arguments and natbib/biblatex variants', () => {
    const line = '\\citep[see][p.~3]{knuth1984} and \\textcite*{smith2020}';
    expect(citeKeyAt(line, line.indexOf('knuth') + 1)?.key).toBe('knuth1984');
    expect(citeKeyAt(line, line.indexOf('smith') + 1)?.key).toBe('smith2020');
  });

  it('returns undefined outside the braces, in the optional argument and on separators', () => {
    const line = '\\cite[p.~3]{a, b} text';
    expect(citeKeyAt(line, 1)).toBeUndefined();
    expect(citeKeyAt(line, line.indexOf('p.~3'))).toBeUndefined();
    expect(citeKeyAt(line, line.indexOf('text'))).toBeUndefined();
    expect(citeKeyAt(line, line.indexOf(', ') + 1)).toBeUndefined();
    expect(citeKeyAt('\\ref{fig1}', 6)).toBeUndefined();
  });

  it('accepts the cursor right after the last character of a key', () => {
    const line = '\\cite{key}';
    expect(citeKeyAt(line, line.indexOf('}'))?.key).toBe('key');
  });
});

describe('formatAuthors', () => {
  it('turns "Last, First" into "First Last"', () => {
    expect(formatAuthors('Einstein, Albert and Doe, John')).toBe('Albert Einstein, John Doe');
    expect(formatAuthors('John Smith and Jane Doe')).toBe('John Smith, Jane Doe');
  });

  it('shortens long author lists', () => {
    expect(formatAuthors('A One and B Two and C Three and D Four')).toBe('A One, B Two, C Three et al.');
  });
});

describe('citationHoverMarkdown', () => {
  const entry: BibEntry = {
    key: 'smith2020',
    type: 'article',
    title: 'A Study on LaTeX Compilation',
    author: 'Smith, John and Doe, Jane',
    year: '2020',
    abstract: '',
    doi: '',
    line: 0,
    fields: {},
  };

  it('shows title, authors, year and entry type', () => {
    const md = citationHoverMarkdown(entry);
    expect(md).toContain('**A Study on LaTeX Compilation**');
    expect(md).toContain('John Smith, Jane Doe (2020)');
    expect(md).toContain('`@article{smith2020}`');
    expect(md).not.toContain('---');
  });

  it('truncates a long abstract', () => {
    const md = citationHoverMarkdown({ ...entry, abstract: 'word '.repeat(300).trim() });
    expect(md).toContain('---');
    expect(md).toContain('…');
    const abstractLine = md.split('\n\n').pop()!;
    expect(abstractLine.length).toBeLessThan(ABSTRACT_LIMIT + 10);
  });
});
