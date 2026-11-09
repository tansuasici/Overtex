// Figures from image files, labels and preamble packages. No vscode import, so it is unit-testable.
import * as path from 'path';
import { commentStart } from './arxiv';

/** Snippet text: plain strings go in as they are, placeholders become tab stops. */
export type Segment = string | { placeholder: string };

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.eps']);
export const TABLE_EXTENSIONS = new Set(['.csv', '.tsv']);

export function isImage(file: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export function isTableFile(file: string): boolean {
  return TABLE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * The path \includegraphics gets: relative to the main file's folder, where the build runs,
 * with forward slashes on every OS. The extension stays so pdflatex and latexmk agree.
 */
export function graphicsPath(image: string, mainDir: string): string {
  return path.relative(mainDir, image).split(path.sep).join('/');
}

/** True when `file` is inside `dir`, so \includegraphics can reach it without a copy. */
export function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const TRANSLIT: Record<string, string> = {
  ş: 's', Ş: 's', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', ö: 'o', Ö: 'o', ü: 'u', Ü: 'u', ç: 'c', Ç: 'c',
  ä: 'a', Ä: 'a', ß: 'ss', é: 'e', è: 'e', á: 'a', à: 'a', ñ: 'n', ø: 'o', å: 'a',
};

/** A label key from a file name: `Grafik Sonuç_1.png` gives `grafik-sonuc-1`. */
export function slug(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  const ascii = [...base].map((ch) => TRANSLIT[ch] ?? ch).join('');
  const s = ascii
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'item';
}

/** `prefix:key`, with -2, -3… added until it is not in `taken`. */
export function uniqueLabel(prefix: string, key: string, taken: ReadonlySet<string>): string {
  const base = `${prefix}:${key}`;
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** A file name safe to copy into figures/: no spaces or characters LaTeX trips on. */
export function safeFileName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return `${slug(name)}${ext}`;
}

/** `name`, or name-2, name-3… when it is taken. */
export function freeName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) {
    return name;
  }
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!exists(candidate)) {
      return candidate;
    }
  }
}

export interface FigureOptions {
  /** The \includegraphics path, as graphicsPath gives it. */
  file: string;
  label: string;
  indent?: string;
}

/** A centred figure, caption below. The caption and label are tab stops. */
export function figureSegments(options: FigureOptions): Segment[] {
  const { file, label, indent = '  ' } = options;
  return [
    `\\begin{figure}[htbp]\n${indent}\\centering\n${indent}\\includegraphics[width=0.8\\linewidth]{${file}}\n${indent}\\caption{`,
    { placeholder: 'Caption' },
    `}\n${indent}\\label{`,
    { placeholder: label },
    `}\n\\end{figure}\n`,
  ];
}

/** The segments as plain text, placeholders filled with their defaults. */
export function segmentsText(segments: Segment[]): string {
  return segments.map((s) => (typeof s === 'string' ? s : s.placeholder)).join('');
}

/** The preamble lines with comments cut, up to \begin{document}. */
function preambleLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const cut = commentStart(raw);
    const line = cut < 0 ? raw : raw.substring(0, cut);
    if (/\\begin\s*\{document\}/.test(line)) {
      break;
    }
    out.push(line);
  }
  return out;
}

/** True when the preamble loads `pkg` with \usepackage or \RequirePackage, alone or in a list. */
export function hasPackage(text: string, pkg: string): boolean {
  const re = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  const joined = preambleLines(text).join('\n');
  let m: RegExpExecArray | null;
  while ((m = re.exec(joined))) {
    if (m[1].split(',').some((p) => p.trim() === pkg)) {
      return true;
    }
  }
  return false;
}

/**
 * The line to put a new \usepackage before: after the last \usepackage, else after
 * \documentclass. Undefined when there is no \documentclass, as in an \input file.
 */
export function packageInsertLine(text: string): number | undefined {
  const joined = preambleLines(text).join('\n');
  // Options may run over several lines, so the line that matters is where the command ends.
  const endLine = (re: RegExp): number | undefined => {
    let last: number | undefined;
    let m: RegExpExecArray | null;
    while ((m = re.exec(joined))) {
      last = joined.substring(0, m.index + m[0].length).split('\n').length - 1;
    }
    return last;
  };
  const documentclass = endLine(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g);
  if (documentclass === undefined) {
    return undefined;
  }
  const lastPackage = endLine(/\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g);
  return (lastPackage !== undefined && lastPackage > documentclass ? lastPackage : documentclass) + 1;
}
