// Starting the PDF.js worker inside a VS Code webview.

export interface BlobWorkerDeps<W> {
  fetch: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  createObjectURL: (blob: Blob) => string;
  createWorker: (url: string, options: { type: 'module' }) => W;
}

/**
 * Starts a module worker from a same-origin blob: URL holding the source at `url`.
 *
 * Webview resources are served from a different origin than the webview document,
 * and browsers refuse to start a worker from a cross-origin URL. So the source is
 * fetched (allowed by the CSP's connect-src) and the worker is started from a blob:.
 * The worker must never be constructed with `url` directly.
 */
export async function startBlobWorker<W>(url: string, deps: BlobWorkerDeps<W>): Promise<W> {
  const res = await deps.fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const blob = new Blob([await res.text()], { type: 'text/javascript' });
  return deps.createWorker(deps.createObjectURL(blob), { type: 'module' });
}
