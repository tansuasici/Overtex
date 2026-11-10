import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { FromViewerMessage, PageRect, ToViewerMessage } from '../src/shared/messages';
import { inReadingOrder, isDone, noteSummary } from '../src/shared/notes';
import type { Note } from '../src/shared/notes';
import { toBytes } from '../src/shared/bytes';
import { wordAt } from '../src/shared/clickedWord';
import type { ClickedWord } from '../src/shared/clickedWord';
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
  notesListOpen?: boolean;
  hideDone?: boolean;
  /** Where the viewer was scrolled to: a moved or restored preview starts from an empty page. */
  anchor?: Anchor | null;
  /** A slideshow in progress, and the page it is on (0-based). */
  presenting?: boolean;
  slide?: number;
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
/**
 * The saved place in a moved or restored preview, kept until its layout settles: a new window can lay
 * out the viewer too small at first for the place to fit, and that would lose it.
 */
let returnTo = vscode.getState()?.anchor ?? null;
let scale = 1;
let loadSeq = 0;
/** In a slideshow only the page at `slide` is shown, so page positions come from `slide`, never from the scroll offset. */
let presenting = vscode.getState()?.presenting ?? false;
let slide = vscode.getState()?.slide ?? 0;

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
  const anchor = returnTo ?? captureAnchor();
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
  if (presenting) {
    showSlide(slide); // A rebuild during a talk stays on the same slide.
  } else {
    restoreAnchor(anchor);
  }
  updatePageInfo();
  if (returnTo) {
    window.setTimeout(() => {
      returnTo = null;
      if (e2e) {
        vscode.postMessage({ type: 'e2e:settled', position: scrollPosition() });
      }
    }, 2000);
  }
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
  if (presenting) {
    // Each slide fits the whole preview; the zoom is left alone for when the slideshow ends.
    const view = pages[slide] ?? pages[0];
    return view ? Math.max(0.1, Math.min(viewer.clientWidth / view.width, viewer.clientHeight / view.height)) : 1;
  }
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
  const anchor = presenting ? null : captureAnchor();
  zoom = next;
  saveState();
  syncZoomSelect();
  relayout();
  restoreAnchor(anchor);
}

/** Sizes the pages for the current scale and re-renders what is on screen at it. */
function relayout(): void {
  scale = resolveScale();
  for (const view of pages) {
    setPageSize(view.el, view);
    view.canvas?.style.setProperty('width', `${Math.floor(view.width * scale)}px`);
    view.canvas?.style.setProperty('height', `${Math.floor(view.height * scale)}px`);
  }
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

/** How many pages down the viewer is, for the end-to-end tests. */
function scrollPosition(): number {
  const at = captureAnchor();
  return at ? at.page + at.offset : 0;
}

function updatePageInfo(): void {
  const current = presenting ? slide : (captureAnchor()?.page ?? 0);
  pageInfo.textContent = pages.length ? `${current + 1} / ${pages.length}` : '';
  presentInfo.textContent = pageInfo.textContent;
}

// ---- Slideshow ----

const presentButton = document.getElementById('present') as HTMLButtonElement;
const presentInfo = document.getElementById('present-info') as HTMLSpanElement;

function showSlide(index: number): void {
  slide = Math.max(0, Math.min(index, pages.length - 1));
  for (const view of pages) {
    view.el.hidden = view.index !== slide;
  }
  relayout(); // Slides can differ in size.
  updatePageInfo();
  saveState();
  reportSlide();
}

function setPresenting(on: boolean): void {
  if (on === presenting) {
    return;
  }
  if (on) {
    if (holdsUnsavedText()) {
      noteText.focus();
      return;
    }
    closeEditor();
    slide = captureAnchor()?.page ?? 0;
    presenting = true;
    syncPresentUi();
    showSlide(slide);
    viewer.focus({ preventScroll: true });
    return;
  }
  presenting = false;
  syncPresentUi();
  for (const view of pages) {
    view.el.hidden = false;
  }
  relayout();
  const back = { page: slide, offset: 0 };
  restoreAnchor(back);
  updatePageInfo();
  saveState();
  // The toolbar and scrollbar come back, so the layout can still shift: put the page back once it has.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!presenting && captureAnchor()?.page !== back.page) {
        restoreAnchor(back);
        updatePageInfo();
        saveState();
      }
      reportSlide();
    })
  );
}

