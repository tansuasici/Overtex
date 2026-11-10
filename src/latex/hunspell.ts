// Spelling through a local Hunspell program, for languages LanguageTool lacks (Turkish). The
// prose comes from the same annotated text LanguageTool reads, so offsets are offsets into the
// source. Hunspell runs in pipe mode (`-a`), one word per line. No vscode import, so it is
// unit-testable.
import { spawn } from 'child_process';

import type { Annotation, GrammarProblem } from './grammar';

export const DEFAULT_HUNSPELL = 'hunspell';
export const HUNSPELL_RULE = 'HUNSPELL';

export class HunspellUnavailableError extends Error {
  constructor(readonly path: string) {
    super(`Hunspell could not be started as ${path}`);
    this.name = 'HunspellUnavailableError';
  }
}

export class HunspellDictionaryError extends Error {
  constructor(readonly dictionary: string) {
    super(`Hunspell has no dictionary named ${dictionary}`);
    this.name = 'HunspellDictionaryError';
  }
}

export interface Word {
  offset: number;
  word: string;
}

const LETTERS = /[\p{L}\p{M}]+/gu;
const APOSTROPHES = new Set(["'", '’']);

/**
 * The words of the prose, with their offsets in the source. A suffix after an apostrophe, as in
 * "Ankara'da", is left out, since the dictionary does not list it alone; so are single letters
 * and all-capital acronyms.
 */
export function proseWords(annotations: Annotation[]): Word[] {
  const words: Word[] = [];
  let offset = 0;
  for (const a of annotations) {
    if ('text' in a) {
      for (const m of a.text.matchAll(LETTERS)) {
        const at = m.index ?? 0;
        const word = m[0];
        const before = a.text[at - 1];
        const afterSuffix = before !== undefined && APOSTROPHES.has(before) && /[\p{L}\p{M}]/u.test(a.text[at - 2] ?? '');
        if (afterSuffix || word.length < 2 || (word === word.toLocaleUpperCase('tr') && word !== word.toLocaleLowerCase('tr'))) {
          continue;
        }
        words.push({ offset: offset + at, word });
      }
      offset += a.text.length;
    } else {
      offset += a.markup.length;
    }
  }
  return words;
}

export interface HunspellVerdict {
  ok: boolean;
  suggestions: string[];
}

/**
 * Reads Hunspell's pipe-mode answer to `count` lines of one word each: a banner, then for each
 * line its result lines and a blank line. `*`, `+` and `-` accept; `&` and `#` reject, `&` with
 * suggestions.
 */
export function parseHunspellOutput(out: string, count: number): HunspellVerdict[] {
  const lines = out.split(/\r?\n/);
  if (lines[0]?.startsWith('@(#)')) {
    lines.shift();
  }
  const verdicts: HunspellVerdict[] = [];
  let current: HunspellVerdict = { ok: true, suggestions: [] };
  let seen = false;
  for (const line of lines) {
    if (line === '') {
      if (seen) {
        verdicts.push(current);
        current = { ok: true, suggestions: [] };
        seen = false;
      }
      continue;
    }
    seen = true;
    if (line.startsWith('&')) {
      const colon = line.indexOf(': ');
      const suggestions = colon < 0 ? [] : line.substring(colon + 2).split(', ').filter((s) => s !== '');
      if (current.ok) {
        current = { ok: false, suggestions };
      }
    } else if (line.startsWith('#')) {
      current.ok = false;
    }
  }
  if (seen) {
    verdicts.push(current);
  }
  if (verdicts.length !== count) {
    throw new Error(`Hunspell answered ${verdicts.length} of ${count} words`);
  }
  return verdicts;
}

/** Feeds `input` to Hunspell and returns what it printed. */
export type RunHunspell = (path: string, args: string[], input: string, signal?: AbortSignal) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const runHunspell: RunHunspell = (path, args, input, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(path, args, { signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input, 'utf8');
  });

export interface HunspellOptions {
  /** The program, `hunspell` on the PATH unless set. */
  path?: string;
  /** The dictionary's name, such as `tr_TR`, or a path to its files without the extension. */
  dictionary: string;
  /** Words not to report. */
  ignore?: Set<string>;
  run?: RunHunspell;
  signal?: AbortSignal;
}

/** Checks the prose's spelling with Hunspell and returns the misspellings, sorted by offset. */
export async function checkSpellingHunspell(annotations: Annotation[], options: HunspellOptions): Promise<GrammarProblem[]> {
  const path = options.path || DEFAULT_HUNSPELL;
  const ignore = options.ignore ?? new Set<string>();
  const words = proseWords(annotations).filter((w) => !ignore.has(w.word));
  const unique = [...new Set(words.map((w) => w.word))];
  if (unique.length === 0) {
    return [];
  }
  // `^` makes each line plain text even when a word would read as a pipe-mode command.
  const input = unique.map((w) => `^${w}\n`).join('');
  let result: Awaited<ReturnType<RunHunspell>>;
  try {
    result = await (options.run ?? runHunspell)(path, ['-a', '-i', 'UTF-8', '-d', options.dictionary], input, options.signal);
  } catch (err) {
    if (options.signal?.aborted) {
      throw err;
    }
    throw new HunspellUnavailableError(path);
  }
  if (/can't open affix or dic/i.test(result.stderr) || (!result.stdout.startsWith('@(#)') && result.code !== 0)) {
    throw new HunspellDictionaryError(options.dictionary);
  }
  const verdicts = parseHunspellOutput(result.stdout, unique.length);
  const byWord = new Map(unique.map((w, i) => [w, verdicts[i]]));
  return words.flatMap((w): GrammarProblem[] => {
    const verdict = byWord.get(w.word);
    return !verdict || verdict.ok
      ? []
      : [
          {
            offset: w.offset,
            length: w.word.length,
            message: `Possible spelling mistake: '${w.word}' is not in the ${options.dictionary} dictionary.`,
            replacements: verdict.suggestions.slice(0, 5),
            ruleId: HUNSPELL_RULE,
            misspelling: true,
          },
        ];
  });
}
