import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createHarperLinter } from '../src/harperLoader';
import { annotateLatex, GrammarProblem, UnsupportedLanguageError } from '../src/latex/grammar';
import { checkLatexWithHarper, harperDialect, HarperLinter, plainText, toSource } from '../src/latex/harper';

const doc = (body: string): string => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

describe('plainText and toSource', () => {
  it('maps prose back to the source, past the markup before it', () => {
    const src = doc('See \\textbf{bold} speling here.');
    const plain = plainText(annotateLatex(src));
    const at = plain.text.indexOf('speling');
    const span = toSource(plain, src, at, at + 'speling'.length)!;
    expect(src.substr(span.offset, span.length)).toBe('speling');
    expect(span.verbatim).toBe(true);
  });

  it('counts UTF-16 units, so text after an emoji or accent still lines up', () => {
    const src = doc('Caf\u00e9 \u{1F600} and teh end.');
    const plain = plainText(annotateLatex(src));
    const at = plain.text.indexOf('teh');
    const span = toSource(plain, src, at, at + 3)!;
    expect(src.substr(span.offset, span.length)).toBe('teh');
  });

  it('gives nothing for a span on math, a citation or a reference', () => {
    const src = doc('Let $x$ be as in \\cite{a} and Section~\\ref{b}.');
    const plain = plainText(annotateLatex(src));
    for (const stand of ['X', '[1]']) {
      const at = plain.text.indexOf(stand);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(toSource(plain, src, at, at + stand.length)).toBeUndefined();
    }
  });

  it('widens a span that ends in markup to the whole command, and marks it not verbatim', () => {
    const src = doc('Schr\\"odinger said so.');
    const plain = plainText(annotateLatex(src));
    const at = plain.text.indexOf('Schr');
    const word = /Schr\S*/.exec(plain.text.slice(at))![0];
    const span = toSource(plain, src, at, at + word.length)!;
    expect(src.substr(span.offset, span.length)).toBe('Schr\\"odinger');
    expect(span.verbatim).toBe(false);
  });
});

describe('harperDialect', () => {
  it('reads English variants and rejects other languages', () => {
    expect(harperDialect('en-US')).toBe(0);
    expect(harperDialect('en')).toBe(0);
    expect(harperDialect('en-GB')).toBe(1);
    expect(harperDialect('en_AU')).toBe(2);
    expect(harperDialect('en-CA')).toBe(3);
    expect(harperDialect('en-IN')).toBe(4);
    expect(harperDialect('de-DE')).toBeUndefined();
    expect(harperDialect('tr')).toBeUndefined();
  });
});

/** A linter that records what it is told and returns no lints. */
function fakeLinter(): HarperLinter & { config?: Record<string, boolean | null>; words: string[]; dialect?: number } {
  const fake = {
    words: [] as string[],
    config: undefined as Record<string, boolean | null> | undefined,
    dialect: undefined as number | undefined,
    organizedLints: async () => ({}),
    getDefaultLintConfig: async () => ({ Spaces: true, NoFrenchSpaces: true, LongSentences: true, SpellCheck: true }),
    setLintConfig: async (c: Record<string, boolean | null>) => void (fake.config = c),
    setDialect: async (d: number) => void (fake.dialect = d),
    importWords: async (w: string[]) => void fake.words.push(...w),
    clearWords: async () => void (fake.words.length = 0),
  };
  return fake;
}

describe('checkLatexWithHarper settings', () => {
  it('turns off source-spacing rules and the user\'s rules, ignoring unknown names', async () => {
    const linter = fakeLinter();
    await checkLatexWithHarper(doc('Text.'), linter, { language: 'en-GB', disabledRules: ['LongSentences', 'EN_QUOTES'], dictionary: ['Overtex'] });
    expect(linter.config).toEqual({ Spaces: false, NoFrenchSpaces: false, LongSentences: false, SpellCheck: true });
    expect(linter.dialect).toBe(1);
    expect(linter.words).toEqual(['Overtex']);
  });

  it('refuses a document in another language', async () => {
    const src = '\\documentclass{article}\n\\usepackage[ngerman]{babel}\n\\begin{document}\nText.\n\\end{document}\n';
    await expect(checkLatexWithHarper(src, fakeLinter(), { language: 'auto' })).rejects.toBeInstanceOf(UnsupportedLanguageError);
  });
});

describe('checkLatexWithHarper with Harper', () => {
  let linter: HarperLinter;
  const sample = fs.readFileSync(path.join(__dirname, 'fixtures', 'harper-sample.tex'), 'utf8');
  const at = (p: GrammarProblem): string => sample.substr(p.offset, p.length);

  beforeAll(async () => {
    const l = createHarperLinter(path.resolve(__dirname, '..', 'node_modules', 'harper.js', 'dist', 'harper_wasm_slim_bg.wasm'));
    await l.setup();
    linter = l;
  }, 30000);

  it('finds a misspelling and a grammar error, and nothing in math, commands or comments', async () => {
    const problems = await checkLatexWithHarper(sample, linter, { language: 'auto' });
    const words = problems.map(at);

    const speling = problems.find((p) => at(p) === 'speling');
    expect(speling?.misspelling).toBe(true);
    expect(speling?.replacements).toContain('spelling');

    const go = problems.find((p) => at(p) === 'go');
    expect(go).toBeDefined();
    expect(go?.misspelling).toBe(false);

    // American English by default.
    expect(words).toContain('minimised');

    const comment = sample.indexOf('% teh');
    const body = sample.indexOf('\\begin{document}');
    for (const p of problems) {
      expect(p.offset).toBeGreaterThan(body);
      expect(sample.slice(p.offset, p.offset + p.length)).not.toMatch(/[\\$%{}]/);
      expect(p.offset < comment || p.offset > sample.indexOf('\n', comment)).toBe(true);
    }
    for (const markup of ['knuth84', 'sec:x', 'alpha', 'sum', 'example', 'my_var', 'odinger', 'teh']) {
      expect(words.some((w) => w.includes(markup))).toBe(false);
    }
  });

  it('follows the dialect, the dictionary and disabled rules', async () => {
    const british = await checkLatexWithHarper(sample, linter, { language: 'en-GB' });
    expect(british.map(at)).not.toContain('minimised');

    const withWord = await checkLatexWithHarper(sample, linter, { language: 'auto', dictionary: ['speling'] });
    expect(withWord.map(at)).not.toContain('speling');

    const all = await checkLatexWithHarper(sample, linter, { language: 'auto' });
    const rule = all.find((p) => at(p) === 'go')!.ruleId!;
    const without = await checkLatexWithHarper(sample, linter, { language: 'auto', disabledRules: [rule] });
    expect(without.some((p) => p.ruleId === rule)).toBe(false);
  });

  it('checks a long document in reasonable time', async () => {
    const paragraph = 'This paragraph has an $x$ and a citation \\cite{a}, and it is written in plain English prose. ';
    const long = doc(Array.from({ length: 550 }, () => paragraph).join('\n\n'));
    expect(long.length).toBeGreaterThan(50000);
    const t = Date.now();
    await checkLatexWithHarper(long, linter, { language: 'auto' });
    const ms = Date.now() - t;
    console.log(`Harper on ${long.length} characters: ${ms} ms`);
    expect(ms).toBeLessThan(10000);
  }, 30000);
});
