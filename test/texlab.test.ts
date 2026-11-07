import { describe, expect, it } from 'vitest';
import { findExecutable } from '../src/latex/executable';
import { texlabOptions, texlabStartDecision, withoutBuildLogDiagnostics } from '../src/latex/texlabConfig';

describe('texlabStartDecision', () => {
  const base = { enabled: true, workspaceTrusted: true, officialExtensionInstalled: false };

  it('starts in a trusted workspace', () => {
    expect(texlabStartDecision(base)).toBe('start');
  });

  it('respects the setting', () => {
    expect(texlabStartDecision({ ...base, enabled: false })).toBe('disabled');
  });

  it('leaves the field to the official TexLab extension', () => {
    expect(texlabStartDecision({ ...base, officialExtensionInstalled: true })).toBe('official-extension');
  });

  it('never runs a configurable executable in an untrusted workspace', () => {
    expect(texlabStartDecision({ ...base, workspaceTrusted: false })).toBe('untrusted');
  });
});

describe('texlabOptions', () => {
  it('keeps texlab from building or forward searching on its own', () => {
    const opts = texlabOptions({ outDir: '', chktex: false }) as any;
    expect(opts.build.onSave).toBe(false);
    expect(opts.build.forwardSearchAfter).toBe(false);
  });

  it('points texlab at the Overtex output directory', () => {
    const opts = texlabOptions({ outDir: 'build', chktex: false }) as any;
    expect(opts.build.auxDirectory).toBe('build');
    expect(opts.build.logDirectory).toBe('build');
    expect(opts.build.pdfDirectory).toBe('build');
    expect((texlabOptions({ outDir: '  ', chktex: false }) as any).build.auxDirectory).toBe('.');
  });

  it('toggles ChkTeX', () => {
    expect((texlabOptions({ outDir: '', chktex: true }) as any).chktex).toEqual({ onOpenAndSave: true, onEdit: true });
    expect((texlabOptions({ outDir: '', chktex: false }) as any).chktex).toEqual({ onOpenAndSave: false, onEdit: false });
  });
});

describe('withoutBuildLogDiagnostics', () => {
  it('drops build-log diagnostics and keeps live ones', () => {
    const diags = [
      { source: 'texlab', message: 'Expecting a curly bracket' },
      { source: 'latex', message: 'Undefined control sequence.' },
      { source: 'ChkTeX', message: 'Wrong length of dash' },
      { message: 'no source' },
    ];
    expect(withoutBuildLogDiagnostics(diags).map((d) => d.message)).toEqual([
      'Expecting a curly bracket',
      'Wrong length of dash',
      'no source',
    ]);
  });
});

describe('findExecutable', () => {
  it('looks a bare name up on PATH', () => {
    const files = new Set(['/opt/homebrew/bin/texlab']);
    expect(findExecutable('texlab', { PATH: '/usr/bin:/opt/homebrew/bin' }, 'darwin', (f) => files.has(f))).toBe(
      '/opt/homebrew/bin/texlab'
    );
  });

  it('returns undefined when it is not installed', () => {
    expect(findExecutable('texlab', { PATH: '/usr/bin' }, 'linux', () => false)).toBeUndefined();
  });

  it('checks an explicit path as is', () => {
    expect(findExecutable('/x/texlab', { PATH: '' }, 'linux', (f) => f === '/x/texlab')).toBe('/x/texlab');
    expect(findExecutable('./texlab', { PATH: '/x' }, 'linux', (f) => f === '/x/texlab')).toBeUndefined();
  });

  it('applies PATHEXT on Windows', () => {
    const files = new Set(['C:\\tools\\texlab.EXE']);
    expect(
      findExecutable('texlab', { Path: 'C:\\Windows;C:\\tools', PATHEXT: '.COM;.EXE' }, 'win32', (f) => files.has(f))
    ).toBe('C:\\tools\\texlab.EXE');
  });
});
