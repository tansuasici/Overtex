import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { BuildResult } from './latex/builder';
import { annotatePdf } from './pdf/annotate';
import { PdfError } from './pdf/objects';
import { readOpenNotes } from './reviewPdf';
import { notesFilePath } from './shared/notes';

export interface PdfWithNotesDeps {
  mainFile: () => string | null;
  /** Where the build writes the main PDF. */
  pdfFor: (main: string) => string;
  build: (target?: string) => Promise<BuildResult | undefined>;
}

export interface PdfWithNotesResult {
  pdf: string;
  placed: number;
  skipped: number;
}

/** `main.pdf` → `main-notes.pdf`, beside it. */
export function notesPdfPath(pdf: string): string {
  return path.join(path.dirname(pdf), `${path.basename(pdf, path.extname(pdf))}-notes.pdf`);
}

/**
 * Overtex: Export PDF with Notes. Copies the built PDF to `<main>-notes.pdf` with the open notes as
 * standard sticky notes, which other PDF readers show and can reply to. The notes were placed on the
 * PDF as it is now, so it is only built when there is none yet. Returns the result, for tests.
 */
export async function exportPdfWithNotesCommand(deps: PdfWithNotesDeps): Promise<PdfWithNotesResult | undefined> {
  const main = deps.mainFile();
  if (!main) {
    void vscode.window.showWarningMessage('Overtex: no LaTeX document found to export.');
    return undefined;
  }
  const notes = readOpenNotes(main);
  if (!notes) {
    void vscode.window.showErrorMessage(`Overtex: ${path.basename(notesFilePath(main))} could not be read, so there are no notes to export.`);
    return undefined;
  }
  if (!notes.length) {
    void vscode.window.showInformationMessage('Overtex: there are no open notes to export. Double-click a page in the PDF preview to add one.');
    return undefined;
  }

  let pdf = deps.pdfFor(main);
  if (!fs.existsSync(pdf)) {
    const result = await deps.build(main);
    if (!result?.pdfFile) {
      return undefined;
    }
    pdf = result.pdfFile;
  }

  const out = notesPdfPath(pdf);
  let placed: number;
  let skipped: number;
  try {
    const result = annotatePdf(await fs.promises.readFile(pdf), notes);
    if (!result.placed) {
      void vscode.window.showWarningMessage(`Overtex: none of the open notes is on a page that ${path.basename(pdf)} has, so nothing was exported.`);
      return undefined;
    }
    await fs.promises.writeFile(out, result.bytes);
    ({ placed, skipped } = result);
  } catch (err) {
    if (!(err instanceof PdfError)) {
      throw err;
    }
    void vscode.window.showErrorMessage(`Overtex: could not add notes to ${path.basename(pdf)}: ${err.message}.`);
    return undefined;
  }

  const count = `${placed} ${placed === 1 ? 'note' : 'notes'}`;
  const left = skipped ? ` ${skipped} ${skipped === 1 ? 'note is' : 'notes are'} on pages the PDF no longer has and ${skipped === 1 ? 'was' : 'were'} left out.` : '';
  const show = skipped ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  void show(`Overtex: saved ${path.basename(out)} with ${count}.${left}`, 'Open', 'Reveal').then((choice) => {
    if (choice === 'Open') {
      void vscode.env.openExternal(vscode.Uri.file(out));
    } else if (choice === 'Reveal') {
      void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(out));
    }
  });
  return { pdf: out, placed, skipped };
}
