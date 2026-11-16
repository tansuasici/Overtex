// Messages between the extension and the math symbol palette's webview.
import type { SymbolCategory, SymbolPackage } from './symbols';

/** A symbol as the palette shows it: rendered by the extension, since the webview has no MathJax. */
export interface PaletteSymbol {
  cmd: string;
  name: string;
  category: SymbolCategory;
  pkg?: SymbolPackage;
  /** Inline SVG coloured with currentColor; empty when MathJax could not render it. */
  svg: string;
}

export type ToPaletteMessage =
  | { type: 'symbols'; symbols: PaletteSymbol[]; usage: Record<string, number> }
  | { type: 'usage'; usage: Record<string, number> }
  /** For the tests: type `query` into the search box and report what is shown. */
  | { type: 'search'; query: string };

export type FromPaletteMessage =
  | { type: 'ready' }
  /** The symbols are on screen. */
  | { type: 'shown' }
  | { type: 'insert'; cmd: string }
  | { type: 'searched'; cmds: string[] };
