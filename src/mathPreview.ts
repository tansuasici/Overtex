import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { collectMacros, findMathSpans, MathSpan, mathAt } from './latex/math';
import type { RenderResult } from './math/render';

type Render = (tex: string, display: boolean, preamble: string[]) => RenderResult;

/** Pixels per ex at scale 1, about what the editor font gives. */
const EX_PX = 8;

/** Renders the math in documents for hovers, with the macros of the document and the main file. */
export class MathRenderer {
  private render: Render | undefined;
  private readonly spanCache = new WeakMap<vscode.TextDocument, { version: number; spans: MathSpan[] }>();
  private readonly mainCache = new Map<string, { mtime: number; macros: string[] }>();

  constructor(
    private readonly extensionPath: string,
    private readonly mainFile: () => string | null
  ) {}

  spansOf(doc: vscode.TextDocument): MathSpan[] {
    const hit = this.spanCache.get(doc);
    if (hit?.version === doc.version) {
      return hit.spans;
    }
    const spans = findMathSpans(doc.getText());
    this.spanCache.set(doc, { version: doc.version, spans });
    return spans;
  }

  /** The span rendered as hover Markdown; MathJax is loaded on first use. */
  markdown(doc: vscode.TextDocument, span: MathSpan): vscode.MarkdownString {
    this.render ??= (require(path.join(this.extensionPath, 'out', 'mathRender.js')) as { renderMath: Render }).renderMath;
    const result = this.render(span.tex, span.display, this.macrosFor(doc));
    const md = new vscode.MarkdownString();
    if ('error' in result) {
      md.appendMarkdown(`*${escapeMarkdown(result.error)}*`);
    } else {
      const scale = vscode.workspace.getConfiguration('overtex', doc.uri).get<number>('mathPreview.scale', 1);
      md.appendMarkdown(`![math](data:image/svg+xml;base64,${Buffer.from(prepareSvg(result.svg, scale, textColor())).toString('base64')})`);
    }
    return md;
  }

  private mainMacros(file: string): string[] {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const hit = this.mainCache.get(file);
      if (hit?.mtime === mtime) {
        return hit.macros;
      }
      const macros = collectMacros(fs.readFileSync(file, 'utf8'));
      this.mainCache.set(file, { mtime, macros });
      return macros;
    } catch {
      return [];
    }
  }

  private macrosFor(doc: vscode.TextDocument): string[] {
    const own = collectMacros(doc.getText());
    const main = this.mainFile();
    if (!main || doc.uri.scheme !== 'file' || path.resolve(main) === path.resolve(doc.uri.fsPath)) {
      return own;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === path.resolve(main));
    return [...(open ? collectMacros(open.getText()) : this.mainMacros(main)), ...own];
  }
}

/**
 * Hovering over math shows it rendered by MathJax, with the macros defined in the file and in the
 * main file. MathJax is a separate bundle, loaded on the first math hover.
 */
export function registerMathPreview(renderer: MathRenderer): vscode.Disposable {
  return vscode.languages.registerHoverProvider(
    [{ language: 'latex' }, { language: 'tex' }],
    {
      provideHover(doc, position) {
        if (!vscode.workspace.getConfiguration('overtex', doc.uri).get<boolean>('mathPreview.enabled', true)) {
          return undefined;
        }
        const span = mathAt(renderer.spansOf(doc), doc.offsetAt(position));
        if (!span) {
          return undefined;
        }
        return new vscode.Hover(renderer.markdown(doc, span), new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end)));
      },
    }
  );
}

/** Gives the SVG pixel sizes (hovers do not know the ex of the editor font) and a fixed color. */
export function prepareSvg(svg: string, scale: number, color: string): string {
  const toPx = (_m: string, attr: string, value: string) => `${attr}="${(parseFloat(value) * EX_PX * scale).toFixed(2)}px"`;
  return svg
    .replace(/\b(width|height)="(-?[\d.]+)ex"/g, toPx)
    .replace(/currentColor/g, color)
    .replace(/vertical-align:\s*-?[\d.]+ex;?/, '');
}

function textColor(): string {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast ? '#D4D4D4' : '#1F1F1F';
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}
