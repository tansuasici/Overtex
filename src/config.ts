import * as vscode from 'vscode';
import type { BuildSettings, Engine } from './latex/builder';

function section(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('overtex');
}

export function buildSettings(): BuildSettings {
  const cfg = section();
  return {
    latexmk: cfg.get<string>('latex.latexmkPath') || 'latexmk',
    engine: cfg.get<Engine>('latex.engine', 'pdflatex'),
    outDir: cfg.get<string>('latex.outDir', ''),
    extraArgs: cfg.get<string[]>('latex.extraArgs', []),
  };
}

export const settings = {
  mainFile: () => section().get<string>('latex.mainFile', ''),
  synctexPath: () => section().get<string>('synctex.path') || 'synctex',
  buildOnSave: () => section().get<boolean>('build.onSave', true),
  autoOpenViewer: () => section().get<boolean>('viewer.autoOpen', true),
};
