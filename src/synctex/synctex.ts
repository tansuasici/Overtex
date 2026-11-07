import * as cp from 'child_process';
import * as path from 'path';
import type { PageRect } from '../shared/messages';

export interface SourceLocation {
  file: string;
  /** 1-based. */
  line: number;
  /** 0-based, or 0 when SyncTeX does not know. */
  column: number;
}

/**
 * Thin wrapper around the `synctex` CLI that ships with TeX Live and MiKTeX.
 * Coordinates are PDF points with the origin at the page's top-left corner.
 */
export class SyncTex {
  constructor(private readonly executable: () => string) {}

  /** Source position -> box on the PDF page. */
  async forward(pdfFile: string, texFile: string, line: number, column: number): Promise<PageRect | null> {
    const cwd = path.dirname(pdfFile);
    // How a file is named in the .synctex.gz depends on how TeX was invoked: Overtex's build
    // records `<dir>/./main.tex`, which only a relative name matches, while a build started with
    // an absolute path (another tool, a manual run) records `<dir>/main.tex`, which only the
    // absolute name matches. Try both.
    const candidates = [...new Set([relativeIfInside(cwd, texFile), texFile])];
    for (const input of candidates) {
      const output = await this.run(['view', '-i', `${line}:${column + 1}:${input}`, '-o', pdfFile], cwd);
      const rect = parseViewOutput(output);
      if (rect) {
        return rect;
      }
    }
    return null;
  }

  /** Point on a PDF page -> source position. */
  async inverse(pdfFile: string, page: number, x: number, y: number): Promise<SourceLocation | null> {
    const cwd = path.dirname(pdfFile);
    const output = await this.run(['edit', '-o', `${page}:${x}:${y}:${pdfFile}`], cwd);
    return parseEditOutput(output, cwd);
  }

  private run(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.execFile(this.executable(), args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`synctex ${args[0]} failed: ${stderr || err.message}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }
}

function relativeIfInside(dir: string, file: string): string {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

/**
 * Parses `synctex view` output. It can list several records; the first one is
 * the best match. `h`/`v` is the box origin on the baseline, `H` its height.
 */
export function parseViewOutput(output: string): PageRect | null {
  const start = output.indexOf('Output:');
  if (start < 0) {
    return null;
  }
  const next = output.indexOf('Output:', start + 1);
  const record = output.substring(start, next < 0 ? undefined : next);
  const num = (key: string) => {
    const m = record.match(new RegExp(`^${key}:(-?[0-9.]+)`, 'm'));
    return m ? parseFloat(m[1]) : NaN;
  };

  const page = num('Page');
  const h = num('h');
  const v = num('v');
  const width = num('W');
  const height = num('H');
  if (Number.isNaN(page) || Number.isNaN(h) || Number.isNaN(v)) {
    return null;
  }
  return {
    page,
    x: h,
    y: Number.isNaN(height) ? v : v - height,
    width: Number.isNaN(width) ? 0 : width,
    height: Number.isNaN(height) ? 0 : height,
  };
}

/** Parses `synctex edit` output, resolving the input path against `cwd`. */
export function parseEditOutput(output: string, cwd: string): SourceLocation | null {
  const input = output.match(/^Input:(.+)$/m);
  const line = output.match(/^Line:(-?\d+)$/m);
  if (!input || !line) {
    return null;
  }
  const column = output.match(/^Column:(-?\d+)$/m);
  return {
    file: path.normalize(path.resolve(cwd, input[1].trim())),
    line: Math.max(1, parseInt(line[1], 10)),
    column: column ? Math.max(0, parseInt(column[1], 10)) : 0,
  };
}
