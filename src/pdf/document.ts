// Reads a PDF's cross-reference data and page tree: what an incremental update needs to know.
// Handles classic xref tables, xref streams, hybrid files and object streams, which together cover
// what pdfTeX, LuaTeX, XeTeX (dvipdfmx) and most other producers write.

import { decodeStream, Lexer, PdfDict, PdfError, PdfName, PdfObject, PdfRef } from './objects';

type XrefEntry = { type: 'free' } | { type: 'offset'; offset: number; gen: number } | { type: 'compressed'; stream: number; index: number };

export interface PdfPage {
  /** 1-based. */
  number: number;
  ref: PdfRef;
  /** The page dictionary's own entries, without inherited ones. */
  dict: PdfDict;
  mediaBox: number[];
  cropBox: number[];
  rotate: number;
}

interface Loaded {
  value: PdfObject;
  stream?: Buffer;
}

export class PdfDocument {
  readonly lexer: Lexer;
  readonly trailer: PdfDict;
  /** Whether the newest cross-reference section is a stream; an update should write the same kind. */
  readonly xrefIsStream: boolean;
  readonly startxref: number;
  private readonly entries = new Map<number, XrefEntry>();
  private readonly cache = new Map<number, Loaded>();
  private readonly objStreams = new Map<number, { data: Buffer; offsets: Map<number, number> }>();

  constructor(readonly bytes: Buffer) {
    this.lexer = new Lexer(bytes);
    this.startxref = findStartxref(bytes);
    const visited = new Set<number>();
    let offset: number | undefined = this.startxref;
    let newest: PdfDict | undefined;
    let newestIsStream = false;
    while (offset !== undefined) {
      if (visited.has(offset) || visited.size > 1000) {
        throw new PdfError('the cross-reference sections loop');
      }
      visited.add(offset);
      const section = this.readSection(offset);
      if (!newest) {
        newest = section.trailer;
        newestIsStream = section.isStream;
      }
      const prev = section.trailer.get('Prev');
      offset = typeof prev === 'number' ? prev : undefined;
    }
    this.trailer = newest!;
    this.xrefIsStream = newestIsStream;
    if (this.trailer.get('Encrypt') !== undefined) {
      throw new PdfError('the PDF is encrypted');
    }
  }

  /** The trailer's /Size: the first object number an update can use. */
  get size(): number {
    const size = this.trailer.get('Size');
    if (typeof size !== 'number' || size < 1) {
      throw new PdfError('the trailer has no /Size');
    }
    return Math.max(size, ...[...this.entries.keys()].map((n) => n + 1));
  }

  /** The generation an updated copy of the object must use. Objects from object streams have 0. */
  generation(num: number): number {
    const entry = this.entries.get(num);
    return entry?.type === 'offset' ? entry.gen : 0;
  }

  resolve(value: PdfObject | undefined, depth = 0): PdfObject | undefined {
    if (value instanceof PdfRef) {
      if (depth > 32) {
        throw new PdfError('references loop');
      }
      return this.resolve(this.load(value.num)?.value, depth + 1);
    }
    return value;
  }

  dict(value: PdfObject | undefined): PdfDict | undefined {
    const v = this.resolve(value);
    return v instanceof PdfDict ? v : undefined;
  }

  pages(): PdfPage[] {
    const root = this.dict(this.trailer.get('Root'));
    const top = root?.get('Pages');
    if (!(top instanceof PdfRef)) {
      throw new PdfError('the document catalog has no page tree');
    }
    const pages: PdfPage[] = [];
    const seen = new Set<number>();
    const walk = (ref: PdfRef, inherited: { mediaBox?: number[]; cropBox?: number[]; rotate?: number }, depth: number): void => {
      if (seen.has(ref.num) || depth > 64) {
        throw new PdfError('the page tree loops');
      }
      seen.add(ref.num);
      const node = this.dict(ref);
      if (!node) {
        throw new PdfError(`page tree node ${ref.num} is missing`);
      }
      const here = {
        mediaBox: this.box(node.get('MediaBox')) ?? inherited.mediaBox,
        cropBox: this.box(node.get('CropBox')) ?? inherited.cropBox,
        rotate: (() => {
          const r = this.resolve(node.get('Rotate'));
          return typeof r === 'number' ? r : inherited.rotate;
        })(),
      };
      const type = this.resolve(node.get('Type'));
      const kids = this.resolve(node.get('Kids'));
      if ((type instanceof PdfName && type.name === 'Pages') || (!(type instanceof PdfName) && Array.isArray(kids))) {
        for (const kid of Array.isArray(kids) ? kids : []) {
          if (kid instanceof PdfRef) {
            walk(kid, here, depth + 1);
          }
        }
        return;
      }
      const mediaBox = here.mediaBox ?? [0, 0, 612, 792];
      pages.push({ number: pages.length + 1, ref, dict: node, mediaBox, cropBox: here.cropBox ?? mediaBox, rotate: here.rotate ?? 0 });
    };
    walk(top, {}, 0);
    return pages;
  }

