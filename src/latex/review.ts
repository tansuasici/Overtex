// Builds a copy of the document to send to reviewers: line numbers, open PDF notes in the margin
// and, optionally, the changes since an earlier version. No vscode import, so it is unit-testable.
import * as fs from 'fs';
import * as path from 'path';

import { BuildSettings } from './builder';
import { CompareError, Version, buildCopy, compareVersions } from './latexdiff';

/** An open PDF note, placed on the source line SyncTeX found for it. */
export interface PlacedNote {
  id: string;
  text: string;
  /** The source file, as a real path. */
  file: string;
  /** 1-based. */
  line: number;
}

export interface ReviewRequest {
  mainFile: string;
  lineNumbers: boolean;
  notes: PlacedNote[];
  /** Mark up the changes since this version; unset for none. */
  since?: Version;
  latexdiff: string;
  build: BuildSettings;
  signal?: AbortSignal;
  log?: (text: string) => void;
}

export type ReviewResult =
  | { status: 'identical' }
  /** `placed` counts the notes that reached the margin; `complete` is false when TeX reported errors. */
  | { status: 'built'; pdf: string; complete: boolean; placed: number };

const MARKER = 'OVERTEX-NOTE:';
/**
 * latexdiff keeps a comment from the new version as is, or in a changed passage as `%DIF > ` at the
 * end of a line of marked-up text. Either way it is a comment running to the end of its line.
 */
const MARKER_COMMENT = /(^|[^\\])%(?:DIF > )?OVERTEX-NOTE:([\w-]+)[ \t]*(\r?)$/gm;
const INPUT = /\\(input|include)\s*\{([^}]+)\}/g;
const MAX_INPUT_DEPTH = 10;
const SUFFIX = '-review';

/** The line without its comment; a `%` after a backslash is text. */
function code(line: string): string {
  const match = /(^|[^\\])(\\\\)*%/.exec(line);
  return match ? line.slice(0, match.index + match[0].length - 1) : line;
}

/** Environments whose rows take no text between them: a margin note there is a TeX error. */
const ALIGNMENT = /\\(begin|end)\s*\{(?:tabular\*?|tabularx|tabulary|longtable\*?|supertabular\*?|array|tabu|longtabu|NiceTabular\*?|NiceArray|tblr|longtblr|talltblr)\}/g;

/**
 * The 0-based line to put a note marker above: the note's own line or, inside a table, the line
 * where the outermost table begins.
 */
function markerLine(lines: readonly string[], line: number): number {
  const target = Math.min(Math.max(line, 1), lines.length) - 1;
  let depth = 0;
  let start = target;
  for (let i = 0; i < target; i++) {
    for (const match of code(lines[i]).matchAll(ALIGNMENT)) {
      if (match[1] === 'begin') {
        if (depth++ === 0) {
          start = i;
        }
      } else if (depth > 0) {
        depth--;
      }
    }
  }
  return depth > 0 ? start : target;
}

/**
 * Puts a `%OVERTEX-NOTE:<id>` line above each note's line, or above the table the line is in,
 * keeping the file's line endings.
 */
export function insertNoteMarkers(text: string, notes: readonly { id: string; line: number }[]): string {
  const lines = text.split('\n');
  const eol = text.includes('\r\n') ? '\r' : '';
  const placed = notes.map((note) => ({ id: note.id, at: markerLine(lines, note.line) }));
  // From the bottom up, so that a marker does not move the lines of the notes above it.
  placed.sort((a, b) => b.at - a.at);
  for (const note of placed) {
    lines.splice(note.at, 0, `%${MARKER}${note.id}${eol}`);
  }
  return lines.join('\n');
}

/** Note text as LaTeX text: special characters escaped, lines joined. */
export function escapeLatex(text: string): string {
  const special: Record<string, string> = {
    '\\': '\\textbackslash{}',
    '{': '\\{',
    '}': '\\}',
    $: '\\$',
    '&': '\\&',
    '#': '\\#',
    '%': '\\%',
    _: '\\_',
    '^': '\\textasciicircum{}',
    '~': '\\textasciitilde{}',
  };
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\{}$&#%_^~]/g, (c) => special[c]);
}

/** Turns the markers into margin notes. Returns the text and the ids of the notes it placed. */
export function replaceNoteMarkers(text: string, notes: ReadonlyMap<string, string>): { text: string; placed: Set<string> } {
  const placed = new Set<string>();
  const out = text.replace(MARKER_COMMENT, (marker, before: string, id: string, eol: string) => {
    const note = notes.get(id);
    if (note === undefined || placed.has(id)) {
      return marker;
    }
    placed.add(id);
    return `${before}\\marginnote{\\footnotesize\\raggedright ${escapeLatex(note)}}%${eol}`;
  });
  return { text: out, placed };
}

