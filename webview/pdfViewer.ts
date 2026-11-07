import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { FromViewerMessage, PageRect, ToViewerMessage } from '../src/shared/messages';
import './pdfViewer.css';

declare function acquireVsCodeApi(): {
  postMessage(msg: FromViewerMessage): void;
  getState(): ViewState | undefined;
  setState(state: ViewState): void;
};

type Zoom = 'page-width' | 'page-fit' | number;

interface ViewState {
  zoom: Zoom;
}

interface PageView {
  index: number;
  page: PDFPageProxy;
  /** Page size in PDF points at scale 1. */
  width: number;
  height: number;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  renderedScale: number;
  task: RenderTask | null;
}

const vscode = acquireVsCodeApi();
const body = document.body.dataset;
pdfjs.GlobalWorkerOptions.workerSrc = body.worker!;

// Webview resources are served from a different origin than the webview document,
// and browsers refuse to start a (module) worker from a cross-origin URL. Load the
// worker source ourselves and start it from a same-origin blob: URL instead.
const workerReady: Promise<void> = (async () => {
  try {
    const res = await fetch(body.worker!);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const blob = new Blob([await res.text()], { type: 'text/javascript' });
    const worker = new Worker(URL.createObjectURL(blob), { type: 'module' });
    pdfjs.GlobalWorkerOptions.workerPort = worker;
  } catch (err) {
    // Fall back to workerSrc; PDF.js then tries a direct worker or its main-thread fallback.
    vscode.postMessage({ type: 'error', message: `Could not start PDF worker from blob: ${String(err)}` });
  }
})();
const modifierKey = body.modifier === 'meta' ? 'metaKey' : 'ctrlKey';

const viewer = document.getElementById('viewer') as HTMLDivElement;
const pagesEl = document.getElementById('pages') as HTMLDivElement;
const emptyEl = document.getElementById('empty') as HTMLParagraphElement;
const zoomSelect = document.getElementById('zoom') as HTMLSelectElement;
const pageInfo = document.getElementById('page-info') as HTMLSpanElement;

const PAGE_GAP = 12;
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

let doc: PDFDocumentProxy | null = null;
let pages: PageView[] = [];
let zoom: Zoom = vscode.getState()?.zoom ?? 'page-width';
let scale = 1;
let loadSeq = 0;

const visibility = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const view = pages[Number((entry.target as HTMLElement).dataset.index)];
      if (!view) {
        continue;
      }
      if (entry.isIntersecting) {
        render(view);
      } else {
        release(view);
      }
    }
  },
  { root: viewer, rootMargin: '100% 0px' }
);

// ---- Loading ----

async function load(data: Uint8Array): Promise<void> {
  const seq = ++loadSeq;
  const anchor = captureAnchor();
  let next: PDFDocumentProxy;
  await workerReady;
  try {
    next = await pdfjs.getDocument({
      data,
      cMapUrl: body.cmaps,
      cMapPacked: true,
      standardFontDataUrl: body.fonts,
      wasmUrl: body.wasm,
    }).promise;
  } catch (err) {
    report(`Could not open PDF: ${String(err)}`);
    return;
  }
  if (seq !== loadSeq) {
    void next.loadingTask.destroy();
    return; // A newer build arrived while this one was parsing.
  }

  const views: PageView[] = [];
  for (let i = 1; i <= next.numPages; i++) {
    const page = await next.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    views.push({ index: i - 1, page, width: vp.width, height: vp.height, el: null!, canvas: null, renderedScale: 0, task: null });
  }
  if (seq !== loadSeq) {
    void next.loadingTask.destroy();
    return;
  }

  const previous = doc;
  doc = next;
  pages = views;
  emptyEl.hidden = true;
  rebuildPageElements();
  restoreAnchor(anchor);
  updatePageInfo();
  void previous?.loadingTask.destroy();
}

function rebuildPageElements(): void {
  visibility.disconnect();
  scale = resolveScale();
  const fragment = document.createDocumentFragment();
  for (const view of pages) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.index = String(view.index);
    setPageSize(el, view);
    view.el = el;
    fragment.appendChild(el);
    visibility.observe(el);
  }
  pagesEl.replaceChildren(fragment);
}

// ---- Rendering ----

function setPageSize(el: HTMLElement, view: PageView): void {
  el.style.width = `${Math.floor(view.width * scale)}px`;
  el.style.height = `${Math.floor(view.height * scale)}px`;
}

