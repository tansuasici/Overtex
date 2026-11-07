import { describe, expect, it } from 'vitest';
import { collectMacros, findMathSpans, mathAt } from '../src/latex/math';

const texOf = (text: string) => findMathSpans(text).map((s) => [s.tex, s.display]);

describe('findMathSpans', () => {
  it('finds inline and display delimiters with their offsets', () => {
    const text = 'Let $x^2$ and \\(y\\), then \\[ z = 1 \\] and $$w$$.';
    expect(texOf(text)).toEqual([
      ['x^2', false],
      ['y', false],
      ['z = 1', true],
      ['w', true],
    ]);
    const first = findMathSpans(text)[0];
    expect(text.substring(first.start, first.end)).toBe('$x^2$');
  });

  it('keeps math environments whole and unwraps math/displaymath', () => {
    const text = '\\begin{align*}\na &= b \\\\\nc &= d\n\\end{align*}\n\\begin{displaymath} e \\end{displaymath}';
    expect(texOf(text)).toEqual([
      ['\\begin{align*}\na &= b \\\\\nc &= d\n\\end{align*}', true],
      ['e', true],
    ]);
  });

  it('skips escaped dollars, comments, \\verb and verbatim environments', () => {
    const text = [
      'Costs \\$5 and \\$6.',
      '% $not math$',
      '\\verb|$x$| and',
      '\\begin{verbatim}',
      '$y$',
      '\\end{verbatim}',
      'real $z$',
    ].join('\n');
    expect(texOf(text)).toEqual([['z', false]]);
  });

  it('strips comments inside math and ignores unclosed or empty math', () => {
    expect(texOf('$a % note\n+ b$')).toEqual([['a       \n+ b', false]]);
    expect(texOf('A lone $ sign.\n\nAnother paragraph $x$.')).toEqual([['x', false]]);
    expect(texOf('$$ $$ \\(\\)')).toEqual([]);
  });

  it('mathAt returns the span under an offset', () => {
    const text = 'a $x$ b';
    const spans = findMathSpans(text);
    expect(mathAt(spans, 3)?.tex).toBe('x');
    expect(mathAt(spans, 0)).toBeUndefined();
    expect(mathAt(spans, 5)).toBeUndefined();
  });
});

describe('collectMacros', () => {
  it('collects \\newcommand variants, operators and \\def', () => {
    const text = [
      '\\newcommand{\\R}{\\mathbb{R}}',
      '\\renewcommand\\vec[1]{\\mathbf{#1}}',
      '\\providecommand{\\abs}[2][x]{|#2|_{#1}}',
      '\\DeclareMathOperator*{\\argmax}{arg\\,max}',
      '\\def\\half#1{\\frac{#1}{2}}',
      '\\newcommand*{\\set}[1]{\\{#1\\}}',
    ].join('\n');
    expect(collectMacros(text)).toEqual([
      '\\newcommand{\\R}{\\mathbb{R}}',
      '\\renewcommand{\\vec}[1]{\\mathbf{#1}}',
      '\\newcommand{\\abs}[2][x]{|#2|_{#1}}',
      '\\DeclareMathOperator*{\\argmax}{arg\\,max}',
      '\\def\\half#1{\\frac{#1}{2}}',
      '\\newcommand*{\\set}[1]{\\{#1\\}}',
    ]);
  });

  it('ignores commented definitions, @ names and unbalanced bodies', () => {
    const text = ['% \\newcommand{\\x}{1}', '\\newcommand{\\my@cmd}{2}', '\\newcommand{\\bad}{\\frac{', '\\newcommand{\\ok}{3}'].join('\n');
    expect(collectMacros(text)).toEqual(['\\newcommand{\\ok}{3}']);
  });
});
