// Pre-submission checks on a finished build. No vscode import, so it is unit-testable.
import * as path from 'path';
import { commentStart, parseFls, selectFiles } from './arxiv';
import type { LogEntry } from './logParser';

export interface SubmissionFinding {
  kind: 'pages' | 'draft' | 'reference' | 'font' | 'todo' | 'anonymity';
  severity: 'warning' | 'info';
  message: string;
  /** Absolute path, when the finding points at a source line. */
  file?: string;
  /** 1-based line, or 0 when unknown. */
  line?: number;
  /** Already shown in the Problems panel by the build itself. */
  fromBuild?: boolean;
}

export interface SubmissionReport {
  /** Page count from the log, or null when TeX did not report one. */
  pages: number | null;
  findings: SubmissionFinding[];
}

/** `Output written on main.pdf (12 pages, 34567 bytes).` */
export function pageCount(log: string): number | null {
  const m = /Output written on .*?\((\d+) pages?\b/.exec(log);
  return m ? parseInt(m[1], 10) : null;
}

/** Fonts pdfTeX or LuaTeX drew from bitmaps (`.600pk` in the recorder file); they become Type 3 fonts. */
export function bitmapFonts(fls: string): string[] {
  const fonts = new Set<string>();
  for (const file of parseFls(fls)) {
    const m = /^(.+?)\.\d+pk$/i.exec(path.basename(file));
    if (m) {
      fonts.add(m[1]);
    }
  }
  return [...fonts];
}

const UNDEFINED = /\b(Reference|Citation) `([^']*)' on page \d+ undefined/;
const MULTIPLY_DEFINED = /\bLabel `([^']*)' multiply defined/;

/** Undefined references and citations (`??` in the PDF) and duplicate labels, from the build's log entries. */
export function referenceProblems(entries: LogEntry[]): SubmissionFinding[] {
  const findings: SubmissionFinding[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.severity !== 'warning') {
      continue;
    }
    const undef = UNDEFINED.exec(entry.message);
    const dup = MULTIPLY_DEFINED.exec(entry.message);
    const message = undef
      ? `${undef[1]} \`${undef[2]}' is undefined and prints as ??.`
      : dup
        ? `Label \`${dup[1]}' is defined more than once.`
        : undefined;
    if (!message || seen.has(`${entry.file}:${entry.line}:${message}`)) {
      continue;
    }
    seen.add(`${entry.file}:${entry.line}:${message}`);
    findings.push({ kind: 'reference', severity: 'warning', message, file: entry.file || undefined, line: entry.line, fromBuild: true });
  }
  return findings;
}

/** Line of a \documentclass with the `draft` option, which leaves out figures; 0 when there is none. */
export function draftLine(mainTex: string): number {
  const lines = mainTex.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const at = commentStart(lines[i]);
    const code = at < 0 ? lines[i] : lines[i].substring(0, at);
    const m = /\\documentclass\s*\[([^\]]*)\]/.exec(code);
    if (m) {
      return m[1].split(',').some((o) => o.trim() === 'draft') ? i + 1 : 0;
    }
    if (/\\documentclass\b/.test(code)) {
      return 0;
    }
  }
  return 0;
}

const TODO_COMMAND = /\\(todo|fixme|TODO|FIXME)\b/;
const TODO_WORD = /\b(TODO|FIXME|XXX)\b/;

/** TODO notes: in the text they print in the PDF; in comments they only reach the published source. */
export function todoFindings(file: string, tex: string): SubmissionFinding[] {
  const findings: SubmissionFinding[] = [];
  tex.split('\n').forEach((line, i) => {
    const at = commentStart(line);
    const code = at < 0 ? line : line.substring(0, at);
    const comment = at < 0 ? '' : line.substring(at + 1);
    const inText = TODO_COMMAND.exec(code) ?? TODO_WORD.exec(code);
    if (inText) {
      findings.push({ kind: 'todo', severity: 'warning', message: `${inText[0]} is left in the text.`, file, line: i + 1 });
    } else if (TODO_WORD.test(comment)) {
      findings.push({ kind: 'todo', severity: 'info', message: 'TODO comment; arXiv publishes comments with the source.', file, line: i + 1 });
    }
  });
  return findings;
}

