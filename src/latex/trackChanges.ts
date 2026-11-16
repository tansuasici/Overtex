// Track changes: what changed in a file since a baseline copy, as hunks of whole lines with the
// words that changed inside them, and what accepting or rejecting a hunk does to either side.
// No vscode import, so it is unit-testable.

/** Above this many differing lines or words, a diff gives up and calls it one change. */
const MAX_EDITS = 4000;

export type Op = 'equal' | 'insert' | 'delete';

/** A run of tokens: `a` indexes the old sequence, `b` the new one. */
export interface Edit {
  op: Op;
  aStart: number;
  bStart: number;
  length: number;
}

/**
 * The shortest edit script from `a` to `b` (Myers), with the common start and end trimmed first.
 * Runs of the same operation are merged.
 */
export function diff<T>(a: readonly T[], b: readonly T[]): Edit[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    pre++;
  }
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
    suf++;
  }
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  const steps: Op[] = middle(
    (i) => a[pre + i],
    (j) => b[pre + j],
    n,
    m
  );

  const edits: Edit[] = [];
  const push = (op: Op, aStart: number, bStart: number, length: number) => {
    if (!length) {
      return;
    }
    const last = edits[edits.length - 1];
    if (last && last.op === op && last.aStart + (op === 'insert' ? 0 : last.length) === aStart && last.bStart + (op === 'delete' ? 0 : last.length) === bStart) {
      last.length += length;
    } else {
      edits.push({ op, aStart, bStart, length });
    }
  };
  push('equal', 0, 0, pre);
  let i = pre;
  let j = pre;
  for (const op of steps) {
    push(op, i, j, 1);
    if (op !== 'insert') {
      i++;
    }
    if (op !== 'delete') {
      j++;
    }
  }
  push('equal', i, j, suf);
  return edits;
}

/** The steps from x[0..n) to y[0..m); deletes come before inserts where both are needed. */
function middle<T>(x: (i: number) => T, y: (j: number) => T, n: number, m: number): Op[] {
  if (!n || !m) {
    return [...Array<Op>(n).fill('delete'), ...Array<Op>(m).fill('insert')];
  }
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let px = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let py = px - k;
      while (px < n && py < m && x(px) === y(py)) {
        px++;
        py++;
      }
      v[offset + k] = px;
      if (px >= n && py >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) {
      break;
    }
  }
  if (found < 0) {
    // Too different to be worth the time: everything old goes, everything new comes.
    return [...Array<Op>(n).fill('delete'), ...Array<Op>(m).fill('insert')];
  }

  // Walk back through the frontiers saved before each round.
  const steps: Op[] = [];
  let px = n;
  let py = m;
  for (let d = found; d >= 0; d--) {
    const prev = trace[d];
    const k = px - py;
    const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (px > prevX && py > prevY && px > 0 && py > 0) {
      steps.push('equal');
      px--;
      py--;
    }
    if (d > 0) {
      if (px === prevX) {
        steps.push('insert');
        py--;
      } else {
        steps.push('delete');
        px--;
      }
    }
  }
  return steps.reverse();
}

/** Splits text into lines that keep their line break, so joining them gives the text back. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** A changed run of lines: old lines [oldStart, oldStart + oldText lines) became the new ones. */
export interface Hunk {
  /** First line in the baseline, 0-based. */
  oldStart: number;
  /** First line in the current text, 0-based. For a deletion, the line the removed lines stood before. */
  newStart: number;
  oldLines: string[];
  newLines: string[];
}

export function hunkText(lines: string[]): string {
  return lines.join('');
}

/** The changed runs of lines from `baseline` to `current`, in order. */
export function hunks(baseline: string, current: string): Hunk[] {
  const a = splitLines(baseline);
  const b = splitLines(current);
  const out: Hunk[] = [];
  let cur: Hunk | undefined;
  for (const e of diff(a, b)) {
    if (e.op === 'equal') {
      cur = undefined;
      continue;
    }
    if (!cur) {
      cur = { oldStart: e.aStart, newStart: e.bStart, oldLines: [], newLines: [] };
      out.push(cur);
    }
    if (e.op === 'delete') {
      cur.oldLines.push(...a.slice(e.aStart, e.aStart + e.length));
    } else {
      cur.newLines.push(...b.slice(e.bStart, e.bStart + e.length));
    }
  }
  return out;
}

/** Character offsets of the start of each line in `text`, with one more for its end. */
function lineOffsets(lines: string[]): number[] {
  const offsets = [0];
  for (const l of lines) {
    offsets.push(offsets[offsets.length - 1] + l.length);
  }
  return offsets;
}

/** Where a hunk sits in the current text, as character offsets. */
export function hunkRange(current: string, hunk: Hunk): { start: number; end: number } {
  const offsets = lineOffsets(splitLines(current));
  const start = offsets[Math.min(hunk.newStart, offsets.length - 1)];
  return { start, end: start + hunkText(hunk.newLines).length };
}

/** The baseline after accepting `hunk`: its old lines are replaced by the new ones. */
export function acceptHunk(baseline: string, hunk: Hunk): string {
  const lines = splitLines(baseline);
  return replaceLines(lines, hunk.oldStart, hunk.oldLines.length, hunk.newLines);
}

/** The current text after rejecting `hunk`: its new lines are replaced by the old ones. */
export function rejectHunk(current: string, hunk: Hunk): string {
  const lines = splitLines(current);
  return replaceLines(lines, hunk.newStart, hunk.newLines.length, hunk.oldLines);
}

function replaceLines(lines: string[], start: number, count: number, insert: string[]): string {
  return [...lines.slice(0, start), ...insert, ...lines.slice(start + count)].join('');
}

/** A hunk's identity, to check that a command still acts on the change it was offered for. */
export function hunkKey(hunk: Hunk): string {
  return `${hunk.oldStart}:${hunk.newStart}:${hunkText(hunk.oldLines)}\u0000${hunkText(hunk.newLines)}`;
}

/** Words, runs of white space and single other characters: what the word-level marks work on. */
export function tokenize(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

export interface WordChanges {
  /** Ranges of the new text that were inserted, as offsets into it. */
  inserted: { start: number; end: number }[];
  /** Old text that was removed, with the offset in the new text where it stood. */
  deleted: { at: number; text: string }[];
}

/** What changed inside a hunk, word by word. */
export function wordChanges(oldText: string, newText: string): WordChanges {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const aOff = lineOffsets(a);
  const bOff = lineOffsets(b);
  const result: WordChanges = { inserted: [], deleted: [] };
  for (const e of diff(a, b)) {
    if (e.op === 'insert') {
      result.inserted.push({ start: bOff[e.bStart], end: bOff[e.bStart + e.length] });
    } else if (e.op === 'delete') {
      result.deleted.push({ at: bOff[e.bStart], text: oldText.slice(aOff[e.aStart], aOff[e.aStart + e.length]) });
    }
  }
  return result;
}
