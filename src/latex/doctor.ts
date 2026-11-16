// The TeX doctor: before a build, are the packages, classes and fonts a project loads installed, and is
// the installed lineno one with a known bug? No vscode import and no process spawning, so it is unit
// tested with a fake lookup. Nothing here installs anything; it only says what to install.
import * as path from 'path';
import type { Engine } from './builder';

export interface DoctorFinding {
  severity: 'error' | 'warning';
  message: string;
  /** Where the package is asked for, when it is. */
  file?: string;
  line?: number;
  /** The TeX Live package to install for it, when known. */
  install?: string;
}

export interface DoctorReport {
  /** How many distinct packages and classes were looked up. */
  checked: number;
  findings: DoctorFinding[];
  /** TeX Live packages to install, without duplicates, in the order found. */
  install: string[];
}

export interface DoctorInput {
  mainFile: string;
  engine: Engine;
  /** A file's text, or undefined when it cannot be read. */
  read: (file: string) => string | undefined;
  /**
   * kpsewhich over file names, run in the main file's folder: the paths it prints, in any order,
   * relative ones (a file in the project) relative to that folder. Missing names print nothing.
   */
  lookup: (names: string[]) => Promise<string[]>;
}

interface Request {
  name: string;
  file: string;
  line: number;
  /** Asked for by a class or style file in the project, often only under some condition. */
  byTemplate: boolean;
}

const LOADS =
  /\\(usepackage|RequirePackage|RequirePackageWithOptions|documentclass|LoadClass|LoadClassWithOptions)\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g;
const INPUTS = /\\(?:input|include|subfile)\s*\{([^{}]+)\}/g;
/** A name kpsewhich can be given: no macro (`\`), parameter (`#`) or option-like leading `-`. */
const NAME = /^[A-Za-z0-9][\w.+@-]*$/;
const MAX_DEPTH = 10;
const MAX_ROUNDS = 5;

/** TeX Live packages whose name differs from the file a document asks for (checked with tlmgr search --file). */
const PACKAGE_OF: Record<string, string> = {
  'times.sty': 'psnfss',
  'mathptmx.sty': 'psnfss',
  'helvet.sty': 'psnfss',
  'courier.sty': 'psnfss',
  'newtxtext.sty': 'newtx',
  'newtxmath.sty': 'newtx',
  'ptmr8t.tfm': 'times',
  'ntx-Regular-tlf-t1.tfm': 'newtx',
  'amssymb.sty': 'amsfonts',
  'graphicx.sty': 'graphics',
  'subcaption.sty': 'caption',
  'algorithmic.sty': 'algorithms',
  'algorithm.sty': 'algorithms',
};

/** Font metrics that pdfLaTeX needs for a package to typeset, checked once the package itself is found. */
const FONT_FOR: Record<string, { file: string; font: string }> = {
  times: { file: 'ptmr8t.tfm', font: 'Times' },
  mathptmx: { file: 'ptmr8t.tfm', font: 'Times' },
  newtxtext: { file: 'ntx-Regular-tlf-t1.tfm', font: 'the newtx Times' },
};

/** The line without its comment; a `%` after a backslash is text. */
function code(line: string): string {
  const match = /(^|[^\\])(\\\\)*%/.exec(line);
  return match ? line.slice(0, match.index + match[0].length - 1) : line;
}

