// A small reader for the PDF object syntax (ISO 32000-1, section 7.3), enough to find pages and
// rewrite one object in an incremental update. It is not a general PDF library: content streams are
// never parsed, and only the filters TeX engines use for cross-reference and object streams are known.

import * as zlib from 'zlib';

export class PdfName {
  constructor(readonly name: string) {}
}

export class PdfRef {
  constructor(
    readonly num: number,
    readonly gen: number
  ) {}
}

/** A string's bytes as they are in the file, after escapes are undone. */
export class PdfString {
  constructor(readonly bytes: Buffer) {}
}

export class PdfDict {
  constructor(readonly entries: Map<string, PdfObject> = new Map()) {}

  get(key: string): PdfObject | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: PdfObject): this {
    this.entries.set(key, value);
    return this;
  }
}

export type PdfObject = null | boolean | number | PdfName | PdfRef | PdfString | PdfDict | PdfObject[];

export class PdfError extends Error {}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isRegular(c: number): boolean {
  return !WHITESPACE.has(c) && !DELIMITERS.has(c);
}

export interface Parsed<T> {
  value: T;
  end: number;
}

/** Reads objects from a buffer. Offsets are byte offsets into it. */
export class Lexer {
  constructor(readonly buf: Buffer) {}

  skipSpace(pos: number): number {
    const b = this.buf;
    while (pos < b.length) {
      const c = b[pos];
      if (WHITESPACE.has(c)) {
        pos++;
      } else if (c === 0x25) {
        while (pos < b.length && b[pos] !== 0x0a && b[pos] !== 0x0d) {
          pos++;
        }
      } else {
        break;
      }
    }
    return pos;
  }

  /** A keyword or number token at `pos`, after whitespace. */
  word(pos: number): Parsed<string> {
    const start = this.skipSpace(pos);
    let end = start;
    while (end < this.buf.length && isRegular(this.buf[end])) {
      end++;
    }
    return { value: this.buf.toString('latin1', start, end), end };
  }

  expectWord(pos: number, word: string): number {
    const got = this.word(pos);
    if (got.value !== word) {
      throw new PdfError(`expected "${word}" at offset ${pos}, found "${got.value.slice(0, 20)}"`);
    }
    return got.end;
  }

  parseObject(pos: number, depth = 0): Parsed<PdfObject> {
    if (depth > 100) {
      throw new PdfError('objects nested too deeply');
    }
    const b = this.buf;
    pos = this.skipSpace(pos);
    if (pos >= b.length) {
      throw new PdfError('unexpected end of file');
    }
    const c = b[pos];
    if (c === 0x3c && b[pos + 1] === 0x3c) {
      return this.parseDict(pos + 2, depth);
    }
    if (c === 0x3c) {
      return this.parseHexString(pos + 1);
    }
    if (c === 0x28) {
      return this.parseLiteralString(pos + 1);
    }
    if (c === 0x5b) {
      const items: PdfObject[] = [];
      let p = pos + 1;
      for (;;) {
        p = this.skipSpace(p);
        if (p >= b.length) {
          throw new PdfError('unterminated array');
        }
        if (b[p] === 0x5d) {
          return { value: items, end: p + 1 };
        }
        const item = this.parseObject(p, depth + 1);
        items.push(item.value);
        p = item.end;
      }
    }
    if (c === 0x2f) {
      return this.parseName(pos + 1);
    }
    const token = this.word(pos);
    if (token.value === 'true' || token.value === 'false') {
      return { value: token.value === 'true', end: token.end };
    }
    if (token.value === 'null') {
      return { value: null, end: token.end };
    }
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token.value)) {
      throw new PdfError(`unexpected "${token.value.slice(0, 20)}" at offset ${pos}`);
    }
    const num = Number(token.value);
    // `12 0 R` is a reference; look ahead without committing.
    if (/^\d+$/.test(token.value)) {
      const gen = this.word(token.end);
      if (/^\d+$/.test(gen.value)) {
        const r = this.word(gen.end);
        if (r.value === 'R') {
          return { value: new PdfRef(num, Number(gen.value)), end: r.end };
        }
      }
    }
    return { value: num, end: token.end };
  }

  private parseDict(pos: number, depth: number): Parsed<PdfDict> {
    const dict = new PdfDict();
    const b = this.buf;
    for (;;) {
      pos = this.skipSpace(pos);
      if (pos >= b.length) {
        throw new PdfError('unterminated dictionary');
      }
      if (b[pos] === 0x3e && b[pos + 1] === 0x3e) {
        return { value: dict, end: pos + 2 };
      }
      if (b[pos] !== 0x2f) {
        throw new PdfError(`expected a name in a dictionary at offset ${pos}`);
      }
      const key = this.parseName(pos + 1);
      const value = this.parseObject(key.end, depth + 1);
      dict.set(key.value.name, value.value);
      pos = value.end;
    }
  }

  private parseName(pos: number): Parsed<PdfName> {
    const b = this.buf;
    const bytes: number[] = [];
    while (pos < b.length && isRegular(b[pos])) {
      if (b[pos] === 0x23 && pos + 2 < b.length && /^[0-9a-fA-F]{2}$/.test(b.toString('latin1', pos + 1, pos + 3))) {
        bytes.push(parseInt(b.toString('latin1', pos + 1, pos + 3), 16));
        pos += 3;
      } else {
        bytes.push(b[pos++]);
      }
    }
    return { value: new PdfName(Buffer.from(bytes).toString('latin1')), end: pos };
  }

  private parseHexString(pos: number): Parsed<PdfString> {
    const end = this.buf.indexOf(0x3e, pos);
    if (end < 0) {
      throw new PdfError('unterminated hex string');
    }
    let hex = this.buf.toString('latin1', pos, end).replace(/[^0-9a-fA-F]/g, '');
    if (hex.length % 2) {
      hex += '0';
    }
    return { value: new PdfString(Buffer.from(hex, 'hex')), end: end + 1 };
  }

  private parseLiteralString(pos: number): Parsed<PdfString> {
    const b = this.buf;
    const out: number[] = [];
    let nesting = 1;
    while (pos < b.length) {
      const c = b[pos++];
      if (c === 0x5c) {
        const e = b[pos++];
        const simple: Record<number, number> = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (e in simple) {
          out.push(simple[e]);
        } else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let i = 0; i < 2 && b[pos] >= 0x30 && b[pos] <= 0x37; i++) {
            v = v * 8 + (b[pos++] - 0x30);
          }
          out.push(v & 0xff);
        } else if (e === 0x0d) {
          if (b[pos] === 0x0a) {
            pos++;
          }
        } else if (e !== 0x0a) {
          out.push(e);
        }
      } else if (c === 0x28) {
        nesting++;
        out.push(c);
      } else if (c === 0x29) {
        if (--nesting === 0) {
          return { value: new PdfString(Buffer.from(out)), end: pos };
        }
        out.push(c);
      } else {
        out.push(c);
      }
    }
    throw new PdfError('unterminated string');
  }
}

