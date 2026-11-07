// Message protocol between the extension host and the PDF viewer webview.

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
  | { type: 'reveal'; target: PageRect };

export type FromViewerMessage =
  | { type: 'ready' }
  | { type: 'inverseSearch'; page: number; x: number; y: number }
  | { type: 'error'; message: string };