const IDENTIFYING: { pattern: RegExp; message: (m: RegExpExecArray) => string }[] = [
  {
    pattern: /\\(author|affiliation|institute|IEEEauthorblockN|IEEEauthorblockA)\b(?!\s*(?:\[[^\]]*\])?\s*\{\s*(?:Anonymous|\}))/i,
    message: (m) => `\\${m[1]} names an author or affiliation.`,
  },
  { pattern: /\\(email|thanks|orcid)\b/, message: (m) => `\\${m[1]} may identify an author.` },
  { pattern: /\\(?:sub)*section\*?\s*\{\s*Acknowledg|\\begin\{(?:acks|acknowledgments?)\}/i, message: () => 'Acknowledgments usually identify the authors.' },
  { pattern: /\bpdfauthor\s*=\s*(?:\{\s*)?[^\s{},]/, message: () => 'pdfauthor puts an author name in the PDF metadata.' },
];

/** Lines that may reveal who wrote a paper under double-blind review. Pointers to look at, not verdicts. */
export function anonymityFindings(file: string, tex: string): SubmissionFinding[] {
  const findings: SubmissionFinding[] = [];
  tex.split('\n').forEach((line, i) => {
    const at = commentStart(line);
    const code = at < 0 ? line : line.substring(0, at);
    for (const { pattern, message } of IDENTIFYING) {
      const m = pattern.exec(code);
      if (m) {
        findings.push({ kind: 'anonymity', severity: 'warning', message: message(m), file, line: i + 1 });
        break;
      }
    }
  });
  return findings;
}

export function checkSubmission(opts: {
  log: string;
  fls: string;
  entries: LogEntry[];
  mainFile: string;
  outDir: string;
  /** 0 means no limit. */
  pageLimit: number;
  anonymous: boolean;
  exists: (file: string) => boolean;
  read: (file: string) => string;
}): SubmissionReport {
  const findings: SubmissionFinding[] = [];
  const pages = pageCount(opts.log);
  if (pages !== null && opts.pageLimit > 0 && pages > opts.pageLimit) {
    findings.push({ kind: 'pages', severity: 'warning', message: `The PDF has ${pages} pages, over the limit of ${opts.pageLimit}.`, file: opts.mainFile, line: 0 });
  }

  const draft = draftLine(opts.read(opts.mainFile));
  if (draft) {
    findings.push({ kind: 'draft', severity: 'warning', message: 'The draft class option leaves figures out and marks overfull lines.', file: opts.mainFile, line: draft });
  }

  findings.push(...referenceProblems(opts.entries));

  const fonts = bitmapFonts(opts.fls);
  if (fonts.length) {
    findings.push({
      kind: 'font',
      severity: 'warning',
      message: `Bitmap (Type 3) font${fonts.length === 1 ? '' : 's'} ${fonts.join(', ')}: many venues reject these; use a vector version of the font.`,
      file: opts.mainFile,
      line: 0,
    });
  }

  const { files } = selectFiles(parseFls(opts.fls), { root: path.dirname(opts.mainFile), outDir: opts.outDir, exists: opts.exists });
  for (const file of files) {
    if (!/\.tex$/i.test(file.source)) {
      continue;
    }
    const tex = opts.read(file.source);
    findings.push(...todoFindings(file.source, tex));
    if (opts.anonymous) {
      findings.push(...anonymityFindings(file.source, tex));
    }
  }
  return { pages, findings };
}

/** One line for the notification, e.g. "7 pages (limit 8) · 2 undefined references · 3 TODOs". */
export function summarize(report: SubmissionReport, pageLimit: number): string {
  const parts: string[] = [];
  if (report.pages !== null) {
    parts.push(`${report.pages} page${report.pages === 1 ? '' : 's'}${pageLimit > 0 ? ` (limit ${pageLimit})` : ''}`);
  }
  const count = (pred: (f: SubmissionFinding) => boolean, one: string, many: string) => {
    const n = report.findings.filter(pred).length;
    if (n) {
      parts.push(`${n} ${n === 1 ? one : many}`);
    }
  };
  count((f) => f.kind === 'draft', 'draft option', 'draft options');
  count((f) => f.kind === 'reference', 'reference problem', 'reference problems');
  count((f) => f.kind === 'font', 'Type 3 font warning', 'Type 3 font warnings');
  count((f) => f.kind === 'todo' && f.severity === 'warning', 'TODO in the text', 'TODOs in the text');
  count((f) => f.kind === 'todo' && f.severity === 'info', 'TODO comment', 'TODO comments');
  count((f) => f.kind === 'anonymity', 'possible author identification', 'possible author identifications');
  return parts.join(' · ');
}