  private box(value: PdfObject | undefined): number[] | undefined {
    const v = this.resolve(value);
    if (!Array.isArray(v) || v.length !== 4) {
      return undefined;
    }
    const nums = v.map((n) => this.resolve(n));
    return nums.every((n): n is number => typeof n === 'number') ? nums : undefined;
  }

  private load(num: number): Loaded | undefined {
    const cached = this.cache.get(num);
    if (cached) {
      return cached;
    }
    const entry = this.entries.get(num);
    let loaded: Loaded | undefined;
    if (entry?.type === 'offset') {
      loaded = this.readIndirect(entry.offset, num).loaded;
    } else if (entry?.type === 'compressed') {
      const stream = this.objectStream(entry.stream);
      const start = stream.offsets.get(num);
      if (start === undefined) {
        throw new PdfError(`object ${num} is not in object stream ${entry.stream}`);
      }
      loaded = { value: new Lexer(stream.data).parseObject(start).value };
    }
    if (loaded) {
      this.cache.set(num, loaded);
    }
    return loaded;
  }

  private objectStream(num: number): { data: Buffer; offsets: Map<number, number> } {
    let stream = this.objStreams.get(num);
    if (stream) {
      return stream;
    }
    const loaded = this.load(num);
    if (!(loaded?.value instanceof PdfDict) || !loaded.stream) {
      throw new PdfError(`object stream ${num} is missing`);
    }
    const data = decodeStream(loaded.value, loaded.stream);
    const n = loaded.value.get('N');
    const first = loaded.value.get('First');
    if (typeof n !== 'number' || typeof first !== 'number') {
      throw new PdfError(`object stream ${num} has no /N or /First`);
    }
    const lexer = new Lexer(data);
    const offsets = new Map<number, number>();
    let pos = 0;
    for (let i = 0; i < n; i++) {
      const objNum = lexer.parseObject(pos);
      const objOffset = lexer.parseObject(objNum.end);
      pos = objOffset.end;
      if (typeof objNum.value === 'number' && typeof objOffset.value === 'number') {
        offsets.set(objNum.value, first + objOffset.value);
      }
    }
    stream = { data, offsets };
    this.objStreams.set(num, stream);
    return stream;
  }

  /** Reads `num gen obj ... endobj` at `offset`, with its stream data when it has one. */
  private readIndirect(offset: number, expected?: number): { num: number; gen: number; loaded: Loaded } {
    const lexer = this.lexer;
    const num = lexer.word(offset);
    const gen = lexer.word(num.end);
    const pos = lexer.expectWord(gen.end, 'obj');
    if (!/^\d+$/.test(num.value) || !/^\d+$/.test(gen.value) || (expected !== undefined && Number(num.value) !== expected)) {
      throw new PdfError(`the cross-reference offset for object ${expected ?? '?'} is wrong`);
    }
    const object = lexer.parseObject(pos);
    const loaded: Loaded = { value: object.value };
    const next = lexer.word(object.end);
    if (next.value === 'stream' && object.value instanceof PdfDict) {
      let start = next.end;
      if (this.bytes[start] === 0x0d) {
        start++;
      }
      if (this.bytes[start] === 0x0a) {
        start++;
      }
      const length = this.resolve(object.value.get('Length'));
      if (typeof length !== 'number' || length < 0 || start + length > this.bytes.length) {
        throw new PdfError('a stream has no usable /Length');
      }
      loaded.stream = this.bytes.subarray(start, start + length);
    }
    return { num: Number(num.value), gen: Number(gen.value), loaded };
  }

