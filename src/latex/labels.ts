// Finding \label definitions and their references in LaTeX source. No vscode import, so it is unit-testable.
import { VERBATIM_ENVS, commentStart } from './arxiv';

export type LabelKind = 'Sections' | 'Figures' | 'Tables' | 'Equations' | 'Theorems' | 'Code' | 'Other';

export const UNDEFINED_GROUP = 'Undefined references';

/** Where a key is written: columns are those of the key itself, inside the braces. */
export interface LabelOccurrence {
  key: string;
  line: number;
  start: number;
  end: number;
  /** The source around the key, for showing in a list. */
  excerpt: string;
}

export interface LabelDefinition extends LabelOccurrence {
  kind: LabelKind;
}

export interface LabelScan {
  labels: LabelDefinition[];
  refs: LabelOccurrence[];
}

export interface LabelSite extends LabelOccurrence {
  file: string;
}

export interface LabelEntry {
  key: string;
  /** Undefined for a key that is referenced but never defined. */
  kind?: LabelKind;
  definitions: LabelSite[];
  references: LabelSite[];
}

const LABEL_COMMANDS = new Set(['label', 'zlabel', 'linelabel']);
const LIST_REF_COMMANDS = new Set(['cref', 'Cref', 'cpageref', 'Cpageref', 'labelcref', 'labelcpageref', 'zcref', 'zcpageref']);
const RANGE_REF_COMMANDS = new Set(['crefrange', 'Crefrange', 'cpagerefrange', 'Cpagerefrange', 'vrefrange', 'vpagerefrange']);
const REF_COMMANDS = new Set([
  'ref', 'eqref', 'pageref', 'autoref', 'Autoref', 'autopageref', 'nameref', 'Nameref', 'titleref',
  'vref', 'Vref', 'vpageref', 'namecref', 'nameCref', 'lcnamecref', 'namecrefs', 'nameCrefs', 'lcnamecrefs',
  'fref', 'Fref', 'fullref', 'subref', 'subcref', 'zref', 'zpageref', 'thref', 'prettyref',
]);
const SECTION_COMMANDS = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph']);

const ENV_KINDS = new Map<string, LabelKind>();
const addEnvs = (kind: LabelKind, names: string) => names.split(' ').forEach((name) => ENV_KINDS.set(name, kind));
addEnvs('Figures', 'figure wrapfigure subfigure SCfigure sidewaysfigure');
addEnvs('Tables', 'table wraptable subtable longtable SCtable sidewaystable xltabular');
addEnvs('Equations', 'equation align alignat flalign gather multline eqnarray subequations dmath');
addEnvs('Theorems', 'theorem lemma proposition corollary definition remark example conjecture claim fact observation assumption problem thm lem prop cor defn rem');
addEnvs('Code', 'algorithm algorithm2e listing lstlisting');
// Labels on list items and footnotes point at the item, whichever section it is in.
addEnvs('Other', 'enumerate itemize description footnote');

const PREFIX_KINDS = new Map<string, LabelKind>();
const addPrefixes = (kind: LabelKind, names: string) => names.split(' ').forEach((name) => PREFIX_KINDS.set(name, kind));
addPrefixes('Sections', 'sec ssec subsec sect section ch chap chapter app appendix part par');
addPrefixes('Figures', 'fig figure sfig subfig');
addPrefixes('Tables', 'tab tbl table');
addPrefixes('Equations', 'eq eqn equation');
addPrefixes('Theorems', 'thm theorem lem lemma prop cor def defn rem ex conj claim');
addPrefixes('Code', 'lst lis listing code alg algo algorithm');

const GROUP_ORDER: LabelKind[] = ['Sections', 'Figures', 'Tables', 'Equations', 'Theorems', 'Code', 'Other'];
const VERBATIM = new RegExp(`^(?:${VERBATIM_ENVS})\\*?$`);
const EXCERPT_BEFORE = 30;
const EXCERPT_AFTER = 50;

