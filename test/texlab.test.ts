import { describe, expect, it } from 'vitest';
import { findExecutable } from '../src/latex/executable';
import { texlabCannotOpen, texlabOptions, texlabStartDecision, texlabUri, withoutBuildLogDiagnostics } from '../src/latex/texlabConfig';

describe('texlabStartDecision', () => {
  const base = { enabled: true, workspaceTrusted: true, officialExtensionInstalled: false, workspaceFolders: ['/home/a/paper'] };

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

  it('does not start where a workspace folder path has [ or ], which crashes texlab', () => {
    expect(texlabStartDecision({ ...base, workspaceFolders: ['/home/a/paper', '/home/a/draft [v2]'] })).toBe('bracket-path');
    expect(texlabStartDecision({ ...base, workspaceFolders: ["/home/a/Drive'ım (1)/paper"] })).toBe('start');
  });
});

describe('texlabCannotOpen', () => {
  it('flags paths with square brackets only', () => {
    expect(texlabCannotOpen('/a/b[1]/main.tex')).toBe(true);
    expect(texlabCannotOpen('C:\\Users\\a\\x]\\main.tex')).toBe(true);
    expect(texlabCannotOpen("/a/Drive'ım (1) & co/main.tex")).toBe(false);
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

describe('texlabUri', () => {
  it("writes an apostrophe the way texlab does, so a Drive'ım folder links its .bib", () => {
    expect(texlabUri('file:///Users/me/Drive%27%C4%B1m/paper/main.tex')).toBe("file:///Users/me/Drive'%C4%B1m/paper/main.tex");
  });

  it('decodes the other characters texlab writes literally', () => {
    expect(texlabUri('file:///p/a%28b%29%26c%2Bd%2Ce%21f%40g%3Dh%3Bi%24j%2Ak/x.tex')).toBe('file:///p/a(b)&c+d,e!f@g=h;i$j*k/x.tex');
  });

  it('keeps everything texlab encodes too, and Windows drive letters', () => {
    const uri = 'file:///c%3A/My%20Papers/%23draft/50%25/%5Bold%5D/%C3%BC.tex';
    expect(texlabUri(uri)).toBe(uri);
  });

  it('leaves untitled documents alone', () => {
    expect(texlabUri('untitled:Untitled-1%27')).toBe('untitled:Untitled-1%27');
  });
});
