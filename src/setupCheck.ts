import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { buildSettings, settings } from './config';
import { BuildTool, toolPathSetting } from './latex/builder';
import { DoctorReport, diagnose, formatDoctor, installCommand } from './latex/doctor';
import { findExecutable } from './latex/executable';
import { SetupOption, SetupReport, TEXLAB_INSTALL_URL, checkSetup, formatReport, setupOptions } from './latex/setup';
import { TEXLAB_EXTENSION_ID } from './latex/texlabConfig';

export const WALKTHROUGH_ID = 'tansuasici.overtex#overtex.gettingStarted';
/** Context key the walkthrough's first step completes on. */
const CAN_BUILD_CONTEXT = 'overtex.canBuild';
const NUDGE_DISMISSED_KEY = 'overtex.setupNudgeDismissed';

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Looks the tools up with the same PATH search the builder and TexLab use. Never runs them. */
export function inspectSetup(): SetupReport {
  const build = buildSettings();
  const texlabCfg = vscode.workspace.getConfiguration('overtex.texlab');
  const texlabOurs = texlabCfg.get<boolean>('enabled', true) && !vscode.extensions.getExtension(TEXLAB_EXTENSION_ID);
  const report = checkSetup({
    tool: build.tool,
    latexmk: build.latexmk,
    tectonic: build.tectonic,
    docker: build.docker,
    engine: build.engine,
    synctex: settings.synctexPath(),
    latexdiff: settings.latexdiffPath(),
    texlab: texlabOurs ? texlabCfg.get<string>('path') || 'texlab' : undefined,
    env: process.env,
    platform: process.platform,
    isFile,
    listDir,
  });
  void vscode.commands.executeCommand('setContext', CAN_BUILD_CONTEXT, report.canBuild);
  return report;
}

export function openWalkthrough(): void {
  void vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
}

/**
 * The "Check LaTeX Installation" command: report to the log, summarize in a notification.
 * Returns the report right away; the notification's buttons are handled when clicked.
 */
export function checkSetupCommand(output: vscode.OutputChannel): SetupReport {
  const report = inspectSetup();
  output.append(formatReport(report, process.platform));
  void notify(report, output);
  void checkProjectPackages(report, output);
  return report;
}

let projectMain: (() => string | null) | undefined;

/** How the setup check finds the project whose packages it looks up. */
export function useMainFile(find: () => string | null): void {
  projectMain = find;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
}

/** kpsewhich from the TeX that builds: next to latexmk first, else on PATH. */
function kpsewhichFor(report: SetupReport): string | undefined {
  const latexmk = report.tools.find((t) => t.name === 'latexmk')?.resolved;
  if (latexmk) {
    const beside = path.join(path.dirname(latexmk), process.platform === 'win32' ? 'kpsewhich.exe' : 'kpsewhich');
    if (isFile(beside)) {
      return beside;
    }
  }
  return findExecutable('kpsewhich', process.env, process.platform, isFile);
}

