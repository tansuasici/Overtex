import * as vscode from 'vscode';
import * as fs from 'fs';

import { buildSettings, settings } from './config';
import { SetupReport, TEXLAB_INSTALL_URL, checkSetup, formatReport, texInstallHint } from './latex/setup';
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
    latexmk: build.latexmk,
    engine: build.engine,
    synctex: settings.synctexPath(),
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
  return report;
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
    const choice = await vscode.window.showWarningMessage(
      `Overtex: ${missing} is installed but not on VS Code's PATH. Quit and restart VS Code, or set overtex.latex.latexmkPath.`,
      'Open Setting',
      showDetails
    );
    if (choice === 'Open Setting') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'overtex.latex.latexmkPath');
    } else if (choice === showDetails) {
      output.show(true);
    }
    return;
  }

  const hint = texInstallHint(process.platform);
  const choice = await vscode.window.showWarningMessage(`Overtex: ${missing} not found. ${hint.text}`, 'How to Install', 'Re-check', showDetails);
  if (choice === 'How to Install') {
    void vscode.env.openExternal(vscode.Uri.parse(hint.url));
  } else if (choice === 'Re-check') {
    checkSetupCommand(output);
  } else if (choice === showDetails) {
    output.show(true);
  }
}

/**
 * Once per install: if a build could not run, say so up front instead of on the first failed build.
 * Only latexmk and the engine count; a missing TexLab has its own hint.
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


