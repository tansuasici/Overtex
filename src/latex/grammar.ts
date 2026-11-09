// Spelling and grammar through a LanguageTool server. LaTeX source becomes LanguageTool's
// annotated text: prose goes as text, everything else as markup (with what it reads as), so the
// offsets LanguageTool answers with are offsets into the source. No vscode import, so it is
// unit-testable.
import { commentStart } from './arxiv';

export const DEFAULT_LANGUAGETOOL_URL = 'http://localhost:8081';

export type Annotation = { text: string } | { markup: string; interpretAs?: string };

export interface GrammarProblem {
  /** Offset into the source, in UTF-16 code units. */
  offset: number;
  length: number;
  message: string;
  replacements: string[];
  ruleId: string;
  /** A misspelling, which the dictionary can silence. */
  misspelling: boolean;
}

export class LanguageToolUnavailableError extends Error {
  constructor(readonly url: string) {
    super(`LanguageTool is not reachable at ${url}`);
    this.name = 'LanguageToolUnavailableError';
  }
}

export class UnsupportedLanguageError extends Error {
  constructor(readonly language: string) {
    super(`LanguageTool does not support ${language}`);
    this.name = 'UnsupportedLanguageError';
  }
}

// --- LaTeX to annotated text -------------------------------------------------------------------

