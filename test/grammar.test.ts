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
  UnsupportedLanguageError,
} from '../src/latex/grammar';

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
    expect(() => resolveLanguage(chapter, 'auto', '\\usepackage[turkish]{babel}')).toThrow(UnsupportedLanguageError);
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

  it('refuses Turkish before asking the server', async () => {
    const calls: { url: string }[] = [];
    const turkish = '\\documentclass{article}\n\\usepackage[turkish]{babel}\n\\begin{document}\nMerhaba.\n\\end{document}\n';
    await expect(checkLatex(turkish, { url: 'http://lt.test', language: 'auto', fetchFn: fakeFetch([], calls) })).rejects.toBeInstanceOf(UnsupportedLanguageError);
    expect(calls).toHaveLength(0);
  });
});
