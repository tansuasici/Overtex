import { describe, expect, it } from 'vitest';

import { renderMath } from '../src/math/render';
import { symbolPackageLoaded } from '../src/latex/symbolPackages';
import { CATEGORIES, SYMBOLS, escapeSnippet, frequentSymbols, searchSymbols } from '../src/shared/symbols';

const cmds = (query: string, usage?: Record<string, number>) => searchSymbols(query, usage).map((s) => s.cmd);

describe('the symbol list', () => {
  it('has unique commands and a known category for each', () => {
    expect(new Set(SYMBOLS.map((s) => s.cmd)).size).toBe(SYMBOLS.length);
    for (const s of SYMBOLS) {
      expect(CATEGORIES).toContain(s.category);
    }
  });

  it('covers every category', () => {
    for (const c of CATEGORIES) {
      expect(SYMBOLS.some((s) => s.category === c)).toBe(true);
    }
  });

  it('renders every symbol with MathJax', () => {
    const failures = SYMBOLS.map((s) => [s.cmd, renderMath(s.tex, false, [])] as const).filter(([, r]) => 'error' in r);
    expect(failures).toEqual([]);
  }, 60_000);

  it('escapes snippet syntax in commands', () => {
    expect(escapeSnippet('\\}')).toBe('\\\\\\}');
    expect(SYMBOLS.find((s) => s.cmd === '\\leq')?.snippet).toBe('\\\\leq');
    expect(SYMBOLS.find((s) => s.cmd === '\\frac')?.snippet).toBe('\\\\frac{$1}{$2}');
  });
});

describe('searchSymbols', () => {
  it('finds a symbol by command, with or without the backslash', () => {
    expect(cmds('leq')[0]).toBe('\\leq');
    expect(cmds('\\leq')[0]).toBe('\\leq');
  });

  it('finds a symbol by its character', () => {
    expect(cmds('≤')[0]).toBe('\\leq');
    expect(cmds('α')[0]).toBe('\\alpha');
  });

  it('finds a symbol by its name, ignoring little words', () => {
    expect(cmds('less or equal')[0]).toBe('\\leq');
    expect(cmds('less than or equal to')[0]).toBe('\\leq');
    expect(cmds('empty set')).toContain('\\emptyset');
  });

  it('finds by keyword and by prefix', () => {
    expect(cmds('iff')).toContain('\\Leftrightarrow');
    expect(cmds('integ')[0]).toBe('\\int');
    expect(cmds('greek')).toContain('\\alpha');
    expect(cmds('greek')[0]).toBe('\\boldsymbol'); // its keyword beats the category
  });

  it('needs every word to match', () => {
    expect(cmds('less greater')).toEqual([]);
    expect(cmds('nonsenseword')).toEqual([]);
  });

  it('puts the more used first among equals', () => {
    const plain = cmds('arrow');
    const used = cmds('arrow', { '\\hookrightarrow': 3 });
    expect(used.indexOf('\\hookrightarrow')).toBeLessThan(plain.indexOf('\\hookrightarrow'));
  });

  it('lists everything for an empty query, the most used first', () => {
    const all = cmds('', { '\\sum': 5, '\\alpha': 2 });
    expect(all.length).toBe(SYMBOLS.length);
    expect(all.slice(0, 2)).toEqual(['\\sum', '\\alpha']);
  });
});

describe('frequentSymbols', () => {
  it('gives the used symbols, most used first, up to the limit', () => {
    expect(frequentSymbols({ '\\pi': 1, '\\sum': 4, '\\int': 2 }, 2).map((s) => s.cmd)).toEqual(['\\sum', '\\int']);
    expect(frequentSymbols({}, 5)).toEqual([]);
  });
});

describe('symbolPackageLoaded', () => {
  const doc = (preamble: string, cls = 'article') => `\\documentclass{${cls}}\n${preamble}\n\\begin{document}\n\\end{document}\n`;

  it('sees the package itself', () => {
    expect(symbolPackageLoaded(doc('\\usepackage{amssymb}'), 'amssymb')).toBe(true);
    expect(symbolPackageLoaded(doc(''), 'amssymb')).toBe(false);
  });

  it('accepts packages that provide the same symbols', () => {
    expect(symbolPackageLoaded(doc('\\usepackage{amssymb}'), 'amsfonts')).toBe(true);
    expect(symbolPackageLoaded(doc('\\usepackage{newtxmath}'), 'amssymb')).toBe(true);
    expect(symbolPackageLoaded(doc('\\usepackage{mathtools}'), 'amsmath')).toBe(true);
    expect(symbolPackageLoaded(doc('\\usepackage{amsmath}'), 'mathtools')).toBe(false);
  });

  it('knows the AMS classes load amsmath', () => {
    expect(symbolPackageLoaded(doc('', 'amsart'), 'amsmath')).toBe(true);
    expect(symbolPackageLoaded(doc('', 'amsart'), 'amssymb')).toBe(false);
  });
});
