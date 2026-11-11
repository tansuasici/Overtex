// Reading the numbers LaTeX gave labels in the last build, from the .aux files. No vscode import, so
// it is unit-testable.
import * as path from 'path';

import { LabelKind } from './labels';

export interface AuxLabel {
  /** As printed: "3", "2.1", "A.1", "iv". */
  number: string;
  page: string;
  /** hyperref's title of the section the label is in, which names a section label. */
  title?: string;
  /** What cleveref says the label is: "equation", "section", "figure", … */
  type?: string;
}

export interface AuxScan {
  labels: Map<string, AuxLabel>;
  /** Files \include wrote their own .aux to, as written (relative to the main .aux's folder). */
  inputs: string[];
}

/** The index just past the group that opens at `open` (a `{`), or -1 when it does not close. */
function groupEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return i + 1;
    }
  }
  return -1;
}

/** The `{…}` groups that follow one another from `at`, contents only, up to `max`. */
function groups(text: string, at: number, max: number): { args: string[]; end: number } {
  const args: string[] = [];
  let i = at;
  while (args.length < max) {
    while (text[i] === ' ' || text[i] === '\t') {
      i++;
    }
    if (text[i] !== '{') {
      break;
    }
    const end = groupEnd(text, i);
    if (end < 0) {
      break;
    }
    args.push(text.substring(i + 1, end - 1));
    i = end;
  }
  return { args, end: i };
}

/** cleveref's `[equation][1][]1`: the type in the first brackets. */
function crefType(value: string): string | undefined {
  return /^\s*\[([^\]]*)\]/.exec(value)?.[1].trim() || undefined;
}

/**
 * Turns the TeX in a number or title into what it prints, for the simple cases: \relax, \protect,
 * font and \text… commands, ties and braces. Anything else is kept as written.
 */
export function auxText(tex: string): string {
  return tex
    .replace(/\\(?:relax|protect|leavevmode|nobreak|ignorespaces)\b ?/g, '')
    .replace(/\\(?:nobreakspace|space)\b ?|~/g, ' ')
    .replace(/\\(?:text[a-z]*|math[a-z]+|emph|em|mbox|hbox|ensuremath|up|it|bf|sf|tt|rm|sc|sl|normalfont|scshape|bfseries|itshape|upshape)\b\s*/g, '')
    .replace(/\\([{}%&#_$])/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The labels in one .aux file. Plain LaTeX writes `\newlabel{key}{{number}{page}}`; hyperref adds
 * `{title}{anchor}{}`; cleveref writes a `key@cref` twin that says what kind of thing the label is.
 * subcaption's `sub@key` entries repeat a label's sub-number and are left out.
 */
export function parseAux(text: string): AuxScan {
  const labels = new Map<string, AuxLabel>();
  const types = new Map<string, string>();
  const inputs: string[] = [];
  const head = /\\(newlabel|@input)\s*\{/g;
  for (let m = head.exec(text); m; m = head.exec(text)) {
    const open = m.index + m[0].length - 1;
    const keyEnd = groupEnd(text, open);
    if (keyEnd < 0) {
      continue;
    }
    const key = text.substring(open + 1, keyEnd - 1).trim();
    if (m[1] === '@input') {
      if (key) {
        inputs.push(key);
      }
      head.lastIndex = keyEnd;
      continue;
    }
    const outer = groups(text, keyEnd, 1);
    head.lastIndex = outer.end;
    if (!key || outer.args.length === 0 || key.startsWith('sub@')) {
      continue;
    }
    const [value, page, rawTitle] = groups(outer.args[0], 0, 3).args;
    if (key.endsWith('@cref')) {
      const type = crefType(value ?? '');
      if (type) {
        types.set(key.slice(0, -'@cref'.length), type);
      }
      continue;
    }
    if (value === undefined) {
      continue;
    }
    const title = rawTitle !== undefined ? auxText(rawTitle) : '';
    labels.set(key, { number: auxText(value), page: auxText(page ?? ''), ...(title ? { title } : {}) });
  }
  for (const [key, type] of types) {
    const label = labels.get(key);
    if (label) {
      label.type = type;
    }
  }
  return { labels, inputs };
}

/**
 * The labels of a whole build: the main .aux and those of \include'd files, which LaTeX reads
 * through \@input. `read` returns undefined for a file that is not there. Each file is read once.
 */
export function readAuxLabels(mainAux: string, read: (file: string) => string | undefined): Map<string, AuxLabel> | undefined {
  const dir = path.dirname(mainAux);
  const all = new Map<string, AuxLabel>();
  const seen = new Set<string>();
  let found = false;
  const visit = (file: string) => {
    const full = path.resolve(dir, file);
    if (seen.has(full) || seen.size > 200) {
      return;
    }
    seen.add(full);
    const text = read(full);
    if (text === undefined) {
      return;
    }
    found = true;
    const scan = parseAux(text);
    for (const [key, label] of scan.labels) {
      all.set(key, label);
    }
    scan.inputs.forEach(visit);
  };
  visit(mainAux);
  return found ? all : undefined;
}

const TYPE_NAMES: Record<string, string> = {
  equation: 'Equation',
  section: 'Section',
  subsection: 'Section',
  subsubsection: 'Section',
  paragraph: 'Paragraph',
  chapter: 'Chapter',
  part: 'Part',
  appendix: 'Appendix',
  subappendix: 'Appendix',
  figure: 'Figure',
  subfigure: 'Figure',
  table: 'Table',
  subtable: 'Table',
  listing: 'Listing',
  lstlisting: 'Listing',
  algorithm: 'Algorithm',
  footnote: 'Footnote',
  enumi: 'Item',
  enumii: 'Item',
  enumiii: 'Item',
  enumiv: 'Item',
  theorem: 'Theorem',
  lemma: 'Lemma',
  proposition: 'Proposition',
  corollary: 'Corollary',
  definition: 'Definition',
  remark: 'Remark',
  example: 'Example',
};

const KIND_NAMES: Partial<Record<LabelKind, string>> = {
  Sections: 'Section',
  Figures: 'Figure',
  Tables: 'Table',
  Equations: 'Equation',
  Theorems: 'Theorem',
  Code: 'Listing',
};

const SECTION_NAMES = new Set(['Section', 'Chapter', 'Part', 'Appendix', 'Paragraph']);

/** What a label is called in a sentence, from cleveref if it said, else from the source. */
function nameOf(label: AuxLabel, kind: LabelKind | undefined): string | undefined {
  if (label.type) {
    const type = label.type.toLowerCase();
    return TYPE_NAMES[type] ?? label.type.charAt(0).toUpperCase() + label.type.slice(1);
  }
  return kind && KIND_NAMES[kind];
}

/**
 * The first line of a reference's hover: "Equation (3), page 5" or "Section 2.1 Results, page 4".
 * The title only names sections: hyperref writes the enclosing section's title on every label.
 */
export function describeAuxLabel(label: AuxLabel, kind: LabelKind | undefined): string {
  const name = nameOf(label, kind);
  const number = label.number || '?';
  const shown = name === 'Equation' ? `(${number})` : number;
  const title = name && SECTION_NAMES.has(name) && label.title ? ` ${label.title}` : '';
  const page = label.page ? `, page ${label.page}` : '';
  return `${name ? `${name} ` : ''}${shown}${title}${page}`;
}
