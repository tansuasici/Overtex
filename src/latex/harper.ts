// Spelling and grammar with Harper, which runs inside the extension and needs no install. Harper
// reads plain text, so the LaTeX source becomes the text LanguageTool would read (prose as is,
// markup as what it stands for) with a table back to source offsets. No vscode import, and no
// runtime import of harper.js, so it is unit-testable with any linter.
import type { LocalLinter, Lint } from 'harper.js';

import { annotateLatex, Annotation, GrammarProblem, resolveLanguage, UnsupportedLanguageError } from './grammar';

export type HarperLinter = Pick<LocalLinter, 'organizedLints' | 'getDefaultLintConfig' | 'setLintConfig' | 'setDialect' | 'importWords' | 'clearWords'> &
  Partial<Pick<LocalLinter, 'dispose'>>;

interface Segment {
  /** Where the piece starts in the plain text and in the source. */
  plain: number;
  source: number;
  /** Its length in the plain text and in the source. */
  plainLength: number;
  sourceLength: number;
  prose: boolean;
  /** Markup that reads as a stand-in word (math, a citation, a reference, code). */
  placeholder: boolean;
}

export interface PlainText {
  text: string;
  segments: Segment[];
}

/** Stand-ins the annotator writes for math and code (`X`), citations (`[1]`) and references (`1`). */
const PLACEHOLDER = /X|\[1\]|1/;

/** The plain text Harper reads for `annotations`, with where each piece came from. */
export function plainText(annotations: Annotation[]): PlainText {
  let text = '';
  let source = 0;
  const segments: Segment[] = [];
  for (const a of annotations) {
    const prose = 'text' in a;
    const piece = prose ? a.text : a.interpretAs ?? '';
    const sourceLength = prose ? a.text.length : a.markup.length;
    segments.push({
      plain: text.length,
      source,
      plainLength: piece.length,
      sourceLength,
      prose,
      placeholder: !prose && PLACEHOLDER.test(piece),
    });
    text += piece;
    source += sourceLength;
  }
  return { text, segments };
}

/** The segment holding the plain text's character at `at`. */
function segmentOf(segments: Segment[], at: number): Segment | undefined {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (s.plain + s.plainLength <= at) {
      lo = mid + 1;
    } else if (s.plain > at) {
      hi = mid - 1;
    } else {
      // Empty pieces share their offset with the next one; the one holding the character wins.
      return s.plainLength > 0 ? s : segments.slice(mid).find((t) => t.plainLength > 0);
    }
  }
  return undefined;
}

export interface SourceSpan {
  offset: number;
  length: number;
  /** The source under the span is exactly the plain text, so a suggestion can replace it. */
  verbatim: boolean;
}

/**
 * The source range under the plain range [start, end), widened to whole markup pieces, or
 * undefined when it touches a stand-in, which is not the author's words.
 */
export function toSource(plain: PlainText, src: string, start: number, end: number): SourceSpan | undefined {
  if (end <= start) {
    return undefined;
  }
  const overlapped = plain.segments.filter((s) => s.plain < end && s.plain + s.plainLength > start);
  if (overlapped.length === 0 || overlapped.some((s) => s.placeholder)) {
    return undefined;
  }
  const first = overlapped[0];
  const last = overlapped[overlapped.length - 1];
  const from = first.prose ? first.source + (start - first.plain) : first.source;
  const to = last.prose ? last.source + (end - last.plain) : last.source + last.sourceLength;
  return { offset: from, length: to - from, verbatim: src.substring(from, to) === plain.text.substring(start, end) };
}

/** Whether the nearest non-space text before or after [start, end) is a stand-in. */
function besidePlaceholder(plain: PlainText, start: number, end: number): boolean {
  let before = start;
  while (before > 0 && /\s/.test(plain.text[before - 1])) {
    before--;
  }
  let after = end;
  while (after < plain.text.length && /\s/.test(plain.text[after])) {
    after++;
  }
  const placeholderAt = (i: number): boolean => segmentOf(plain.segments, i)?.placeholder ?? false;
  return (before > 0 && placeholderAt(before - 1)) || (after < plain.text.length && placeholderAt(after));
}

