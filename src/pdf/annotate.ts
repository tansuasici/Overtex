// Writes notes into a copy of a PDF as standard sticky-note (/Text) annotations, so Acrobat,
// Preview, Zotero and other readers show and edit them. The original bytes are kept as they are and
// the annotations are appended as an incremental update (ISO 32000-1, section 7.5.6).

import { PdfDocument, PdfPage } from './document';
import { PdfDict, PdfName, PdfObject, PdfRef, PdfString, serialize, textString } from './objects';

export interface PdfNote {
  id: string;
  /** 1-based. */
  page: number;
  /** PDF points from the top-left corner of the page as the viewer shows it (its crop box and rotation). */
  x: number;
  y: number;
  text: string;
  /** ISO 8601. */
  createdAt: string;
}

export interface AnnotateResult {
  bytes: Buffer;
  placed: number;
  /** Notes on a page the PDF does not have, or outside the page. */
  skipped: number;
}

const ICON = 20;
const POPUP_WIDTH = 220;
const POPUP_HEIGHT = 120;

/** The part of the page a viewer shows: the crop box clipped to the media box, as pdf.js does. */
export function visibleBox(page: Pick<PdfPage, 'mediaBox' | 'cropBox'>): [number, number, number, number] {
  const norm = (b: number[]): number[] => [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
  const m = norm(page.mediaBox);
  const c = norm(page.cropBox);
  const box = [Math.max(m[0], c[0]), Math.max(m[1], c[1]), Math.min(m[2], c[2]), Math.min(m[3], c[3])];
  return box[0] < box[2] && box[1] < box[3] ? (box as [number, number, number, number]) : (m as [number, number, number, number]);
}

function normalRotation(rotate: number): number {
  const r = ((rotate % 360) + 360) % 360;
  return r % 90 === 0 ? r : 0;
}

/** The size of the page as the viewer shows it, at scale 1. */
export function viewSize(page: Pick<PdfPage, 'mediaBox' | 'cropBox' | 'rotate'>): { width: number; height: number } {
  const [x1, y1, x2, y2] = visibleBox(page);
  const sideways = normalRotation(page.rotate) % 180 !== 0;
  return sideways ? { width: y2 - y1, height: x2 - x1 } : { width: x2 - x1, height: y2 - y1 };
}

/**
 * Maps a point in the viewer's top-left, rotated space to the page's own coordinates: the inverse of
 * the transform a pdf.js viewport at scale 1 uses.
 */
export function toUserSpace(page: Pick<PdfPage, 'mediaBox' | 'cropBox' | 'rotate'>, x: number, y: number): [number, number] {
  const [x1, y1, x2, y2] = visibleBox(page);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const [a, b, c, d] = ({ 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] } as Record<number, number[]>)[normalRotation(page.rotate)];
  const offX = a === 0 ? Math.abs(cy - y1) : Math.abs(cx - x1);
  const offY = a === 0 ? Math.abs(cx - x1) : Math.abs(cy - y1);
  const e = offX - a * cx - c * cy;
  const f = offY - b * cx - d * cy;
  const det = a * d - b * c;
  return [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det];
}

