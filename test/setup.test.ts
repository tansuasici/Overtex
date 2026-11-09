import { describe, expect, it } from 'vitest';
import { SetupInput, checkSetup, formatReport, setupOptions, standardTexDirs, texInstallHint } from '../src/latex/setup';

function input(files: string[], overrides: Partial<SetupInput> = {}): SetupInput {
  const set = new Set(files);
  const dirs: Record<string, string[]> = {
    '/usr/local/texlive': ['2023', '2025', 'texmf-local'],
    '/usr/local/texlive/2025/bin': ['x86_64-linux'],
    '/usr/local/texlive/2023/bin': ['x86_64-linux'],
  };
  return {
    tool: 'latexmk',
    latexmk: 'latexmk',
    tectonic: 'tectonic',
    docker: 'docker',
    engine: 'pdflatex',
    synctex: 'synctex',
    env: { PATH: '/usr/bin:/bin' },
    platform: 'linux',
    isFile: (p) => set.has(p),
    listDir: (d) => dirs[d] ?? [],
    ...overrides,
  };
}

describe('checkSetup', () => {
  it('needs only Tectonic when building with Tectonic, whatever the engine', () => {
    const report = checkSetup(input(['/usr/bin/tectonic'], { tool: 'tectonic', engine: 'lualatex' }));
    expect(report.tool).toBe('tectonic');
    expect(report.canBuild).toBe(true);
    expect(report.tools.map((t) => t.name)).not.toContain('latexmk');
    expect(report.tools.map((t) => t.name)).not.toContain('lualatex');
  });

  it('needs only Docker when building with Docker', () => {
    const report = checkSetup(input(['/usr/bin/docker'], { tool: 'docker' }));
    expect(report.canBuild).toBe(true);
    expect(report.tools.map((t) => t.name)).not.toContain('latexmk');
    expect(report.missingOptional.map((t) => t.name)).toEqual(['synctex']);
  });

  it('says what to install for the chosen tool', () => {
    const report = checkSetup(input(['/usr/bin/latexmk', '/usr/bin/pdflatex'], { tool: 'tectonic' }));
    expect(report.canBuild).toBe(false);
    expect(report.missingRequired.map((t) => t.name)).toEqual(['tectonic']);
    expect(texInstallHint('darwin', 'tectonic').text.toLowerCase()).toContain('tectonic');
    expect(texInstallHint('linux', 'docker').text.toLowerCase()).toContain('docker');
    expect(formatReport(report, 'darwin').toLowerCase()).toContain('tectonic');
  });

  it('lists latexdiff as optional when asked to check it', () => {
    const report = checkSetup(input(['/usr/bin/latexmk', '/usr/bin/pdflatex', '/usr/bin/synctex'], { latexdiff: 'latexdiff' }));
    expect(report.canBuild).toBe(true);
    expect(report.missingOptional.map((t) => t.name)).toContain('latexdiff');
  });

  it('reports a complete installation', () => {
    const report = checkSetup(input(['/usr/bin/latexmk', '/usr/bin/pdflatex', '/usr/bin/synctex']));
    expect(report.canBuild).toBe(true);
    expect(report.missingRequired).toEqual([]);
    expect(report.missingOptional).toEqual([]);
    expect(report.tools.map((t) => t.resolved)).toEqual(['/usr/bin/latexmk', '/usr/bin/pdflatex', '/usr/bin/synctex']);
  });

  it('cannot build without latexmk or the engine', () => {
    const report = checkSetup(input(['/usr/bin/pdflatex'], { engine: 'xelatex' }));
    expect(report.canBuild).toBe(false);
    expect(report.missingRequired.map((t) => t.name)).toEqual(['latexmk', 'xelatex']);
    expect(report.missingOptional.map((t) => t.name)).toEqual(['synctex']);
  });

  it('checks texlab only when asked, as optional', () => {
    const files = ['/usr/bin/latexmk', '/usr/bin/pdflatex', '/usr/bin/synctex'];
    expect(checkSetup(input(files)).tools.map((t) => t.name)).not.toContain('texlab');
    const report = checkSetup(input(files, { texlab: 'texlab' }));
    expect(report.canBuild).toBe(true);
    expect(report.missingOptional.map((t) => t.name)).toEqual(['texlab']);
  });

  it('finds TeX Live installed but not on PATH, newest year first', () => {
    const report = checkSetup(
      input([
        '/usr/local/texlive/2023/bin/x86_64-linux/latexmk',
        '/usr/local/texlive/2025/bin/x86_64-linux/latexmk',
        '/usr/local/texlive/2025/bin/x86_64-linux/pdflatex',
      ])
    );
    expect(report.canBuild).toBe(false);
    expect(report.missingRequired[0].foundOutsidePath).toBe('/usr/local/texlive/2025/bin/x86_64-linux/latexmk');
    expect(formatReport(report, 'linux')).toContain('restart VS Code');
  });

  it('finds MacTeX outside a Dock-launched PATH', () => {
    const report = checkSetup(input(['/Library/TeX/texbin/latexmk', '/Library/TeX/texbin/pdflatex'], { platform: 'darwin' }));
    expect(report.missingRequired.map((t) => t.foundOutsidePath)).toEqual(['/Library/TeX/texbin/latexmk', '/Library/TeX/texbin/pdflatex']);
  });

  it('does not search elsewhere for an explicit path that does not exist', () => {
    const report = checkSetup(input(['/Library/TeX/texbin/latexmk'], { latexmk: '/opt/tex/latexmk', platform: 'darwin' }));
    expect(report.tools[0].resolved).toBeUndefined();
    expect(report.tools[0].foundOutsidePath).toBeUndefined();
  });

  it('honours PATHEXT on Windows', () => {
    const report = checkSetup(
      input(['C:\\tex\\latexmk.EXE', 'C:\\tex\\pdflatex.EXE'], {
        platform: 'win32',
        env: { Path: 'C:\\tex', PATHEXT: '.EXE' },
      })
    );
    expect(report.canBuild).toBe(true);
  });

  it('finds MiKTeX in Program Files on Windows', () => {
    const report = checkSetup(
      input(['C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\latexmk.exe'], {
        platform: 'win32',
        env: { Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
      })
    );
    expect(report.tools[0].foundOutsidePath).toBe('C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\latexmk.exe');
  });
});

describe('standardTexDirs', () => {
  it('lists versioned TeX Live directories on Linux', () => {
    expect(standardTexDirs('linux', {}, input([]).listDir)).toEqual([
      '/usr/local/texlive/2025/bin/x86_64-linux',
      '/usr/local/texlive/2023/bin/x86_64-linux',
    ]);
  });
});

describe('texInstallHint', () => {
  it('names the usual distribution per platform', () => {
    expect(texInstallHint('darwin').text).toContain('MacTeX');
    expect(texInstallHint('win32').text).toContain('MiKTeX');
    expect(texInstallHint('linux').text).toContain('apt');
  });
});

describe('setupOptions', () => {
  const kinds = (o: ReturnType<typeof setupOptions>) => o.map((x) => [x.action.kind, 'then' in x.action ? x.action.then : x.action.tool]);

  it('switches to an installed Tectonic first', () => {
    const options = setupOptions({ platform: 'darwin', tool: 'latexmk', found: { tectonic: '/opt/homebrew/bin/tectonic', brew: '/opt/homebrew/bin/brew' } });
    expect(kinds(options)).toEqual([['switch-tool', 'tectonic'], ['open-url', 'latexmk']]);
  });

  it('types brew install tectonic into a terminal when Homebrew is there', () => {
    const [first] = setupOptions({ platform: 'darwin', tool: 'latexmk', found: { brew: '/opt/homebrew/bin/brew' } });
    expect(first.action).toEqual({ kind: 'terminal', command: 'brew install tectonic', then: 'tectonic' });
  });

  it('opens the Tectonic guide without Homebrew and never offers the one-line installers', () => {
    const options = setupOptions({ platform: 'win32', tool: 'latexmk', found: {} });
    expect(options[0].action).toMatchObject({ kind: 'open-url', then: 'tectonic' });
    expect(JSON.stringify(options)).not.toMatch(/curl|iex|drop-sh|drop-ps1/);
    expect(options[options.length - 1].action).toMatchObject({ kind: 'open-url', url: 'https://miktex.org/download', then: 'latexmk' });
  });

  it('offers Docker only when it is installed and not already the tool', () => {
    expect(kinds(setupOptions({ platform: 'linux', tool: 'latexmk', found: {} }))).not.toContainEqual(['switch-tool', 'docker']);
    expect(kinds(setupOptions({ platform: 'linux', tool: 'latexmk', found: { docker: '/usr/bin/docker' } }))).toContainEqual(['switch-tool', 'docker']);
    expect(kinds(setupOptions({ platform: 'linux', tool: 'docker', found: { docker: '/usr/bin/docker' } }))).not.toContainEqual(['switch-tool', 'docker']);
  });

  it('still offers installing Tectonic when it is the tool but missing', () => {
    const [first] = setupOptions({ platform: 'linux', tool: 'tectonic', found: {} });
    expect(first.action).toMatchObject({ kind: 'open-url', then: 'tectonic' });
  });

  it('mentions brew in the macOS Tectonic hint', () => {
    expect(texInstallHint('darwin', 'tectonic').text).toContain('brew install tectonic');
    expect(texInstallHint('linux', 'tectonic').text).not.toContain('brew');
  });
});
