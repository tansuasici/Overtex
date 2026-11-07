// Finding math in LaTeX sources, and the macro definitions it may use. No vscode import, so it is
// unit-testable.
import { commentStart } from './arxiv';

export interface MathSpan {
  /** Offsets of the whole span, delimiters included; end exclusive. */
  start: number;
  end: number;
  /** What to render: the content of $…$, \(…\), \[…\] and $$…$$, or the whole environment. */
  tex: string;
  display: boolean;
}

// Environments MathJax renders itself, \begin and \end included.
const RENDERED_ENVS = ['equation', 'align', 'gather', 'multline', 'flalign', 'alignat', 'eqnarray'];
// Environments whose content is passed on without the \begin/\end.
const CONTENT_ENVS = ['math', 'displaymath'];
const VERBATIM_ENVS = ['verbatim', 'Verbatim', 'lstlisting', 'minted', 'comment'];
const ENV = /^\\begin\s*\{([a-zA-Z]+\*?)\}/;

/** Longest span looked at, so a stray $ does not make one span of the rest of the file. */
const MAX_SPAN = 20000;

/** All math spans in `text`, in order. Comments and verbatim environments are skipped. */
export function findMathSpans(text: string): MathSpan[] {
  const code = blankComments(text);
  const spans: MathSpan[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') {
      const next = code[i + 1];
      if (next === '(' || next === '[') {
        const close = next === '(' ? '\\)' : '\\]';
        const end = code.indexOf(close, i + 2);
        if (end >= 0 && end - i <= MAX_SPAN) {
          spans.push({ start: i, end: end + 2, tex: code.substring(i + 2, end).trim(), display: next === '[' });
          i = end + 2;
          continue;
        }
      }
      const verb = /^\\verb\*?([^a-zA-Z\s*])/.exec(code.substring(i, i + 8));
      if (verb) {
        const close = code.indexOf(verb[1], i + verb[0].length);
        const eol = code.indexOf('\n', i);
        i = close < 0 || (eol >= 0 && close > eol) ? i + verb[0].length : close + 1;
        continue;
      }
      const env = ENV.exec(code.substring(i, i + 40));
      if (env) {
        const name = env[1];
        const base = name.replace(/\*$/, '');
        const close = code.indexOf(`\\end{${name}}`, i + env[0].length);
        if (VERBATIM_ENVS.includes(base)) {
          i = close < 0 ? code.length : close + name.length + 6;
          continue;
        }
        if (close >= 0 && close - i <= MAX_SPAN && (RENDERED_ENVS.includes(base) || CONTENT_ENVS.includes(base))) {
          const end = close + name.length + 6;
          const tex = RENDERED_ENVS.includes(base) ? code.substring(i, end) : code.substring(i + env[0].length, close).trim();
          spans.push({ start: i, end, tex, display: name !== 'math' });
          i = end;
          continue;
        }
      }
      i += 2; // \$, \\ and every other escape
      continue;
    }
    if (ch === '$') {
      const display = code[i + 1] === '$';
      const open = display ? 2 : 1;
      const end = closingDollar(code, i + open, display);
      if (end >= 0) {
        spans.push({ start: i, end: end + open, tex: code.substring(i + open, end).trim(), display });
        i = end + open;
        continue;
      }
      i += open;
      continue;
    }
    i++;
  }
  return spans.filter((s) => s.tex !== '');
}

/** The math span that contains `offset`, if any. */
export function mathAt(spans: MathSpan[], offset: number): MathSpan | undefined {
  return spans.find((s) => offset >= s.start && offset < s.end);
}

/** Where the closing $ (or $$) is, or -1. Inline math does not cross a blank line. */
function closingDollar(code: string, from: number, display: boolean): number {
  const limit = Math.min(code.length, from + MAX_SPAN);
  for (let j = from; j < limit; j++) {
    const ch = code[j];
    if (ch === '\\') {
      j++;
    } else if (ch === '$') {
      if (!display) {
        return j;
      }
      if (code[j + 1] === '$') {
        return j;
      }
    } else if (!display && ch === '\n' && /^\n[ \t]*\n/.test(code.substring(j, j + 80))) {
      return -1;
    }
  }
  return -1;
}

/** `text` with every comment replaced by spaces, so offsets stay the same. */
function blankComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const at = commentStart(line);
      return at < 0 ? line : line.substring(0, at) + ' '.repeat(line.length - at);
    })
    .join('\n');
}

/**
 * Macro definitions in `text` that MathJax can use: \newcommand, \renewcommand, \providecommand,
 * \DeclareMathOperator and \def, each as a separate string, in order.
 */
export function collectMacros(text: string): string[] {
  const code = blankComments(text);
  const found: string[] = [];
  const head = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def)\b\*?/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(code)) !== null) {
    const def = m[1] === 'def' ? readDef(code, head.lastIndex) : readCommand(code, head.lastIndex, m[1] === 'DeclareMathOperator');
    if (def) {
      const cmd = m[1] === 'providecommand' ? 'newcommand' : m[1] === 'def' ? 'def' : m[0].substring(1);
      found.push(`\\${cmd}${def.text}`);
      head.lastIndex = def.end;
    }
  }
  return found;
}

/** {\name} or \name, then [n][default] for \newcommand, then the {body}. */
function readCommand(code: string, pos: number, operator: boolean): { text: string; end: number } | null {
  let i = skipSpace(code, pos);
  let name: string;
  if (code[i] === '{') {
    const close = groupEnd(code, i);
    if (close < 0) {
      return null;
    }
    name = code.substring(i + 1, close).trim();
    i = close + 1;
  } else {
    const n = /^\\(?:[a-zA-Z@]+|.)/.exec(code.substring(i));
    if (!n) {
      return null;
    }
    name = n[0];
    i += n[0].length;
  }
  if (!/^\\(?:[a-zA-Z]+|[^a-zA-Z@])$/.test(name)) {
    return null; // \makeatletter names and other things MathJax cannot define
  }
  let args = '';
  if (!operator) {
    for (let k = 0; k < 2; k++) {
      i = skipSpace(code, i);
      if (code[i] !== '[') {
        break;
      }
      const close = code.indexOf(']', i);
      if (close < 0) {
        return null;
      }
      args += code.substring(i, close + 1);
      i = close + 1;
    }
  }
  i = skipSpace(code, i);
  if (code[i] !== '{') {
    return null;
  }
  const close = groupEnd(code, i);
  if (close < 0) {
    return null;
  }
  return { text: `{${name}}${args}${code.substring(i, close + 1)}`, end: close + 1 };
}

/** \def\name#1#2{body}. */
function readDef(code: string, pos: number): { text: string; end: number } | null {
  const m = /^\s*(\\[a-zA-Z]+)((?:#[1-9])*)\s*\{/.exec(code.substring(pos));
  if (!m) {
    return null;
  }
  const open = pos + m[0].length - 1;
  const close = groupEnd(code, open);
  if (close < 0) {
    return null;
  }
  return { text: `${m[1]}${m[2]}${code.substring(open, close + 1)}`, end: close + 1 };
}

function skipSpace(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i])) {
    i++;
  }
  return i;
}

/** Index of the } that closes the { at `open`, or -1. */
function groupEnd(code: string, open: number): number {
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    const ch = code[j];
    if (ch === '\\') {
      j++;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return j;
    }
  }
  return -1;
}
