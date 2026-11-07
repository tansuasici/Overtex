// Packing a project's sources for an arXiv submission. No vscode import, so it is unit-testable.
import * as path from 'path';
import * as zlib from 'zlib';

/**
 * Reads the files TeX opened from a latexmk `-recorder` file. Relative paths are relative to
 * the `PWD` line. Returns absolute paths in first-seen order, without duplicates.
 */
export function parseFls(text: string): string[] {
  let pwd = '';
  const seen = new Set<string>();
  const inputs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('PWD ')) {
      pwd = line.substring(4).trim();
    } else if (line.startsWith('INPUT ')) {
      const file = path.resolve(pwd, line.substring(6).trim());
      if (!seen.has(file)) {
        seen.add(file);
        inputs.push(file);
      }
    }
  }
  return inputs;
}

/** Build by-products arXiv regenerates itself. `.bbl`, `.ind` and `.gls` are kept, since it may not. */
const REGENERATED = /\.(aux|toc|lof|lot|loa|lol|out|nav|snm|vrb|bcf|run\.xml|log|fls|fdb_latexmk|synctex(\.gz)?|xdv|blg|ilg|glg|idx|glo)$/i;

export interface ArxivFile {
  /** Where the file is on disk. */
  source: string;
  /** Its path in the archive, relative to the main file's folder, with forward slashes. */
  name: string;
}

export interface FileSelection {
  files: ArxivFile[];
  /** Project files TeX read from outside the main file's folder; they cannot go into the archive. */
  outside: string[];
}

/**
 * Picks the project's own inputs from everything TeX read: files under the main file's folder,
 * plus generated inputs such as the `.bbl` from the output directory, which are moved beside the
 * main file. TeX distribution files are left out; other files from inside the workspace but
 * outside the main file's folder are reported.
 */
export function selectFiles(
  inputs: string[],
  opts: { root: string; outDir: string; workspaceRoot?: string; exists: (file: string) => boolean }
): FileSelection {
  const files: ArxivFile[] = [];
  const outside: string[] = [];
  const names = new Set<string>();
  for (const file of inputs) {
    if (REGENERATED.test(file) || !opts.exists(file)) {
      continue;
    }
    const base = opts.outDir !== opts.root && isInside(file, opts.outDir) ? opts.outDir : isInside(file, opts.root) ? opts.root : undefined;
    if (!base) {
      if (opts.workspaceRoot && isInside(file, opts.workspaceRoot)) {
        outside.push(file);
      }
      continue;
    }
    const name = path.relative(base, file).split(path.sep).join('/');
    if (!names.has(name)) {
      names.add(name);
      files.push({ source: file, name });
    }
  }
  return { files, outside };
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const VERBATIM_ENVS = 'verbatim|Verbatim|BVerbatim|lstlisting|minted|comment|filecontents';
const BEGIN_VERBATIM = new RegExp(`\\\\begin\\{(${VERBATIM_ENVS})\\*?\\}`);

/**
 * Removes comments, which arXiv would otherwise publish with the source. A line that is only a
 * comment is dropped; a trailing comment is cut after its `%`, which is kept because it also
 * suppresses the line end's space. Verbatim environments, `\verb` and `\url`/`\href` targets
 * are left alone, since `%` is not a comment there.
 */
export function stripComments(tex: string): string {
  const out: string[] = [];
  let verbatimEnd: string | undefined;
  for (const line of tex.split('\n')) {
    if (verbatimEnd) {
      out.push(line);
      if (line.includes(verbatimEnd)) {
        verbatimEnd = undefined;
      }
      continue;
    }
    const at = commentStart(line);
    const code = at < 0 ? line : line.substring(0, at);
    const begin = BEGIN_VERBATIM.exec(code);
    if (begin) {
      const end = `\\end{${begin[0].substring(7)}`;
      if (!code.substring(begin.index).includes(end)) {
        verbatimEnd = end;
      }
      out.push(line);
      continue;
    }
    if (at < 0) {
      out.push(line);
    } else if (code.trim() !== '') {
      out.push(line.substring(0, at + 1));
    }
  }
  return out.join('\n');
}

/** Index of the `%` that starts a comment, or -1. */
function commentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      const verb = /^\\verb\*?([^a-zA-Z\s*])/.exec(line.substring(i));
      if (verb) {
        const close = line.indexOf(verb[1], i + verb[0].length);
        i = close < 0 ? line.length : close;
        continue;
      }
      const url = /^\\(?:url|href)\s*\{/.exec(line.substring(i));
      if (url) {
        const close = line.indexOf('}', i + url[0].length);
        i = close < 0 ? line.length : close;
        continue;
      }
      i++; // skips \% and \\ alike
    } else if (ch === '%') {
      return i;
    }
  }
  return -1;
}