  private setEntry(num: number, entry: XrefEntry): void {
    // Sections are read newest first, so the first entry seen for a number is the one that counts.
    if (!this.entries.has(num)) {
      this.entries.set(num, entry);
    }
  }

  private readSection(offset: number): { trailer: PdfDict; isStream: boolean } {
    const lexer = this.lexer;
    const first = lexer.word(offset);
    if (first.value !== 'xref') {
      return { trailer: this.readXrefStream(offset), isStream: true };
    }
    let pos = first.end;
    for (;;) {
      const start = lexer.word(pos);
      if (start.value === 'trailer') {
        pos = start.end;
        break;
      }
      const count = lexer.word(start.end);
      if (!/^\d+$/.test(start.value) || !/^\d+$/.test(count.value)) {
        throw new PdfError('the cross-reference table is malformed');
      }
      pos = count.end;
      for (let i = 0; i < Number(count.value); i++) {
        const off = lexer.word(pos);
        const gen = lexer.word(off.end);
        const kind = lexer.word(gen.end);
        pos = kind.end;
        const num = Number(start.value) + i;
        if (kind.value === 'n') {
          this.setEntry(num, { type: 'offset', offset: Number(off.value), gen: Number(gen.value) });
        } else if (kind.value === 'f') {
          this.setEntry(num, { type: 'free' });
        } else {
          throw new PdfError('the cross-reference table is malformed');
        }
      }
    }
    const trailer = lexer.parseObject(pos).value;
    if (!(trailer instanceof PdfDict)) {
      throw new PdfError('the trailer is not a dictionary');
    }
    // A hybrid file keeps objects that only newer readers know about in a separate stream.
    const xrefStm = trailer.get('XRefStm');
    if (typeof xrefStm === 'number') {
      this.readXrefStream(xrefStm);
    }
    return { trailer, isStream: false };
  }

  private readXrefStream(offset: number): PdfDict {
    const { loaded } = this.readIndirect(offset);
    const dict = loaded.value;
    if (!(dict instanceof PdfDict) || !loaded.stream || !(dict.get('Type') instanceof PdfName) || (dict.get('Type') as PdfName).name !== 'XRef') {
      throw new PdfError('startxref does not point at a cross-reference section');
    }
    const w = dict.get('W');
    const size = dict.get('Size');
    if (!Array.isArray(w) || w.length !== 3 || !w.every((n): n is number => typeof n === 'number') || typeof size !== 'number') {
      throw new PdfError('the cross-reference stream has no /W or /Size');
    }
    const index = dict.get('Index');
    const ranges = Array.isArray(index) && index.every((n) => typeof n === 'number') ? (index as number[]) : [0, size];
    const data = decodeStream(dict, loaded.stream);
    const rowLength = w[0] + w[1] + w[2];
    const field = (row: number, start: number, width: number): number => {
      let v = 0;
      for (let i = 0; i < width; i++) {
        v = v * 256 + data[row + start + i];
      }
      return v;
    };
    let row = 0;
    for (let r = 0; r + 1 < ranges.length; r += 2) {
      for (let i = 0; i < ranges[r + 1]; i++, row += rowLength) {
        if (row + rowLength > data.length) {
          throw new PdfError('the cross-reference stream is too short');
        }
        const type = w[0] === 0 ? 1 : field(row, 0, w[0]);
        const a = field(row, w[0], w[1]);
        const b = field(row, w[0] + w[1], w[2]);
        const num = ranges[r] + i;
        if (type === 0) {
          this.setEntry(num, { type: 'free' });
        } else if (type === 1) {
          this.setEntry(num, { type: 'offset', offset: a, gen: b });
        } else if (type === 2) {
          this.setEntry(num, { type: 'compressed', stream: a, index: b });
        }
      }
    }
    return dict;
  }
}

function findStartxref(bytes: Buffer): number {
  const tail = bytes.subarray(Math.max(0, bytes.length - 2048));
  const at = tail.lastIndexOf('startxref');
  if (at < 0) {
    throw new PdfError('the file has no startxref; it may not be a PDF');
  }
  const match = /^startxref\s+(\d+)/.exec(tail.toString('latin1', at, at + 40));
  if (!match) {
    throw new PdfError('startxref is malformed');
  }
  return Number(match[1]);
}
