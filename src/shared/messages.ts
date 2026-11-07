// Message protocol between the extension host and the PDF viewer webview.
import type { ColorScheme } from './colorScheme';

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
  | { type: 'load'; data: ArrayBuffer; fileName: string }
  | { type: 'reveal'; target: PageRect }
  | { type: 'colorScheme'; scheme: ColorScheme }
  | E2eToViewerMessage;

export type FromViewerMessage =
  | { type: 'ready' }
  | { type: 'inverseSearch'; page: number; x: number; y: number }
  | { type: 'error'; message: string }
  /** The toolbar's dark mode button; the extension updates `overtex.viewer.colorScheme`. */
  | { type: 'toggleColorScheme' }
  | E2eFromViewerMessage;

// End-to-end test hooks. The viewer only answers these when the extension host was started with
// OVERTEX_E2E set; they let the test drive the real viewer the way a user would.

export type E2eToViewerMessage =
  /** Clicks the page at a point in PDF points, holding the inverse-search modifier. */
  { type: 'e2e:click'; page: number; x: number; y: number };

export type E2eFromViewerMessage =
  | { type: 'e2e:loaded'; pages: number }
  /** Sent once a reveal has scrolled; `inView` says whether the whole target box is on screen. */
  | { type: 'e2e:revealed'; target: PageRect; inView: boolean }
  /** Sent whenever the page color scheme is applied. */
  | { type: 'e2e:colorScheme'; dark: boolean };

export function isE2eMessage(msg: { type: string }): msg is E2eFromViewerMessage {
  return msg.type.startsWith('e2e:');
}