/** Runs kpsewhich; it exits 1 when a name is missing, so its output counts whatever the exit code. */
function kpsewhich(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(command, args, { cwd, timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && (typeof err.code === 'string' || err.killed)) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * The TeX doctor: are the packages, classes and Times fonts the project loads installed, and is lineno
 * a fixed version. Only for latexmk, since Tectonic fetches packages itself and Docker images bring their
 * own TeX. Looks things up; installs nothing.
 */
async function checkProjectPackages(report: SetupReport, output: vscode.OutputChannel): Promise<DoctorReport | undefined> {
  const main = projectMain?.();
  const command = report.tool === 'latexmk' && report.canBuild ? kpsewhichFor(report) : undefined;
  if (!main || !command) {
    return undefined;
  }
  const cwd = path.dirname(main);
  let doctor: DoctorReport;
  try {
    // MiKTeX may install a missing package when asked for it; this check should not, so it leaves MiKTeX alone.
    if (/miktex/i.test(await kpsewhich(command, ['--version'], cwd))) {
      output.append('Packages: not checked, since MiKTeX manages them (MiKTeX Console > Packages).\n');
      return undefined;
    }
    doctor = await diagnose({
      mainFile: main,
      engine: buildSettings().engine,
      read: readText,
      lookup: async (names) => (await kpsewhich(command, names, cwd)).split(/\r?\n/).filter((l) => l.trim()),
    });
  } catch {
    output.append('Packages: not checked, since kpsewhich did not run.\n');
    return undefined;
  }
  output.append(formatDoctor(doctor, main, process.platform));
  const missing = doctor.findings.filter((f) => f.severity === 'error').length;
  const warnings = doctor.findings.length - missing;
  if (!doctor.findings.length) {
    return doctor;
  }
  const install = installCommand(doctor.install, process.platform);
  const showDetails = 'Show Details';
  const typeIt = 'Install in Terminal…';
  const message = missing
    ? `Overtex: ${missing} package${missing === 1 ? '' : 's'} that ${path.basename(main)} loads ${missing === 1 ? 'is' : 'are'} not installed.`
    : `Overtex: ${warnings} possible problem${warnings === 1 ? '' : 's'} with the TeX packages for ${path.basename(main)}.`;
  const choice = await vscode.window.showWarningMessage(message, ...(install ? [typeIt, showDetails] : [showDetails]));
  if (choice === typeIt && install) {
    // Typed, not run: pressing Enter in the terminal is the user's go-ahead.
    const terminal = vscode.window.createTerminal({ name: 'Overtex Setup' });
    terminal.show();
    terminal.sendText(install, false);
  } else if (choice === showDetails) {
    output.show(true);
  }
  return doctor;
}

async function notify(report: SetupReport, output: vscode.OutputChannel): Promise<void> {
  const showDetails = 'Show Details';
  if (report.canBuild) {
    const optional = report.missingOptional.map((t) => t.name);
    const extra = optional.length ? ` Optional, not found: ${optional.join(', ')}.` : '';
    const buttons = report.missingOptional.some((t) => t.name === 'texlab') ? ['Install TexLab', showDetails] : [showDetails];
    const choice = await vscode.window.showInformationMessage(`Overtex: LaTeX is ready to build.${extra}`, ...buttons);
    if (choice === 'Install TexLab') {
      void vscode.env.openExternal(vscode.Uri.parse(TEXLAB_INSTALL_URL));
    } else if (choice === showDetails) {
      output.show(true);
    }
    return;
  }

  const missing = report.missingRequired.map((t) => t.name).join(' and ');
  if (report.missingRequired.some((t) => t.foundOutsidePath)) {
    const pathSetting = toolPathSetting(report.tool);
    const choice = await vscode.window.showWarningMessage(
      `Overtex: ${missing} is installed but not on VS Code's PATH. Quit and restart VS Code, or set ${pathSetting}.`,
      'Open Setting',
      showDetails
    );
    if (choice === 'Open Setting') {
      void vscode.commands.executeCommand('workbench.action.openSettings', pathSetting);
    } else if (choice === showDetails) {
      output.show(true);
    }
    return;
  }

  const setUp = 'Set Up…';
  const choice = await vscode.window.showWarningMessage(
    `Overtex: ${missing} not found. Choose Set Up… to use Tectonic, which needs no TeX distribution, or to install one.`,
    setUp,
    'Re-check',
    showDetails
  );
  if (choice === setUp) {
    await chooseSetup(report.tool, output);
  } else if (choice === 'Re-check') {
    checkSetupCommand(output);
  } else if (choice === showDetails) {
    output.show(true);
  }
}

/** Offers the ways to get a working build: Tectonic, Docker when present, or a full TeX distribution. */
async function chooseSetup(tool: BuildTool, output: vscode.OutputChannel): Promise<void> {
  const build = buildSettings();
  const find = (command: string) => findExecutable(command, process.env, process.platform, isFile);
  const options = setupOptions({
    platform: process.platform,
    tool,
    found: { tectonic: find(build.tectonic), docker: find(build.docker), brew: process.platform === 'win32' ? undefined : find('brew') },
  });
  const picked = await vscode.window.showQuickPick(
    options.map((o) => ({ label: o.label, detail: o.detail, option: o })),
    { title: 'Overtex: Set Up LaTeX Builds', placeHolder: 'How should Overtex build your documents?', matchOnDetail: true }
  );
  if (picked) {
    await runSetupOption(picked.option, output);
  }
}

async function useTool(tool: BuildTool): Promise<void> {
  // Which TeX is installed is a property of the machine, so the choice goes to user settings,
  // unless the workspace sets the tool itself and would override that.
  const cfg = vscode.workspace.getConfiguration('overtex');
  const target = cfg.inspect('latex.tool')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await cfg.update('latex.tool', tool, target);
}

async function runSetupOption(option: SetupOption, output: vscode.OutputChannel): Promise<void> {
  const action = option.action;
  if (action.kind === 'switch-tool') {
    await useTool(action.tool);
    checkSetupCommand(output);
  } else if (action.kind === 'terminal') {
    // Typed, not run: pressing Enter in the terminal is the user's go-ahead.
    const terminal = vscode.window.createTerminal({ name: 'Overtex Setup' });
    terminal.show();
    terminal.sendText(action.command, false);
    await useTool(action.then);
    const recheck = 'Re-check';
    const choice = await vscode.window.showInformationMessage(
      `Overtex: press Enter in the terminal to run \`${action.command}\`. Builds now use ${action.then}; re-check once it finishes.`,
      recheck
    );
    if (choice === recheck) {
      checkSetupCommand(output);
    }
  } else {
    void vscode.env.openExternal(vscode.Uri.parse(action.url));
    await useTool(action.then);
    const recheck = 'Re-check';
    if ((await vscode.window.showInformationMessage('Overtex: after installing, restart VS Code or re-check.', recheck)) === recheck) {
      checkSetupCommand(output);
    }
  }
}

/**
 * Once per install: if a build could not run, say so up front instead of on the first failed build.
 * Only what the build tool needs counts; a missing TexLab has its own hint.
 */
export function nudgeIfSetupMissing(context: vscode.ExtensionContext): void {
  const report = inspectSetup();
  if (report.canBuild || context.globalState.get(NUDGE_DISMISSED_KEY)) {
    return;
  }
  const missing = report.missingRequired.map((t) => t.name).join(' and ');
  const check = 'Check Setup';
  const guide = 'Open Getting Started';
  const dismiss = "Don't Show Again";
  void vscode.window
    .showWarningMessage(`Overtex: ${missing} not found, so LaTeX documents cannot be built yet.`, check, guide, dismiss)
    .then((choice) => {
      if (choice === check) {
        void vscode.commands.executeCommand('overtex.checkSetup');
      } else if (choice === guide) {
        openWalkthrough();
      } else if (choice === dismiss) {
        void context.globalState.update(NUDGE_DISMISSED_KEY, true);
      }
    });
}


