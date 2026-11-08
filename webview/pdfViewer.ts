import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { FromViewerMessage, PageRect, ToViewerMessage } from '../src/shared/messages';
import type { Note } from '../src/shared/notes';
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
  notesVisible?: boolean;
}

interface PageView {
  index: number;
  page: PDFPageProxy;
  /** Page size in PDF points at scale 1. */
  width: number;
  height: number;
  el: HTMLDivElement;
  notesEl: HTMLDivElement;
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
    views.push({ index: i - 1, page, width: vp.width, height: vp.height, el: null!, notesEl: null!, canvas: null, renderedScale: 0, task: null });
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
    view.notesEl = document.createElement('div');
    view.notesEl.className = 'notes-layer';
    el.appendChild(view.notesEl);
    fragment.appendChild(el);
    visibility.observe(el);
  }
  // A build can finish while a note is being written; the editor moves to the new pages with its text.
  const typing = document.activeElement === noteText;
  pagesEl.replaceChildren(fragment);
  renderNotes();
  if (typing && editing) {
    noteText.focus({ preventScroll: true });
  }
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
  saveState();
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

/** Clicks like a user would: scrolls the point into view and dispatches a mouse event there. */
async function e2eMouse(type: 'click' | 'dblclick', page: number, x: number, y: number, init: MouseEventInit): Promise<void> {
  const view = pages[page - 1];
  if (!view) {
    report(`e2e:${type}: no page ${page}`);
    return;
  }
  viewer.scrollTop = view.el.offsetTop + y * scale - viewer.clientHeight / 2;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const rect = view.el.getBoundingClientRect();
  const clientX = rect.left + x * scale;
  const clientY = rect.top + y * scale;
  const target = document.elementFromPoint(clientX, clientY) ?? view.el;
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY, ...init }));
}

function e2eType(text: string): void {
  noteText.value = text;
  noteText.dispatchEvent(new Event('input', { bubbles: true }));
  noteSave.click();
}

async function e2eAddNote(page: number, x: number, y: number, text: string): Promise<void> {
  await e2eMouse('dblclick', page, x, y, {});
  e2eType(text);
}

function e2eEditNote(id: string, text: string | null): void {
  pagesEl.querySelector<HTMLElement>(`.note-pin[data-id="${CSS.escape(id)}"]`)?.click();
  if (text === null) {
    noteDelete.click();
  } else {
    e2eType(text);
  }
}

function e2eReportNotes(): void {
  const pins = (notes ?? []).flatMap((note) => {
    const pin = pagesEl.querySelector<HTMLElement>(`.note-pin[data-id="${CSS.escape(note.id)}"]`);
    if (!pin) {
      return [];
    }
    const box = pin.getBoundingClientRect();
    const page = pin.closest<HTMLElement>('.page')!.getBoundingClientRect();
    return [{ id: note.id, page: note.page, x: (box.left + box.width / 2 - page.left) / scale, y: (box.top + box.height / 2 - page.top) / scale, text: note.text }];
  });
  vscode.postMessage({ type: 'e2e:notes', enabled: notes !== null, pins });
}

// ---- Notes ----

/** The notes of the open PDF, or null for a PDF that has none, like the output of Compare Versions. */
let notes: Note[] | null = null;
let notesVisible = vscode.getState()?.notesVisible ?? true;
/** What the editor is open on. `id` is null for a note not saved yet. */
let editing: { id: string | null; page: number; x: number; y: number; original: string } | null = null;

const notesButton = document.getElementById('toggle-notes') as HTMLButtonElement;
const notesHint = document.getElementById('notes-hint') as HTMLSpanElement;

const noteEditor = document.createElement('div');
noteEditor.className = 'note-editor';
const noteText = document.createElement('textarea');
noteText.rows = 4;
noteText.setAttribute('aria-label', 'Note text');
const noteDelete = editorButton('Delete');
const noteCancel = editorButton('Cancel');
const noteSave = editorButton('Save');
noteSave.classList.add('primary');
const noteActions = document.createElement('div');
noteActions.className = 'note-actions';
const noteActionsGap = document.createElement('span');
noteActionsGap.className = 'spacer';
noteActions.append(noteDelete, noteActionsGap, noteCancel, noteSave);
noteEditor.append(noteText, noteActions);

function editorButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  return button;
}

function saveState(): void {
  vscode.setState({ zoom, notesVisible });
}

/** A position on the page as a percentage, so that a pin stays in place at any zoom. */
function percent(value: number, size: number): number {
  return Math.min(100, Math.max(0, (value / size) * 100));
}

function renderNotes(): void {
  for (const view of pages) {
    view.notesEl.querySelectorAll('.note-pin').forEach((pin) => pin.remove());
  }
  // A note on a page the document no longer has stays in the file, for when the page comes back.
  for (const note of notes ?? []) {
    const view = pages[note.page - 1];
    if (view) {
      view.notesEl.appendChild(createPin(note, view));
    }
  }
  if (editing && (notes === null || (editing.id !== null && !notes.some((n) => n.id === editing!.id)))) {
    closeEditor();
  }
  placeEditor();
  syncNotesUi();
  if (e2e) {
    e2eReportNotes();
  }
}

