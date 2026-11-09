import * as vscode from 'vscode';
import * as path from 'path';

import { buildSettings, settings } from './config';
import { isCancellation } from './latex/bibCheck';
import { Commit, CompareError, CompareResult, Version, compareVersions, listCommits } from './latex/latexdiff';

export interface CompareDeps {
  mainFile: () => string | null;
  saveSources: () => Promise<void>;
  showPdf: (pdf: string) => Promise<void>;
  log: (text: string) => void;
  showLog: () => void;
}

/** Arguments for running without the pickers; `new` defaults to the main file on disk. */
export interface CompareArgs {
  old: Version;
  new?: Version;
}

interface VersionPick extends vscode.QuickPickItem {
  /** Unset for the item that opens a file dialog. */
  version?: Version;
}

function commitPick(commit: Commit): VersionPick {
  const refs = commit.refs.replace(/^HEAD -> /, '');
  return {
    label: `$(git-commit) ${commit.subject}`,
    description: [commit.shortHash, commit.date, refs].filter(Boolean).join('  '),
    version: { revision: commit.hash },
  };
}

async function chooseFile(title: string, main: string): Promise<Version | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title,
    defaultUri: vscode.Uri.file(path.dirname(main)),
    canSelectMany: false,
    filters: { LaTeX: ['tex', 'ltx'] },
  });
  return picked?.[0] && { file: picked[0].fsPath };
}

const ANOTHER_FILE: VersionPick = { label: '$(file) Choose a .tex file…' };

/** Asks for an earlier version: a commit of the main file's repository or another .tex file. */
export async function chooseOldVersion(main: string, title: string, commits?: Commit[]): Promise<Version | undefined> {
  const list = commits ?? (await listCommits(main));
  const pick = await vscode.window.showQuickPick<VersionPick>([...list.map(commitPick), ANOTHER_FILE], {
    title,
    placeHolder: list.length ? 'Which commit or file should be compared?' : 'This folder has no git history. Choose a file to compare.',
  });
  if (!pick) {
    return undefined;
  }
  return pick.version ?? (await chooseFile('Old version', main));
}

/** Asks for the old version, then for the new one: the files on disk, a later commit or another file. */
async function chooseVersions(main: string): Promise<{ old: Version; new: Version } | undefined> {
  const commits = await listCommits(main);
  const old = await chooseOldVersion(main, 'Compare Versions: old version', commits);
  if (!old) {
    return undefined;
  }

  const index = 'revision' in old ? commits.findIndex((c) => c.hash === old.revision) : 0;
  const current: VersionPick = { label: `$(file-text) Current ${path.basename(main)}`, description: 'the files on disk', version: { file: main } };
  const newPick = await vscode.window.showQuickPick<VersionPick>([current, ...commits.slice(0, index).map(commitPick), ANOTHER_FILE], {
    title: 'Compare Versions: new version',
  });
  if (!newPick) {
    return undefined;
  }
  const next = newPick.version ?? (await chooseFile('New version', main));
  return next && { old, new: next };
}

/**
 * Overtex: Compare Versions. Marks up the changes between two git commits, a commit and the files
 * on disk, or two files with latexdiff, and shows the PDF. Returns the result, for tests.
 */
export async function compareVersionsCommand(deps: CompareDeps, args?: CompareArgs): Promise<CompareResult | undefined> {
  const main = deps.mainFile();
  if (!main) {
    void vscode.window.showWarningMessage('Overtex: no LaTeX document found to compare.');
    return undefined;
  }
  const versions = args ? { old: args.old, new: args.new ?? { file: main } } : await chooseVersions(main);
  if (!versions) {
    return undefined;
  }
  await deps.saveSources();

  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Overtex: comparing versions', cancellable: true },
      async (_progress, token) => {
        const ctl = new AbortController();
        const sub = token.onCancellationRequested(() => ctl.abort());
        try {
          return await compareVersions({
            mainFile: main,
            ...versions,
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
      void vscode.window.showInformationMessage('Overtex: the two versions have the same document text.');
      return result;
    }
    await deps.showPdf(result.pdf);
    if (result.complete) {
      void vscode.window.showInformationMessage(`Overtex: changes marked up in ${path.basename(result.pdf)}.`);
    } else {
      void showFailure(deps, `TeX reported errors in the marked-up document, so ${path.basename(result.pdf)} may be incomplete.`, 'warning');
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

async function showFailure(deps: CompareDeps, message: string, level: 'warning' | 'error'): Promise<void> {
  const show = level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showErrorMessage;
  if ((await show(`Overtex: ${message}`, 'Show Log')) === 'Show Log') {
    deps.showLog();
  }
}
