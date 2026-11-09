import type * as vscode from 'vscode';
import type { BuildResult } from './latex/builder';
import type { E2eFromViewerMessage, E2eToViewerMessage } from './shared/messages';

export type { BuildResult };

/**
 * Returned from `activate()`. Other extensions (OverleafConnect) reach it with
 * `vscode.extensions.getExtension<OvertexApi>('tansuasici.overtex')?.exports`.
 * Bump `version` on breaking changes.
 */
export interface OvertexApi {
  readonly version: 1;
  /** Builds `mainFile`, or the detected main file. Resolves to undefined if there is nothing to build. */
  build(mainFile?: string): Promise<BuildResult | undefined>;
  readonly onDidStartBuild: vscode.Event<{ mainFile: string }>;
  readonly onDidEndBuild: vscode.Event<BuildResult>;
  viewPdf(): Promise<void>;
  forwardSearch(): Promise<void>;
  /** Present only when the extension host was started by the end-to-end tests. Not part of the public API. */
  readonly e2e?: OvertexE2e;
}

export interface OvertexE2e {
  readonly onViewerMessage: vscode.Event<E2eFromViewerMessage>;
  sendToViewer(msg: E2eToViewerMessage): void;
  /** The editor group the preview is in. */
  viewerColumn(): vscode.ViewColumn | undefined;
  /** Does what happens when VS Code brings the preview back after a reload, which a test cannot trigger. */
  restoreViewer(panel: vscode.WebviewPanel): Promise<void>;
  /** What the Papers panel lists: its groups in order, with the paper keys in order. */
  paperGroups(): Promise<{ group: string; keys: string[] }[]>;
  /** What the Labels panel lists: its groups in order, with the label keys in order. */
  labelGroups(): Promise<{ group: string; keys: string[] }[]>;
}
