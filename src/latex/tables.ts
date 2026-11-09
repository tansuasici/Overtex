// Turning CSV and TSV data into a booktabs table. No vscode import, so it is unit-testable.
import { Segment } from './figures';

export interface Delimited {
  rows: string[][];
  delimiter: ',' | ';' | '\t';
}

const DELIMITERS = ['\t', ';', ','] as const;

/**
 * Reads CSV or TSV text: quoted fields may hold the delimiter, line breaks and doubled quotes.
 * The delimiter is the one that splits the first lines into the same number of fields, so a
 * semicolon file from a spreadsheet set to a comma-decimal locale reads right too. Undefined
 * for text that is not a table of at least `minColumns` columns.
 */
export function parseDelimited(text: string, minColumns = 1): Delimited | undefined {
  const clean = text.replace(/^\uFEFF/, '');
  if (!clean.trim()) {
    return undefined;
  }
  let best: Delimited | undefined;
  let bestScore = -1;
  for (const delimiter of DELIMITERS) {
    const rows = splitRows(clean, delimiter);
    const sample = rows.slice(0, 10);
    const width = sample[0]?.length ?? 0;
    if (width < 2) {
      continue;
    }
    const consistent = sample.filter((r) => r.length === width).length;
    // Most rows of the same width wins; on a tie the wider split, then the order above.
    const score = consistent * 1000 + width;
    if (score > bestScore) {
      best = { rows, delimiter };
      bestScore = score;
    }
  }
  if (!best) {
    const rows = splitRows(clean, ',');
    best = { rows, delimiter: ',' };
  }
  const width = Math.max(...best.rows.map((r) => r.length));
  if (width < minColumns) {
    return undefined;
  }
  const rows = best.rows.map((r) => (r.length < width ? [...r, ...new Array<string>(width - r.length).fill('')] : r));
  return { rows, delimiter: best.delimiter };
}

function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
      fieldStart = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i++;
      }
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
      fieldStart = true;
    } else {
      field += ch;
      if (ch !== ' ') {
        fieldStart = false;
      }
    }
  }
  if (field || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  // Blank lines carry no data.
  return rows.filter((r) => r.some((f) => f !== ''));
}

const LATEX_SPECIALS: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

/** The text as LaTeX prints it: special characters escaped, line breaks as spaces. */
export function escapeLatex(text: string): string {
  return text.replace(/[\\&%$#_{}~^]/g, (ch) => LATEX_SPECIALS[ch]).replace(/\s*[\r\n]+\s*/g, ' ');
}

/** A number as people write them: 1234, -1.5, 1,5 (comma decimal), 12%, 1 234 or 1.234,5. */
export function isNumeric(cell: string, decimalComma: boolean): boolean {
  const t = cell.trim().replace(/%$/, '');
  if (!t) {
    return false;
  }
  return decimalComma
    ? /^[-+−]?(\d{1,3}([. \u00a0]\d{3})+|\d+)(,\d+)?$/.test(t)
    : /^[-+−]?(\d{1,3}([, \u00a0]\d{3})+|\d+)(\.\d+)?([eE][-+]?\d+)?$/.test(t);
}

/** `r` for columns of numbers, so the digits line up, and `l` for the rest. The header row does not count. */
export function columnSpec(rows: string[][], header: boolean, decimalComma: boolean): string {
  const body = header ? rows.slice(1) : rows;
  const width = rows[0]?.length ?? 0;
  let spec = '';
  for (let c = 0; c < width; c++) {
    const cells = body.map((r) => r[c] ?? '').filter((v) => v.trim() !== '');
    spec += cells.length > 0 && cells.every((v) => isNumeric(v, decimalComma)) ? 'r' : 'l';
  }
  return spec;
}

export interface TableOptions {
  /** The first row is a header, set apart by a rule. */
  header?: boolean;
  /** Read `1,5` as a number: true for semicolon-separated files. */
  decimalComma?: boolean;
  /** The \label key; the caller makes it unique. */
  label: string;
  indent?: string;
}

/**
 * A table environment with a booktabs tabular, caption above. The caption and label are
 * placeholders the editor puts the cursor in.
 */
export function tableSegments(rows: string[][], options: TableOptions): Segment[] {
  const { header = true, decimalComma = false, label, indent = '  ' } = options;
  const i1 = indent;
  const i2 = indent + indent;
  const line = (cells: string[]) => `${i2}${cells.map(escapeLatex).join(' & ')} \\\\\n`;
  const body: string[] = [];
  body.push(`${i1}\\begin{tabular}{${columnSpec(rows, header, decimalComma)}}\n`);
  body.push(`${i2}\\toprule\n`);
  rows.forEach((row, n) => {
    body.push(line(row));
    if (header && n === 0 && rows.length > 1) {
      body.push(`${i2}\\midrule\n`);
    }
  });
  body.push(`${i2}\\bottomrule\n`);
  body.push(`${i1}\\end{tabular}\n`);
  return [
    `\\begin{table}[htbp]\n${i1}\\centering\n${i1}\\caption{`,
    { placeholder: 'Caption' },
    `}\n${i1}\\label{`,
    { placeholder: label },
    `}\n`,
    body.join(''),
    '\\end{table}\n',
  ];
}