// ---- Writing ----

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new PdfError(`cannot write the number ${n}`);
  }
  if (Number.isInteger(n)) {
    return String(n);
  }
  const s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

function formatName(name: string): string {
  let out = '/';
  for (const byte of Buffer.from(name, 'latin1')) {
    out += byte > 0x20 && byte < 0x7f && byte !== 0x23 && isRegular(byte) ? String.fromCharCode(byte) : `#${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

export function serialize(value: PdfObject): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return formatNumber(value);
  }
  if (value instanceof PdfName) {
    return formatName(value.name);
  }
  if (value instanceof PdfRef) {
    return `${value.num} ${value.gen} R`;
  }
  if (value instanceof PdfString) {
    return `<${value.bytes.toString('hex')}>`;
  }
  if (value instanceof PdfDict) {
    let out = '<<';
    for (const [key, v] of value.entries) {
      out += `${formatName(key)} ${serialize(v)}`;
    }
    return `${out}>>`;
  }
  return `[${value.map(serialize).join(' ')}]`;
}

/** A text string (7.9.2.2) that any reader decodes: UTF-16BE with a byte order mark. */
export function textString(text: string): PdfString {
  const units = Buffer.alloc(2 + text.length * 2);
  units[0] = 0xfe;
  units[1] = 0xff;
  for (let i = 0; i < text.length; i++) {
    units.writeUInt16BE(text.charCodeAt(i), 2 + i * 2);
  }
  return new PdfString(units);
}

// ---- Streams ----

function pngUnpredict(data: Buffer, columns: number, colors: number, bits: number): Buffer {
  const bpp = Math.max(1, Math.ceil((colors * bits) / 8));
  const rowLength = Math.ceil((columns * colors * bits) / 8);
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = Buffer.alloc(rows * rowLength);
  let prev = Buffer.alloc(rowLength);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLength + 1)];
    const row = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
    const cur = out.subarray(r * rowLength, (r + 1) * rowLength);
    for (let i = 0; i < rowLength; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (type === 1) {
        v += left;
      } else if (type === 2) {
        v += up;
      } else if (type === 3) {
        v += (left + up) >> 1;
      } else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (type !== 0) {
        throw new PdfError(`unknown PNG predictor ${type}`);
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return out;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** Undoes the stream's filters. Only FlateDecode, with or without a PNG predictor, is supported. */
export function decodeStream(dict: PdfDict, raw: Buffer): Buffer {
  const filters = asArray(dict.get('Filter') as PdfName | PdfName[] | undefined);
  const params = asArray(dict.get('DecodeParms') as PdfDict | null | (PdfDict | null)[] | undefined);
  let data = raw;
  filters.forEach((filter, i) => {
    if (!(filter instanceof PdfName) || (filter.name !== 'FlateDecode' && filter.name !== 'Fl')) {
      throw new PdfError(`the ${filter instanceof PdfName ? filter.name : 'unknown'} filter is not supported`);
    }
    data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    const p = params[i];
    const predictor = p instanceof PdfDict ? (p.get('Predictor') as number | undefined) ?? 1 : 1;
    if (predictor >= 10) {
      const num = (key: string, fallback: number): number => (p instanceof PdfDict && typeof p.get(key) === 'number' ? (p.get(key) as number) : fallback);
      data = pngUnpredict(data, num('Columns', 1), num('Colors', 1), num('BitsPerComponent', 8));
    } else if (predictor !== 1) {
      throw new PdfError(`predictor ${predictor} is not supported`);
    }
  });
  return data;
}
