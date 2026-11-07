// Checking that the tools Overtex runs are installed. No vscode import, so it is unit-testable.
import * as path from 'path';
import { findExecutable } from './executable';

export interface ToolCheck {
  /** Display name, e.g. "latexmk". */
  name: string;
  /** What was configured or defaulted, e.g. "latexmk" or "/opt/tex/bin/latexmk". */
  command: string;
  /** Absolute path when found. */
  resolved?: string;
  required: boolean;
  /** Set when the tool is missing from PATH but sits in a standard TeX install directory. */
  foundOutsidePath?: string;
  /** What the tool is for, shown next to a missing tool. */
  purpose: string;
}

export interface SetupInput {
  latexmk: string;
  engine: string;
  synctex: string;
  /** Undefined when TexLab is disabled or left to the TexLab extension. */
  texlab?: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  isFile: (candidate: string) => boolean;
  /** Lists subdirectories, for the versioned TeX Live layout. Returns [] when the directory is missing. */
  listDir: (dir: string) => string[];
}

export interface SetupReport {
  tools: ToolCheck[];
  /** latexmk and the engine are present, so a build can run. */
  canBuild: boolean;
  missingRequired: ToolCheck[];
  missingOptional: ToolCheck[];
}

/**
 * Where TeX distributions put their binaries. VS Code started before the installer ran (or from
 * the Dock on macOS without a login shell) may not see these on PATH yet.
 */
export function standardTexDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, listDir: (dir: string) => string[]): string[] {
  if (platform === 'darwin') {
    return ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin'];
  }
  if (platform === 'win32') {
    const dirs: string[] = [];
    for (const base of [env.ProgramFiles, env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')]) {
      if (base) {
        dirs.push(path.win32.join(base, 'MiKTeX', 'miktex', 'bin', 'x64'));
      }
    }
    const texlive = env.SystemDrive ? `${env.SystemDrive}\\texlive` : 'C:\\texlive';
    for (const year of newestFirst(listDir(texlive))) {
      dirs.push(path.win32.join(texlive, year, 'bin', 'windows'), path.win32.join(texlive, year, 'bin', 'win32'));
    }
    return dirs;
  }
  const dirs: string[] = [];
  for (const year of newestFirst(listDir('/usr/local/texlive'))) {
    for (const arch of listDir(path.posix.join('/usr/local/texlive', year, 'bin'))) {
      dirs.push(path.posix.join('/usr/local/texlive', year, 'bin', arch));
    }
  }
  return dirs;
}

function newestFirst(names: string[]): string[] {
  return names.filter((n) => /^\d{4}$/.test(n)).sort().reverse();
}

export function checkSetup(input: SetupInput): SetupReport {
  const { env, platform, isFile } = input;
  let extraDirs: string[] | undefined;
  const check = (name: string, command: string, required: boolean, purpose: string): ToolCheck => {
    const tool: ToolCheck = { name, command, required, purpose };
    tool.resolved = findExecutable(command, env, platform, isFile);
    // Only bare names are looked up elsewhere; an explicit path that does not exist is just wrong.
    const bare = !command.includes('/') && !command.includes('\\');
    if (!tool.resolved && bare) {
      extraDirs ??= standardTexDirs(platform, env, input.listDir);
      const p = platform === 'win32' ? path.win32 : path.posix;
      const exts = platform === 'win32' ? ['.exe', '.bat', '.cmd', ''] : [''];
      for (const dir of extraDirs) {
        const hit = exts.map((ext) => p.join(dir, command + ext)).find(isFile);
        if (hit) {
          tool.foundOutsidePath = hit;
          break;
        }
      }
    }
    return tool;
  };

  const tools = [
    check('latexmk', input.latexmk, true, 'runs the build'),
    check(input.engine, input.engine, true, 'the TeX engine latexmk calls'),
    check('synctex', input.synctex, false, 'jumps between the source and the PDF'),
  ];
  if (input.texlab !== undefined) {
    tools.push(check('texlab', input.texlab, false, 'live error checking and completion'));
  }
  const missingRequired = tools.filter((t) => t.required && !t.resolved);
  return {
    tools,
    canBuild: missingRequired.length === 0,
    missingRequired,
    missingOptional: tools.filter((t) => !t.required && !t.resolved),
  };
}

export interface InstallHint {
  text: string;
  url: string;
}

export function texInstallHint(platform: NodeJS.Platform): InstallHint {
  if (platform === 'darwin') {
    return {
      text: 'Install MacTeX (or `brew install --cask mactex-no-gui`), then restart VS Code.',
      url: 'https://www.tug.org/mactex/',
    };
  }
  if (platform === 'win32') {
    return {
      text: 'Install MiKTeX or TeX Live, then restart VS Code. latexmk needs Perl; TeX Live includes it, MiKTeX users can install Strawberry Perl.',
      url: 'https://miktex.org/download',
    };
  }
  return {
    text: 'Install TeX Live from your package manager (for example `sudo apt install texlive-latex-extra latexmk`, or `sudo dnf install texlive-scheme-medium latexmk`), then restart VS Code.',
    url: 'https://www.tug.org/texlive/',
  };
}

export const TEXLAB_INSTALL_URL = 'https://github.com/latex-lsp/texlab#installation';

/** Plain-text report for the output channel. */
export function formatReport(report: SetupReport, platform: NodeJS.Platform): string {
  const lines = ['Overtex setup check:'];
  for (const t of report.tools) {
    if (t.resolved) {
      lines.push(`  ✓ ${t.name}: ${t.resolved}`);
    } else if (t.foundOutsidePath) {
      lines.push(`  ✗ ${t.name}: not on VS Code's PATH, but installed at ${t.foundOutsidePath}. Quit and restart VS Code so it picks up the new PATH.`);
    } else {
      lines.push(`  ${t.required ? '✗' : '–'} ${t.name}: not found (${t.required ? 'required' : 'optional'}, ${t.purpose})`);
    }
  }
  if (!report.canBuild && !report.missingRequired.some((t) => t.foundOutsidePath)) {
    lines.push('', texInstallHint(platform).text);
  }
  if (report.missingOptional.some((t) => t.name === 'texlab')) {
    lines.push('', `TexLab: ${TEXLAB_INSTALL_URL}`);
  }
  return lines.join('\n') + '\n';
}
