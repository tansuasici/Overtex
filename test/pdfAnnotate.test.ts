// pdf.js reads the results back: it is an independent reader, and the viewer's own coordinates come
// from it. The end of this file runs pdfLaTeX and is skipped when it is not installed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { annotatePdf, PdfNote, pdfDate, toUserSpace } from '../src/pdf/annotate';
import { PdfDocument } from '../src/pdf/document';
import { PdfError } from '../src/pdf/objects';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: PdfJs;

beforeAll(async () => {
  pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
});

interface ReadAnnotation {
  subtype: string;
  contents: string;
  rect: number[];
  id: string;
  popupRef?: string;
  /** On a popup: its parent's /Rect as written. pdf.js moves a NoZoom icon's own rect to its icon size. */
  parentRect?: number[];
  url?: string;
}

async function readBack(bytes: Buffer): Promise<{ pages: { width: number; height: number; annotations: ReadAnnotation[]; toView: (x: number, y: number) => number[] }[] }> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const annotations = (await page.getAnnotations()) as { subtype: string; contentsObj?: { str: string }; rect: number[]; id: string; popupRef?: string; parentRect?: number[]; url?: string }[];
    pages.push({
      width: vp.width,
      height: vp.height,
      annotations: annotations.map((a) => ({ subtype: a.subtype, contents: a.contentsObj?.str ?? '', rect: a.rect, id: a.id, popupRef: a.popupRef, parentRect: a.parentRect, url: a.url })),
      toView: (x: number, y: number) => vp.convertToViewportPoint(x, y) as number[],
    });
  }
  await task.destroy();
  return { pages };
}

const center = (rect: number[]): [number, number] => [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];

/** Checks the note is a sticky note with a popup, centred where the viewer showed its pin. */
function expectNote(page: Awaited<ReturnType<typeof readBack>>['pages'][number], n: PdfNote): void {
  const text = page.annotations.find((a) => a.subtype === 'Text' && a.contents === n.text);
  expect(text, n.text).toBeDefined();
  const popup = page.annotations.find((a) => a.subtype === 'Popup' && a.id === text!.popupRef);
  expect(popup?.parentRect).toBeDefined();
  const [vx, vy] = page.toView(...center(popup!.parentRect!));
  expect(vx).toBeCloseTo(n.x, 3);
  expect(vy).toBeCloseTo(n.y, 3);
}

function note(id: string, page: number, x: number, y: number, text: string): PdfNote {
  return { id, page, x, y, text, createdAt: '2026-11-10T09:08:07.000Z' };
}

/**
 * A classic-xref PDF written by hand: the media box is inherited from the page tree, page 2 is
 * rotated with a crop box, and its /Annots is an indirect array holding a link.
 */
function handmadePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 600 800] >>',
    '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Rotate 90 /CropBox [50 100 550 700] /Annots 6 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '[7 0 R]',
    '<< /Type /Annot /Subtype /Link /Rect [100 200 200 220] /A << /S /URI /URI (https://example.org/) >> >>',
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('annotatePdf on a hand-written PDF', () => {
  it('appends sticky notes that pdf.js finds where the viewer put them, keeping the original bytes', async () => {
    const original = handmadePdf();
    const notes = [note('a', 1, 100, 150, 'First note\nwith a second line'), note('b', 2, 300, 120, 'Dönüş: ünlü ğ ş ı 🙂'), note('c', 2, 450, 400, 'Near the corner')];
    const result = annotatePdf(original, notes);
    expect(result).toMatchObject({ placed: 3, skipped: 0 });
    expect(result.bytes.subarray(0, original.length).equals(original)).toBe(true);

    const { pages } = await readBack(result.bytes);
    expect(pages[1]).toMatchObject({ width: 600, height: 500 });
    for (const n of notes) {
      expectNote(pages[n.page - 1], n);
    }
    expect(pages[1].annotations.find((a) => a.subtype === 'Link')?.url).toBe('https://example.org/');
  });

  it('skips notes on pages the PDF does not have or outside the page', () => {
    const original = handmadePdf();
    const result = annotatePdf(original, [note('x', 3, 10, 10, 'gone'), note('y', 2, 10, 550, 'below a 500-point page'), note('z', 1, 10, 10, 'kept')]);
    expect(result).toMatchObject({ placed: 1, skipped: 2 });
  });

  it('returns the PDF unchanged when no note fits', () => {
    const original = handmadePdf();
    expect(annotatePdf(original, [note('x', 9, 1, 1, 'gone')]).bytes).toBe(original);
  });

  it('can annotate its own output again', async () => {
    const once = annotatePdf(handmadePdf(), [note('a', 1, 100, 100, 'one')]).bytes;
    const twice = annotatePdf(once, [note('b', 1, 200, 200, 'two')]).bytes;
    const { pages } = await readBack(twice);
    expect(pages[0].annotations.filter((a) => a.subtype === 'Text').map((a) => a.contents)).toEqual(['one', 'two']);
  });

  it('refuses an encrypted PDF', () => {
    const encrypted = Buffer.from(handmadePdf().toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Encrypt << /Filter /Standard >>'), 'latin1');
    expect(() => annotatePdf(encrypted, [note('a', 1, 1, 1, 'x')])).toThrow(PdfError);
  });
});

describe('toUserSpace', () => {
  it('inverts each rotation', () => {
    const box = { mediaBox: [0, 0, 600, 800], cropBox: [0, 0, 600, 800] };
    expect(toUserSpace({ ...box, rotate: 0 }, 10, 20)).toEqual([10, 780]);
    expect(toUserSpace({ ...box, rotate: 90 }, 10, 20)).toEqual([20, 10]);
    expect(toUserSpace({ ...box, rotate: 180 }, 10, 20)).toEqual([590, 20]);
    expect(toUserSpace({ ...box, rotate: 270 }, 10, 20)).toEqual([580, 790]);
  });
});

describe('pdfDate', () => {
  it('writes UTC', () => {
    expect(pdfDate('2026-01-02T03:04:05.000Z')).toBe('D:20260102030405Z');
  });
});

// ---- Real TeX output ----

function has(command: string): boolean {
  return cp.spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

const tex = String.raw`\documentclass{article}
\usepackage[colorlinks]{hyperref}
\begin{document}
\section{One}\label{one}
See \url{https://example.org/} and Section~\ref{one}.
\newpage
\section{Two}
Page two.
\end{document}
`;

describe.skipIf(!has('pdflatex'))('annotatePdf on TeX output', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-annotate-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function build(name: string, preamble: string, engine = 'pdflatex'): Buffer {
    fs.writeFileSync(path.join(dir, `${name}.tex`), preamble + tex);
    const run = cp.spawnSync(engine, ['-interaction=nonstopmode', '-halt-on-error', `${name}.tex`], { cwd: dir, encoding: 'utf8' });
    expect(run.status, run.stdout).toBe(0);
    return fs.readFileSync(path.join(dir, `${name}.pdf`));
  }

  for (const [name, preamble, engine, stream] of [
    ['compressed', '', 'pdflatex', true],
    ['classic', '\\pdfobjcompresslevel=0\n', 'pdflatex', false],
    ['lualatex', '', 'lualatex', true],
    ['xelatex', '', 'xelatex', undefined],
  ] as const) {
    it.skipIf(!has(engine))(`keeps hyperref's links and adds the notes (${name})`, async () => {
      const original = build(name, preamble, engine);
      if (stream !== undefined) {
        expect(new PdfDocument(original).xrefIsStream).toBe(stream);
      }
      const before = await readBack(original);
      const notes = [note('one', 1, 200, 150, 'On page one'), note('two', 2, 300, 400, 'On page two')];
      const result = annotatePdf(original, notes);
      expect(result).toMatchObject({ placed: 2, skipped: 0 });
      expect(result.bytes.subarray(0, original.length).equals(original)).toBe(true);
      expect(new PdfDocument(result.bytes).xrefIsStream).toBe(new PdfDocument(original).xrefIsStream);

      const after = await readBack(result.bytes);
      const links = (r: typeof before): number => r.pages[0].annotations.filter((a) => a.subtype === 'Link').length;
      expect(links(before)).toBeGreaterThan(0);
      expect(links(after)).toBe(links(before));
      for (const n of notes) {
        expectNote(after.pages[n.page - 1], n);
      }
      if (has('qpdf')) {
        const out = path.join(dir, `${name}-notes.pdf`);
        fs.writeFileSync(out, result.bytes);
        const check = cp.spawnSync('qpdf', ['--check', out], { encoding: 'utf8' });
        expect(check.status, check.stdout + check.stderr).toBe(0);
      }
    });
  }
});
