// Word counts from texcount. No vscode import, so it is unit-testable.

export interface WordCount {
  /** Words in running text. */
  text: number;
  /** Words in section titles. */
  headers: number;
  /** Words in captions and other text outside the main flow. */
  captions: number;
  /** text + headers + captions. */
  total: number;
}

/** Arguments for `texcount` run in the main file's folder: follow \input/\include, total only. */
export function texcountArgs(mainFileName: string): string[] {
  return ['-inc', '-utf8', '-total', mainFileName];
}

/** Parses texcount's `-total` report (`Words in text: 29`, …); null when it has no word counts. */
export function parseTexcount(output: string): WordCount | null {
  const field = (label: RegExp): number | null => {
    const m = label.exec(output);
    return m ? parseInt(m[1], 10) : null;
  };
  const text = field(/^Words in text:\s*(\d+)/m);
  const headers = field(/^Words in headers:\s*(\d+)/m);
  const captions = field(/^Words outside text[^:]*:\s*(\d+)/m);
  if (text === null) {
    return null;
  }
  const count = { text, headers: headers ?? 0, captions: captions ?? 0 };
  return { ...count, total: count.text + count.headers + count.captions };
}

const number = (n: number) => n.toLocaleString('en-US');

/** Status bar text, e.g. `1,234 words` or `1,234 / 5,000 words`. */
export function wordCountLabel(count: WordCount, goal: number): string {
  return goal > 0 ? `${number(count.total)} / ${number(goal)} words` : `${number(count.total)} word${count.total === 1 ? '' : 's'}`;
}

/** Multi-line breakdown for the tooltip and the Count Words message. */
export function wordCountDetails(count: WordCount, goal: number, sessionStart?: number): string[] {
  const lines = [`${number(count.text)} in text, ${number(count.headers)} in headings, ${number(count.captions)} in captions`];
  if (goal > 0) {
    const percent = Math.floor((count.total / goal) * 100);
    lines.push(count.total >= goal ? `Goal of ${number(goal)} words reached (${percent}%).` : `${percent}% of the ${number(goal)} word goal, ${number(goal - count.total)} to go.`);
  }
  if (sessionStart !== undefined && sessionStart !== count.total) {
    const delta = count.total - sessionStart;
    lines.push(`${delta > 0 ? '+' : '−'}${number(Math.abs(delta))} since this session started.`);
  }
  return lines;
}
