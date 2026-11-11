// The part of the built-in Git extension's API (extension id `vscode.git`, `getAPI(1)`) that Overtex uses.
// Written by hand from extensions/git/src/api/git.d.ts at VS Code 1.85, the oldest version Overtex supports.
// Members added after 1.85 are optional and are checked before use.
import type { Event, Uri } from 'vscode';

export interface Ref {
  readonly type: number; // 0 head, 1 remote head, 2 tag
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface Branch extends Ref {
  readonly upstream?: { readonly remote: string; readonly name: string; readonly commit?: string };
  readonly ahead?: number;
  readonly behind?: number;
}

export interface Change {
  readonly uri: Uri;
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly isReadOnly: boolean;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly refs: Ref[];
  readonly remotes: Remote[];
  readonly rebaseCommit: unknown | undefined;
  readonly mergeChanges: Change[];
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  /** Only filled when `git.untrackedChanges` is `separate`; newer than 1.85. */
  readonly untrackedChanges?: Change[];
  readonly onDidChange: Event<void>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  setConfig(key: string, value: string): Promise<string>;
  getConfig(key: string): Promise<string>;
  getBranches(query: { remote?: boolean }): Promise<Ref[]>;
  status(): Promise<void>;
  fetch(options?: { remote?: string; ref?: string; all?: boolean; prune?: boolean }): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
  commit(message: string, opts?: { all?: boolean | 'tracked'; postCommitCommand?: string | null }): Promise<void>;
}

export interface API {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: Event<'uninitialized' | 'initialized'>;
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  getRepository(uri: Uri): Repository | null;
  init(root: Uri): Promise<Repository | null>;
  openRepository(root: Uri): Promise<Repository | null>;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): API;
}