/** Rules about spacing in the source, which TeX evens out. */
const ALWAYS_OFF = ['Spaces', 'NoFrenchSpaces'];

const DIALECTS: Record<string, number> = { US: 0, GB: 1, NZ: 1, IE: 1, AU: 2, CA: 3, IN: 4 };

/** Harper's dialect for an English language code, or undefined when the language is not English. */
export function harperDialect(language: string): number | undefined {
  const m = /^en(?:[-_]([a-z]{2}))?\b/i.exec(language);
  if (!m) {
    return undefined;
  }
  return DIALECTS[(m[1] ?? 'US').toUpperCase()] ?? 0;
}

const LANGUAGE_NAMES: Record<string, string> = {
  de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian',
  uk: 'Ukrainian', ca: 'Catalan', sv: 'Swedish', da: 'Danish', el: 'Greek', ja: 'Japanese', zh: 'Chinese', tr: 'Turkish',
};

export interface HarperOptions {
  /** A language code, or `auto` to take it from the document. */
  language: string;
  /** The root document's source, whose preamble names the language when `src` is a chapter file. */
  root?: string;
  /** Rules to leave out; names Harper does not know (LanguageTool's) are ignored. */
  disabledRules?: string[];
  /** Words not to report as misspellings. */
  dictionary?: string[];
}

/** Checks LaTeX source with Harper and returns the problems, sorted by offset. */
export async function checkLatexWithHarper(src: string, linter: HarperLinter, options: HarperOptions): Promise<GrammarProblem[]> {
  const language = resolveLanguage(src, options.language, options.root);
  const dialect = harperDialect(language);
  if (dialect === undefined) {
    const code = language.split(/[-_]/)[0].toLowerCase();
    throw new UnsupportedLanguageError(LANGUAGE_NAMES[code] ?? language, 'Harper');
  }
  await linter.setDialect(dialect);
  const config = await linter.getDefaultLintConfig();
  for (const rule of [...ALWAYS_OFF, ...(options.disabledRules ?? [])]) {
    if (rule in config) {
      config[rule] = false;
    }
  }
  await linter.setLintConfig(config);
  const dictionary = new Set(options.dictionary ?? []);
  await linter.clearWords();
  if (dictionary.size > 0) {
    await linter.importWords([...dictionary]);
  }

  const plain = plainText(annotateLatex(src));
  if (plain.text.trim() === '') {
    return [];
  }
  const organized = await linter.organizedLints(plain.text, { language: 'plaintext' });
  const problems: GrammarProblem[] = [];
  const seen = new Set<string>();
  for (const [ruleId, lints] of Object.entries(organized)) {
    for (const lint of lints as Lint[]) {
      const { start, end } = lint.span();
      const misspelling = lint.lint_kind() === 'Spelling';
      // Grammar beside math or a citation is about a stand-in the author did not write.
      if (!misspelling && besidePlaceholder(plain, start, end)) {
        continue;
      }
      const span = toSource(plain, src, start, end);
      if (!span) {
        continue;
      }
      const word = src.substring(span.offset, span.offset + span.length);
      if (misspelling && dictionary.has(word)) {
        continue;
      }
      const key = `${span.offset}:${span.length}:${lint.message()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      problems.push({
        offset: span.offset,
        length: span.length,
        message: lint.message(),
        // A suggestion would overwrite markup unless the source under the span is plain prose.
        replacements: span.verbatim
          ? lint
              .suggestions()
              .map((s) => (s.kind() === 1 ? '' : s.kind() === 2 ? word + s.get_replacement_text() : s.get_replacement_text()))
              .filter((value, i, all) => all.indexOf(value) === i)
              .slice(0, 5)
          : [],
        ruleId,
        misspelling,
      });
    }
  }
  return problems.sort((a, b) => a.offset - b.offset || a.length - b.length);
}
