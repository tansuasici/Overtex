// Checking that the tools Overtex runs are installed. No vscode import, so it is unit-testable.
import * as path from 'path';
import type { BuildTool } from './builder';
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
  tool: BuildTool;
  latexmk: string;
  tectonic: string;
  docker: string;
  engine: string;
  synctex: string;
  /** Omitted by callers that do not check it. */
  latexdiff?: string;
  /** Undefined when TexLab is disabled or left to the TexLab extension. */
  texlab?: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  isFile: (candidate: string) => boolean;
  /** Lists subdirectories, for the versioned TeX Live layout. Returns [] when the directory is missing. */
  listDir: (dir: string) => string[];
}

export interface SetupReport {
  /** The build tool the report was made for. */
  tool: BuildTool;
  tools: ToolCheck[];
  /** What the build tool needs is present, so a build can run. */
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

  const required: Record<BuildTool, () => ToolCheck[]> = {
    latexmk: () => [check('latexmk', input.latexmk, true, 'runs the build'), check(input.engine, input.engine, true, 'the TeX engine latexmk calls')],
    tectonic: () => [check('tectonic', input.tectonic, true, 'runs the build')],
    docker: () => [check('docker', input.docker, true, 'runs the build in a container')],
  };
  const tools = [...required[input.tool](), check('synctex', input.synctex, false, 'jumps between the source and the PDF')];
  if (input.latexdiff !== undefined) {
    tools.push(check('latexdiff', input.latexdiff, false, 'compares versions of a document'));
  }
  if (input.texlab !== undefined) {
    tools.push(check('texlab', input.texlab, false, 'live error checking and completion'));
  }
  const missingRequired = tools.filter((t) => t.required && !t.resolved);
  return {
    tool: input.tool,
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

export function texInstallHint(platform: NodeJS.Platform, tool: BuildTool = 'latexmk'): InstallHint {
  if (tool === 'tectonic') {
    const brew = platform === 'darwin' ? ' (`brew install tectonic`)' : '';
    return { text: `Install Tectonic${brew}, then restart VS Code.`, url: TECTONIC_INSTALL_URL };
  }
  if (tool === 'docker') {
    return { text: 'Install Docker, then restart VS Code.', url: 'https://docs.docker.com/get-docker/' };
  }
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

export const TECTONIC_INSTALL_URL = 'https://tectonic-typesetting.github.io/book/latest/installation/';

/**
 * What picking a setup option does; `then` is the build tool to switch to. Nothing is installed
 * without the user pressing Enter in a terminal.
 */
export type SetupAction =
  | { kind: 'switch-tool'; tool: BuildTool }
  | { kind: 'terminal'; command: string; then: BuildTool }
  | { kind: 'open-url'; url: string; then: BuildTool };

export interface SetupOption {
  label: string;
  detail: string;
  action: SetupAction;
}

export interface SetupOptionsInput {
  platform: NodeJS.Platform;
  /** The build tool currently configured. */
  tool: BuildTool;
  /** Absolute paths of programs found on PATH. */
  found: { tectonic?: string; docker?: string; brew?: string };
}

const TECTONIC_DETAIL =
  'A single program that downloads only the packages a document uses. Always uses XeTeX; Export for arXiv and Check Submission are not available.';

/**
 * Ways to get a working build when the configured tool is missing, best first. Tectonic leads
 * because it is one small download. Only the Homebrew command is offered to run: the official
 * one-line installers put the binary in the current directory, which would be the user's project.
 */
export function setupOptions(input: SetupOptionsInput): SetupOption[] {
  const { platform, tool, found } = input;
  const options: SetupOption[] = [];
  if (found.tectonic) {
    if (tool !== 'tectonic') {
      options.push({ label: 'Use Tectonic', detail: `Found at ${found.tectonic}. ${TECTONIC_DETAIL}`, action: { kind: 'switch-tool', tool: 'tectonic' } });
    }
  } else if (found.brew) {
    options.push({
      label: 'Install Tectonic with Homebrew (recommended)',
      detail: `Types \`brew install tectonic\` into a terminal for you to run, and builds with Tectonic. ${TECTONIC_DETAIL}`,
      action: { kind: 'terminal', command: 'brew install tectonic', then: 'tectonic' },
    });
  } else {
    options.push({ label: 'Install Tectonic (recommended)', detail: `Opens the Tectonic installation guide. ${TECTONIC_DETAIL}`, action: { kind: 'open-url', url: TECTONIC_INSTALL_URL, then: 'tectonic' } });
  }
  if (found.docker && tool !== 'docker') {
    options.push({
      label: 'Use Docker',
      detail: `Found at ${found.docker}. Builds with latexmk in a TeX Live image; the first build downloads the image.`,
      action: { kind: 'switch-tool', tool: 'docker' },
    });
  }
  const dist = texInstallHint(platform, 'latexmk');
  options.push({ label: 'Install a full TeX distribution', detail: dist.text, action: { kind: 'open-url', url: dist.url, then: 'latexmk' } });
  return options;
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
    lines.push('', texInstallHint(platform, report.tool).text);
  }
  if (report.missingOptional.some((t) => t.name === 'texlab')) {
    lines.push('', `TexLab: ${TEXLAB_INSTALL_URL}`);
  }
  return lines.join('\n') + '\n';
}
