// Message protocol between the extension host and the PDF viewer webview.
import type { ColorScheme } from './colorScheme';
import type { Note } from './notes';

/** A rectangle on a PDF page, in PDF points (1/72 in), origin at the top-left corner. */
export interface PageRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ToViewerMessage =
  /**
   * `data` is sent as a standalone ArrayBuffer: VS Code's webview bridge does not
   * reliably preserve Uint8Array views (Node Buffers in particular), so the viewer
   * must normalise whatever arrives with `toBytes()`.
   */
  | { type: 'load'; data: ArrayBuffer; fileName: string; notes: Note[] | null }
  | { type: 'reveal'; target: PageRect }
  | { type: 'colorScheme'; scheme: ColorScheme }
  /** The saved notes, after any change. `null` means this PDF has no notes (Compare Versions output). */
  | { type: 'notes'; notes: Note[] | null }
  /** Starts the slideshow: one page at a time, fit to the preview, on the page the viewer is at. */
  | { type: 'present' }
  | E2eToViewerMessage;

export type FromViewerMessage =
  | { type: 'ready' }
  | { type: 'inverseSearch'; page: number; x: number; y: number }
  | { type: 'error'; message: string }
  /** The toolbar's dark mode button; the extension updates `overtex.viewer.colorScheme`. */
  | { type: 'toggleColorScheme' }
  | { type: 'addNote'; page: number; x: number; y: number; text: string }
  | { type: 'updateNote'; id: string; text: string }
  | { type: 'deleteNote'; id: string }
  | { type: 'setNoteDone'; id: string; done: boolean }
  | E2eFromViewerMessage;

// End-to-end test hooks. The viewer only answers these when the extension host was started with
// OVERTEX_E2E set; they let the test drive the real viewer the way a user would.

export type E2eToViewerMessage =
  /** Clicks the page at a point in PDF points, holding the inverse-search modifier. */
  | { type: 'e2e:click'; page: number; x: number; y: number }
  /** Double-clicks the page at a point in PDF points, types `text` into the note editor and saves. */
  | { type: 'e2e:addNote'; page: number; x: number; y: number; text: string }
  /** Clicks a note's pin, then saves `text` or, when it is null, presses Delete. */
  | { type: 'e2e:editNote'; id: string; text: string | null }
  /** Marks a note done or open: from its pin's editor, first replacing its text if `text` is given, or from its row in the note list. */
  | { type: 'e2e:markDone'; id: string; done: boolean; via: 'editor' | 'list'; text?: string }
  /** Sets the note list's Hide done box. */
  | { type: 'e2e:hideDone'; hide: boolean }
  /** Clicks the toolbar's note list button, then reports the notes. */
  | { type: 'e2e:toggleList' }
  /** Clicks a note's row in the note list, then reports whether its pin came into view. */
  | { type: 'e2e:showNote'; id: string }
  /** Sets the zoom, then reports where the pins are. */
  | { type: 'e2e:zoom'; zoom: 'page-width' | number }
  /** Presses a key in the viewer, as a user would during a slideshow. */
  | { type: 'e2e:key'; key: string };

export type E2eFromViewerMessage =
  | { type: 'e2e:loaded'; pages: number }
  /** A moved or restored preview's layout has settled: how many pages down it ended up. */
  | { type: 'e2e:settled'; position: number }
  /** Sent once a reveal has scrolled; `inView` says whether the whole target box is on screen. */
  | { type: 'e2e:revealed'; target: PageRect; inView: boolean; position: number }
  /** Sent whenever the page color scheme is applied. */
  | { type: 'e2e:colorScheme'; dark: boolean }
  /**
   * Sent whenever pins are drawn. `x` and `y` are measured from the pin on screen, in PDF points.
   * `enabled` is false for a PDF that has no notes. `badge` is the note list button's text, `list`
   * the rows the note list shows, whether or not it is open.
   */
  | {
      type: 'e2e:notes';
      enabled: boolean;
      pins: { id: string; page: number; x: number; y: number; text: string; done: boolean }[];
      badge: string;
      listOpen: boolean;
      list: { id: string; label: string; done: boolean }[];
    }
  | { type: 'e2e:noteShown'; id: string; inView: boolean }
  /**
   * Sent whenever the slideshow shows a page, starts or ends. `slide` is 0-based, `visible` how many
   * pages are shown, `fits` whether the shown page lies wholly inside the preview, and `position`
   * how many pages down the viewer is (meaningful once the slideshow has ended).
   */
  | { type: 'e2e:slide'; presenting: boolean; slide: number; visible: number; fits: boolean; position: number };

export function isE2eMessage(msg: { type: string }): msg is E2eFromViewerMessage {
  return msg.type.startsWith('e2e:');
}
