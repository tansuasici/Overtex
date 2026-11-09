import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { chooseOldVersion } from './compareVersions';
import { buildSettings, settings } from './config';
import { isCancellation } from './latex/bibCheck';
import { BuildResult } from './latex/builder';
import { CompareError, Version } from './latex/latexdiff';
import { PlacedNote, ReviewResult, exportReview } from './latex/review';
import { Note, inReadingOrder, isDone, notesFilePath, parseNotes } from './shared/notes';

export interface ReviewDeps {
  mainFile: () => string | null;
  build: (target?: string) => Promise<BuildResult | undefined>;
  /** SyncTeX from a point on a PDF page to a source line. */
  inverse: (pdf: string, page: number, x: number, y: number) => Promise<{ file: string; line: number } | null>;
  saveSources: () => Promise<void>;
  showPdf: (pdf: string) => Promise<void>;
  log: (text: string) => void;
  showLog: () => void;
}

/** Arguments for running without the picker. */
export interface ReviewArgs {
  lineNumbers?: boolean;
  notes?: boolean;
  since?: Version;
}

interface OptionPick extends vscode.QuickPickItem {
  option: 'lineNumbers' | 'notes' | 'since';
}

/** The open notes, or undefined when the notes file exists but cannot be read. */
function readOpenNotes(main: string): Note[] | undefined {
  let content: string;
  try {
    content = fs.readFileSync(notesFilePath(main), 'utf-8');
  } catch {
    return [];
  }
  try {
    return inReadingOrder(parseNotes(content).filter((n) => !isDone(n)));
  } catch {
    return undefined;
  }
}

async function chooseOptions(main: string, openNotes: number): Promise<Required<Pick<ReviewArgs, 'lineNumbers' | 'notes'>> & { since?: Version } | undefined> {
  const items: OptionPick[] = [{ option: 'lineNumbers', label: 'Line numbers', picked: true }];
  if (openNotes) {
    items.push({ option: 'notes', label: 'Notes in the margin', description: `${openNotes} open ${openNotes === 1 ? 'note' : 'notes'}`, picked: true });
  }
  items.push({ option: 'since', label: 'Changes since a version…', description: 'marked up with latexdiff' });
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Export Review PDF',
    placeHolder: 'What should the review copy show? Your source files are not changed.',
    canPickMany: true,
  });
  if (!picked) {
    return undefined;
  }
  const has = (option: OptionPick['option']): boolean => picked.some((p) => p.option === option);
  let since: Version | undefined;
  if (has('since')) {
    since = await chooseOldVersion(main, 'Export Review PDF: changes since');
    if (!since) {
      return undefined;
    }
  }
  return { lineNumbers: has('lineNumbers'), notes: has('notes'), since };
}

/** Finds the source line of each note in a fresh build. */
async function placeNotes(deps: ReviewDeps, main: string, notes: Note[]): Promise<PlacedNote[] | undefined> {
  const result = await deps.build(main);
  if (!result || result.cancelled) {
    return undefined;
  }
  if (!result.pdfFile) {
    throw new CompareError('build-failed', 'the document did not build, so the notes could not be placed.');
  }
  const pdf = result.pdfFile;
  const placed: PlacedNote[] = [];
  for (const note of notes) {
    try {
      const source = await deps.inverse(pdf, note.page, note.x, note.y);
      if (source && source.line >= 1 && /\.(tex|ltx)$/i.test(source.file)) {
        placed.push({ id: note.id, text: note.text, file: source.file, line: source.line });
      }
    } catch (err) {
      deps.log(`Review PDF: could not place note ${note.id}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return placed;
}

/**
 * Overtex: Export Review PDF. Builds `<main>-review.pdf` with line numbers, open PDF notes in the
 * margin and, if asked, the changes since an earlier version. Returns the result, for tests.
 */
export async function exportReviewPdfCommand(deps: ReviewDeps, args?: ReviewArgs): Promise<ReviewResult | undefined> {
  const main = deps.mainFile();
  if (!main) {
    void vscode.window.showWarningMessage('Overtex: no LaTeX document found to export.');
    return undefined;
  }
  let notes = readOpenNotes(main);
  if (!notes) {
    void vscode.window.showWarningMessage(`Overtex: ${path.basename(notesFilePath(main))} could not be read, so the review copy has no notes.`);
    notes = [];
  }
  const options = args
    ? { lineNumbers: args.lineNumbers ?? true, notes: args.notes ?? notes.length > 0, since: args.since }
    : await chooseOptions(main, notes.length);
  if (!options) {
    return undefined;
  }
  await deps.saveSources();

  try {
    let placed: PlacedNote[] = [];
    if (options.notes && notes.length) {
      const found = await placeNotes(deps, main, notes);
      if (!found) {
        return undefined;
      }
      placed = found;
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Overtex: building the review copy', cancellable: true },
      async (_progress, token) => {
        const ctl = new AbortController();
        const sub = token.onCancellationRequested(() => ctl.abort());
        try {
          return await exportReview({
            mainFile: main,
            lineNumbers: options.lineNumbers,
            notes: placed,
            since: options.since,
            latexdiff: settings.latexdiffPath(),
            build: buildSettings(),
            signal: ctl.signal,
            log: deps.log,
          });
        } finally {
          sub.dispose();
        }
      }
    );
    if (result.status === 'identical') {
      void vscode.window.showInformationMessage('Overtex: nothing has changed since that version, so there is nothing to mark up.');
      return result;
    }
    await deps.showPdf(result.pdf);
    const missing = options.notes ? notes.length - result.placed : 0;
    const name = path.basename(result.pdf);
    if (!result.complete) {
      void showFailure(deps, `TeX reported errors in the review copy, so ${name} may be incomplete.`, 'warning');
    } else if (missing > 0) {
      void showFailure(deps, `${name} is ready, but ${missing} ${missing === 1 ? 'note' : 'notes'} could not be placed in the margin.`, 'warning');
    } else {
      void vscode.window.showInformationMessage(`Overtex: review copy saved as ${name}.`);
    }
    return result;
  } catch (err) {
    if (isCancellation(err)) {
      return undefined;
    }
    if (!(err instanceof CompareError)) {
      throw err;
    }
    const hint = err.kind === 'latexdiff-missing' ? ' latexdiff comes with TeX Live and MiKTeX and needs Perl; check that it is on PATH or set overtex.latexdiff.path.' : '';
    void showFailure(deps, `${err.message}${hint}`, 'error');
    return undefined;
  }
}

async function showFailure(deps: ReviewDeps, message: string, level: 'warning' | 'error'): Promise<void> {
  const show = level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showErrorMessage;
  if ((await show(`Overtex: ${message}`, 'Show Log')) === 'Show Log') {
    deps.showLog();
  }
}
