/** How long a build may print nothing before Overtex stops it, unless overtex.build.stallTimeout says otherwise. */
export const DEFAULT_STALL_TIMEOUT_SECONDS = 300;

export interface LoopLimits {
  /** Lines in a row that repeat the same short block. */
  lines: number;
  /** How long the repetition must last, so a burst of identical warnings does not count. */
  ms: number;
}

export const DEFAULT_LOOP_LIMITS: LoopLimits = { lines: 200, ms: 10_000 };

/** Repeating blocks up to this many lines long count as a loop: a warning and its context line, say. */
const MAX_PERIOD = 8;
/** A line longer than this is cut, so output without newlines cannot grow the buffer without end. */
const MAX_LINE = 10_000;

/**
 * Watches build output for a loop: the same line, or the same short block of lines, printed over and
 * over for a while. Blank lines are ignored. Output arrives in chunks that may split lines anywhere.
 */
export class LoopWatch {
  private carry = '';
  private readonly recent: string[] = [];
  /** For each period p, how many lines in a row equalled the line p before them, and since when. */
  private readonly runs = new Array<number>(MAX_PERIOD + 1).fill(0);
  private readonly runStart = new Array<number>(MAX_PERIOD + 1).fill(0);

  constructor(private readonly limits: LoopLimits = DEFAULT_LOOP_LIMITS) {}

  /** Feeds a chunk of output; returns the repeating line once the output looks stuck in a loop. */
  feed(text: string, now: number): string | undefined {
    const parts = (this.carry + text).split(/\r?\n/);
    this.carry = parts.pop()!.slice(-MAX_LINE);
    for (const part of parts) {
      const repeated = this.line(part.trimEnd().slice(0, MAX_LINE), now);
      if (repeated !== undefined) {
        return repeated;
      }
    }
    return undefined;
  }

  private line(line: string, now: number): string | undefined {
    if (!line.trim()) {
      return undefined;
    }
    let found: string | undefined;
    for (let p = 1; p <= MAX_PERIOD; p++) {
      if (this.recent.length >= p && this.recent[this.recent.length - p] === line) {
        if (this.runs[p] === 0) {
          this.runStart[p] = now;
        }
        this.runs[p]++;
        if (found === undefined && this.runs[p] >= this.limits.lines && now - this.runStart[p] >= this.limits.ms) {
          found = line;
        }
      } else {
        this.runs[p] = 0;
      }
    }
    this.recent.push(line);
    if (this.recent.length > MAX_PERIOD) {
      this.recent.shift();
    }
    return found;
  }
}

export function silenceMessage(seconds: number): string {
  return `Stopped the build: no output for ${seconds} s, so TeX looks stuck. If this build is just slow, raise overtex.build.stallTimeout or set it to 0.`;
}

export function loopMessage(line: string): string {
  const shown = line.trim().length > 120 ? `${line.trim().slice(0, 117)}...` : line.trim();
  return `Stopped the build: the same output kept repeating, so TeX looks stuck in a loop: "${shown}"`;
}
