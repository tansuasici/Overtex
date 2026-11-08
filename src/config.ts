import * as vscode from 'vscode';
import type { BuildSettings, BuildTool, Engine } from './latex/builder';
import { parseColorScheme } from './shared/colorScheme';

function section(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('overtex');
}

export function buildSettings(): BuildSettings {
  const cfg = section();
  return {
    tool: cfg.get<BuildTool>('latex.tool', 'latexmk'),
    latexmk: cfg.get<string>('latex.latexmkPath') || 'latexmk',
    tectonic: cfg.get<string>('tectonic.path') || 'tectonic',
    docker: cfg.get<string>('docker.path') || 'docker',
    dockerImage: cfg.get<string>('docker.image') || 'texlive/texlive:latest',
    engine: cfg.get<Engine>('latex.engine', 'pdflatex'),
    outDir: cfg.get<string>('latex.outDir', ''),
    extraArgs: cfg.get<string[]>('latex.extraArgs', []),
    workspaceRoot: (file) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath,
  };
}

export const settings = {
  mainFile: () => section().get<string>('latex.mainFile', ''),
  synctexPath: () => section().get<string>('synctex.path') || 'synctex',
  latexdiffPath: () => section().get<string>('latexdiff.path') || 'latexdiff',
  buildOnSave: () => section().get<boolean>('build.onSave', true),
  autoOpenViewer: () => section().get<boolean>('viewer.autoOpen', true),
  viewerColorScheme: () => parseColorScheme(section().get('viewer.colorScheme')),
};