function render(view: PageView): void {
  if (view.renderedScale === scale && view.canvas) {
    return;
  }
  view.task?.cancel();

  const dpr = window.devicePixelRatio || 1;
  const viewport = view.page.getViewport({ scale: scale * dpr });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(view.width * scale)}px`;
  canvas.style.height = `${Math.floor(view.height * scale)}px`;

  const renderScale = scale;
  const task = view.page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport });
  view.task = task;
  task.promise.then(
    () => {
      if (view.task !== task) {
        return;
      }
      view.task = null;
      view.canvas?.remove();
      view.canvas = canvas;
      view.renderedScale = renderScale;
      view.el.prepend(canvas);
    },
    (err: unknown) => {
      if (!(err instanceof pdfjs.RenderingCancelledException)) {
        report(`Render failed on page ${view.index + 1}: ${String(err)}`);
      }
    }
  );
}

/** Frees the canvas of a page that scrolled far out of view; long papers would otherwise hold every page in memory. */
function release(view: PageView): void {
  view.task?.cancel();
  view.task = null;
  view.canvas?.remove();
  view.canvas = null;
  view.renderedScale = 0;
}

function resolveScale(): number {
  if (typeof zoom === 'number') {
    return zoom;
  }
  const first = pages[0];
  if (!first) {
    return 1;
  }
  const availableWidth = viewer.clientWidth - 2 * PAGE_GAP;
  const widthScale = availableWidth / first.width;
  if (zoom === 'page-width') {
    return Math.max(0.1, widthScale);
  }
  const heightScale = (viewer.clientHeight - 2 * PAGE_GAP) / first.height;
  return Math.max(0.1, Math.min(widthScale, heightScale));
}

function applyZoom(next: Zoom): void {
  const anchor = captureAnchor();
  zoom = next;
  vscode.setState({ zoom });
  syncZoomSelect();
  scale = resolveScale();
  for (const view of pages) {
    setPageSize(view.el, view);
    view.canvas?.style.setProperty('width', `${Math.floor(view.width * scale)}px`);
    view.canvas?.style.setProperty('height', `${Math.floor(view.height * scale)}px`);
  }
  restoreAnchor(anchor);
  // Re-render what is on screen at the new resolution.
  visibility.disconnect();
  pages.forEach((v) => visibility.observe(v.el));
}

function syncZoomSelect(): void {
  const value = String(zoom);
  let option = Array.from(zoomSelect.options).find((o) => o.value === value);
  zoomSelect.querySelector('option[data-custom]')?.remove();
  if (!option) {
    option = new Option(`${Math.round(Number(zoom) * 100)}%`, value);
    option.dataset.custom = '';
    zoomSelect.add(option);
  }
  zoomSelect.value = value;
}

// ---- Scroll position across reloads and zoom changes ----

interface Anchor {
  page: number;
  /** Fraction of the page height at the top of the viewport. */
  offset: number;
}

function captureAnchor(): Anchor | null {
  const top = viewer.scrollTop;
  for (const view of pages) {
    const bottom = view.el.offsetTop + view.el.offsetHeight;
    if (bottom > top) {
      return { page: view.index, offset: (top - view.el.offsetTop) / view.el.offsetHeight };
    }
  }
  return null;
}

function restoreAnchor(anchor: Anchor | null): void {
  if (!anchor) {
    return;
  }
  const view = pages[Math.min(anchor.page, pages.length - 1)];
  if (view) {
    viewer.scrollTop = view.el.offsetTop + anchor.offset * view.el.offsetHeight;
  }
}

function updatePageInfo(): void {
  const anchor = captureAnchor();
  pageInfo.textContent = pages.length ? `${(anchor?.page ?? 0) + 1} / ${pages.length}` : '';
}

// ---- SyncTeX ----

function reveal(target: PageRect): void {
  const view = pages[target.page - 1];
  if (!view) {
    return;
  }
  const top = view.el.offsetTop + target.y * scale;
  viewer.scrollTo({ top: Math.max(0, top - viewer.clientHeight / 3), behavior: 'smooth' });

  const marker = document.createElement('div');
  marker.className = 'synctex-marker';
  const width = target.width > 0 ? target.width : view.width - 2 * target.x;
  marker.style.left = `${target.x * scale}px`;
  marker.style.top = `${target.y * scale}px`;
  marker.style.width = `${Math.max(width, 8) * scale}px`;
  marker.style.height = `${Math.max(target.height, 8) * scale}px`;
  view.el.appendChild(marker);
  marker.addEventListener('animationend', () => marker.remove());
}

pagesEl.addEventListener('click', (event) => {
  if (!event[modifierKey]) {
    return;
  }
  const pageEl = (event.target as HTMLElement).closest<HTMLElement>('.page');
  if (!pageEl) {
    return;
  }
  const rect = pageEl.getBoundingClientRect();
  vscode.postMessage({
    type: 'inverseSearch',
    page: Number(pageEl.dataset.index) + 1,
    x: (event.clientX - rect.left) / scale,
    y: (event.clientY - rect.top) / scale,
  });
});

// ---- Wiring ----

function report(message: string): void {
  vscode.postMessage({ type: 'error', message });
}

function stepZoom(direction: 1 | -1): void {
  const index = ZOOM_STEPS.findIndex((s) => (direction > 0 ? s > scale + 0.01 : s >= scale - 0.01));
  const next = direction > 0 ? ZOOM_STEPS[index === -1 ? ZOOM_STEPS.length - 1 : index] : ZOOM_STEPS[Math.max(0, (index === -1 ? ZOOM_STEPS.length : index) - 1)];
  applyZoom(next);
}

document.getElementById('zoom-in')!.addEventListener('click', () => stepZoom(1));
document.getElementById('zoom-out')!.addEventListener('click', () => stepZoom(-1));
zoomSelect.addEventListener('change', () => {
  const value = zoomSelect.value;
  applyZoom(value === 'page-width' || value === 'page-fit' ? value : Number(value));
});

viewer.addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      stepZoom(event.deltaY < 0 ? 1 : -1);
    }
  },
  { passive: false }
);

viewer.addEventListener('scroll', updatePageInfo, { passive: true });

let resizeTimer: number | undefined;
new ResizeObserver(() => {
  if (typeof zoom !== 'number') {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => applyZoom(zoom), 100);
  }
}).observe(viewer);

/** Normalises PDF bytes from postMessage: ArrayBuffer, typed array, or a JSON-ified Buffer. */
function toBytes(data: unknown): Uint8Array | undefined {
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

window.addEventListener('message', (event: MessageEvent<ToViewerMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'load': {
      const bytes = toBytes(msg.data);
      if (bytes) {
        void load(bytes);
      } else {
        vscode.postMessage({ type: 'error', message: 'Received PDF data in an unexpected format.' });
      }
      break;
    }
    case 'reveal':
      reveal(msg.target);
      break;
  }
});

syncZoomSelect();
vscode.postMessage({ type: 'ready' });