const MATH_ENVS = new Set(['equation', 'align', 'gather', 'multline', 'eqnarray', 'flalign', 'alignat', 'displaymath', 'math', 'dmath']);
/** Bodies that are code, drawings or tables rather than prose. */
const SKIPPED_ENVS = new Set([
  'verbatim', 'Verbatim', 'BVerbatim', 'lstlisting', 'minted', 'comment', 'filecontents', 'tikzpicture', 'pgfpicture',
  'algorithmic', 'tabular', 'tabularx', 'tabulary', 'longtable', 'array', 'thebibliography',
]);
const CITE = /^(?:[a-zA-Z]*cite[a-zA-Z]*|footcite|parencite|textcite|autocite|smartcite|supercite)$/;
const REF = new Set(['ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref', 'nameref', 'vref', 'Vref', 'labelcref']);
/** Commands whose argument stands on its own, so it reads as a paragraph of its own. */
const BLOCK_PROSE = new Set([
  'part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'caption', 'title', 'subtitle',
  'footnote', 'footnotetext', 'marginpar', 'thanks', 'frametitle', 'framesubtitle',
]);
/** Commands whose argument is part of the running text. */
const INLINE_PROSE = new Set([
  'emph', 'textbf', 'textit', 'textsl', 'textsc', 'textup', 'textmd', 'textrm', 'textsf', 'textnormal', 'underline', 'uline',
  'mbox', 'text', 'enquote', 'intertext', 'shortintertext',
]);
/** Commands with a prose argument after others: true marks the prose one. */
const MIXED_PROSE: Record<string, boolean[]> = {
  href: [false, true],
  textcolor: [false, true],
  colorbox: [false, true],
  hyperref: [true],
};
/** Commands whose argument is code or an address, which reads as a single word. */
const CODE_ARG = new Set(['texttt', 'url', 'path', 'nolinkurl', 'lstinline', 'mintinline', 'code']);
const NAMED: Record<string, string> = {
  LaTeX: 'LaTeX', LaTeXe: 'LaTeX', TeX: 'TeX', BibTeX: 'BibTeX', ldots: '…', dots: '…', textellipsis: '…',
  i: 'ı', j: 'ȷ', ss: 'ß', SS: 'SS', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł',
  textendash: '–', textemdash: '—', textquoteleft: '‘', textquoteright: '’', textquotedblleft: '“', textquotedblright: '”',
  item: '\n\n', par: '\n\n', newline: ' ', linebreak: ' ', quad: ' ', qquad: ' ', enspace: ' ', thinspace: ' ', textbackslash: '\\',
  textasciitilde: '~', textasciicircum: '^', textbar: '|', S: '§', P: '¶', copyright: '©', textregistered: '®', texttrademark: '™',
  euro: '€', pounds: '£', textdegree: '°',
};
const SYMBOL_ACCENTS: Record<string, string> = { "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇' };
const LETTER_ACCENTS: Record<string, string> = { c: '̧', v: '̌', u: '̆', H: '̋', k: '̨', r: '̊', d: '̣', b: '̱' };
const ESCAPED = new Set(['%', '&', '$', '#', '_', '{', '}']);
const SPECIAL = /[%\r\n\\${}~\-`'&]/g;

class Pieces {
  readonly list: Annotation[] = [];

  text(s: string): void {
    if (!s) {
      return;
    }
    const last = this.list[this.list.length - 1];
    if (last && 'text' in last) {
      last.text += s;
    } else {
      this.list.push({ text: s });
    }
  }

  markup(s: string, interpretAs = ''): void {
    if (!s) {
      return;
    }
    const last = this.list[this.list.length - 1];
    if (last && 'markup' in last) {
      last.markup += s;
      last.interpretAs = (last.interpretAs ?? '') + interpretAs;
    } else {
      this.list.push(interpretAs ? { markup: s, interpretAs } : { markup: s });
    }
  }
}

/** Where the group or optional argument opened at `open` closes, or -1. */
function matching(src: string, open: number, end: number): number {
  const [o, c] = src[open] === '[' ? ['[', ']'] : ['{', '}'];
  let depth = 0;
  for (let i = open; i < end; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '%') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 || nl >= end ? end : nl;
    } else if (ch === '{' && o === '[') {
      const close = matching(src, i, end);
      if (close < 0) {
        return -1;
      }
      i = close;
    } else if (ch === o) {
      depth++;
    } else if (ch === c && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Skips the optional and required arguments that follow `at` directly. */
function skipArgs(src: string, at: number, end: number, max = Infinity): number {
  let i = at;
  for (let n = 0; n < max && (src[i] === '{' || src[i] === '['); n++) {
    const close = matching(src, i, end);
    if (close < 0) {
      return i;
    }
    i = close + 1;
  }
  return i;
}

function skipOptional(src: string, at: number, end: number): number {
  let i = at;
  while (src[i] === '[') {
    const close = matching(src, i, end);
    if (close < 0) {
      return i;
    }
    i = close + 1;
  }
  return i;
}

/** Finds `needle` outside comments, or returns -1. */
function findOutsideComments(src: string, needle: RegExp, from: number): RegExpExecArray | null {
  const re = new RegExp(needle.source, 'g');
  re.lastIndex = from;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const lineStart = src.lastIndexOf('\n', m.index - 1) + 1;
    const lineEnd = src.indexOf('\n', m.index);
    const at = commentStart(src.substring(lineStart, lineEnd < 0 ? src.length : lineEnd));
    if (at < 0 || lineStart + at > m.index) {
      return m;
    }
  }
  return null;
}

class Annotator {
  readonly out = new Pieces();

  constructor(private readonly src: string) {}

  run(start: number, end: number): void {
    const src = this.src;
    let i = start;
    while (i < end) {
      SPECIAL.lastIndex = i;
      const m = SPECIAL.exec(src);
      const next = m && m.index < end ? m.index : end;
      this.out.text(src.substring(i, next));
      i = next;
      if (i >= end) {
        break;
      }
      i = this.special(i, end);
    }
  }

  /** Handles the character at `i`, which SPECIAL matched, and returns where to go on. */
  private special(i: number, end: number): number {
    const src = this.src;
    const ch = src[i];
    switch (ch) {
      case '%': {
        const nl = src.indexOf('\n', i);
        const stop = nl < 0 || nl > end ? end : nl;
        this.out.markup(src.substring(i, stop));
        return stop;
      }
      case '\r':
      case '\n': {
        let j = i;
        let lines = 0;
        while (j < end && /[ \t\r\n]/.test(src[j])) {
          if (src[j] === '\n') {
            lines++;
          }
          j++;
        }
        // A line break is a space in LaTeX, and a blank line ends the paragraph.
        this.out.markup(src.substring(i, j), lines >= 2 ? '\n\n' : ' ');
        return j;
      }
      case '\\':
        return this.command(i, end);
      case '$': {
        const display = src[i + 1] === '$';
        const close = this.findUnescaped(display ? '$$' : '$', i + (display ? 2 : 1), end);
        const stop = close < 0 ? end : close + (display ? 2 : 1);
        this.out.markup(src.substring(i, stop), 'X');
        return stop;
      }
      case '{':
      case '}':
        this.out.markup(ch);
        return i + 1;
      case '~':
        this.out.markup(ch, ' ');
        return i + 1;
      case '&':
        this.out.markup(ch, ' ');
        return i + 1;
      case '-': {
        const run = /^-+/.exec(src.substring(i, Math.min(end, i + 3)))![0];
        if (run.length === 1) {
          this.out.text('-');
        } else {
          this.out.markup(run, run.length === 2 ? '–' : '—');
        }
        return i + run.length;
      }
      case '`':
        if (src[i + 1] === '`') {
          this.out.markup('``', '“');
          return i + 2;
        }
        this.out.markup('`', '‘');
        return i + 1;
      case "'":
        if (src[i + 1] === "'") {
          this.out.markup("''", '”');
          return i + 2;
        }
        this.out.text("'");
        return i + 1;
      default:
        this.out.text(ch);
        return i + 1;
    }
  }

  private findUnescaped(needle: string, from: number, end: number): number {
    for (let i = from; i < end; i++) {
      if (this.src[i] === '\\') {
        i++;
      } else if (this.src.startsWith(needle, i)) {
        return i;
      }
    }
    return -1;
  }

  private command(i: number, end: number): number {
    const src = this.src;
    const next = src[i + 1];
    if (next === undefined || i + 1 >= end) {
      this.out.markup('\\');
      return i + 1;
    }
    if (!/[a-zA-Z@]/.test(next)) {
      return this.controlSymbol(i, next, end);
    }
    let j = i + 1;
    while (j < end && /[a-zA-Z@]/.test(src[j])) {
      j++;
    }
    const name = src.substring(i + 1, j);
    if (src[j] === '*') {
      j++;
    }

    if (name === 'begin' || name === 'end') {
      return this.environment(i, j, end, name === 'begin');
    }
    if (name === 'verb') {
      const delim = src[j];
      const close = delim ? src.indexOf(delim, j + 1) : -1;
      const stop = close < 0 || close >= end ? end : close + 1;
      this.out.markup(src.substring(i, stop), 'X');
      return stop;
    }
    if (CITE.test(name)) {
      const stop = skipArgs(src, j, end);
      this.out.markup(src.substring(i, stop), name === 'nocite' ? '' : '[1]');
      return stop;
    }
    if (REF.has(name)) {
      const stop = skipArgs(src, j, end);
      this.out.markup(src.substring(i, stop), '1');
      return stop;
    }
    if (CODE_ARG.has(name)) {
      const stop = skipArgs(src, j, end);
      this.out.markup(src.substring(i, stop), 'X');
      return stop;
    }
    if (name in LETTER_ACCENTS && src[j] === '{') {
      const close = matching(src, j, end);
      if (close > j) {
        const letter = src.substring(j + 1, close).replace(/^\\/, '');
        this.out.markup(src.substring(i, close + 1), (letter + LETTER_ACCENTS[name]).normalize('NFC'));
        return close + 1;
      }
    }
    if (name === 'item') {
      const stop = skipOptional(src, j, end);
      this.out.markup(src.substring(i, stop), '\n\n');
      return stop;
    }
    if (BLOCK_PROSE.has(name) || INLINE_PROSE.has(name)) {
      return this.proseArgs(i, j, end, [true], BLOCK_PROSE.has(name) ? '\n\n' : '');
    }
    if (name in MIXED_PROSE) {
      return this.proseArgs(i, j, end, MIXED_PROSE[name], '');
    }
    if (name in NAMED) {
      // `\LaTeX{}` reads the same as `\LaTeX`.
      const stop = src.startsWith('{}', j) ? j + 2 : j;
      this.out.markup(src.substring(i, stop), NAMED[name]);
      return stop;
    }
    const stop = skipArgs(src, j, end);
    this.out.markup(src.substring(i, stop));
    return stop;
  }

  private controlSymbol(i: number, next: string, end: number): number {
    const src = this.src;
    if (next === '(' || next === '[') {
      const close = this.findUnescaped(next === '(' ? '\\)' : '\\]', i + 2, end);
      const stop = close < 0 ? end : close + 2;
      this.out.markup(src.substring(i, stop), 'X');
      return stop;
    }
    if (next === '\\') {
      let stop = i + 2;
      if (src[stop] === '*') {
        stop++;
      }
      stop = skipOptional(src, stop, end);
      this.out.markup(src.substring(i, stop), ' ');
      return stop;
    }
    if (next in SYMBOL_ACCENTS) {
      let stop = i + 2;
      let letter = src[stop] ?? '';
      if (letter === '{') {
        const close = matching(src, stop, end);
        letter = close > stop ? src.substring(stop + 1, close).replace(/^\\/, '') : '';
        stop = close > stop ? close + 1 : stop;
      } else {
        stop = letter ? stop + 1 : stop;
      }
      this.out.markup(src.substring(i, stop), (letter + SYMBOL_ACCENTS[next]).normalize('NFC'));
      return stop;
    }
    if (ESCAPED.has(next)) {
      this.out.markup(src.substring(i, i + 2), next);
      return i + 2;
    }
    const spaces: Record<string, string> = { ' ': ' ', '\n': ' ', '\t': ' ', ',': ' ', ';': ' ', ':': ' ', '>': ' ' };
    this.out.markup(src.substring(i, i + 2), spaces[next] ?? '');
    return i + 2;
  }

  /** `\name[opt]{arg}...` where `prose` says which required arguments to check. */
  private proseArgs(i: number, j: number, end: number, prose: boolean[], around: string): number {
    const src = this.src;
    let at = skipOptional(src, j, end);
    this.out.markup(src.substring(i, at), around);
    for (const isProse of prose) {
      at = skipOptional(src, at, end);
      if (src[at] !== '{') {
        break;
      }
      const close = matching(src, at, end);
      if (close < 0) {
        break;
      }
      if (isProse) {
        this.out.markup('{');
        this.run(at + 1, close);
        this.out.markup('}', around);
      } else {
        this.out.markup(src.substring(at, close + 1));
      }
      at = close + 1;
    }
    return at;
  }

  private environment(i: number, j: number, end: number, begin: boolean): number {
    const src = this.src;
    if (src[j] !== '{') {
      this.out.markup(src.substring(i, j));
      return j;
    }
    const close = matching(src, j, end);
    if (close < 0) {
      this.out.markup(src.substring(i, j));
      return j;
    }
    const env = src.substring(j + 1, close).trim();
    const base = env.replace(/\*$/, '');
    let stop = close + 1;
    if (begin && (MATH_ENVS.has(base) || SKIPPED_ENVS.has(base))) {
      const endTag = findEnd(src, env, stop, end);
      stop = endTag < 0 ? end : endTag;
      this.out.markup(src.substring(i, stop), MATH_ENVS.has(base) ? 'X' : '\n\n');
      return stop;
    }
    if (begin) {
      stop = skipArgs(src, stop, end);
    }
    this.out.markup(src.substring(i, stop), '\n\n');
    return stop;
  }
}

