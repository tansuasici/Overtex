import * as fs from 'fs';
import * as path from 'path';

export type LogSeverity = 'error' | 'warning' | 'info';

interface NamedFile {
  file: string;
  length: number;
}

export interface LogEntry {
  severity: LogSeverity;
  message: string;
  /** Absolute path of the source file, or '' when TeX did not say. */
  file: string;
  /** 1-based line number, or 0 when unknown. */
  line: number;
}

const SOURCE_EXT = /\.(tex|sty|cls|bib|bbl|ltx|dtx|def|cfg|clo)$/i;

// `./chapters/intro.tex:12: Undefined control sequence.` (produced by -file-line-error)
const FILE_LINE_ERROR = /^(.*?\.[A-Za-z]+):(\d+): (.*)$/;
const LATEX_WARNING = /^LaTeX(?: Font)? Warning: (.*)$/;
const PACKAGE_WARNING = /^Package (\S+) Warning: (.*)$/;
const CLASS_WARNING = /^Class (\S+) Warning: (.*)$/;
const ON_INPUT_LINE = /\s*on input line (\d+)\.?$/;
const BOX_WARNING = /^((?:Over|Under)full \\[hv]box .*?) (?:in paragraph |detected )?at lines? (\d+)/;

/**
 * Parses a TeX log into diagnostics. Expects a log produced with
 * `-file-line-error` and `max_print_line` raised so lines are not wrapped,
 * but also understands the classic `! message` / `l.N` error format.
 */
export function parseLog(content: string, rootDir: string): LogEntry[] {
  return parseLines(content.split(/\r?\n/), rootDir, fileNamedAt);
}

/**
 * Tectonic ignores `max_print_line` and has no `-file-line-error`, so its log wraps at 79 columns
 * and names files as the document wrote them: `\input{sub dir/two}` logs `(sub dir/two`, which
 * only the disk can tell apart from text in parentheses.
 */
export function parseTectonicLog(content: string, rootDir: string, isFile: (file: string) => boolean = isRegularFile): LogEntry[] {
  const lines = unwrapTectonicLog(content).map((line) => line.replace(/^! ! (.*?)\.*$/, '! $1.'));
  const fileAt = (text: string): NamedFile | undefined => {
    const upToParen = text.match(/^[^()]+/)?.[0].trimEnd() ?? '';
    for (const name of [upToParen, upToParen.split(/\s/)[0]]) {
      for (const file of [name, `${name}.tex`]) {
        if (name && isFile(path.resolve(rootDir, file))) {
          return { file, length: name.length };
        }
      }
    }
    return fileNamedAt(text);
  };
  return parseLines(lines, rootDir, fileAt);
}

const TECTONIC_LOG_WIDTH = 79;
// Lines TeX starts anew, which must survive a line before them that happens to fill the width.
const STARTS_LOG_ENTRY = /^$|^! |^(LaTeX|Package|Class) |^(Over|Under)full /;

function unwrapTectonicLog(content: string): string[] {
  const lines: string[] = [];
  let wrapped = false;
  for (const line of content.split(/\r?\n/)) {
    if (wrapped && !STARTS_LOG_ENTRY.test(line)) {
      lines[lines.length - 1] += line;
    } else {
      lines.push(line);
    }
    wrapped = line.length === TECTONIC_LOG_WIDTH;
  }
  return lines;
}

function isRegularFile(file: string): boolean {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}

function parseLines(lines: string[], rootDir: string, fileAt: (text: string) => NamedFile | undefined): LogEntry[] {
  const entries: LogEntry[] = [];
  const fileStack: string[] = [];
  const resolve = (file: string) => (file ? path.resolve(rootDir, file) : '');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const currentFile = fileStack.findLast((f) => f !== '') ?? '';

    const fileLine = line.match(FILE_LINE_ERROR);
    if (fileLine && SOURCE_EXT.test(fileLine[1])) {
      entries.push({
        severity: 'error',
        message: withContinuation(fileLine[3], lines, i),
        file: resolve(fileLine[1]),
        line: parseInt(fileLine[2], 10),
      });
      continue;
    }

    if (line.startsWith('! ')) {
      let errorLine = 0;
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const m = lines[j].match(/^l\.(\d+)/);
        if (m) {
          errorLine = parseInt(m[1], 10);
          break;
        }
      }
      entries.push({
        severity: 'error',
        message: line.substring(2).trim(),
        file: resolve(currentFile),
        line: errorLine,
      });
      continue;
    }

    const warning = matchWarning(line);
    if (warning) {
      const full = withContinuation(warning, lines, i);
      const lineMatch = full.match(ON_INPUT_LINE);
      entries.push({
        severity: 'warning',
        message: full.replace(ON_INPUT_LINE, '').trim(),
        file: resolve(currentFile),
        line: lineMatch ? parseInt(lineMatch[1], 10) : 0,
      });
      continue;
    }

    const box = line.match(BOX_WARNING);
    if (box) {
      entries.push({
        severity: 'info',
        message: box[1],
        file: resolve(currentFile),
        line: parseInt(box[2], 10),
      });
      continue;
    }

    updateFileStack(line, fileStack, fileAt);
  }

  return entries;
}

function matchWarning(line: string): string | null {
  let m = line.match(LATEX_WARNING);
  if (m) {
    return m[1];
  }
  m = line.match(PACKAGE_WARNING) ?? line.match(CLASS_WARNING);
  if (m) {
    return `[${m[1]}] ${m[2]}`;
  }
  return null;
}

/**
 * Package warnings continue on lines indented to the package name, e.g.
 * `(hyperref)                removing `math shift' on input line 3.`
 */
function withContinuation(first: string, lines: string[], index: number): string {
  let message = first;
  for (let j = index + 1; j < lines.length; j++) {
    const m = lines[j].match(/^\([^)]*\)\s+(.*)$/);
    if (!m) {
      break;
    }
    message += ' ' + m[1].trim();
  }
  return message;
}

/** The file named at the start of `text`, which follows a `(` in the log, and how much of `text` names it. */
function fileNamedAt(text: string): NamedFile | undefined {
  const m = text.match(/^"?([^\s()"]+)"?/);
  return m && SOURCE_EXT.test(m[1]) ? { file: m[1], length: m[0].length } : undefined;
}

/** Tracks which file TeX is reading from the `(file` / `)` markers in the log. */
function updateFileStack(line: string, stack: string[], fileAt: (text: string) => NamedFile | undefined): void {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '(') {
      const named = fileAt(line.substring(i + 1));
      if (named) {
        stack.push(named.file);
        i += named.length;
      } else {
        // Keep parentheses balanced for non-file groups such as "(see the transcript file)".
        stack.push('');
      }
    } else if (ch === ')' && stack.length > 0) {
      stack.pop();
    }
  }
}
