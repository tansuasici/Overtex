import type * as vscode from 'vscode';
import type { BuildResult } from './latex/builder';

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
}