/** The text with comments removed, line breaks kept, so offsets still give line numbers. */
function uncommented(text: string): string {
  return text.split('\n').map(code).join('\n');
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

/** The file names (`name.sty`, `name.cls`) a source asks TeX to load, with where it asks. */
export function loadRequests(text: string, file: string, byTemplate: boolean): Request[] {
  const body = uncommented(text);
  const out: Request[] = [];
  for (const match of body.matchAll(LOADS)) {
    const ext = /Class/i.test(match[1]) || match[1] === 'documentclass' ? '.cls' : '.sty';
    const line = lineAt(body, match.index ?? 0);
    for (const raw of match[2].split(',')) {
      const name = raw.trim();
      if (NAME.test(name)) {
        out.push({ name: name.endsWith(ext) ? name : `${name}${ext}`, file, line, byTemplate });
      }
    }
  }
  return out;
}

/** The main file and the files it \input s or \include s, with their text, depth first. */
function sources(mainFile: string, read: (file: string) => string | undefined): { file: string; text: string }[] {
  const dir = path.dirname(mainFile);
  const seen = new Set<string>();
  const out: { file: string; text: string }[] = [];
  const visit = (file: string, depth: number) => {
    if (seen.has(file) || depth > MAX_DEPTH) {
      return;
    }
    seen.add(file);
    const text = read(file);
    if (text === undefined) {
      return;
    }
    out.push({ file, text });
    for (const match of uncommented(text).matchAll(INPUTS)) {
      const name = match[1].trim();
      if (name && !name.includes('\\') && !name.includes('#')) {
        visit(path.resolve(dir, path.extname(name) ? name : `${name}.tex`), depth + 1);
      }
    }
  };
  visit(mainFile, 0);
  return out;
}

/** The version a lineno.sty declares, e.g. "5.7", when its header says. */
export function linenoVersion(sty: string): string | undefined {
  return /\\def\\fileversion\s*\{v?(\d+(?:\.\d+)*)\}/.exec(sty)?.[1];
}

/** The LaTeX kernel date in latex.ltx, as [year, month]. The value sits on the line after \fmtversion. */
export function kernelDate(ltx: string): [number, number] | undefined {
  const m = /\\fmtversion\s*\{\s*(\d{4})[-/](\d\d)[-/]\d\d\s*\}/.exec(ltx);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/**
 * lineno 5.7 puts the line numbers of a two-column page's right column over its text on LaTeX kernels
 * from 2025-06 on; later versions fix it. True for exactly that pair.
 */
export function linenoMisplacesNumbers(version: string, kernel: [number, number]): boolean {
  return version === '5.7' && (kernel[0] > 2025 || (kernel[0] === 2025 && kernel[1] >= 6));
}

const LINENO_ADVICE =
  'lineno 5.7 is installed, which draws the line numbers of two-column pages over the text with this LaTeX (review copies and conference review modes use them). Update it: tlmgr update lineno.';

/** The same check from a build's log, which names the lineno and kernel that actually ran. */
export function linenoLogWarning(log: string): string | undefined {
  const pkg = /^Package: lineno \d{4}\/\d\d\/\d\d\s+v(\d+(?:\.\d+)*)\b/m.exec(log);
  const kernel = /^LaTeX2e <(\d{4})-(\d\d)-\d\d>/m.exec(log);
  if (!pkg || !kernel) {
    return undefined;
  }
  return linenoMisplacesNumbers(pkg[1], [Number(kernel[1]), Number(kernel[2])]) ? LINENO_ADVICE : undefined;
}

/** The TeX Live package that has `file`; usually the file's own name. */
export function texLivePackage(file: string): string {
  return PACKAGE_OF[file] ?? file.replace(/\.(sty|cls)$/, '');
}

function inProject(found: string, dir: string): string | undefined {
  const full = path.resolve(dir, found);
  const rel = path.relative(dir, full);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? full : undefined;
}

export async function diagnose(input: DoctorInput): Promise<DoctorReport> {
  const dir = path.dirname(input.mainFile);
  const requests: Request[] = [];
  for (const source of sources(input.mainFile, input.read)) {
    requests.push(...loadRequests(source.text, source.file, false));
  }

  // name -> path; a name looked up and not found maps to undefined.
  const found = new Map<string, string | undefined>();
  const scanned = new Set<string>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const names = [...new Set(requests.map((r) => r.name))].filter((n) => !found.has(n));
    if (round === 0) {
      names.push('lineno.sty', 'latex.ltx');
    }
    if (!names.length) {
      break;
    }
    const byName = new Map((await input.lookup(names)).map((p) => [path.basename(p.trim()), p.trim()] as const));
    for (const name of names) {
      found.set(name, byName.get(name));
    }
    // A class or style file shipped with the project (a conference template) asks for more.
    for (const name of names) {
      const local = byName.get(name) && inProject(byName.get(name)!, dir);
      if (local && /\.(sty|cls)$/.test(name) && !scanned.has(local)) {
        scanned.add(local);
        const text = input.read(local);
        if (text !== undefined) {
          requests.push(...loadRequests(text, local, true));
        }
      }
    }
  }

  const findings: DoctorFinding[] = [];
  const reported = new Set<string>();
  for (const r of requests) {
    if (found.get(r.name) !== undefined || reported.has(r.name)) {
      continue;
    }
    reported.add(r.name);
    const what = r.name.endsWith('.cls') ? 'class' : 'package';
    const where = `${path.relative(dir, r.file) || path.basename(r.file)}:${r.line}`;
    findings.push(
      r.byTemplate
        ? { severity: 'warning', message: `${r.name} is not installed. ${where} asks for it, maybe only in some cases.`, file: r.file, line: r.line, install: texLivePackage(r.name) }
        : { severity: 'error', message: `${r.name} is not installed: the ${what} loaded at ${where}.`, file: r.file, line: r.line, install: texLivePackage(r.name) }
    );
  }

  if (input.engine === 'pdflatex') {
    const fonts = Object.entries(FONT_FOR).filter(([pkg]) => found.get(`${pkg}.sty`) !== undefined);
    const files = [...new Set(fonts.map(([, f]) => f.file))];
    if (files.length) {
      const present = new Set((await input.lookup(files)).map((p) => path.basename(p.trim())));
      for (const [pkg, f] of fonts) {
        if (!present.has(f.file) && !reported.has(f.file)) {
          reported.add(f.file);
          findings.push({
            severity: 'warning',
            message: `${pkg}.sty is installed but ${f.file}, the metrics of ${f.font}, was not found, so pdfLaTeX may stop at the first text in that font.`,
            install: texLivePackage(f.file),
          });
        }
      }
    }
  }

  const linenoPath = found.get('lineno.sty');
  const ltxPath = found.get('latex.ltx');
  const version = linenoPath ? linenoVersion(input.read(path.resolve(dir, linenoPath)) ?? '') : undefined;
  const kernel = ltxPath ? kernelDate(input.read(path.resolve(dir, ltxPath)) ?? '') : undefined;
  if (version && kernel && linenoMisplacesNumbers(version, kernel)) {
    findings.push({ severity: 'warning', message: LINENO_ADVICE });
  }

  const install = [...new Set(findings.filter((f) => f.install).map((f) => f.install!))];
  const checked = new Set(requests.map((r) => r.name)).size;
  return { checked, findings, install };
}

/** The command to type for the missing packages, or undefined when there is nothing to install. */
export function installCommand(packages: readonly string[], platform: NodeJS.Platform): string | undefined {
  if (!packages.length) {
    return undefined;
  }
  // MacTeX installs TeX Live system-wide, which tlmgr can only change as root.
  return `${platform === 'darwin' ? 'sudo ' : ''}tlmgr install ${packages.join(' ')}`;
}

/** The report as plain text for the output channel. */
export function formatDoctor(report: DoctorReport, main: string, platform: NodeJS.Platform): string {
  const lines = [`Packages for ${path.basename(main)}: ${report.checked} looked up.`];
  if (!report.findings.length) {
    lines.push('  Everything the project loads is installed.');
  }
  for (const f of report.findings) {
    lines.push(`  ${f.severity === 'error' ? '✗' : '!'} ${f.message}`);
  }
  const command = installCommand(report.install, platform);
  if (command) {
    lines.push(`  To install: ${command}`);
    lines.push('  If tlmgr does not know a name, `tlmgr search --global --file /NAME.sty` shows the package that has it.');
  }
  return `${lines.join('\n')}\n`;
}
