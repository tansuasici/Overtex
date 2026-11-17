// Pure helpers for the TexLab language server; kept free of `vscode` so they can be unit tested.

export const TEXLAB_EXTENSION_ID = 'efoerster.texlab';

export interface TexlabStartInputs {
  enabled: boolean;
  workspaceTrusted: boolean;
  /** The official TexLab extension runs its own server; two servers would duplicate everything. */
  officialExtensionInstalled: boolean;
  /** Local paths of the workspace folders. */
  workspaceFolders: readonly string[];
}

export type TexlabStartDecision = 'start' | 'disabled' | 'untrusted' | 'official-extension' | 'bracket-path';

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
  if (inputs.workspaceFolders.some(texlabCannotOpen)) {
    return 'bracket-path';
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

/**
 * Characters VS Code percent-encodes in a file URI but texlab writes literally when it builds
 * URIs for `\bibliography`, `\input` and the like. Sent encoded, the same folder gets two
 * spellings, texlab does not link the files, and every citation shows as undefined
 * (for example in Google Drive's Turkish "Drive'ım" folder). `[` and `]` are left out: texlab
 * fails on those either way. `:` is left out so Windows drive letters keep VS Code's form.
 */
const LITERAL_IN_TEXLAB = /%(21|24|26|27|28|29|2A|2B|2C|3B|3D|40)/gi;

/** A file URI spelled the way texlab spells it, so both sides name a file the same way. */
export function texlabUri(uri: string): string {
  return uri.startsWith('file:') ? uri.replace(LITERAL_IN_TEXLAB, (m) => decodeURIComponent(m)) : uri;
}

/**
 * texlab 5.26 exits with a panic (util/to_proto.rs) as soon as it reads a file whose path has
 * `[` or `]`, whether the URI spells them encoded or not. Such files are kept away from it.
 */
export function texlabCannotOpen(fsPath: string): boolean {
  return /[[\]]/.test(fsPath);
}