function syncPresentUi(): void {
  document.body.classList.toggle('presenting', presenting);
  presentButton.setAttribute('aria-pressed', String(presenting));
  if (presenting) {
    showPresentBar(PRESENT_BAR_ON_ENTER_MS);
  } else {
    hidePresentBar();
  }
}

const PRESENT_BAR_ON_ENTER_MS = 3000;
const PRESENT_BAR_ON_MOVE_MS = 2000;
let presentBarTimer: ReturnType<typeof setTimeout> | undefined;

/** Shows the Exit bar for `ms`, then lets it fade; hovering or focusing it keeps it up. */
function showPresentBar(ms: number): void {
  document.body.classList.add('present-bar-shown');
  clearTimeout(presentBarTimer);
  presentBarTimer = setTimeout(() => document.body.classList.remove('present-bar-shown'), ms);
}

function hidePresentBar(): void {
  clearTimeout(presentBarTimer);
  document.body.classList.remove('present-bar-shown');
}

const SLIDE_KEYS: Record<string, (current: number) => number> = {
  ArrowRight: (i) => i + 1,
  ArrowDown: (i) => i + 1,
  PageDown: (i) => i + 1,
  ' ': (i) => i + 1,
  Enter: (i) => i + 1,
  ArrowLeft: (i) => i - 1,
  ArrowUp: (i) => i - 1,
  PageUp: (i) => i - 1,
  Backspace: (i) => i - 1,
  Home: () => 0,
  End: () => Number.MAX_SAFE_INTEGER,
};

function onSlideKey(event: KeyboardEvent): void {
  if (!presenting || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLButtonElement) {
    return; // The Exit button.
  }
  if (event.key === 'Escape') {
    setPresenting(false);
  } else if (SLIDE_KEYS[event.key]) {
    showSlide(SLIDE_KEYS[event.key](slide));
  } else {
    return;
  }
  event.preventDefault();
}

function reportSlide(): void {
  if (!e2e) {
    return;
  }
  const shown = pages.filter((v) => !v.el.hidden);
  const area = viewer.getBoundingClientRect();
  const box = shown[0]?.el.getBoundingClientRect();
  const fits = box !== undefined && box.left >= area.left - 1 && box.right <= area.right + 1 && box.top >= area.top - 1 && box.bottom <= area.bottom + 1;
  const layout = { scrollTop: Math.round(viewer.scrollTop), height: viewer.clientHeight, scrollHeight: viewer.scrollHeight, zoom: String(zoom) };
  const exitShown = document.body.classList.contains('present-bar-shown');
  vscode.postMessage({ type: 'e2e:slide', presenting, slide, visible: shown.length, fits, exitShown, position: scrollPosition(), layout });
}

// ---- SyncTeX ----

