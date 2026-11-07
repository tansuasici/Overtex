// Ranges the editor highlights in LaTeX sources. No vscode import, so it is unit-testable.
import { commentStart } from './arxiv';

/** Zero-based, end exclusive. */
export interface TextRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export interface Highlights {
  /** TODO/FIXME/XXX notes in comments and \todo{…}-style commands. */
  todos: TextRange[];
  /** Text TeX never typesets: \iffalse … \fi and comment environments. */
  inactive: TextRange[];
}

const TODO_WORD = /\b(?:TODO|FIXME|XXX)\b/;
const TODO_COMMAND = /\\(?:todo|fixme|TODO|FIXME)\b\*?/g;
const COMMENT_ENVS = 'comment|commentblock';
const BEGIN_COMMENT = new RegExp(`\\\\begin\\s*\\{(${COMMENT_ENVS})\\}`);
const IF_OR_FI = /\\(iffalse|if[a-zA-Z@]*|fi)(?![a-zA-Z@])/g;

export function findHighlights(text: string): Highlights {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const todos: TextRange[] = [];
  const inactive: TextRange[] = [];

  let block: { startLine: number; startChar: number; env?: string; depth: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = commentStart(line);
    const code = at < 0 ? line : line.substring(0, at);

    // Inside an inactive block: look only for its end.
    let from = 0;
    if (block) {
      const end = blockEnd(code, block);
      if (end < 0) {
        continue;
      }
      inactive.push({ startLine: block.startLine, startChar: block.startChar, endLine: i, endChar: end });
      block = null;
      from = end;
    }

    // TODO notes, before any block that starts later on this line.
    const start = blockStart(code, from);
    const todoEnd = start ? start.char : code.length;
    for (const m of code.substring(0, todoEnd).matchAll(TODO_COMMAND)) {
      const s = m.index!;
      if (s < from) {
        continue;
      }
      todos.push({ startLine: i, startChar: s, endLine: i, endChar: Math.min(argumentEnd(code, s + m[0].length), todoEnd) });
    }
    if (!start && at >= 0) {
      const w = TODO_WORD.exec(line.substring(at + 1));
      if (w) {
        todos.push({ startLine: i, startChar: at + 1 + w.index, endLine: i, endChar: line.length });
      }
    }

    if (start) {
      block = { startLine: i, startChar: start.char, env: start.env, depth: 0 };
      // The block may also close on the line it opens.
      const end = blockEnd(code.substring(start.after), block);
      if (end >= 0) {
        inactive.push({ startLine: i, startChar: start.char, endLine: i, endChar: start.after + end });
        block = null;
      }
    }
  }

  if (block) {
    const last = lines.length - 1;
    inactive.push({ startLine: block.startLine, startChar: block.startChar, endLine: last, endChar: lines[last].length });
  }
  return { todos, inactive };
}

/** The first \iffalse or \begin{comment} at or after `from`. */
function blockStart(code: string, from: number): { char: number; after: number; env?: string } | null {
  const rest = code.substring(from);
  const iff = /\\iffalse(?![a-zA-Z@])/.exec(rest);
  const env = BEGIN_COMMENT.exec(rest);
  if (iff && (!env || iff.index < env.index)) {
    return { char: from + iff.index, after: from + iff.index + iff[0].length };
  }
  if (env) {
    return { char: from + env.index, after: from + env.index + env[0].length, env: env[1] };
  }
  return null;
}

/** End column (after the closing token) of the block on this line, or -1. Tracks nested \if…\fi. */
function blockEnd(code: string, block: { env?: string; depth: number }): number {
  if (block.env) {
    const m = new RegExp(`\\\\end\\s*\\{${block.env}\\}`).exec(code);
    return m ? m.index + m[0].length : -1;
  }
  IF_OR_FI.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IF_OR_FI.exec(code)) !== null) {
    if (m[1] === 'fi') {
      if (block.depth === 0) {
        return m.index + m[0].length;
      }
      block.depth--;
    } else {
      block.depth++;
    }
  }
  return -1;
}

/** End of the optional [..] and {..} arguments that follow a command, on the same line. */
function argumentEnd(code: string, pos: number): number {
  let i = pos;
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    let j = i;
    while (code[j] === ' ') {
      j++;
    }
    if (code[j] !== open) {
      continue;
    }
    let depth = 0;
    for (; j < code.length; j++) {
      if (code[j] === '\\') {
        j++;
      } else if (code[j] === open) {
        depth++;
      } else if (code[j] === close && --depth === 0) {
        break;
      }
    }
    i = Math.min(j + 1, code.length);
  }
  return i;
}
