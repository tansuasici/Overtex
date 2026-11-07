import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { FromViewerMessage, PageRect, ToViewerMessage } from '../src/shared/messages';
import { toBytes } from '../src/shared/bytes';
import { startBlobWorker } from '../src/shared/blobWorker';
import { isDarkScheme, isDarkThemeKind, parseColorScheme } from '../src/shared/colorScheme';
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

// The worker URL is cross-origin to the webview, so start it from a blob: (see startBlobWorker).
const workerReady: Promise<void> = (async () => {
  try {
    pdfjs.GlobalWorkerOptions.workerPort = await startBlobWorker(body.worker!, {
      fetch: (url) => fetch(url),
      createObjectURL: (blob) => URL.createObjectURL(blob),
      createWorker: (url, options) => new Worker(url, options),
    });
  } catch (err) {
    // Fall back to workerSrc; PDF.js then tries a direct worker or its main-thread fallback.
    vscode.postMessage({ type: 'error', message: `Could not start PDF worker from blob: ${String(err)}` });
  }
})();
const modifierKey = body.modifier === 'meta' ? 'metaKey' : 'ctrlKey';
/** Set only when the extension host runs the end-to-end tests. */
const e2e = body.e2e !== undefined;

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
  if (e2e) {
    vscode.postMessage({ type: 'e2e:loaded', pages: pages.length });
  }
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
  if (e2e) {
    void reportReveal(view, target, Math.max(target.height, 8));
  }
}

// ---- End-to-end test hooks ----

/** Resolves once a smooth scroll has stopped moving (or after 5 s). */
async function scrollSettled(): Promise<void> {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const end = performance.now() + 5000;
  let last = viewer.scrollTop;
  let still = 0;
  while (still < 10 && performance.now() < end) {
    await frame();
    still = viewer.scrollTop === last ? still + 1 : 0;
    last = viewer.scrollTop;
  }
}

async function reportReveal(view: PageView, target: PageRect, height: number): Promise<void> {
  await scrollSettled();
  const top = view.el.offsetTop + target.y * scale - viewer.scrollTop;
  const bottom = top + height * scale;
  vscode.postMessage({ type: 'e2e:revealed', target, inView: top >= 0 && bottom <= viewer.clientHeight });
}

/** Clicks like a user would: scrolls the point into view and dispatches a modifier-click there. */
async function e2eClick(page: number, x: number, y: number): Promise<void> {
  const view = pages[page - 1];
  if (!view) {
    report(`e2e:click: no page ${page}`);
    return;
  }
  viewer.scrollTop = view.el.offsetTop + y * scale - viewer.clientHeight / 2;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const rect = view.el.getBoundingClientRect();
  const clientX = rect.left + x * scale;
  const clientY = rect.top + y * scale;
  const target = document.elementFromPoint(clientX, clientY) ?? view.el;
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY, [modifierKey]: true }));
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

// Dark pages: the scheme comes from the setting, `auto` follows the theme kind VS Code keeps on <body>.
const darkButton = document.getElementById('dark-mode') as HTMLButtonElement;

function applyColorScheme(): void {
  const dark = isDarkScheme(parseColorScheme(body.scheme), isDarkThemeKind(body.vscodeThemeKind));
  document.body.classList.toggle('dark-pages', dark);
  darkButton.setAttribute('aria-pressed', String(dark));
  darkButton.title = dark ? 'Light pages' : 'Dark pages';
  if (e2e) {
    vscode.postMessage({ type: 'e2e:colorScheme', dark });
  }
}

darkButton.addEventListener('click', () => vscode.postMessage({ type: 'toggleColorScheme' }));
new MutationObserver(applyColorScheme).observe(document.body, { attributes: true, attributeFilter: ['data-vscode-theme-kind'] });
applyColorScheme();

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
    case 'colorScheme':
      body.scheme = msg.scheme;
      applyColorScheme();
      break;
    case 'e2e:click':
      if (e2e) {
        void e2eClick(msg.page, msg.x, msg.y);
      }
      break;
  }
});

syncZoomSelect();
vscode.postMessage({ type: 'ready' });
