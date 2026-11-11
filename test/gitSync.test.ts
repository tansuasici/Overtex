import { describe, expect, it } from 'vitest';
import {
  IGNORE_HEADER,
  commitMessage,
  describeGitError,
  isBuildOutput,
  missingIgnoreLines,
  needsIdentity,
  pushRemote,
  syncStatus,
  withIgnoreLines,
} from '../src/shared/gitSync';

describe('commitMessage', () => {
  it('uses the default for an empty answer and keeps a cancel as a cancel', () => {
    expect(commitMessage('')).toBe('Update');
    expect(commitMessage('   ')).toBe('Update');
    expect(commitMessage(' Fixed the intro ')).toBe('Fixed the intro');
    expect(commitMessage(undefined)).toBeUndefined();
  });
});

describe('isBuildOutput', () => {
  it('knows the files LaTeX writes on a build', () => {
    expect(isBuildOutput('main.aux')).toBe(true);
    expect(isBuildOutput('chapters/part.aux')).toBe(true);
    expect(isBuildOutput('main.synctex.gz')).toBe(true);
    expect(isBuildOutput('main.fdb_latexmk')).toBe(true);
    expect(isBuildOutput('build\\main.log')).toBe(true);
  });

  it('leaves sources, notes and figure PDFs alone', () => {
    expect(isBuildOutput('main.tex')).toBe(false);
    expect(isBuildOutput('refs.bib')).toBe(false);
    expect(isBuildOutput('.overtex/notes.json')).toBe(false);
    expect(isBuildOutput('figures/plot.pdf', 'main.pdf')).toBe(false);
  });

  it('treats only the main document PDF as built', () => {
    expect(isBuildOutput('main.pdf', 'main.pdf')).toBe(true);
    expect(isBuildOutput('out/main.pdf', 'out\\main.pdf')).toBe(true);
    expect(isBuildOutput('main.pdf')).toBe(false);
  });
});

describe('missingIgnoreLines', () => {
  it('lists every build pattern for an empty .gitignore, with the PDF anchored to the root', () => {
    const lines = missingIgnoreLines('', 'main.pdf');
    expect(lines).toContain('*.aux');
    expect(lines).toContain('*.synctex.gz');
    expect(lines).toContain('/main.pdf');
    expect(lines).not.toContain('*.pdf');
  });

  it('skips lines that are already there, and the PDF when *.pdf is ignored', () => {
    const lines = missingIgnoreLines('# mine\n*.aux\r\n*.log\n*.pdf\n', 'main.pdf');
    expect(lines).not.toContain('*.aux');
    expect(lines).not.toContain('*.log');
    expect(lines).not.toContain('/main.pdf');
    expect(lines).toContain('*.fls');
  });

  it('does not count a commented-out line as present', () => {
    expect(missingIgnoreLines('# *.aux\n')).toContain('*.aux');
  });
});

describe('withIgnoreLines', () => {
  it('starts a new file with the header', () => {
    expect(withIgnoreLines('', ['*.aux'])).toBe(`${IGNORE_HEADER}\n*.aux\n`);
  });

  it('appends after existing lines with a blank line between', () => {
    expect(withIgnoreLines('node_modules', ['*.aux', '*.log'])).toBe(`node_modules\n\n${IGNORE_HEADER}\n*.aux\n*.log\n`);
    expect(withIgnoreLines('a\n', ['*.aux'])).toBe(`a\n\n${IGNORE_HEADER}\n*.aux\n`);
  });

  it('changes nothing when nothing is missing', () => {
    expect(withIgnoreLines('a\n', [])).toBe('a\n');
  });
});

describe('pushRemote', () => {
  it('pushes to the upstream remote first, then origin, then the only remote', () => {
    expect(pushRemote(['origin', 'gitlab'], 'gitlab')).toBe('gitlab');
    expect(pushRemote(['origin', 'gitlab'])).toBe('origin');
    expect(pushRemote(['github'])).toBe('github');
  });

  it('asks when it cannot tell which remote is yours', () => {
    expect(pushRemote(['github', 'gitlab'])).toBeUndefined();
    expect(pushRemote(['github', 'gitlab'], 'gone')).toBeUndefined();
    expect(pushRemote([])).toBeUndefined();
  });
});

describe('syncStatus', () => {
  it('shows versions to get, to send, and unshared edits', () => {
    expect(syncStatus({ changes: 2, ahead: 1, behind: 3 }).text).toBe('$(sync) 3↓ 1↑ •');
    expect(syncStatus({ changes: 2, ahead: 1, behind: 3 }).tooltip).toBe(
      'Overtex: 2 edited files not shared yet, 1 version to send, 3 versions to get. Click to share and get changes.'
    );
  });

  it('is a bare icon when everything is shared', () => {
    const s = syncStatus({ changes: 0, ahead: 0, behind: 0 });
    expect(s.text).toBe('$(sync)');
    expect(s.tooltip).toContain('Everything is shared');
  });

  it('spins while syncing', () => {
    expect(syncStatus({ changes: 1, ahead: 0, behind: 0, busy: true }).text).toBe('$(sync~spin) Syncing…');
  });
});

describe('describeGitError', () => {
  it('turns Git error codes into plain language', () => {
    expect(describeGitError({ gitErrorCode: 'AuthenticationFailed' })).toMatch(/refused access/);
    expect(describeGitError({ gitErrorCode: 'PushRejected' })).toMatch(/Get Changes/);
    expect(describeGitError({ gitErrorCode: 'RemoteConnectionError' })).toMatch(/internet/);
    expect(describeGitError({ gitErrorCode: 'Conflict' })).toMatch(/same lines/);
  });

  it('recognises merge refusals from the git output', () => {
    expect(describeGitError({ stderr: 'fatal: refusing to merge unrelated histories' })).toMatch(/starting point/);
    expect(
      describeGitError({ stderr: 'error: Your local changes to the following files would be overwritten by merge:\n\tmain.tex' })
    ).toMatch(/Share Changes instead/);
  });

  it('falls back to the first line of the git output without the fatal prefix', () => {
    expect(describeGitError(Object.assign(new Error('Failed to execute git'), { stderr: '\nfatal: something odd\nmore' }))).toBe('something odd');
    expect(describeGitError(new Error('plain'))).toBe('plain');
  });

  it('knows when Git is missing your name or email', () => {
    expect(needsIdentity({ gitErrorCode: 'NoUserEmailConfigured' })).toBe(true);
    expect(needsIdentity(new Error('x'))).toBe(false);
  });
});
