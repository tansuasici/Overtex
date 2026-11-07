import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { collectMacros, findMathSpans, MathSpan, mathAt } from './latex/math';
import type { RenderResult } from './math/render';

type Render = (tex: string, display: boolean, preamble: string[]) => RenderResult;

/** Pixels per ex at scale 1, about what the editor font gives. */
const EX_PX = 8;

/**
 * Hovering over math shows it rendered by MathJax, with the macros defined in the file and in the
 * main file. MathJax is a separate bundle, loaded on the first math hover.
 */
export function registerMathPreview(extensionPath: string, mainFile: () => string | null): vscode.Disposable {
  let render: Render | undefined;
  const spanCache = new WeakMap<vscode.TextDocument, { version: number; spans: MathSpan[] }>();
  const mainCache = new Map<string, { mtime: number; macros: string[] }>();

  function spansOf(doc: vscode.TextDocument): MathSpan[] {
    const hit = spanCache.get(doc);
    if (hit?.version === doc.version) {
      return hit.spans;
    }
    const spans = findMathSpans(doc.getText());
    spanCache.set(doc, { version: doc.version, spans });
    return spans;
  }

  function mainMacros(file: string): string[] {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const hit = mainCache.get(file);
      if (hit?.mtime === mtime) {
        return hit.macros;
      }
      const macros = collectMacros(fs.readFileSync(file, 'utf8'));
      mainCache.set(file, { mtime, macros });
      return macros;
    } catch {
      return [];
    }
  }

  function macrosFor(doc: vscode.TextDocument): string[] {
    const own = collectMacros(doc.getText());
    const main = mainFile();
    if (!main || doc.uri.scheme !== 'file' || path.resolve(main) === path.resolve(doc.uri.fsPath)) {
      return own;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === path.resolve(main));
    return [...(open ? collectMacros(open.getText()) : mainMacros(main)), ...own];
  }

  return vscode.languages.registerHoverProvider(
    [{ language: 'latex' }, { language: 'tex' }],
    {
      provideHover(doc, position) {
        const config = vscode.workspace.getConfiguration('overtex', doc.uri);
        if (!config.get<boolean>('mathPreview.enabled', true)) {
          return undefined;
        }
        const span = mathAt(spansOf(doc), doc.offsetAt(position));
        if (!span) {
          return undefined;
        }
        render ??= (require(path.join(extensionPath, 'out', 'mathRender.js')) as { renderMath: Render }).renderMath;
        const result = render(span.tex, span.display, macrosFor(doc));
        const range = new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end));
        const md = new vscode.MarkdownString();
        if ('error' in result) {
          md.appendMarkdown(`*${escapeMarkdown(result.error)}*`);
        } else {
          const scale = config.get<number>('mathPreview.scale', 1);
          md.appendMarkdown(`![math](data:image/svg+xml;base64,${Buffer.from(prepareSvg(result.svg, scale, textColor())).toString('base64')})`);
        }
        return new vscode.Hover(md, range);
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