/** A PDF date (7.9.4) in UTC. */
export function pdfDate(iso: string): string {
  const date = new Date(iso);
  const valid = Number.isFinite(date.getTime()) ? date : new Date(0);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `D:${p(valid.getUTCFullYear(), 4)}${p(valid.getUTCMonth() + 1)}${p(valid.getUTCDate())}${p(valid.getUTCHours())}${p(valid.getUTCMinutes())}${p(valid.getUTCSeconds())}Z`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function ascii(text: string): PdfString {
  return new PdfString(Buffer.from(text, 'latin1'));
}

interface NewObject {
  num: number;
  gen: number;
  value: PdfObject;
}

export function annotatePdf(original: Buffer, notes: readonly PdfNote[]): AnnotateResult {
  const doc = new PdfDocument(original);
  const pages = doc.pages();
  let next = doc.size;
  const objects: NewObject[] = [];
  const added = new Map<PdfPage, PdfRef[]>();
  let skipped = 0;

  for (const note of notes) {
    const page = pages[note.page - 1];
    const size = page && viewSize(page);
    if (!page || note.x < 0 || note.y < 0 || note.x > size.width || note.y > size.height) {
      skipped++;
      continue;
    }
    const [vx1, vy1, vx2, vy2] = visibleBox(page);
    const [ux, uy] = toUserSpace(page, note.x, note.y);
    const left = clamp(ux - ICON / 2, vx1, vx2 - ICON);
    const bottom = clamp(uy - ICON / 2, vy1, vy2 - ICON);
    const popupLeft = clamp(left + ICON, vx1, vx2 - POPUP_WIDTH);
    const popupTop = clamp(bottom + ICON, vy1 + POPUP_HEIGHT, vy2);

    const annotRef = new PdfRef(next++, 0);
    const popupRef = new PdfRef(next++, 0);
    const date = ascii(pdfDate(note.createdAt));
    objects.push({
      num: annotRef.num,
      gen: 0,
      value: new PdfDict()
        .set('Type', new PdfName('Annot'))
        .set('Subtype', new PdfName('Text'))
        .set('Rect', [left, bottom, left + ICON, bottom + ICON])
        .set('Contents', textString(note.text))
        .set('NM', textString(note.id))
        .set('M', date)
        .set('CreationDate', date)
        // Print, NoZoom and NoRotate: the icon stays the same size, upright, and prints.
        .set('F', 28)
        .set('Name', new PdfName('Comment'))
        .set('Open', false)
        .set('C', [1, 0.84, 0.2])
        .set('P', page.ref)
        .set('Popup', popupRef),
    });
    objects.push({
      num: popupRef.num,
      gen: 0,
      value: new PdfDict()
        .set('Type', new PdfName('Annot'))
        .set('Subtype', new PdfName('Popup'))
        .set('Rect', [popupLeft, popupTop - POPUP_HEIGHT, popupLeft + POPUP_WIDTH, popupTop])
        .set('Parent', annotRef)
        .set('Open', false)
        .set('P', page.ref),
    });
    const refs = added.get(page) ?? [];
    refs.push(annotRef, popupRef);
    added.set(page, refs);
  }

  if (added.size === 0) {
    return { bytes: original, placed: 0, skipped };
  }

  // Each page gets a new copy with its own /Annots array: the old one may be shared with other pages,
  // and existing annotations, such as hyperref's links, stay in it.
  for (const [page, refs] of added) {
    const dict = new PdfDict(new Map(page.dict.entries));
    const existing = doc.resolve(page.dict.get('Annots'));
    const kept = Array.isArray(existing) ? existing : [];
    dict.set('Annots', [...kept, ...refs]);
    objects.push({ num: page.ref.num, gen: doc.generation(page.ref.num), value: dict });
  }

  return { bytes: appendUpdate(doc, objects, next), placed: notes.length - skipped, skipped };
}

function appendUpdate(doc: PdfDocument, objects: NewObject[], size: number): Buffer {
  const original = doc.bytes;
  const chunks: Buffer[] = [original];
  let length = original.length;
  const push = (data: string | Buffer): void => {
    const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    chunks.push(buf);
    length += buf.length;
  };
  const last = original[original.length - 1];
  if (last !== 0x0a && last !== 0x0d) {
    push('\n');
  }

  const offsets = new Map<number, { offset: number; gen: number }>();
  for (const object of objects) {
    offsets.set(object.num, { offset: length, gen: object.gen });
    push(`${object.num} ${object.gen} obj\n${serialize(object.value)}\nendobj\n`);
  }

  const trailer = new PdfDict();
  for (const key of ['Root', 'Info', 'ID']) {
    const value = doc.trailer.get(key);
    if (value !== undefined) {
      trailer.set(key, value);
    }
  }
  trailer.set('Prev', doc.startxref);

  let xrefOffset: number;
  if (doc.xrefIsStream) {
    const xrefNum = size;
    xrefOffset = length;
    offsets.set(xrefNum, { offset: xrefOffset, gen: 0 });
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    const rows = Buffer.alloc(nums.length * 7);
    nums.forEach((num, i) => {
      const { offset, gen } = offsets.get(num)!;
      rows[i * 7] = 1;
      rows.writeUInt32BE(offset, i * 7 + 1);
      rows.writeUInt16BE(gen, i * 7 + 5);
    });
    const dict = new PdfDict()
      .set('Type', new PdfName('XRef'))
      .set('Size', xrefNum + 1)
      .set('W', [1, 4, 2])
      .set('Index', runs(nums).flat())
      .set('Length', rows.length);
    for (const [key, value] of trailer.entries) {
      dict.set(key, value);
    }
    push(`${xrefNum} 0 obj\n${serialize(dict)}\nstream\n`);
    push(rows);
    push('\nendstream\nendobj\n');
  } else {
    xrefOffset = length;
    let table = 'xref\n';
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    for (const [start, count] of runs(nums)) {
      table += `${start} ${count}\n`;
      for (let num = start; num < start + count; num++) {
        const { offset, gen } = offsets.get(num)!;
        table += `${String(offset).padStart(10, '0')} ${String(gen).padStart(5, '0')} n \n`;
      }
    }
    trailer.set('Size', size);
    push(`${table}trailer\n${serialize(trailer)}\n`);
  }
  push(`startxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks, length);
}

/** Sorted numbers as [start, count] runs of consecutive values. */
function runs(nums: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const num of nums) {
    const last = out[out.length - 1];
    if (last && last[0] + last[1] === num) {
      last[1]++;
    } else {
      out.push([num, 1]);
    }
  }
  return out;
}
