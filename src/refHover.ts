import * as fs from 'fs';
import * as vscode from 'vscode';

import { AuxLabel, describeAuxLabel, readAuxLabels } from './latex/aux';
import { LabelEntry, scanLabels } from './latex/labels';
import { mathAt } from './latex/math';
import { MathRenderer } from './mathPreview';

export interface RefHoverOptions {
  /** What the workspace's sources say about a key. */
  entry: (key: string) => Promise<LabelEntry | undefined>;
  /** The main .aux of the last build, if there is a main file. */
  auxFile: () => string | undefined;
  renderer: MathRenderer;
}

/**
 * Hovering over a key in \ref, \eqref, \cref and the like shows the number and page LaTeX gave it
 * in the last build (from the .aux files), and an equation's math, rendered.
 */
export function registerRefHover(options: RefHoverOptions): vscode.Disposable {
  let cache: { file: string; mtime: number; labels: Map<string, AuxLabel> | undefined } | undefined;

  const auxLabels = (): Map<string, AuxLabel> | undefined => {
    const file = options.auxFile();
    if (!file) {
      return undefined;
    }
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
    if (cache?.file !== file || cache.mtime !== mtime) {
      const read = (f: string) => {
        try {
          return fs.readFileSync(f, 'latin1');
        } catch {
          return undefined;
        }
      };
      cache = { file, mtime, labels: readAuxLabels(file, read) };
    }
    return cache.labels;
  };

  const equationOf = async (entry: LabelEntry): Promise<vscode.MarkdownString | undefined> => {
    const [site] = entry.definitions;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(site.file));
    const span = mathAt(options.renderer.spansOf(doc), doc.offsetAt(new vscode.Position(site.line, site.start)));
    return span && options.renderer.markdown(doc, span);
  };

  return vscode.languages.registerHoverProvider([{ language: 'latex' }, { language: 'tex' }], {
    async provideHover(doc, position) {
      if (!vscode.workspace.getConfiguration('overtex', doc.uri).get<boolean>('refHover.enabled', true)) {
        return undefined;
      }
      const ref = scanLabels(doc.getText()).refs.find(
        (o) => o.line === position.line && o.start <= position.character && position.character <= o.end
      );
      if (!ref) {
        return undefined;
      }
      const entry = await options.entry(ref.key);
      const defined = entry?.definitions.length ?? 0;
      const all = auxLabels();
      const label = all?.get(ref.key);

      const md = new vscode.MarkdownString();
      if (label) {
        md.appendMarkdown('**').appendText(describeAuxLabel(label, entry?.kind)).appendMarkdown('**');
      } else if (defined === 0) {
        md.appendText(`No \\label{${ref.key}} in the workspace.`);
      } else {
        md.appendMarkdown(all ? '*Not in the last build: build again to number it.*' : '*Build to see its number.*');
      }
      if (defined > 1) {
        md.appendMarkdown(`\n\n*Defined ${defined} times.*`);
      }
      if (entry && defined === 1 && (label?.type === 'equation' || (!label?.type && entry.kind === 'Equations'))) {
        const math = await equationOf(entry);
        if (math) {
          md.appendMarkdown('\n\n').appendMarkdown(math.value);
        }
      }
      return new vscode.Hover(md, new vscode.Range(ref.line, ref.start, ref.line, ref.end));
    },
  });
}