/** Whether the preamble loads `name` with \usepackage or \RequirePackage. */
export function loadsPackage(preamble: string, name: string): boolean {
  const uncommented = preamble.split('\n').map(code).join('\n');
  const use = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  for (const match of uncommented.matchAll(use)) {
    if (match[1].split(',').some((p) => p.trim() === name)) {
      return true;
    }
  }
  return false;
}

/** Where the first \begin{document} outside a comment starts, or -1. */
export function documentStart(text: string): number {
  let offset = 0;
  for (const line of text.split('\n')) {
    const at = code(line).indexOf('\\begin{document}');
    if (at >= 0) {
      return offset + at;
    }
    offset += line.length + 1;
  }
  return -1;
}

/**
 * Adds what line numbers and margin notes need just before \begin{document}. A package the document
 * already loads is not loaded again, since different options would be an option clash.
 */
export function injectPreamble(text: string, options: { lineNumbers: boolean; notes: boolean }): string {
  const start = documentStart(text);
  if (start < 0) {
    throw new CompareError('build-failed', 'the document has no \\begin{document}.');
  }
  const preamble = text.slice(0, start);
  const lines: string[] = [];
  if (options.lineNumbers) {
    if (!loadsPackage(preamble, 'lineno')) {
      lines.push('\\usepackage[mathlines]{lineno}');
    }
    lines.push('\\linenumbers');
  }
  if (options.notes && !loadsPackage(preamble, 'marginnote')) {
    lines.push('\\usepackage{marginnote}');
  }
  if (!lines.length) {
    return text;
  }
  const block = `% Added by Overtex for the review copy\n${lines.join('\n')}\n`;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  return text.slice(0, lineStart) + block + text.slice(lineStart);
}

/**
 * Pastes \input and \include files into the main file, so that a copy built elsewhere still has the
 * notes placed in them. Names are resolved from the main file's folder, as TeX does when it runs
 * there; a file that is not found is left to TeX. `read` returns undefined for a missing file.
 */
export function flattenInputs(mainFile: string, read: (file: string) => string | undefined): string {
  const dir = path.dirname(mainFile);
  const expand = (text: string, depth: number): string =>
    text
      .split('\n')
      .map((line) => {
        const body = code(line);
        if (depth >= MAX_INPUT_DEPTH || !INPUT.test(body)) {
          return line;
        }
        INPUT.lastIndex = 0;
        const replaced = body.replace(INPUT, (command, kind: string, name: string) => {
          const trimmed = name.trim();
          const file = path.resolve(dir, path.extname(trimmed) ? trimmed : `${trimmed}.tex`);
          const content = read(file);
          if (content === undefined) {
            return command;
          }
          const inner = expand(content, depth + 1);
          return kind === 'include' ? `\\clearpage\n${inner}\n\\clearpage ` : `${inner}\n`;
        });
        return replaced + line.slice(body.length);
      })
      .join('\n');
  const main = read(mainFile);
  if (main === undefined) {
    throw new CompareError('build-failed', `could not read ${path.basename(mainFile)}.`);
  }
  return expand(main, 0);
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** Builds `<main>-review.pdf` beside the build output. */
export async function exportReview(request: ReviewRequest): Promise<ReviewResult> {
  const byFile = new Map<string, PlacedNote[]>();
  for (const note of request.notes) {
    const file = realpath(note.file);
    byFile.set(file, [...(byFile.get(file) ?? []), note]);
  }
  const texts = new Map(request.notes.map((n) => [n.id, n.text]));
  const mark = (file: string, data: Buffer): Buffer => {
    const notes = byFile.get(realpath(file));
    return notes ? Buffer.from(insertNoteMarkers(data.toString('utf-8'), notes), 'utf-8') : data;
  };

  let placed = 0;
  const finish = (text: string): string => {
    // A margin note in the preamble would be a TeX error, so markers there stay comments.
    const start = Math.max(documentStart(text), 0);
    const result = replaceNoteMarkers(text.slice(start), texts);
    placed = result.placed.size;
    return injectPreamble(text.slice(0, start) + result.text, { lineNumbers: request.lineNumbers, notes: placed > 0 });
  };

  if (request.since) {
    const result = await compareVersions({
      mainFile: request.mainFile,
      old: request.since,
      new: { file: request.mainFile },
      latexdiff: request.latexdiff,
      build: request.build,
      signal: request.signal,
      log: request.log,
      editNew: mark,
      transformDiff: finish,
      suffix: SUFFIX,
    });
    return result.status === 'identical' ? result : { status: 'built', pdf: result.pdf, complete: result.complete, placed };
  }

  const read = (file: string): string | undefined => {
    try {
      return mark(file, fs.readFileSync(file)).toString('utf-8');
    } catch {
      return undefined;
    }
  };
  const tex = finish(flattenInputs(request.mainFile, read));
  const built = await buildCopy({ ...request, suffix: SUFFIX }, Buffer.from(tex, 'utf-8'), path.dirname(request.mainFile));
  return { status: 'built', ...built, placed };
}
