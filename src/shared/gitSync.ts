// Plain-language helpers for Share Changes / Get Changes. No vscode import, so they are unit tested.

/** Files LaTeX writes next to the sources on every build. PDFs are not here: figures are often PDFs. */
export const LATEX_BUILD_PATTERNS = [
  '*.aux',
  '*.log',
  '*.fls',
  '*.fdb_latexmk',
  '*.synctex.gz',
  '*.synctex(busy)',
  '*.out',
  '*.toc',
  '*.lof',
  '*.lot',
  '*.bbl',
  '*.blg',
  '*.bcf',
  '*.run.xml',
  '*.xdv',
  '*.nav',
  '*.snm',
];

export const IGNORE_HEADER = '# LaTeX build files (added by Overtex)';

export const DEFAULT_COMMIT_MESSAGE = 'Update';

/** Undefined when the person cancelled the box; an empty answer means the default message. */
export function commitMessage(input: string | undefined): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed || DEFAULT_COMMIT_MESSAGE;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** `*.aux`-style patterns only: enough for the fixed list above. */
function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.startsWith('*')) {
    return name.endsWith(pattern.slice(1));
  }
  return name === pattern;
}

/**
 * Whether a changed file (path relative to the repository root) is a build output: an aux-style file,
 * or the main document's PDF (`builtPdf`, also relative to the root).
 */
export function isBuildOutput(relPath: string, builtPdf?: string): boolean {
  const rel = toPosix(relPath);
  if (builtPdf && rel === toPosix(builtPdf)) {
    return true;
  }
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return LATEX_BUILD_PATTERNS.some((p) => matchesPattern(name, p));
}

/** The .gitignore lines that would leave out the build outputs, minus the ones already there. */
export function missingIgnoreLines(existing: string, builtPdf?: string): string[] {
  const present = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  );
  const wanted = [...LATEX_BUILD_PATTERNS];
  if (builtPdf) {
    wanted.push(`/${toPosix(builtPdf).replace(/^\/+/, '')}`);
  }
  // `*.pdf` already covers the built PDF.
  return wanted.filter((line) => !present.has(line) && !(line.endsWith('.pdf') && present.has('*.pdf')));
}

/** The .gitignore text with the missing lines added under one header. */
export function withIgnoreLines(existing: string, lines: string[]): string {
  if (!lines.length) {
    return existing;
  }
  const head = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
  const gap = head ? '\n' : '';
  return `${head}${gap}${IGNORE_HEADER}\n${lines.join('\n')}\n`;
}

/**
 * The remote Share Changes pushes to: your own copy. That is the branch's upstream remote, else
 * `origin`, else the only remote. Undefined means ask. A co-author's remote is only ever pulled from.
 */
export function pushRemote(remotes: string[], upstreamRemote?: string): string | undefined {
  if (upstreamRemote && remotes.includes(upstreamRemote)) {
    return upstreamRemote;
  }
  if (remotes.includes('origin')) {
    return 'origin';
  }
  return remotes.length === 1 ? remotes[0] : undefined;
}

/**
 * Where a project with no versions yet starts from: the first remote copy of this branch, else of
 * `main` or `master`. The branch is the one to switch the empty project to.
 */
export function startingRef(remoteBranches: string[], remotes: string[], branch: string): { ref: string; branch: string } | undefined {
  for (const name of [branch, 'main', 'master']) {
    for (const remote of remotes) {
      if (remoteBranches.includes(`${remote}/${name}`)) {
        return { ref: `${remote}/${name}`, branch: name };
      }
    }
  }
  return undefined;
}

export interface SyncCounts {
  /** Edited files not yet saved as a version. */
  changes: number;
  /** Versions here that the online copy does not have. */
  ahead: number;
  /** Versions online that are not here yet (as of the last fetch). */
  behind: number;
  busy?: boolean;
}

export function syncStatus(c: SyncCounts): { text: string; tooltip: string } {
  if (c.busy) {
    return { text: '$(sync~spin) Syncing…', tooltip: 'Overtex: sharing and getting changes…' };
  }
  const parts: string[] = [];
  if (c.behind) {
    parts.push(`${c.behind}↓`);
  }
  if (c.ahead) {
    parts.push(`${c.ahead}↑`);
  }
  if (c.changes) {
    parts.push('•');
  }
  const lines: string[] = [];
  if (c.changes) {
    lines.push(`${c.changes} edited file${c.changes === 1 ? '' : 's'} not shared yet`);
  }
  if (c.ahead) {
    lines.push(`${c.ahead} version${c.ahead === 1 ? '' : 's'} to send`);
  }
  if (c.behind) {
    lines.push(`${c.behind} version${c.behind === 1 ? '' : 's'} to get`);
  }
  if (!lines.length) {
    lines.push('Everything is shared');
  }
  return {
    text: parts.length ? `$(sync) ${parts.join(' ')}` : '$(sync)',
    tooltip: `Overtex: ${lines.join(', ')}. Click to share and get changes.`,
  };
}

/** Error codes the Git extension puts on its errors (`gitErrorCode`). */
export function describeGitError(err: unknown): string {
  const code = (err as { gitErrorCode?: string } | undefined)?.gitErrorCode;
  const stderr = (err as { stderr?: string } | undefined)?.stderr ?? '';
  const message = err instanceof Error ? err.message : String(err);
  switch (code) {
    case 'AuthenticationFailed':
    case 'PermissionDenied':
      return 'The online copy refused access. Check that you are signed in and have been given access to it.';
    case 'RemoteConnectionError':
    case 'CantAccessRemote':
      return 'Could not reach the online copy. Check your internet connection and try again.';
    case 'RepositoryNotFound':
      return 'The online copy was not found. It may have been moved or deleted, or you may not have access.';
    case 'PushRejected':
      return 'The online copy has newer changes than yours. Run Overtex: Get Changes, then share again.';
    case 'NoUserNameConfigured':
    case 'NoUserEmailConfigured':
      return 'Git needs your name and email to label your changes.';
  }
  if (needsIdentity(err)) {
    return 'Git needs your name and email to label your changes.';
  }
  switch (code) {
    case 'Conflict':
    case 'UnmergedChanges':
      return 'You and a co-author changed the same lines. Choose which version to keep, then share again.';
    case 'LocalChangesOverwritten':
    case 'DirtyWorkTree':
      return 'You have edits that are not shared yet in files that also changed online. Run Overtex: Share Changes instead: it saves your edits first.';
  }
  const text = `${stderr}\n${message}`;
  if (/unrelated histories/i.test(text)) {
    return 'The two copies do not share a starting point, so Overtex cannot combine them. One of you should start from a copy of the other.';
  }
  if (/would be overwritten by merge/i.test(text)) {
    return describeGitError({ gitErrorCode: 'LocalChangesOverwritten' });
  }
  const first = (stderr || message).split(/\r?\n/).find((l) => l.trim());
  return first?.replace(/^(fatal|error):\s*/i, '').trim() || 'Git failed.';
}

export function needsIdentity(err: unknown): boolean {
  const code = (err as { gitErrorCode?: string } | undefined)?.gitErrorCode;
  const stderr = (err as { stderr?: string } | undefined)?.stderr ?? '';
  return code === 'NoUserNameConfigured' || code === 'NoUserEmailConfigured' || /tell me who you are/i.test(stderr);
}
