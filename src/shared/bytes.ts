// Byte helpers for sending the PDF across the webview postMessage bridge.

/**
 * Copies `data` into an ArrayBuffer that holds exactly its bytes.
 *
 * `workspace.fs.readFile` can return a Node Buffer that is a view into a larger
 * shared pool; posting `data.buffer` would send the whole pool, and posting the
 * view itself does not reliably survive the webview bridge.
 */
export function toStandaloneArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/**
 * Normalises whatever arrived in a `load` message into bytes. Accepts an
 * ArrayBuffer, any ArrayBuffer view, a JSON-serialised Node Buffer
 * (`{ type: 'Buffer', data: [...] }`) or an index-keyed object of numbers
 * (what a Uint8Array becomes after JSON serialisation).
 */
export function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data && typeof data === 'object') {
    const obj = data as { type?: string; data?: unknown };
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return Uint8Array.from(obj.data as number[]);
    }
    const values = Object.values(data);
    if (values.length > 0 && values.every((v) => typeof v === 'number')) {
      return Uint8Array.from(values as number[]);
    }
  }
  return undefined;
}
