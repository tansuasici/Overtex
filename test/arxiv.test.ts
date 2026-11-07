import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { crc32, createZip, packArxiv, parseFls, selectFiles, stripComments, withPdfOutput } from '../src/latex/arxiv';

const ROOT = '/proj';
// parseFls resolves paths with the platform's rules, so on Windows '/proj' becomes 'D:\\proj'.
const abs = (p: string) => path.resolve(p);

describe('parseFls', () => {
  it('resolves relative inputs against PWD and drops duplicates and outputs', () => {
    const fls = ['PWD /proj', 'INPUT /usr/share/texmf/tex/latex/base/article.cls', 'INPUT main.tex', 'OUTPUT main.aux', 'INPUT ./chapters/intro.tex', 'INPUT main.tex'].join('\n');
    expect(parseFls(fls)).toEqual(['/usr/share/texmf/tex/latex/base/article.cls', '/proj/main.tex', '/proj/chapters/intro.tex'].map(abs));
  });
});

describe('selectFiles', () => {
  const exists = () => true;

  it('keeps project inputs, drops distribution files and build by-products', () => {
    const { files } = selectFiles(
      ['/usr/texmf/article.cls', '/proj/main.tex', '/proj/main.aux', '/proj/main.out', '/proj/fig/plot.pdf', '/proj/main.bbl', '/proj/mystyle.sty'],
      { root: ROOT, outDir: ROOT, exists }
    );
    expect(files.map((f) => f.name)).toEqual(['main.tex', 'fig/plot.pdf', 'main.bbl', 'mystyle.sty']);
  });

  it('moves generated inputs from the output directory beside the main file', () => {
    const { files } = selectFiles(['/proj/main.tex', '/proj/build/main.bbl', '/proj/build/main.toc'], { root: ROOT, outDir: '/proj/build', exists });
    expect(files).toEqual([
      { source: '/proj/main.tex', name: 'main.tex' },
      { source: '/proj/build/main.bbl', name: 'main.bbl' },
    ]);
  });

  it('reports workspace files outside the main folder and skips missing ones', () => {
    const sel = selectFiles(['/ws/shared/macros.tex', '/proj/gone.tex', '/proj/main.tex'], {
      root: '/ws/paper',
      outDir: '/ws/paper',
      workspaceRoot: '/ws',
      exists: (f) => f !== '/proj/gone.tex',
    });
    expect(sel.outside).toEqual(['/ws/shared/macros.tex']);
    expect(sel.files).toEqual([]);
  });
});

describe('stripComments', () => {
  it('drops comment-only lines and cuts trailing comments after the %', () => {
    expect(stripComments('% header\nText % note\n  % indented\nMore')).toBe('Text %\nMore');
  });

  it('leaves escaped percent signs, \\verb and \\url alone', () => {
    expect(stripComments('50\\% off % cut')).toBe('50\\% off %');
    expect(stripComments('a\\\\% comment')).toBe('a\\\\%');
    expect(stripComments('\\verb|50%| and % cut')).toBe('\\verb|50%| and %');
    expect(stripComments('\\url{http://x.org/a%20b} % cut')).toBe('\\url{http://x.org/a%20b} %');
  });

  it('keeps verbatim environments verbatim', () => {
    const tex = 'before % x\n\\begin{verbatim}\n% kept\n\\end{verbatim}\n\\begin{lstlisting}[language=Python] % opts\nx = 1 % kept\n\\end{lstlisting}\n% gone';
    expect(stripComments(tex)).toBe('before %\n\\begin{verbatim}\n% kept\n\\end{verbatim}\n\\begin{lstlisting}[language=Python] % opts\nx = 1 % kept\n\\end{lstlisting}');
  });
});

describe('withPdfOutput', () => {
  it('adds \\pdfoutput=1 once', () => {
    expect(withPdfOutput('\\documentclass{article}')).toBe('\\pdfoutput=1\n\\documentclass{article}');
    expect(withPdfOutput('\\pdfoutput=1\n\\documentclass{article}')).toBe('\\pdfoutput=1\n\\documentclass{article}');
  });
});

describe('packArxiv', () => {
  const files: Record<string, string> = {
    [abs('/proj/main.tex')]: '% draft\n\\documentclass{article}\n\\begin{document}\nHi % todo\n\\bibliography{refs}\n\\end{document}\n',
    [abs('/proj/main.bbl')]: '% $ biblatex auxiliary file $\n',
  };
  const base = {
    fls: 'PWD /proj\nINPUT /proj/main.tex\nINPUT /proj/main.aux\nINPUT /proj/main.bbl\n',
    mainFile: abs('/proj/main.tex'),
    outDir: abs(ROOT),
    exists: (f: string) => f in files,
    read: (f: string) => Buffer.from(files[f]),
  };

  it('strips comments, sets \\pdfoutput and flags a biber .bbl', () => {
    const pkg = packArxiv({ ...base, engine: 'pdflatex' });
    expect(pkg.entries.map((e) => e.name)).toEqual(['main.tex', 'main.bbl']);
    expect(pkg.entries[0].data.toString()).toBe('\\pdfoutput=1\n\\documentclass{article}\n\\begin{document}\nHi %\n\\bibliography{refs}\n\\end{document}\n');
    expect(pkg.warnings.join('\n')).toMatch(/biber/);
  });

  it('warns about other engines and a missing .bbl', () => {
    const pkg = packArxiv({ ...base, fls: 'PWD /proj\nINPUT main.tex\n', engine: 'xelatex' });
    expect(pkg.entries[0].data.toString()).not.toMatch(/pdfoutput/);
    expect(pkg.warnings.join('\n')).toMatch(/No \.bbl/);
    expect(pkg.warnings.join('\n')).toMatch(/xelatex/);
  });
});

describe('createZip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('writes entries that read back intact', () => {
    const text = Buffer.from('\\documentclass{article}\n'.repeat(50));
    const tiny = Buffer.from('x');
    const zip = createZip([
      { name: 'main.tex', data: text },
      { name: 'chapters/a.tex', data: tiny },
    ]);

    // Walk the local headers by hand.
    let at = 0;
    const read: Record<string, string> = {};
    while (zip.readUInt32LE(at) === 0x04034b50) {
      const method = zip.readUInt16LE(at + 8);
      const size = zip.readUInt32LE(at + 18);
      const nameLen = zip.readUInt16LE(at + 26);
      const name = zip.subarray(at + 30, at + 30 + nameLen).toString();
      const body = zip.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
      read[name] = (method === 8 ? zlib.inflateRawSync(body) : body).toString();
      at += 30 + nameLen + size;
    }
    expect(read).toEqual({ 'main.tex': text.toString(), 'chapters/a.tex': 'x' });
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);

    // And with unzip, where it is installed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-zip-'));
    const file = path.join(dir, 'out.zip');
    fs.writeFileSync(file, zip);
    try {
      expect(execFileSync('unzip', ['-t', file]).toString()).toMatch(/No errors detected/);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