function createPin(note: Note, view: PageView): HTMLButtonElement {
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'note-pin';
  pin.dataset.id = note.id;
  pin.title = note.text;
  pin.setAttribute('aria-label', `Note: ${note.text}`);
  pin.style.left = `${percent(note.x, view.width)}%`;
  pin.style.top = `${percent(note.y, view.height)}%`;
  pin.addEventListener('click', (event) => {
    // A modifier-click goes on to the page's handler and jumps to the source.
    if (!event[modifierKey]) {
      openEditor({ id: note.id, page: note.page, x: note.x, y: note.y, original: note.text });
    }
  });
  pin.addEventListener('dblclick', (event) => event.stopPropagation());
  return pin;
}

function syncNotesUi(): void {
  const hasNotes = notes !== null;
  notesButton.hidden = !hasNotes;
  notesHint.hidden = !hasNotes;
  document.body.classList.toggle('notes-hidden', !notesVisible);
  notesButton.setAttribute('aria-pressed', String(notesVisible));
  notesButton.title = notesVisible ? 'Hide notes' : 'Show notes';
}

/** True while the editor holds text that would be lost by opening something else. */
function holdsUnsavedText(): boolean {
  return editing !== null && noteText.value !== editing.original;
}

function openEditor(target: NonNullable<typeof editing>): void {
  if (holdsUnsavedText()) {
    noteText.focus();
    return;
  }
  editing = target;
  noteText.value = target.original;
  noteDelete.hidden = target.id === null;
  noteSave.disabled = !target.original.trim();
  placeEditor();
  noteText.focus();
}

function closeEditor(): void {
  editing = null;
  noteEditor.remove();
}

function placeEditor(): void {
  if (!editing || pages.length === 0) {
    return;
  }
  const view = pages[Math.min(editing.page, pages.length) - 1];
  const left = percent(editing.x, view.width);
  const top = percent(editing.y, view.height);
  noteEditor.style.left = `${left}%`;
  noteEditor.style.top = `${top}%`;
  noteEditor.classList.toggle('flip-x', left > 55);
  noteEditor.classList.toggle('flip-y', top > 65);
  if (noteEditor.parentElement !== view.notesEl) {
    view.notesEl.appendChild(noteEditor);
  }
}

function saveEditor(): void {
  const text = noteText.value;
  if (!editing || !text.trim()) {
    return;
  }
  const { id, page, x, y } = editing;
  vscode.postMessage(id === null ? { type: 'addNote', page, x, y, text } : { type: 'updateNote', id, text });
  closeEditor();
}

noteText.addEventListener('input', () => {
  noteSave.disabled = !noteText.value.trim();
});
noteSave.addEventListener('click', saveEditor);
noteCancel.addEventListener('click', closeEditor);
noteDelete.addEventListener('click', () => {
  if (editing?.id) {
    vscode.postMessage({ type: 'deleteNote', id: editing.id });
  }
  closeEditor();
});
noteEditor.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeEditor();
  } else if (event.key === 'Enter' && event[modifierKey]) {
    event.preventDefault();
    saveEditor();
  }
});
// Clicks in the editor are not clicks on the page: no new note and no jump to the source.
noteEditor.addEventListener('click', (event) => event.stopPropagation());
noteEditor.addEventListener('dblclick', (event) => event.stopPropagation());

notesButton.addEventListener('click', () => {
  if (holdsUnsavedText()) {
    noteText.focus();
    return;
  }
  closeEditor();
  notesVisible = !notesVisible;
  saveState();
  syncNotesUi();
});

pagesEl.addEventListener('dblclick', (event) => {
  const pageEl = (event.target as HTMLElement).closest<HTMLElement>('.page');
  if (!pageEl || notes === null || event[modifierKey]) {
    return;
  }
  if (!notesVisible) {
    notesVisible = true;
    saveState();
    syncNotesUi();
  }
  const rect = pageEl.getBoundingClientRect();
  openEditor({
    id: null,
    page: Number(pageEl.dataset.index) + 1,
    x: (event.clientX - rect.left) / scale,
    y: (event.clientY - rect.top) / scale,
    original: '',
  });
});

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
      notes = msg.notes;
      renderNotes();
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
    case 'notes':
      notes = msg.notes;
      renderNotes();
      break;
    case 'e2e:click':
      if (e2e) {
        void e2eMouse('click', msg.page, msg.x, msg.y, { [modifierKey]: true });
      }
      break;
    case 'e2e:addNote':
      if (e2e) {
        void e2eAddNote(msg.page, msg.x, msg.y, msg.text);
      }
      break;
    case 'e2e:editNote':
      if (e2e) {
        e2eEditNote(msg.id, msg.text);
      }
      break;
    case 'e2e:zoom':
      if (e2e) {
        applyZoom(msg.zoom);
        e2eReportNotes();
      }
      break;
  }
});

syncNotesUi();
syncZoomSelect();
vscode.postMessage({ type: 'ready' });
