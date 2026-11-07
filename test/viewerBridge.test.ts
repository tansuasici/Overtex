import { describe, expect, it, vi } from 'vitest';
import { toBytes, toStandaloneArrayBuffer } from '../src/shared/bytes';
import { startBlobWorker } from '../src/shared/blobWorker';

// Regression tests for two bugs that only showed up in a real VS Code webview:
// 1. "Invalid PDF binary data": the PDF bytes did not survive postMessage.
// 2. The PDF hung forever: the module worker was started from a cross-origin URL.

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

describe('toStandaloneArrayBuffer', () => {
  it('copies only the view, not the shared Buffer pool behind it', () => {
    const buf = Buffer.from(PDF_HEADER); // small Buffers are views into an 8 KiB pool
    expect(buf.buffer.byteLength).toBeGreaterThan(buf.byteLength);

    const out = toStandaloneArrayBuffer(buf);
    expect(out.byteLength).toBe(PDF_HEADER.length);
    expect([...new Uint8Array(out)]).toEqual(PDF_HEADER);
  });

  it('honours a non-zero byteOffset', () => {
    const backing = new Uint8Array([9, 9, ...PDF_HEADER, 9]);
    const view = backing.subarray(2, 2 + PDF_HEADER.length);
    expect([...new Uint8Array(toStandaloneArrayBuffer(view))]).toEqual(PDF_HEADER);
  });

  it('survives structured cloning intact', () => {
    const cloned = structuredClone(toStandaloneArrayBuffer(Buffer.from(PDF_HEADER)));
    expect(cloned).toBeInstanceOf(ArrayBuffer);
    expect([...toBytes(cloned)!]).toEqual(PDF_HEADER);
  });
});

describe('toBytes', () => {
  it('accepts an ArrayBuffer', () => {
    expect([...toBytes(new Uint8Array(PDF_HEADER).buffer)!]).toEqual(PDF_HEADER);
  });

  it('accepts a typed-array view with an offset', () => {
    const view = new Uint8Array([0, ...PDF_HEADER]).subarray(1);
    expect([...toBytes(view)!]).toEqual(PDF_HEADER);
  });

  it('accepts a JSON-serialised Node Buffer', () => {
    const json = JSON.parse(JSON.stringify(Buffer.from(PDF_HEADER)));
    expect(json.type).toBe('Buffer');
    expect([...toBytes(json)!]).toEqual(PDF_HEADER);
  });

  it('accepts a JSON-serialised Uint8Array (index-keyed object)', () => {
    const json = JSON.parse(JSON.stringify(new Uint8Array(PDF_HEADER)));
    expect(Array.isArray(json)).toBe(false);
    expect([...toBytes(json)!]).toEqual(PDF_HEADER);
  });

  it('rejects data that is not bytes', () => {
    expect(toBytes(undefined)).toBeUndefined();
    expect(toBytes('abc')).toBeUndefined();
    expect(toBytes({})).toBeUndefined();
    expect(toBytes({ a: 'x' })).toBeUndefined();
  });
});

describe('startBlobWorker', () => {
  const workerUrl = 'https://file+.vscode-resource.vscode-cdn.net/ext/out/webview/pdf.worker.min.mjs';

  it('starts the worker from a blob: URL, never from the cross-origin URL', async () => {
    const createWorker = vi.fn((url: string) => ({ url }));
    const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'self.onmessage = () => {};' }));
    let blob: Blob | undefined;

    const worker = await startBlobWorker(workerUrl, {
      fetch,
      createObjectURL: (b) => ((blob = b), 'blob:vscode-webview://abc/123'),
      createWorker,
    });

    expect(fetch).toHaveBeenCalledWith(workerUrl);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(createWorker).toHaveBeenCalledWith('blob:vscode-webview://abc/123', { type: 'module' });
    expect(worker.url.startsWith('blob:')).toBe(true);
    expect(blob?.type).toBe('text/javascript');
    expect(await blob?.text()).toBe('self.onmessage = () => {};');
  });

  it('fails without starting a worker when the source cannot be fetched', async () => {
    const createWorker = vi.fn();
    await expect(
      startBlobWorker(workerUrl, {
        fetch: async () => ({ ok: false, status: 404, text: async () => '' }),
        createObjectURL: () => 'blob:x',
        createWorker,
      })
    ).rejects.toThrow('HTTP 404');
    expect(createWorker).not.toHaveBeenCalled();
  });
});