function compareKeys(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/** Blanks `\verb|…|` and `\lstinline|…|`, whose content is not TeX, keeping every column in place. */
function maskInlineVerbatim(code: string): string {
  return code.replace(/\\(?:verb\*?|lstinline(?:\[[^\]]*\])?)([^a-zA-Z\s*{[])(.*?)\1/g, (match) => ' '.repeat(match.length));
}

interface Arg {
  text: string;
  start: number;
  /** The index just after the closing delimiter. */
  next: number;
}

function skipSpaces(code: string, at: number): number {
  while (code[at] === ' ' || code[at] === '\t') {
    at++;
  }
  return at;
}

function bracketArg(code: string, at: number): Arg | undefined {
  const open = skipSpaces(code, at);
  if (code[open] !== '[') {
    return undefined;
  }
  let depth = 0;
  for (let i = open + 1; i < code.length; i++) {
    if (code[i] === '{') {
      depth++;
    } else if (code[i] === '}') {
      depth--;
    } else if (code[i] === ']' && depth === 0) {
      return { text: code.substring(open + 1, i), start: open + 1, next: i + 1 };
    }
  }
  return undefined;
}

/** A `{…}` argument that closes on this line. Braces inside mean it is not a plain key. */
function braceArg(code: string, at: number): Arg | undefined {
  const open = skipSpaces(code, at);
  if (code[open] !== '{') {
    return undefined;
  }
  const close = code.indexOf('}', open + 1);
  return close < 0 ? undefined : { text: code.substring(open + 1, close), start: open + 1, next: close + 1 };
}

/** Skips a starred form and any optional arguments. */
function afterOptions(code: string, at: number): number {
  if (code[at] === '*') {
    at++;
  }
  for (let option = bracketArg(code, at); option; option = bracketArg(code, at)) {
    at = option.next;
  }
  return at;
}

function excerptAround(raw: string, start: number, end: number): string {
  const from = Math.max(0, start - EXCERPT_BEFORE);
  const to = Math.min(raw.length, end + EXCERPT_AFTER);
  return `${from > 0 ? '…' : ''}${raw.substring(from, to).trim()}${to < raw.length ? '…' : ''}`;
}

/** What a label points at: its prefix says what its author meant, else what surrounds it does. */
function kindOf(key: string, env: LabelKind | undefined, afterSection: boolean): LabelKind {
  const colon = key.indexOf(':');
  const prefix = colon > 0 ? PREFIX_KINDS.get(key.substring(0, colon).toLowerCase()) : undefined;
  return prefix ?? env ?? (afterSection ? 'Sections' : 'Other');
}

/**
 * Finds the labels and references in one file, skipping comments and verbatim text. Keys that hold
 * a macro or a parameter (`\ref{fig:#1}` in a `\newcommand`) are ignored: they are not one label.
 */
export function scanLabels(text: string): LabelScan {
  const labels: LabelDefinition[] = [];
  const refs: LabelOccurrence[] = [];
  const envs: { name: string; kind: LabelKind }[] = [];
  let afterSection = false;
  let verbatimEnd: string | undefined;

  text.split(/\r?\n/).forEach((raw, line) => {
    if (verbatimEnd) {
      if (raw.includes(verbatimEnd)) {
        verbatimEnd = undefined;
      }
      return;
    }
    const comment = commentStart(raw);
    const code = maskInlineVerbatim(comment < 0 ? raw : raw.substring(0, comment));

    const occurrence = (text: string, start: number): LabelOccurrence | undefined => {
      const key = text.trim();
      if (!key || /[#\\{}]/.test(key)) {
        return undefined;
      }
      const from = start + text.indexOf(key);
      return { key, line, start: from, end: from + key.length, excerpt: excerptAround(raw, from, from + key.length) };
    };
    const addRef = (text: string, start: number) => {
      const found = occurrence(text, start);
      if (found) {
        refs.push(found);
      }
    };
    const addRefList = (arg: Arg) => {
      let offset = arg.start;
      for (const part of arg.text.split(',')) {
        addRef(part, offset);
        offset += part.length + 1;
      }
    };
    const addLabel = (text: string, start: number, env = envs[envs.length - 1]?.kind) => {
      const found = occurrence(text, start);
      if (found) {
        labels.push({ ...found, kind: kindOf(found.key, env, afterSection) });
      }
    };
    /** `[…, label=key, …]` on a listing, which is where listings keep their label. */
    const addListingLabel = (options: Arg | undefined) => {
      const match = options && /(?:^|,)\s*label\s*=\s*(?:\{([^{}]*)\}|([^,{}]*))/.exec(options.text);
      if (match) {
        const value = match[1] ?? match[2];
        addLabel(value, options.start + match.index + match[0].length - value.length - (match[1] === undefined ? 0 : 1), 'Code');
      }
    };

    // Reading one control sequence at a time keeps `\\label` (a line break, then a word) from matching.
    const token = /\\(?:([a-zA-Z@]+)|.)/g;
    for (let match = token.exec(code); match; match = token.exec(code)) {
      const name = match[1];
      const at = token.lastIndex;
      if (!name) {
        continue;
      }
      if (name === 'begin' || name === 'end') {
        const arg = braceArg(code, at);
        if (!arg) {
          continue;
        }
        token.lastIndex = arg.next;
        const env = arg.text.trim();
        if (name === 'begin' && VERBATIM.test(env)) {
          if (env.startsWith('lstlisting')) {
            addListingLabel(bracketArg(code, arg.next));
          }
          const end = `\\end{${env}}`;
          if (!code.includes(end, arg.next)) {
            verbatimEnd = end;
            return;
          }
          token.lastIndex = code.indexOf(end, arg.next) + end.length;
          continue;
        }
        const kind = ENV_KINDS.get(env.replace(/\*$/, ''));
        if (kind && name === 'begin') {
          envs.push({ name: env, kind });
        } else if (kind) {
          const open = envs.map((e) => e.name).lastIndexOf(env);
          if (open >= 0) {
            envs.length = open;
          }
        }
      } else if (LABEL_COMMANDS.has(name)) {
        const arg = braceArg(code, afterOptions(code, at));
        if (arg) {
          addLabel(arg.text, arg.start);
          token.lastIndex = arg.next;
        }
      } else if (name === 'lstinputlisting') {
        addListingLabel(bracketArg(code, at));
      } else if (name === 'hyperref') {
        const arg = bracketArg(code, at);
        if (arg) {
          addRef(arg.text, arg.start);
          token.lastIndex = arg.next;
        }
      } else if (LIST_REF_COMMANDS.has(name) || REF_COMMANDS.has(name)) {
        const arg = braceArg(code, afterOptions(code, at));
        if (arg) {
          if (LIST_REF_COMMANDS.has(name)) {
            addRefList(arg);
          } else {
            addRef(arg.text, arg.start);
          }
          token.lastIndex = arg.next;
        }
      } else if (RANGE_REF_COMMANDS.has(name)) {
        const first = braceArg(code, afterOptions(code, at));
        const second = first && braceArg(code, first.next);
        if (first && second) {
          addRef(first.text, first.start);
          addRef(second.text, second.start);
          token.lastIndex = second.next;
        }
      } else if (SECTION_COMMANDS.has(name)) {
        afterSection = true;
      }
    }
  });
  return { labels, refs };
}

/** Puts the files' scans together under each key, in key order. */
export function mergeLabels(files: { file: string; scan: LabelScan }[]): LabelEntry[] {
  const entries = new Map<string, LabelEntry>();
  const entry = (key: string) => {
    let found = entries.get(key);
    if (!found) {
      found = { key, definitions: [], references: [] };
      entries.set(key, found);
    }
    return found;
  };
  for (const { file, scan } of files) {
    for (const { kind, ...label } of scan.labels) {
      const found = entry(label.key);
      found.kind ??= kind;
      found.definitions.push({ ...label, file });
    }
    for (const ref of scan.refs) {
      entry(ref.key).references.push({ ...ref, file });
    }
  }
  return [...entries.values()].sort((a, b) => compareKeys(a.key, b.key));
}

/** The panel's groups: what needs fixing first, then labels by kind. Empty groups are left out. */
export function groupLabels(entries: LabelEntry[]): { group: string; entries: LabelEntry[] }[] {
  const undefinedRefs = entries.filter((e) => e.definitions.length === 0);
  return [
    { group: UNDEFINED_GROUP, entries: undefinedRefs },
    ...GROUP_ORDER.map((kind) => ({ group: kind as string, entries: entries.filter((e) => e.kind === kind) })),
  ].filter((g) => g.entries.length > 0);
}

/** A row's short state: how often the label is used, and whether it is defined more than once. */
export function labelSummary(entry: LabelEntry): string {
  const refs = entry.references.length;
  const used = refs === 0 ? 'unused' : `${refs} ${refs === 1 ? 'ref' : 'refs'}`;
  return entry.definitions.length > 1 ? `defined ${entry.definitions.length}×, ${used}` : used;
}

/** Why `newKey` cannot replace `oldKey`, if so. Replacing a key that has no definition may merge it into a label, which is how a typo gets fixed. */
export function renameProblem(entries: LabelEntry[], oldKey: string, newKey: string): string | undefined {
  const key = newKey.trim();
  if (!key) {
    return 'Enter a label.';
  }
  if (/[\s,{}#%\\~^$&]/.test(key)) {
    return 'A label cannot contain spaces or any of , { } # % \\ ~ ^ $ &';
  }
  if (key === oldKey) {
    return undefined;
  }
  const hasDefinition = (k: string) => entries.some((e) => e.key === k && e.definitions.length > 0);
  return hasDefinition(oldKey) && hasDefinition(key) ? `"${key}" is already a label.` : undefined;
}

/** The label or reference at this position, the cursor touching either end of the key included. */
export function occurrenceAt(scan: LabelScan, line: number, character: number): LabelOccurrence | undefined {
  return [...scan.labels, ...scan.refs].find((o) => o.line === line && o.start <= character && character <= o.end);
}

/** The command to reference a label with: equations are numbered in parentheses. */
export function refCommand(entry: LabelEntry): string {
  return `\\${entry.kind === 'Equations' ? 'eqref' : 'ref'}{${entry.key}}`;
}
