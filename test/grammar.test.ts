import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  Annotation,
  annotateLatex,
  checkLatex,
  chunkAnnotations,
  detectLanguage,
  LanguageToolUnavailableError,
  resolveLanguage,
} from '../src/latex/grammar';
import { HunspellDictionaryError, HunspellUnavailableError, parseHunspellOutput, proseWords, RunHunspell } from '../src/latex/hunspell';

const joined = (a: Annotation[]): string => a.map((p) => ('text' in p ? p.text : p.markup)).join('');
/** What LanguageTool reads: text as it is, markup as what it is interpreted as. */
const reads = (a: Annotation[]): string => a.map((p) => ('text' in p ? p.text : p.interpretAs ?? '')).join('');
const doc = (body: string): string => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

function texFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? texFiles(p) : e.name.endsWith('.tex') ? [p] : [];
  });
}

describe('annotateLatex', () => {
  it('joins back into the source, for every fixture', () => {
    const files = texFiles(path.join(__dirname, 'fixtures'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect(joined(annotateLatex(src)), f).toBe(src);
    }
  });

  it('joins back into the source for awkward input', () => {
    for (const src of ['', '\\', '$unclosed', '\\begin{equation', '{{{', '\\emph{open', '%only a comment', 'a\\\\', '\\verb', '\\href{x}']) {
      expect(joined(annotateLatex(src))).toBe(src);
    }
  });

  it('checks only the body, and leaves out math, comments and commands', () => {
    const src = doc('We prove $x^2 \\geq 0$ in \\cref{sec:a} as shown by \\citet{knuth}. % a note\nThe \\emph{key} idea~works.');
    const text = reads(annotateLatex(src));
    expect(text).not.toContain('documentclass');
    expect(text).toContain('We prove X in 1 as shown by [1].');
    expect(text).not.toContain('a note');
    expect(text).toContain('The key idea works.');
  });

  it('reads section titles and captions as paragraphs of their own', () => {
    const text = reads(annotateLatex(doc('\\section{Introduction}\nText here.\\footnote{A note.}')));
    expect(text).toContain('\n\nIntroduction\n\n');
    expect(text).toContain('\n\nA note.\n\n');
  });

  it('skips code, tables and display math', () => {
    const text = reads(annotateLatex(doc('Before.\n\\begin{verbatim}\nteh code\n\\end{verbatim}\n\\begin{align*}\na &= b\n\\end{align*}\n\\begin{tabular}{ll}\nteh & cell\n\\end{tabular}\nAfter.')));
    expect(text).not.toContain('teh');
    expect(text).toContain('Before.');
    expect(text).toContain('After.');
  });

  it('reads quotes, dashes, accents and escapes as what they print', () => {
    const text = reads(annotateLatex(doc("``Caf\\'e'' -- 50\\% \\& more---and G\\\"odel.")));
    expect(text).toContain('“Café” – 50% & more—and Gödel.');
  });

  it('keeps a paragraph break as one, and a line break as a space', () => {
    const text = reads(annotateLatex(doc('one\ntwo\n\n  \nthree')));
    expect(text).toContain('one two\n\nthree');
  });

  it('checks the prose argument of \\href but not the address', () => {
    const text = reads(annotateLatex(doc('See \\href{https://example.com}{the site} now.')));
    expect(text).toContain('See the site now.');
  });
});

describe('chunkAnnotations', () => {
  it('splits at paragraph breaks and keeps offsets into the source', () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${'word '.repeat(20)}`);
    const src = doc(paragraphs.join('\n\n'));
    const chunks = chunkAnnotations(annotateLatex(src), 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const s = joined(c.annotations);
      expect(src.substring(c.offset, c.offset + s.length)).toBe(s);
    }
  });
});

describe('detectLanguage', () => {
  it('reads babel, polyglossia and class options', () => {
    expect(detectLanguage('\\usepackage[ngerman,british]{babel}')).toBe('en-GB');
    expect(detectLanguage('\\usepackage[english,main=french]{babel}')).toBe('fr');
    expect(detectLanguage('\\setmainlanguage[variant=british]{english}')).toBe('en-GB');
    expect(detectLanguage('\\setdefaultlanguage{german}')).toBe('de-DE');
    expect(detectLanguage('\\documentclass[11pt,american]{article}')).toBe('en-US');
    expect(detectLanguage('\\documentclass{article}')).toBeUndefined();
    expect(detectLanguage('% \\usepackage[french]{babel}\n\\documentclass{article}')).toBeUndefined();
    expect(detectLanguage('\\usepackage[turkish]{babel}')).toBe('tr');
  });

  it('takes a chapter file\'s language from the root document, and English when none is named', () => {
    const chapter = 'Ein Kapitel.';
    expect(resolveLanguage(chapter, 'auto', '\\documentclass{book}\n\\usepackage[ngerman]{babel}')).toBe('de-DE');
    expect(resolveLanguage(doc('\\usepackage[french]{babel}'), 'auto', '\\usepackage[ngerman]{babel}')).toBe('fr');
    expect(resolveLanguage(chapter, 'auto', '\\documentclass{book}')).toBe('en-US');
    expect(resolveLanguage(chapter, 'auto')).toBe('en-US');
    expect(resolveLanguage(chapter, 'en-GB', '\\usepackage[ngerman]{babel}')).toBe('en-GB');
    expect(resolveLanguage(chapter, 'auto', '\\usepackage[turkish]{babel}')).toBe('tr');
  });
});

describe('checkLatex', () => {
  const src = doc('This is teh text with \\emph{an} error.');
  const at = src.indexOf('teh');

  function fakeFetch(matches: unknown[], calls: { url: string; body?: URLSearchParams }[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body as URLSearchParams | undefined });
      if (url.endsWith('/v2/languages')) {
        return new Response('[]');
      }
      return new Response(JSON.stringify({ matches }));
    }) as typeof fetch;
  }

  const misspelling = {
    offset: 0,
    length: 3,
    message: 'Possible spelling mistake found.',
    replacements: [{ value: 'the' }, { value: 'tech' }],
    rule: { id: 'MORFOLOGIK_RULE_EN_US', issueType: 'misspelling', category: { id: 'TYPOS' } },
  };

  it('maps the offsets LanguageTool answers with back to the source', async () => {
    const calls: { url: string; body?: URLSearchParams }[] = [];
    const chunk = chunkAnnotations(annotateLatex(src))[0];
    const problems = await checkLatex(src, {
      url: 'http://lt.test/',
      language: 'auto',
      fetchFn: fakeFetch([{ ...misspelling, offset: at - chunk.offset }], calls),
    });
    expect(problems).toHaveLength(1);
    expect(src.substring(problems[0].offset, problems[0].offset + problems[0].length)).toBe('teh');
    expect(problems[0].replacements).toEqual(['the', 'tech']);
    const check = calls.find((c) => c.url === 'http://lt.test/v2/check')!;
    expect(check.body!.get('language')).toBe('en-US');
    expect(check.body!.get('disabledRules')).toContain('WHITESPACE_RULE');
    expect(JSON.parse(check.body!.get('data')!).annotation.length).toBeGreaterThan(1);
  });

  it('leaves out words in the dictionary, and passes disabled rules on', async () => {
    const calls: { url: string; body?: URLSearchParams }[] = [];
    const problems = await checkLatex(src, {
      url: 'http://lt.test',
      language: 'en-GB',
      dictionary: ['teh'],
      disabledRules: ['EN_QUOTES'],
      fetchFn: fakeFetch([{ ...misspelling, offset: at }], calls),
    });
    expect(problems).toHaveLength(0);
    const check = calls.find((c) => c.url.endsWith('/v2/check'))!;
    expect(check.body!.get('language')).toBe('en-GB');
    expect(check.body!.get('disabledRules')).toContain('EN_QUOTES');
  });

  it('says so when no server answers', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(checkLatex(src, { url: 'http://lt.test', language: 'auto', fetchFn: failing })).rejects.toBeInstanceOf(LanguageToolUnavailableError);
  });

  it('checks Turkish with Hunspell, not the server', async () => {
    const calls: { url: string }[] = [];
    const turkish = '\\documentclass{article}\n\\usepackage[turkish]{babel}\n\\begin{document}\nMerhaba dünyya, \\emph{Ankara\'da} dünyya.\n\\end{document}\n';
    const runs: { path: string; args: string[]; input: string }[] = [];
    const run: RunHunspell = async (path, args, input) => {
      runs.push({ path, args, input });
      return { code: 0, stdout: '@(#) International Ispell Version 3.2.06 (but really Hunspell 1.7.2)\n*\n\n& dünyya 2 0: dünya, dünyaya\n\n*\n\n', stderr: '' };
    };
    const problems = await checkLatex(turkish, { url: 'http://lt.test', language: 'auto', fetchFn: fakeFetch([], calls), hunspell: { run } });
    expect(calls).toHaveLength(0);
    expect(runs).toEqual([{ path: 'hunspell', args: ['-a', '-i', 'UTF-8', '-d', 'tr_TR'], input: '^Merhaba\n^dünyya\n^Ankara\n' }]);
    const first = turkish.indexOf('dünyya');
    expect(problems.map((p) => [p.offset, p.length, p.replacements, p.misspelling])).toEqual([
      [first, 6, ['dünya', 'dünyaya'], true],
      [turkish.indexOf('dünyya', first + 1), 6, ['dünya', 'dünyaya'], true],
    ]);
  });

  it('leaves dictionary words out of the Hunspell check', async () => {
    const turkish = '\\usepackage[turkish]{babel}\n\\begin{document}\nOverleaf ile\n\\end{document}\n';
    const runs: string[] = [];
    const run: RunHunspell = async (_path, _args, input) => {
      runs.push(input);
      return { code: 0, stdout: '@(#) Hunspell\n*\n\n', stderr: '' };
    };
    expect(await checkLatex(turkish, { url: 'http://lt.test', language: 'auto', dictionary: ['Overleaf'], hunspell: { run } })).toEqual([]);
    expect(runs).toEqual(['^ile\n']);
  });

  it('says when Hunspell or its dictionary is missing', async () => {
    const turkish = '\\usepackage[turkish]{babel}\n\\begin{document}\nMerhaba\n\\end{document}\n';
    const missing: RunHunspell = async () => {
      throw Object.assign(new Error('spawn hunspell ENOENT'), { code: 'ENOENT' });
    };
    await expect(checkLatex(turkish, { url: 'x', language: 'auto', hunspell: { run: missing } })).rejects.toBeInstanceOf(HunspellUnavailableError);
    const noDict: RunHunspell = async () => ({ code: 1, stdout: '', stderr: 'Can\'t open affix or dic files for dictionary named "tr_TR".\n' });
    await expect(checkLatex(turkish, { url: 'x', language: 'tr', hunspell: { run: noDict } })).rejects.toBeInstanceOf(HunspellDictionaryError);
  });
});

describe('hunspell', () => {
  it('takes the prose words with their offsets, skipping suffixes, single letters and acronyms', () => {
    const words = proseWords([{ text: 'Bu bir ' }, { markup: '\\cite{x}' }, { text: " Ankara'da NASA ve İstanbul’a a." }]);
    expect(words.map((w) => w.word)).toEqual(['Bu', 'bir', 'Ankara', 've', 'İstanbul']);
    expect(words[2].offset).toBe('Bu bir \\cite{x} '.length);
  });

  it('reads pipe-mode answers, one block per word', () => {
    const out = '@(#) Hunspell\n*\n\n+ kitap\n\n& kitab 1 0: kitap\n\n# xqz 0\n\n-\n\n';
    expect(parseHunspellOutput(out, 5)).toEqual([
      { ok: true, suggestions: [] },
      { ok: true, suggestions: [] },
      { ok: false, suggestions: ['kitap'] },
      { ok: false, suggestions: [] },
      { ok: true, suggestions: [] },
    ]);
    expect(() => parseHunspellOutput('@(#) Hunspell\n*\n\n', 2)).toThrow();
  });
});