function reveal(target: PageRect): void {
  const view = pages[target.page - 1];
  if (!view) {
    return;
  }
  if (presenting) {
    showSlide(view.index);
  } else {
    const top = view.el.offsetTop + target.y * scale;
    viewer.scrollTo({ top: Math.max(0, top - viewer.clientHeight / 3), behavior: 'smooth' });
  }

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
  vscode.postMessage({ type: 'e2e:revealed', target, inView: top >= 0 && bottom <= viewer.clientHeight, position: scrollPosition() });
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

function e2eMarkDone(id: string, done: boolean, via: 'editor' | 'list', text?: string): void {
  if (via === 'editor') {
    pagesEl.querySelector<HTMLElement>(`.note-pin[data-id="${CSS.escape(id)}"]`)?.click();
    if (text !== undefined) {
      noteText.value = text;
      noteText.dispatchEvent(new Event('input'));
    }
    if (editingDone !== done) {
      noteDone.click();
    }
    return;
  }
  if (!notesListOpen) {
    notesListButton.click();
  }
  const box = notesListRows.querySelector<HTMLInputElement>(`[data-id="${CSS.escape(id)}"] input`);
  if (box && box.checked !== done) {
    box.click();
  }
}

async function e2eShowNote(id: string): Promise<void> {
  if (!notesListOpen) {
    notesListButton.click();
  }
  notesListRows.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"] button`)?.click();
  await scrollSettled();
  const pin = pagesEl.querySelector<HTMLElement>(`.note-pin[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  const area = viewer.getBoundingClientRect();
  const inView = pin !== undefined && pin.left >= area.left && pin.right <= area.right && pin.top >= area.top && pin.bottom <= area.bottom;
  vscode.postMessage({ type: 'e2e:noteShown', id, inView });
}

function e2eReportNotes(): void {
  const pins = (notes ?? []).flatMap((note) => {
    const pin = pagesEl.querySelector<HTMLElement>(`.note-pin[data-id="${CSS.escape(note.id)}"]`);
    if (!pin) {
      return [];
    }
    const box = pin.getBoundingClientRect();
    const page = pin.closest<HTMLElement>('.page')!.getBoundingClientRect();
    return [{ id: note.id, page: note.page, x: (box.left + box.width / 2 - page.left) / scale, y: (box.top + box.height / 2 - page.top) / scale, text: note.text, done: isDone(note) }];
  });
  const list = [...notesListRows.querySelectorAll<HTMLElement>('li')].map((row) => ({
    id: row.dataset.id!,
    label: row.querySelector('.note-row-label')!.textContent ?? '',
    done: row.classList.contains('done'),
  }));
  vscode.postMessage({ type: 'e2e:notes', enabled: notes !== null, pins, badge: notesCount.textContent ?? '', listOpen: !notesList.hidden, list });
}

// ---- Notes ----

/** The notes of the open PDF, or null for a PDF that has none, like the output of Compare Versions. */
let notes: Note[] | null = null;
let notesVisible = vscode.getState()?.notesVisible ?? true;
let notesListOpen = vscode.getState()?.notesListOpen ?? false;
let hideDone = vscode.getState()?.hideDone ?? false;
/** What the editor is open on. `id` is null for a note not saved yet. */
let editing: { id: string | null; page: number; x: number; y: number; original: string } | null = null;
let editingDone = false;

const notesButton = document.getElementById('toggle-notes') as HTMLButtonElement;
const notesHint = document.getElementById('notes-hint') as HTMLSpanElement;
const notesListButton = document.getElementById('toggle-notes-list') as HTMLButtonElement;
const notesCount = document.getElementById('notes-count') as HTMLSpanElement;
const notesListSummary = document.getElementById('notes-list-summary') as HTMLSpanElement;
const closeNotesListButton = document.getElementById('close-notes-list') as HTMLButtonElement;
const notesList = document.getElementById('notes-list') as HTMLElement;
const notesListRows = document.getElementById('notes-list-rows') as HTMLUListElement;
const notesListEmpty = document.getElementById('notes-list-empty') as HTMLParagraphElement;
const hideDoneBox = document.getElementById('hide-done') as HTMLInputElement;

/** Keep in step with the width in pdfViewer.css. */
const NOTES_LIST_COVERS_PAGE = '(max-width: 560px)';

const ICON_CHECK = 'M3 8.5l3.2 3.2L13 5';
const ICON_REOPEN = 'M3.6 8a4.4 4.4 0 1 0 1.3-3.1L3 6.8M3 3.2v3.6h3.6';
const ICON_TRASH = 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v3.5M9.2 7v3.5';

const noteEditor = document.createElement('div');
noteEditor.className = 'note-editor';
noteEditor.setAttribute('role', 'dialog');
noteEditor.setAttribute('aria-label', 'Note');
const noteTitle = document.createElement('span');
noteTitle.className = 'note-editor-title';
const noteDone = editorButton('');
noteDone.classList.add('ghost');
const noteDelete = editorButton('');
noteDelete.classList.add('ghost', 'danger');
noteDelete.title = 'Delete note';
noteDelete.setAttribute('aria-label', 'Delete note');
noteDelete.append(icon(ICON_TRASH));
const noteHead = document.createElement('div');
noteHead.className = 'note-editor-head';
noteHead.append(noteTitle, noteDone, noteDelete);
const noteText = document.createElement('textarea');
noteText.rows = 5;
noteText.placeholder = 'Write a note…';
noteText.setAttribute('aria-label', 'Note text');
const noteHint = document.createElement('span');
noteHint.className = 'note-editor-hint';
noteHint.textContent = modifierKey === 'metaKey' ? '⌘↵ to save' : 'Ctrl+Enter to save';
const noteCancel = editorButton('Cancel');
const noteSave = editorButton('Save');
noteSave.classList.add('primary');
const noteActions = document.createElement('div');
noteActions.className = 'note-actions';
noteActions.append(noteHint, noteCancel, noteSave);
noteEditor.append(noteHead, noteText, noteActions);

function editorButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  return button;
}

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

function saveState(): void {
  const anchor = returnTo ?? (presenting ? { page: slide, offset: 0 } : captureAnchor());
  vscode.setState({ zoom, notesVisible, notesListOpen, hideDone, anchor, presenting, slide });
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
    if (view && !(hideDone && isDone(note))) {
      view.notesEl.appendChild(createPin(note, view));
    }
  }
  if (editing && (notes === null || (editing.id !== null && !notes.some((n) => n.id === editing!.id)))) {
    closeEditor();
  }
  placeEditor();
  renderNotesList();
  syncNotesUi();
  if (e2e) {
    e2eReportNotes();
  }
}

function createPin(note: Note, view: PageView): HTMLButtonElement {
  const pin = document.createElement('button');
  pin.type = 'button';
  const done = isDone(note);
  pin.className = done ? 'note-pin done' : 'note-pin';
  pin.dataset.id = note.id;
  if (done) {
    pin.append(icon(ICON_CHECK));
  }
  pin.title = done ? `Done: ${note.text}` : note.text;
  pin.setAttribute('aria-label', `${done ? 'Done note' : 'Note'}: ${note.text}`);
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

  const all = notes ?? [];
  const open = all.filter((note) => !isDone(note)).length;
  const closed = all.length - open;
  const summary = `${open} open, ${closed} done`;
  notesListButton.hidden = !hasNotes;
  notesCount.textContent = String(open);
  notesCount.classList.toggle('zero', open === 0);
  notesListSummary.textContent = closed ? `${open} open · ${closed} done` : `${open} open`;
  notesListButton.title = `Note list: ${summary}`;
  notesListButton.setAttribute('aria-label', `Note list: ${summary}`);
  notesListButton.setAttribute('aria-pressed', String(notesListOpen));
  // Takes room from the viewer rather than covering it, or a pin at the page's edge could not be seen.
  notesList.hidden = !hasNotes || !notesListOpen;
  document.body.classList.toggle('notes-list-open', !notesList.hidden);
  hideDoneBox.checked = hideDone;
}

function renderNotesList(): void {
  // Rows are replaced, so a checkbox used from the keyboard would lose its place.
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('#notes-list-rows li')?.dataset.id;
  const all = notes ?? [];
  const rows = inReadingOrder(all).filter((note) => !(hideDone && isDone(note)));
  notesListRows.replaceChildren(...rows.map(createListRow));
  notesListEmpty.textContent = rows.length ? '' : all.length ? 'All notes are done.' : 'No notes yet. Double-click a page to add one.';
  if (focused) {
    notesListRows.querySelector<HTMLElement>(`[data-id="${CSS.escape(focused)}"] input`)?.focus();
  }
}

function createListRow(note: Note): HTMLLIElement {
  const done = isDone(note);
  const row = document.createElement('li');
  row.className = done ? 'done' : '';
  row.dataset.id = note.id;

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = done;
  box.title = done ? 'Mark open' : 'Mark done';
  box.setAttribute('aria-label', `Done: ${note.text}`);
  box.addEventListener('change', () => vscode.postMessage({ type: 'setNoteDone', id: note.id, done: box.checked }));

  const show = document.createElement('button');
  show.type = 'button';
  const label = document.createElement('span');
  label.className = 'note-row-label';
  label.textContent = noteSummary(note.text);
  const page = document.createElement('span');
  page.className = 'note-row-page';
  page.textContent = `Page ${note.page}`;
  show.append(label, page);
  // A note on a page the document no longer has stays in the list, with nowhere to jump to.
  show.disabled = !pages[note.page - 1];
  show.title = show.disabled ? 'This page is not in the PDF.' : note.text;
  show.addEventListener('click', () => showNote(note));

  row.append(box, show);
  return row;
}

function showNote(note: Note): void {
  const view = pages[note.page - 1];
  if (!view) {
    return;
  }
  ensureNotesVisible();
  viewer.scrollTo({
    top: Math.max(0, view.el.offsetTop + note.y * scale - viewer.clientHeight / 3),
    left: Math.max(0, view.el.offsetLeft + note.x * scale - viewer.clientWidth / 2),
    behavior: 'smooth',
  });
  const pin = view.notesEl.querySelector<HTMLElement>(`.note-pin[data-id="${CSS.escape(note.id)}"]`);
  pin?.classList.add('flash');
  pin?.addEventListener('animationend', () => pin.classList.remove('flash'), { once: true });
  // In a narrow window the list covers the page, so it has to go for the jump to be seen.
  if (window.matchMedia(NOTES_LIST_COVERS_PAGE).matches) {
    setNotesListOpen(false);
  }
}

function setNotesListOpen(open: boolean): void {
  notesListOpen = open;
  saveState();
  syncNotesUi();
}

function ensureNotesVisible(): void {
  if (!notesVisible) {
    notesVisible = true;
    saveState();
    syncNotesUi();
  }
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
  editingDone = notes?.some((n) => n.id === target.id && isDone(n)) ?? false;
  noteText.value = target.original;
  noteTitle.textContent = target.id === null ? `New note · Page ${target.page}` : editingDone ? `Page ${target.page} · Done` : `Page ${target.page}`;
  noteDelete.hidden = target.id === null;
  noteDone.hidden = target.id === null;
  noteDone.replaceChildren(icon(editingDone ? ICON_REOPEN : ICON_CHECK), editingDone ? 'Reopen' : 'Mark done');
  noteSave.disabled = !target.original.trim();
  noteDone.disabled = noteSave.disabled;
  placeEditor();
  noteEditor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  noteText.focus({ preventScroll: true });
}

function closeEditor(): void {
  editing = null;
  noteEditor.remove();
  markEditedPin();
}

function markEditedPin(): void {
  pagesEl.querySelectorAll<HTMLElement>('.note-pin').forEach((pin) => pin.classList.toggle('editing', pin.dataset.id === editing?.id));
}

/**
 * How far the editor sits from its point along one axis: after the point if it fits in the
 * visible part of the viewer, else before it, else as far on screen as it can be.
 */
function editorOffset(point: number, size: number, start: number, end: number): number {
  const gap = 12;
  if (point + gap + size <= end) {
    return gap;
  }
  if (point - gap - size >= start) {
    return -gap - size;
  }
  return Math.max(start, end - size) - point;
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
  if (noteEditor.parentElement !== view.notesEl) {
    view.notesEl.appendChild(noteEditor);
  }
  const page = view.notesEl.getBoundingClientRect();
  const area = viewer.getBoundingClientRect();
  const pointX = page.left + (page.width * left) / 100;
  const pointY = page.top + (page.height * top) / 100;
  noteEditor.style.setProperty('--offset-x', `${editorOffset(pointX, noteEditor.offsetWidth, area.left, area.left + viewer.clientWidth)}px`);
  noteEditor.style.setProperty('--offset-y', `${editorOffset(pointY, noteEditor.offsetHeight, area.top, area.top + viewer.clientHeight)}px`);
  markEditedPin();
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
  noteDone.disabled = noteSave.disabled;
});
noteSave.addEventListener('click', saveEditor);
// Closes the editor like Save does, and keeps what was typed: the two changes are queued in order.
noteDone.addEventListener('click', () => {
  const id = editing?.id;
  if (!id) {
    return;
  }
  const done = !editingDone;
  if (holdsUnsavedText()) {
    saveEditor();
  } else {
    closeEditor();
  }
  vscode.postMessage({ type: 'setNoteDone', id, done });
});
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

notesListButton.addEventListener('click', () => setNotesListOpen(!notesListOpen));
closeNotesListButton.addEventListener('click', () => {
  setNotesListOpen(false);
  notesListButton.focus();
});

hideDoneBox.addEventListener('change', () => {
  if (holdsUnsavedText()) {
    hideDoneBox.checked = hideDone;
    noteText.focus();
    return;
  }
  // The note being edited may be about to lose its pin.
  closeEditor();
  hideDone = hideDoneBox.checked;
  saveState();
  renderNotes();
});

pagesEl.addEventListener('dblclick', (event) => {
  const pageEl = (event.target as HTMLElement).closest<HTMLElement>('.page');
  if (!pageEl || notes === null || event[modifierKey] || presenting) {
    return;
  }
  ensureNotesVisible();
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
    if (presenting) {
      return; // The viewer's own click handler moves to the next slide.
    }
    // A click beside an untouched editor dismisses it; one that holds text stays open.
    if (!(event.target as HTMLElement).closest('.note-pin') && !holdsUnsavedText()) {
      closeEditor();
    }
    return;
  }
  const pageEl = (event.target as HTMLElement).closest<HTMLElement>('.page');
  if (!pageEl) {
    return;
  }
  const rect = pageEl.getBoundingClientRect();
  const index = Number(pageEl.dataset.index);
  const x = (event.clientX - rect.left) / scale;
  const y = (event.clientY - rect.top) / scale;
  void clickedWord(pages[index], x, y)
    .catch(() => undefined)
    .then((word) => vscode.postMessage({ type: 'inverseSearch', page: index + 1, x, y, word }));
});

/**
 * The word at a point on the page, in PDF points from the top-left corner, read from the page's
 * text with the rest of its line around it, so the editor can put the cursor on that word.
 */
async function clickedWord(view: PageView | undefined, x: number, y: number): Promise<ClickedWord | undefined> {
  if (!view) {
    return undefined;
  }
  const [px, py] = view.page.getViewport({ scale: 1 }).convertToPdfPoint(x, y);
  const items = (await view.page.getTextContent()).items.flatMap((item) =>
    'str' in item && item.str ? [{ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height || Math.abs(item.transform[3]) }] : [],
  );
  // The text run under the point: on its line (from a little below the baseline to the top), nearest across.
  let hit: (typeof items)[number] | undefined;
  let gap = Infinity;
  for (const item of items) {
    if (py < item.y - item.height * 0.3 || py > item.y + item.height) {
      continue;
    }
    const d = px < item.x ? item.x - px : Math.max(0, px - (item.x + item.width));
    if (d < gap) {
      gap = d;
      hit = item;
    }
  }
  if (!hit || gap > 2) {
    return undefined;
  }
  // The whole line, left to right, with a space wherever the runs do not touch.
  const line = items.filter((item) => Math.abs(item.y - hit!.y) < hit!.height * 0.3).sort((a, b) => a.x - b.x);
  let text = '';
  let offset = 0;
  let end = -Infinity;
  for (const item of line) {
    if (text && item.x - end > hit.height * 0.1) {
      text += ' ';
    }
    if (item === hit) {
      offset = text.length;
    }
    text += item.str;
    end = item.x + item.width;
  }
  const along = hit.width > 0 ? (px - hit.x) / hit.width : 0;
  const char = Math.min(hit.str.length - 1, Math.max(0, Math.floor(along * hit.str.length)));
  return wordAt(text, offset + char);
}

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

presentButton.addEventListener('click', () => setPresenting(true));
document.getElementById('present-exit')!.addEventListener('click', () => setPresenting(false));
window.addEventListener('keydown', onSlideKey);
window.addEventListener('mousemove', () => {
  if (presenting) {
    showPresentBar(PRESENT_BAR_ON_MOVE_MS);
  }
});
viewer.addEventListener('click', (event) => {
  if (presenting && !event[modifierKey]) {
    showSlide(slide + 1);
  }
});

viewer.addEventListener(
  'wheel',
  (event) => {
    if (presenting) {
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      stepZoom(event.deltaY < 0 ? 1 : -1);
    }
  },
  { passive: false }
);

let scrollSaveTimer: number | undefined;
viewer.addEventListener(
  'scroll',
  () => {
    updatePageInfo();
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = window.setTimeout(saveState, 200);
  },
  { passive: true }
);

let resizeTimer: number | undefined;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (presenting) {
      relayout();
      return;
    }
    if (typeof zoom !== 'number') {
      applyZoom(zoom);
    }
    restoreAnchor(returnTo);
  }, 100);
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
    case 'present':
      setPresenting(true);
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
    case 'e2e:markDone':
      if (e2e) {
        e2eMarkDone(msg.id, msg.done, msg.via, msg.text);
      }
      break;
    case 'e2e:hideDone':
      if (e2e && hideDoneBox.checked !== msg.hide) {
        hideDoneBox.click();
      }
      break;
    case 'e2e:toggleList':
      if (e2e) {
        notesListButton.click();
        e2eReportNotes();
      }
      break;
    case 'e2e:showNote':
      if (e2e) {
        void e2eShowNote(msg.id);
      }
      break;
    case 'e2e:key':
      if (e2e) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: msg.key, cancelable: true }));
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
syncPresentUi();
vscode.postMessage({ type: 'ready' });