/** Where `\end{env}` that closes an environment ends, or -1. */
function findEnd(src: string, env: string, from: number, end: number): number {
  const escaped = env.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\\\end\\s*\\{${escaped}\\}`, 'g');
  re.lastIndex = from;
  const m = re.exec(src);
  return m && m.index < end ? m.index + m[0].length : -1;
}

/**
 * Turns LaTeX source into LanguageTool's annotated text. The pieces, joined, are the source
 * exactly, so an offset LanguageTool reports is an offset into the source.
 */
export function annotateLatex(src: string): Annotation[] {
  const annotator = new Annotator(src);
  const begin = findOutsideComments(src, /\\begin\s*\{document\}/, 0);
  const start = begin ? begin.index + begin[0].length : 0;
  const finish = findOutsideComments(src, /\\end\s*\{document\}/, start);
  const stop = finish ? finish.index : src.length;
  annotator.out.markup(src.substring(0, start), begin ? '\n\n' : '');
  annotator.run(start, stop);
  annotator.out.markup(src.substring(stop));
  return annotator.out.list;
}

export interface Chunk {
  /** Offset of the chunk's first piece in the source. */
  offset: number;
  annotations: Annotation[];
}

function pieceLength(a: Annotation): number {
  return 'text' in a ? a.text.length : a.markup.length;
}

/**
 * Splits at paragraph breaks into chunks of about `size` characters of source, so a long paper
 * stays under a server's text limit.
 */
export function chunkAnnotations(annotations: Annotation[], size = 20000): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Chunk = { offset: 0, annotations: [] };
  let length = 0;
  let offset = 0;
  for (const a of annotations) {
    current.annotations.push(a);
    offset += pieceLength(a);
    length += pieceLength(a);
    if ('markup' in a && length >= size && (a.interpretAs ?? '').includes('\n\n')) {
      chunks.push(current);
      current = { offset, annotations: [] };
      length = 0;
    }
  }
  if (current.annotations.length > 0) {
    chunks.push(current);
  }
  return chunks.filter((c) => c.annotations.some((a) => 'text' in a && a.text.trim() !== ''));
}

// --- Language ----------------------------------------------------------------------------------

const BABEL_LANGUAGES: Record<string, string> = {
  english: 'en-US', american: 'en-US', usenglish: 'en-US', british: 'en-GB', ukenglish: 'en-GB', australian: 'en-AU',
  canadian: 'en-CA', newzealand: 'en-NZ', german: 'de-DE', ngerman: 'de-DE', austrian: 'de-AT', naustrian: 'de-AT',
  swissgerman: 'de-CH', nswissgerman: 'de-CH', french: 'fr', francais: 'fr', acadian: 'fr', canadien: 'fr', spanish: 'es',
  italian: 'it', portuguese: 'pt-PT', portuges: 'pt-PT', brazil: 'pt-BR', brazilian: 'pt-BR', dutch: 'nl', polish: 'pl-PL',
  russian: 'ru-RU', ukrainian: 'uk-UA', catalan: 'ca-ES', swedish: 'sv', danish: 'da-DK', greek: 'el-GR', japanese: 'ja-JP',
  chinese: 'zh-CN', irish: 'ga-IE', galician: 'gl-ES', romanian: 'ro-RO', slovak: 'sk-SK', slovene: 'sl-SI', slovenian: 'sl-SI',
  esperanto: 'eo', persian: 'fa', farsi: 'fa', breton: 'br-FR', belarusian: 'be-BY', tamil: 'ta-IN', arabic: 'ar',
  khmer: 'km-KH', asturian: 'ast-ES', turkish: 'tr',
};
const POLYGLOSSIA_VARIANTS: Record<string, Record<string, string>> = {
  english: { british: 'en-GB', uk: 'en-GB', american: 'en-US', us: 'en-US', australian: 'en-AU', canadian: 'en-CA', newzealand: 'en-NZ' },
  german: { austrian: 'de-AT', swiss: 'de-CH' },
  portuguese: { brazilian: 'pt-BR' },
};

function withoutComments(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const at = commentStart(line);
      return at < 0 ? line : line.substring(0, at);
    })
    .join('\n');
}

/**
 * The document's main language as a LanguageTool code, from polyglossia, babel or the class
 * options, or undefined when it names none. Turkish comes back as `tr`, which LanguageTool lacks.
 */
export function detectLanguage(src: string): string | undefined {
  const code = withoutComments(src);
  const poly = /\\set(?:main|default)language\s*(?:\[([^\]]*)\])?\s*\{\s*([a-zA-Z]+)\s*\}/.exec(code);
  if (poly) {
    const name = poly[2].toLowerCase();
    const variant = /variant\s*=\s*([a-zA-Z]+)/.exec(poly[1] ?? '')?.[1].toLowerCase();
    const language = (variant && POLYGLOSSIA_VARIANTS[name]?.[variant]) || BABEL_LANGUAGES[name];
    if (language) {
      return language;
    }
  }
  const options = (re: RegExp): string[] =>
    (re.exec(code)?.[1] ?? '')
      .split(',')
      .map((o) => o.trim().replace(/^main\s*=\s*/, '').toLowerCase())
      .filter((o) => o in BABEL_LANGUAGES);
  // babel's main language is its last option, unless one says `main=`.
  const babelRaw = /\\usepackage\s*\[([^\]]*)\]\s*\{babel\}/.exec(code)?.[1] ?? '';
  const main = /main\s*=\s*([a-zA-Z]+)/.exec(babelRaw)?.[1].toLowerCase();
  if (main && main in BABEL_LANGUAGES) {
    return BABEL_LANGUAGES[main];
  }
  const babel = options(/\\usepackage\s*\[([^\]]*)\]\s*\{babel\}/);
  if (babel.length > 0) {
    return BABEL_LANGUAGES[babel[babel.length - 1]];
  }
  const cls = options(/\\documentclass\s*\[([^\]]*)\]/);
  return cls.length > 0 ? BABEL_LANGUAGES[cls[cls.length - 1]] : undefined;
}

// --- LanguageTool ------------------------------------------------------------------------------

interface LanguageToolMatch {
  offset: number;
  length: number;
  message: string;
  shortMessage?: string;
  replacements?: { value: string }[];
  rule?: { id: string; issueType?: string; category?: { id?: string } };
}

/** Rules that make no sense for LaTeX source, where spacing is up to TeX. */
const ALWAYS_DISABLED = ['WHITESPACE_RULE', 'CONSECUTIVE_SPACES'];

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** Says whether a LanguageTool server answers at `baseUrl`. */
export async function probeLanguageTool(baseUrl: string, fetchFn: typeof fetch = fetch, timeoutMs = 2000): Promise<void> {
  try {
    const res = await fetchFn(endpoint(baseUrl, '/v2/languages'), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      throw new Error(String(res.status));
    }
    await res.text();
  } catch {
    throw new LanguageToolUnavailableError(baseUrl);
  }
}

export interface GrammarOptions {
  url: string;
  /** A LanguageTool code, or `auto` to take it from the document. */
  language: string;
  /** The root document's source, whose preamble names the language when `src` is a chapter file. */
  root?: string;
  disabledRules?: string[];
  /** Words not to report as misspellings. */
  dictionary?: string[];
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * The language a check of `src` uses, with Turkish refused because LanguageTool lacks it. `auto`
 * reads the file, then the root document; a document that names no language is typeset in
 * English, and is checked as American English rather than left to LanguageTool's guess, which
 * misreads short passages.
 */
export function resolveLanguage(src: string, setting: string, root?: string): string {
  const language =
    !setting || setting === 'auto' ? detectLanguage(src) ?? (root !== undefined ? detectLanguage(root) : undefined) ?? 'en-US' : setting;
  if (/^tr\b/i.test(language)) {
    throw new UnsupportedLanguageError('Turkish');
  }
  return language;
}

/** Checks LaTeX source and returns the problems, sorted by offset. */
export async function checkLatex(src: string, options: GrammarOptions): Promise<GrammarProblem[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const language = resolveLanguage(src, options.language, options.root);
  await probeLanguageTool(options.url, fetchFn);
  const disabled = [...new Set([...ALWAYS_DISABLED, ...(options.disabledRules ?? [])])];
  const dictionary = new Set(options.dictionary ?? []);
  const problems: GrammarProblem[] = [];
  for (const chunk of chunkAnnotations(annotateLatex(src))) {
    const body = new URLSearchParams({
      language,
      data: JSON.stringify({ annotation: chunk.annotations }),
      disabledRules: disabled.join(','),
    });
    let res: Response;
    try {
      res = await fetchFn(endpoint(options.url, '/v2/check'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: options.signal,
      });
    } catch (err) {
      if (options.signal?.aborted) {
        throw err;
      }
      throw new LanguageToolUnavailableError(options.url);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`LanguageTool answered ${res.status}${text.trim() ? `: ${text.trim().split('\n')[0]}` : ''}`);
    }
    const matches = (JSON.parse(text) as { matches?: LanguageToolMatch[] }).matches ?? [];
    for (const m of matches) {
      const offset = chunk.offset + m.offset;
      const misspelling = m.rule?.issueType === 'misspelling' || m.rule?.category?.id === 'TYPOS';
      if (misspelling && dictionary.has(src.substring(offset, offset + m.length))) {
        continue;
      }
      problems.push({
        offset,
        length: m.length,
        message: m.message,
        replacements: (m.replacements ?? []).slice(0, 5).map((r) => r.value),
        ruleId: m.rule?.id ?? 'UNKNOWN',
        misspelling,
      });
    }
  }
  return problems.sort((a, b) => a.offset - b.offset);
}
