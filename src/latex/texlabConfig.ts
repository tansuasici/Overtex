// Pure helpers for the TexLab language server; kept free of `vscode` so they can be unit tested.

export const TEXLAB_EXTENSION_ID = 'efoerster.texlab';

export interface TexlabStartInputs {
  enabled: boolean;
  workspaceTrusted: boolean;
  /** The official TexLab extension runs its own server; two servers would duplicate everything. */
  officialExtensionInstalled: boolean;
}

export type TexlabStartDecision = 'start' | 'disabled' | 'untrusted' | 'official-extension';

export function texlabStartDecision(inputs: TexlabStartInputs): TexlabStartDecision {
  if (!inputs.enabled) {
    return 'disabled';
  }
  if (inputs.officialExtensionInstalled) {
    return 'official-extension';
  }
  if (!inputs.workspaceTrusted) {
    return 'untrusted';
  }
  return 'start';
}

export interface TexlabOptionInputs {
  /** `overtex.latex.outDir`, relative to the main file; empty means next to it. */
  outDir: string;
  chktex: boolean;
}

/**
 * The `texlab` settings section, answered on Overtex's behalf (see texlab's server/options.rs).
 * Overtex owns building and SyncTeX, so texlab's own build and forward search stay off.
 */
export function texlabOptions(inputs: TexlabOptionInputs): Record<string, unknown> {
  const dir = inputs.outDir.trim() || '.';
  return {
    build: {
      onSave: false,
      forwardSearchAfter: false,
      // texlab reads .aux/.log files from here for label and citation completion.
      auxDirectory: dir,
      logDirectory: dir,
      pdfDirectory: dir,
    },
    chktex: {
      onOpenAndSave: inputs.chktex,
      onEdit: inputs.chktex,
    },
    diagnosticsDelay: 300,
  };
}

/** texlab tags diagnostics parsed from the build log with source "latex". */
const BUILD_LOG_SOURCE = 'latex';

/** Overtex already reports build-log errors after each build, so drop texlab's copies of them. */
export function withoutBuildLogDiagnostics<T extends { source?: string }>(diagnostics: readonly T[]): T[] {
  return diagnostics.filter((d) => d.source !== BUILD_LOG_SOURCE);
}