/**
 * arXiv guesses between LaTeX and pdfLaTeX; `\pdfoutput=1` in the first lines settles it for
 * projects built with pdfLaTeX.
 */
export function withPdfOutput(mainTex: string): string {
  const head = mainTex.split('\n').slice(0, 5).join('\n');
  return /\\pdfoutput\s*=\s*1/.test(head) ? mainTex : `\\pdfoutput=1\n${mainTex}`;
}

/** A biber `.bbl` only works with the biblatex version that wrote it. */
export function isBiberBbl(bbl: string): boolean {
  return /biblatex auxiliary file/.test(bbl.substring(0, 500));
}

export interface ArxivPackage {
  entries: { name: string; data: Buffer }[];
  /** Things the author should check before uploading. */
  warnings: string[];
}

/**
 * Turns a finished build into archive entries: the project's own inputs from the `.fls`, with
 * comments stripped from `.tex` files and `\pdfoutput=1` added to a pdfLaTeX main file.
 */
export function packArxiv(opts: {
  fls: string;
  mainFile: string;
  /** Absolute output directory of the build. */
  outDir: string;
  engine: 'pdflatex' | 'xelatex' | 'lualatex';
  workspaceRoot?: string;
  exists: (file: string) => boolean;
  read: (file: string) => Buffer;
}): ArxivPackage {
  const root = path.dirname(opts.mainFile);
  const { files, outside } = selectFiles(parseFls(opts.fls), { root, outDir: opts.outDir, workspaceRoot: opts.workspaceRoot, exists: opts.exists });
  const warnings: string[] = [];
  const entries: { name: string; data: Buffer }[] = [];
  let hasBbl = false;
  for (const file of files) {
    let data = opts.read(file.source);
    if (/\.tex$/i.test(file.name)) {
      let tex = stripComments(data.toString('utf8'));
      if (file.source === opts.mainFile && opts.engine === 'pdflatex') {
        tex = withPdfOutput(tex);
      }
      data = Buffer.from(tex, 'utf8');
    } else if (/\.bbl$/i.test(file.name)) {
      hasBbl = true;
      if (isBiberBbl(data.toString('utf8'))) {
        warnings.push('The bibliography was made with biber; arXiv accepts the .bbl only if its biblatex version matches yours.');
      }
    }
    entries.push({ name: file.name, data });
  }
  if (!files.some((f) => f.source === opts.mainFile)) {
    warnings.push('The main file is missing from the build record; rebuild and try again.');
  }
  if (!hasBbl && /\\(bibliography|addbibresource|printbibliography)\b/.test(opts.read(opts.mainFile).toString('utf8'))) {
    warnings.push('No .bbl was found, so arXiv will show no references. Build once with the bibliography and export again.');
  }
  if (opts.engine !== 'pdflatex') {
    warnings.push(`The project builds with ${opts.engine}; arXiv compiles with pdfLaTeX, so check the result in arXiv's preview.`);
  }
  for (const file of outside) {
    warnings.push(`${opts.workspaceRoot ? path.relative(opts.workspaceRoot, file) : file} is outside the main file's folder and was left out.`);
  }
  return { entries, warnings };
}

// ---- A minimal zip writer (deflate, no zip64) ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function createZip(entries: { name: string; data: Buffer }[], when = new Date()): Buffer {
  const { time, date } = dosDateTime(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = zlib.deflateRawSync(entry.data);
    const store = deflated.length >= entry.data.length;
    const body = store ? entry.data : deflated;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
