// Overtex: Share Changes / Get Changes. One click saves your edits as a version, gets your co-authors'
// versions from every remote and sends the result to your own online copy, through the built-in Git
// extension so that its sign-in and credential handling apply.
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { API, GitExtension, Repository } from './types/git';
import {
  commitMessage,
  describeGitError,
  isBuildOutput,
  missingIgnoreLines,
  needsIdentity,
  pushRemote,
  startingRef,
  syncStatus,
  withIgnoreLines,
} from './shared/gitSync';
import { GitHubClient, GitHubError, normalizeUsername, parseGitHubRemote, repoNameFor, validRepoName, type GitHubRepo } from './shared/github';
import { GitLabClient, GitLabError } from './shared/gitlab';
import {
  KNOWN_HOSTS,
  READ_ONLY_PUSH_URL,
  coauthorRemoteName,
  coauthorUrl,
  encodeCode,
  isOurSshCommand,
  normalizePublicKey,
  parseCode,
  parseHostedRemote,
  safeConfigPath,
  sshCommand,
  sshConfig,
  validKeyId,
  type AliasEntry,
  type Code,
  type Host,
  type HostedRepo,
} from './shared/inviteCode';

export interface SyncArgs {
  /** A file or folder inside the repository; the active file's repository otherwise. */
  uri?: vscode.Uri;
  /** Skips the message box (tests, keybindings). */
  message?: string;
}

export interface InviteArgs extends SyncArgs {
  /** Skips the username box. */
  username?: string;
  /** Skips the name box when a new GitHub repository has to be made. */
  repoName?: string;
}

export interface CodeArgs extends SyncArgs {
  /** Skips the paste box. */
  code?: string;
  /** Skips the confirmations (tests). */
  yes?: boolean;
  /** Skips the name box when a new GitHub repository has to be made. */
  repoName?: string;
}

interface Deps {
  /** The main document's PDF, absolute, if there is a main document. */
  builtPdf: () => string | undefined;
  requireTrust: (action: string) => boolean;
  log: (text: string) => void;
}

/** Thrown to end a flow after the person has already been told why. */
class Stop extends Error {}

/** Thrown to end a flow with a message for the person. */
class Refusal extends Error {}

const GITLAB_TOKEN = 'overtex.gitlabToken';

export function registerGitSync(context: vscode.ExtensionContext, deps: Deps): void {
  const sync = new GitSync(context, deps);
  context.subscriptions.push(
    sync,
    vscode.commands.registerCommand('overtex.shareChanges', (args?: SyncArgs | vscode.Uri) => sync.share(asArgs(args))),
    vscode.commands.registerCommand('overtex.getChanges', (args?: SyncArgs | vscode.Uri) => sync.get(asArgs(args))),
    vscode.commands.registerCommand('overtex.inviteCoauthor', (args?: InviteArgs | vscode.Uri) => sync.invite(asArgs(args))),
    vscode.commands.registerCommand('overtex.createInviteCode', (args?: CodeArgs | vscode.Uri) => sync.createInviteCode(asArgs(args))),
    vscode.commands.registerCommand('overtex.enterInviteCode', (args?: CodeArgs | vscode.Uri) => sync.enterInviteCode(asArgs(args)))
  );
  void sync.start();
}

function asArgs<T extends SyncArgs>(args?: T | vscode.Uri): T {
  return (args instanceof vscode.Uri ? { uri: args } : args ?? {}) as T;
}

class GitSync implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('overtex.sync', vscode.StatusBarAlignment.Left, 49);
  private readonly disposables: vscode.Disposable[] = [this.item];
  private repoListener: vscode.Disposable | undefined;
  private api: API | undefined;
  private busy = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: Deps
  ) {
    this.item.name = 'Overtex Sync';
    this.item.command = 'overtex.shareChanges';
  }

  /** Waits for the Git extension in the background and keeps the status item current. */
  async start(): Promise<void> {
    const api = await this.gitApi();
    if (!api) {
      return;
    }
    this.disposables.push(
      api.onDidOpenRepository(() => this.watch()),
      api.onDidCloseRepository(() => this.watch()),
      vscode.window.onDidChangeActiveTextEditor(() => this.watch())
    );
    this.watch();
  }

  private async gitApi(): Promise<API | undefined> {
    if (this.api) {
      return this.api;
    }
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) {
      return undefined;
    }
    try {
      const exports = ext.isActive ? ext.exports : await ext.activate();
      if (!exports.enabled) {
        return undefined;
      }
      const api = exports.getAPI(1);
      if (api.state !== 'initialized') {
        await new Promise<void>((resolve) => {
          const sub = api.onDidChangeState((state) => {
            if (state === 'initialized') {
              sub.dispose();
              resolve();
            }
          });
        });
      }
      this.api = api;
      return api;
    } catch {
      return undefined;
    }
  }

  /** The repository for the given file, else the active file, else the first workspace folder. */
  private repoFor(api: API, uri?: vscode.Uri): Repository | undefined {
    if (uri) {
      return api.getRepository(uri) ?? undefined;
    }
    const candidates = [vscode.window.activeTextEditor?.document.uri, vscode.workspace.workspaceFolders?.[0]?.uri];
    for (const candidate of candidates) {
      const repo = candidate && candidate.scheme === 'file' ? api.getRepository(candidate) : null;
      if (repo) {
        return repo;
      }
    }
    return api.repositories.length === 1 ? api.repositories[0] : undefined;
  }

  // ---- Status bar ----

  private watched: Repository | undefined;

  private watch(): void {
    const repo = this.api && this.repoFor(this.api);
    if (repo !== this.watched) {
      this.repoListener?.dispose();
      this.watched = repo;
      this.repoListener = repo?.state.onDidChange(() => this.render());
    }
    this.render();
  }

  private render(): void {
    const repo = this.watched;
    if (!repo || !repo.state.remotes.length) {
      this.item.hide();
      return;
    }
    const head = repo.state.HEAD;
    const { text, tooltip } = syncStatus({
      changes: changeCount(repo),
      ahead: head?.ahead ?? 0,
      behind: head?.behind ?? 0,
      busy: this.busy,
    });
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.show();
  }

  // ---- Commands ----

  async share(args: SyncArgs): Promise<void> {
    await this.run('Sharing changes', args, async (repo, branch) => {
      if (changeCount(repo)) {
        await this.offerIgnore(repo);
        const message = args.message !== undefined ? commitMessage(args.message) : commitMessage(await askMessage());
        if (message === undefined) {
          throw new Stop();
        }
        await this.withIdentity(repo, () => repo.commit(message, { all: true, postCommitCommand: null }));
      }
      const warnings = await this.getAll(repo, branch);
      const remote = await this.chooseRemote(repo);
      await repo.push(remote, repo.state.HEAD?.name ?? branch, !repo.state.HEAD?.upstream);
      done(`changes shared to ${remote}`, warnings);
    });
  }

  async get(args: SyncArgs): Promise<void> {
    await this.run('Getting changes', args, async (repo, branch) => {
      const before = repo.state.HEAD?.commit;
      const warnings = await this.getAll(repo, branch);
      await repo.status();
      done(repo.state.HEAD?.commit === before ? 'already up to date' : 'got the latest changes', warnings);
    });
  }

  /**
   * Invites a co-author by GitHub username. If the project has no GitHub copy yet, first makes a private
   * repository under your account and sends the project there.
   */
  async invite(args: InviteArgs): Promise<void> {
    await this.run(
      'Inviting a co-author',
      args,
      async (repo, branch) => {
        const gh = await githubClient();
        const target = (await this.githubCopy(repo)) ?? (await this.publish(repo, branch, gh, args));
        const typed =
          args.username ??
          (await vscode.window.showInputBox({
            title: `Invite a co-author to ${target.owner}/${target.name}`,
            prompt: 'Their GitHub username. GitHub emails them an invitation; once they accept, they can edit and share.',
            placeHolder: 'octocat',
            ignoreFocusOut: true,
            validateInput: (v) => (!v.trim() || normalizeUsername(v) ? undefined : 'That is not a GitHub username.'),
          }));
        if (typed === undefined) {
          throw new Stop();
        }
        const username = normalizeUsername(typed);
        if (!username) {
          throw new GitHubError(0, `"${typed}" is not a GitHub username.`);
        }
        if (username.toLowerCase() === (await gh.login()).toLowerCase()) {
          throw new GitHubError(0, 'That is your own username. Type the username of the person you want to invite.');
        }
        const result = await gh.invite(target, username);
        const link = `https://github.com/${target.owner}/${target.name}`;
        const text =
          result === 'already'
            ? `Overtex: ${username} can already edit ${target.owner}/${target.name}.`
            : `Overtex: invited ${username} to ${target.owner}/${target.name}. GitHub emails them; once they accept, they open the link in VS Code with Git: Clone.`;
        void vscode.window.showInformationMessage(text, 'Copy Link').then((c) => c && vscode.env.clipboard.writeText(link));
      },
      { needsRemote: false }
    );
  }

  /**
   * Makes a code that asks a co-author to give your project read access to their copy, and that says
   * where your copy is. Nothing is sent anywhere: you pass the code on yourself.
   */
  async createInviteCode(args: CodeArgs): Promise<string | undefined> {
    let result: string | undefined;
    await this.run(
      'Creating an invite code',
      args,
      async (repo) => {
        const own = ownCopy(repo);
        if (!own) {
          throw new Refusal(
            'put your project on GitHub or GitLab first (Overtex: Invite Co-author makes a private GitHub copy), then make the code.'
          );
        }
        const dir = await this.overtexDir(repo);
        await this.checkSshCommand(repo);
        const id = newKeyId();
        const key = await newKey(dir, id, { role: 'invite' });
        result = encodeCode({ kind: 'invite', repo: own, key, id });
        await vscode.env.clipboard.writeText(result);
        void vscode.window.showInformationMessage(
          'Overtex: invite code copied. Send it to your co-author: they paste it with "Overtex: Enter Invite Code" and send you back an answer code, which you enter the same way.'
        );
      },
      { needsRemote: false }
    );
    return result;
  }

  /**
   * Enters a co-author's code. An invite: gives them read access to your copy, adds theirs as a copy you
   * get changes from, and makes the answer code. An answer: the same for the invite you made.
   */
  async enterInviteCode(args: CodeArgs): Promise<string | undefined> {
    let result: string | undefined;
    await this.run(
      'Entering an invite code',
      args,
      async (repo, branch) => {
        const text =
          args.code ??
          (await vscode.window.showInputBox({
            title: 'Enter Invite Code',
            prompt: 'Paste the code your co-author sent you.',
            placeHolder: 'overtex-invite:… or overtex-join:…',
            ignoreFocusOut: true,
            validateInput: (v) => {
              if (!v.trim()) {
                return undefined;
              }
              try {
                parseCode(v);
                return undefined;
              } catch (err) {
                return (err as Error).message;
              }
            },
          }));
        if (!text?.trim()) {
          throw new Stop();
        }
        let code: Code;
        try {
          code = parseCode(text);
        } catch (err) {
          throw new Refusal((err as Error).message);
        }
        const dir = await this.overtexDir(repo);
        await this.checkSshCommand(repo);
        const theirs = `${code.repo.path} on ${hostName(code.repo.host)}`;
        const connected = coauthorRemote(repo, dir, code.repo);
        if (connected) {
          throw new Refusal(`this project already gets changes from ${theirs} (as ${connected}).`);
        }
        if (code.kind === 'join') {
          const meta = readMeta(dir, code.id);
          if (meta?.role !== 'invite') {
            throw new Refusal('this answer code is for an invite made in another project. Open that project and enter it there.');
          }
          if ((meta.host || meta.path) && (meta.host !== code.repo.host || meta.path?.toLowerCase() !== code.repo.path.toLowerCase())) {
            throw new Refusal(
              `this invite code was already answered for ${meta.path ?? 'another copy'}. Make a new invite code for each co-author.`
            );
          }
        }

        let own = ownCopy(repo);
        if (!own) {
          if (code.kind === 'join') {
            throw new Refusal('the project has no online copy of its own any more. Put it on GitHub or GitLab and make a new invite code.');
          }
          const make =
            args.yes ||
            (await vscode.window.showInformationMessage(
              `Your co-author's copy is ${theirs}. To share your changes back, your project needs its own online copy. Make a private one on GitHub?`,
              { modal: true },
              'Make GitHub Copy'
            ));
          if (!make) {
            throw new Stop();
          }
          const created = await this.publish(repo, branch, await githubClient(), args);
          own = { host: 'github.com', path: `${created.owner}/${created.name}` };
        }
        if (own.host === code.repo.host && own.path.toLowerCase() === code.repo.path.toLowerCase()) {
          throw new Refusal('that code is for your own copy. Send it to your co-author instead.');
        }

        const ok =
          args.yes ||
          (await vscode.window.showInformationMessage(
            `Give ${theirs} read access to your copy ${own.path}? Your co-author can then get your changes, but cannot change your copy.`,
            { modal: true },
            'Give Read Access'
          ));
        if (!ok) {
          throw new Stop();
        }
        await this.addDeployKey(own, code.key, `Overtex co-author: ${code.repo.host}/${code.repo.path}`.slice(0, 100));

        // The key this project reads the co-author's copy with: new for an invite, the invite's for an answer.
        const readId = code.kind === 'invite' ? newKeyId() : code.id;
        const readKey =
          code.kind === 'invite'
            ? await newKey(dir, readId, { role: 'join', host: code.repo.host, path: code.repo.path })
            : (writeMeta(dir, readId, { role: 'invite', host: code.repo.host, path: code.repo.path }), undefined);
        const name = coauthorRemoteName(code.repo, repo.state.remotes.map((r) => r.name));
        await this.git(repo, ['remote', 'add', name, coauthorUrl(code.repo, readId)]);
        await this.git(repo, ['remote', 'set-url', '--push', name, READ_ONLY_PUSH_URL]);
        await this.writeSsh(repo, dir);
        await repo.status();

        if (code.kind === 'invite') {
          result = encodeCode({ kind: 'join', repo: own, key: readKey!, id: code.id });
          await vscode.env.clipboard.writeText(result);
          void vscode.window.showInformationMessage(
            `Overtex: ${theirs} can now get your changes. Answer code copied: send it back to your co-author. Once they enter it, Get Changes brings in theirs.`
          );
        } else {
          result = name;
          void vscode.window
            .showInformationMessage(`Overtex: connected. You can now get changes from ${theirs}, and they from you.`, 'Get Changes')
            .then((c) => c && vscode.commands.executeCommand('overtex.getChanges', { uri: repo.rootUri }));
        }
      },
      { needsRemote: false }
    );
    return result;
  }

  /** Gives a co-author's public key read-only access to your own copy. */
  private async addDeployKey(own: HostedRepo, key: string, title: string): Promise<void> {
    if (own.host === 'github.com') {
      const [owner, name] = own.path.split('/');
      await (await githubClient()).addDeployKey({ owner, name }, title, key);
      return;
    }
    const gl = await this.gitlabClient();
    try {
      await gl.addDeployKey(own.path, title, key);
    } catch (err) {
      if (err instanceof GitLabError && err.status === 401) {
        await this.context.secrets.delete(GITLAB_TOKEN);
      }
      throw err;
    }
  }

  /**
   * A GitLab client with the access token kept in VS Code's secret storage (asked for once). Under the
   * end-to-end tests only, OVERTEX_E2E_GITLAB_API points it at a local fake server.
   */
  private async gitlabClient(): Promise<GitLabClient> {
    const fake = process.env.OVERTEX_E2E && process.env.OVERTEX_E2E_GITLAB_API;
    if (fake) {
      return new GitLabClient('e2e', fetch, fake);
    }
    let token = await this.context.secrets.get(GITLAB_TOKEN);
    if (!token) {
      token = (
        await vscode.window.showInputBox({
          title: 'GitLab access token',
          prompt:
            'To give your co-author read access, Overtex needs a GitLab personal access token with the "api" scope (GitLab: Preferences > Access tokens). VS Code keeps it in its secret storage.',
          password: true,
          ignoreFocusOut: true,
        })
      )?.trim();
      if (!token) {
        throw new Stop();
      }
      await this.context.secrets.store(GITLAB_TOKEN, token);
    }
    return new GitLabClient(token, fetch);
  }

  /** The folder with this project's co-author keys and ssh config, inside .git (never shared). */
  private async overtexDir(repo: Repository): Promise<string> {
    const gitDir = (await this.git(repo, ['rev-parse', '--absolute-git-dir'])).trim();
    const dir = path.join(gitDir, 'overtex').replace(/\\/g, '/');
    if (!safeConfigPath(dir)) {
      throw new Refusal('the project folder has a character in its path that ssh cannot read (a quote, $, % or backslash). Move or rename it and try again.');
    }
    return dir;
  }

  /** Overtex sets core.sshCommand for the project; it never replaces one you set yourself. */
  private async checkSshCommand(repo: Repository): Promise<void> {
    const current = (await this.git(repo, ['config', '--local', '--get', 'core.sshCommand']).catch(() => '')).trim();
    if (!isOurSshCommand(current)) {
      throw new Refusal('this project has its own Git ssh command (core.sshCommand), so Overtex cannot add a co-author copy to it.');
    }
  }

  /** Writes the project's ssh config and pinned host keys, and points Git at them. */
  private async writeSsh(repo: Repository, dir: string): Promise<void> {
    const entries: AliasEntry[] = [];
    const keys = path.join(dir, 'keys');
    for (const file of fs.existsSync(keys) ? fs.readdirSync(keys) : []) {
      const id = file.replace(/\.json$/, '');
      const meta = file.endsWith('.json') && validKeyId(id) ? readMeta(dir, id) : undefined;
      if (meta?.host) {
        entries.push({ id, host: meta.host });
      }
    }
    fs.writeFileSync(path.join(dir, 'known_hosts'), KNOWN_HOSTS);
    const config = `${dir}/ssh_config`;
    fs.writeFileSync(config, sshConfig(dir, entries));
    await this.git(repo, ['config', '--local', 'core.sshCommand', sshCommand(config)]);
  }

  /** The GitHub repository your changes go to, if the project already has one. */
  private async githubCopy(repo: Repository): Promise<GitHubRepo | undefined> {
    // Only your own copy: a co-author's GitHub remote is theirs to invite people to.
    const own = ownRemote(repo);
    return parseGitHubRemote(own?.pushUrl ?? own?.fetchUrl);
  }

  /** Makes a private GitHub repository for the project and sends the project there. */
  private async publish(repo: Repository, branch: string, gh: GitHubClient, args: InviteArgs): Promise<GitHubRepo> {
    let suggested = repoNameFor(path.basename(repo.rootUri.fsPath));
    const current = ownRemote(repo)?.name;
    const moving = current ? ` From now on Share Changes sends to it; ${current} stays as a copy you get changes from.` : '';
    for (;;) {
      const name =
        args.repoName ??
        (await vscode.window.showInputBox({
          title: 'Put this project on GitHub',
          prompt: `Overtex makes a private repository under your GitHub account. Only people you invite can see it.${moving}`,
          value: suggested,
          ignoreFocusOut: true,
          validateInput: (v) => (validRepoName(v.trim()) ? undefined : 'Use letters, numbers, dots, dashes and underscores.'),
        }));
      if (name === undefined) {
        throw new Stop();
      }
      try {
        const created = await gh.createPrivateRepo(name.trim());
        const remote = repo.state.remotes.some((r) => r.name === 'origin') ? 'github' : 'origin';
        await this.git(repo, ['remote', 'add', remote, created.cloneUrl]);
        try {
          await repo.status();
          // A new, empty project: nothing to send yet. Share Changes sends the first version.
          if (repo.state.HEAD?.commit || changeCount(repo)) {
            if (changeCount(repo) || !repo.state.HEAD?.commit) {
              await this.offerIgnore(repo);
              await this.withIdentity(repo, () => repo.commit(commitMessage(args.message ?? '') ?? 'Update', { all: true, postCommitCommand: null }));
            }
            await repo.push(remote, branch, true);
          }
        } catch (err) {
          // Not sent: drop the remote, so the next Invite does not invite people to an empty repository.
          await this.git(repo, ['remote', 'remove', remote]).catch(() => undefined);
          void vscode.window.showWarningMessage(
            `Overtex: the project was not sent to ${created.owner}/${created.name}, which is still empty on GitHub. Invite again and pick that name or delete it on GitHub.`
          );
          throw err;
        }
        return created;
      } catch (err) {
        if (err instanceof GitHubError && err.status === 422 && args.repoName === undefined) {
          void vscode.window.showWarningMessage(`Overtex: ${err.message}`);
          suggested = `${name.trim()}-2`;
          continue;
        }
        throw err;
      }
    }
  }

  private async run(
    title: string,
    args: SyncArgs,
    flow: (repo: Repository, branch: string) => Promise<void>,
    { needsRemote = true } = {}
  ): Promise<void> {
    if (!this.deps.requireTrust(title)) {
      return;
    }
    if (this.busy) {
      void vscode.window.showInformationMessage('Overtex: already syncing. Wait for it to finish.');
      return;
    }
    const api = await this.gitApi();
    if (!api) {
      void vscode.window.showErrorMessage('Overtex: sharing needs the built-in Git extension. Install Git and make sure "git.enabled" is on.');
      return;
    }
    this.busy = true;
    this.render();
    try {
      const repo = await this.ensureRepo(api, args.uri);
      await repo.status();
      if (repo.state.rebaseCommit) {
        void vscode.window.showWarningMessage('Overtex: a Git rebase is in progress. Finish or abort it in Source Control first.');
        throw new Stop();
      }
      await this.concludeMerge(repo);
      const branch = repo.state.HEAD?.name;
      if (!branch) {
        void vscode.window.showWarningMessage('Overtex: you are looking at an older version, not a branch. Switch back to your branch (Git: Checkout to…) and try again.');
        throw new Stop();
      }
      if (needsRemote && !repo.state.remotes.length) {
        const choice = await vscode.window.showWarningMessage(
          'Overtex: this project has no online copy to share with yet. Add one (for example a GitHub or GitLab repository).',
          'Add Online Copy'
        );
        if (choice) {
          void vscode.commands.executeCommand('git.addRemote');
        }
        throw new Stop();
      }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Overtex: ${title}…` }, () => flow(repo, branch));
    } catch (err) {
      if (err instanceof GitHubError || err instanceof GitLabError) {
        this.deps.log(`${title} failed: ${err instanceof GitHubError ? 'GitHub' : 'GitLab'} ${err.status}\n`);
        void vscode.window.showErrorMessage(`Overtex: ${err.message}`);
      } else if (err instanceof Refusal) {
        void vscode.window.showWarningMessage(`Overtex: ${err.message}`);
      } else if (!(err instanceof Stop)) {
        this.deps.log(`${title} failed: ${err instanceof Error ? err.message : String(err)}\n`);
        void vscode.window.showErrorMessage(`Overtex: ${describeGitError(err)}`);
      }
    } finally {
      this.busy = false;
      this.watch();
    }
  }

  private async ensureRepo(api: API, uri?: vscode.Uri): Promise<Repository> {
    const found = this.repoFor(api, uri) ?? (uri ? (await api.openRepository(uri)) ?? undefined : undefined);
    if (found) {
      return found;
    }
    const folder = (uri && vscode.workspace.getWorkspaceFolder(uri)) ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage('Overtex: open your project folder first (File > Open Folder…).');
      throw new Stop();
    }
    const choice = await vscode.window.showInformationMessage(
      `Overtex: "${folder.name}" is not set up for sharing yet. Set it up? This starts keeping versions of your files with Git.`,
      'Set Up'
    );
    if (!choice) {
      throw new Stop();
    }
    const repo = await api.init(folder.uri);
    if (!repo) {
      throw new Error('Git could not set up this folder.');
    }
    return repo;
  }

  /** Fetches every remote and combines each remote's copy of the branch into yours. */
  private async getAll(repo: Repository, branch: string): Promise<string[]> {
    const warnings: string[] = [];
    for (const remote of repo.state.remotes) {
      try {
        await repo.fetch({ remote: remote.name });
      } catch (err) {
        warnings.push(`could not get changes from ${remote.name}: ${describeGitError(err)}`);
      }
    }
    const remoteBranches = new Set((await repo.getBranches({ remote: true })).map((r) => r.name).filter((n): n is string => !!n));
    if (!repo.state.HEAD?.commit) {
      // A new project with no versions yet: start from a copy that has some (yours first).
      const order = [...ownRemotes(repo), ...repo.state.remotes.filter((r) => !ownRemotes(repo).includes(r))].map((r) => r.name);
      const start = startingRef([...remoteBranches], order, branch);
      if (start) {
        if (start.branch !== branch) {
          await this.git(repo, ['symbolic-ref', 'HEAD', `refs/heads/${start.branch}`]);
          branch = start.branch;
        }
        await this.git(repo, ['merge', '--no-edit', start.ref]);
        await repo.status();
      }
    }
    for (const remote of repo.state.remotes) {
      const ref = `${remote.name}/${branch}`;
      if (!remoteBranches.has(ref) || !repo.state.HEAD?.commit) {
        continue;
      }
      try {
        await this.git(repo, ['merge', '--no-edit', ref]);
      } catch (err) {
        await repo.status();
        const unmerged = await this.unmerged(repo);
        if (unmerged.length) {
          await showConflicts(unmerged, `You and a co-author (${remote.name}) changed the same lines. Choose which version to keep in each marked file, save, then run Share Changes again.`);
          throw new Stop();
        }
        throw err;
      }
    }
    await repo.status();
    return warnings;
  }

  /**
   * A merge stopped by a conflict stays in progress until it is committed. Once no file has conflict
   * markers left (the person picked a version and saved, or kept their own exactly), commit it so that
   * the share can go on; otherwise point at the files still to fix.
   */
  private async concludeMerge(repo: Repository): Promise<void> {
    const inProgress = await this.git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(
      () => true,
      () => false
    );
    if (!inProgress) {
      return;
    }
    const unmerged = await this.unmerged(repo);
    const marked = unmerged.filter((uri) => hasConflictMarkers(uri.fsPath));
    if (marked.length) {
      await showConflicts(marked, 'Finish combining the changes first: choose which version to keep in each marked file, save, then share again.');
      throw new Stop();
    }
    await this.git(repo, ['add', '-A']);
    await this.withIdentity(repo, () => this.git(repo, ['commit', '--no-edit']).then(() => undefined));
    await repo.status();
  }

  /** Files git still lists as unmerged. */
  private async unmerged(repo: Repository): Promise<vscode.Uri[]> {
    const out = await this.git(repo, ['diff', '--name-only', '--diff-filter=U', '-z']);
    return out
      .split('\0')
      .filter(Boolean)
      .map((rel) => vscode.Uri.file(path.join(repo.rootUri.fsPath, rel)));
  }

  /** Runs git for a local operation (no network, so no credentials needed). */
  private git(repo: Repository, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.api!.git.path, args, { cwd: repo.rootUri.fsPath, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(new Error(stderr || err.message), { stderr }));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  private async chooseRemote(repo: Repository): Promise<string> {
    const names = ownRemotes(repo).map((r) => r.name);
    const remote = pushRemote(names, repo.state.HEAD?.upstream?.remote);
    if (remote) {
      return remote;
    }
    const picked = await vscode.window.showQuickPick(names, { placeHolder: 'Which online copy is yours? Overtex sends your changes there.' });
    if (!picked) {
      throw new Stop();
    }
    return picked;
  }

  /** Before the first share with build files among the changes, offers to leave them out. */
  private async offerIgnore(repo: Repository): Promise<void> {
    const root = repo.rootUri.fsPath;
    const pdf = this.deps.builtPdf();
    const builtPdf = pdf && !path.relative(root, pdf).startsWith('..') ? path.relative(root, pdf) : undefined;
    const changed = allChanges(repo).map((c) => path.relative(root, c.uri.fsPath));
    const builds = changed.filter((rel) => isBuildOutput(rel, builtPdf));
    const key = `overtex.sync.ignoreAsked:${root}`;
    if (!builds.length || this.context.workspaceState.get(key)) {
      return;
    }
    const file = path.join(root, '.gitignore');
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const lines = missingIgnoreLines(existing, builtPdf);
    if (!lines.length) {
      return;
    }
    const shown = builds.slice(0, 3).map((b) => path.basename(b)).join(', ') + (builds.length > 3 ? '…' : '');
    const choice = await vscode.window.showInformationMessage(
      `Some changes are files LaTeX makes on every build (${shown}). Leave them out of sharing? Your co-authors can build them themselves.`,
      { modal: true },
      'Leave Out',
      'Share Them Too'
    );
    if (!choice) {
      throw new Stop();
    }
    await this.context.workspaceState.update(key, true);
    if (choice === 'Leave Out') {
      fs.writeFileSync(file, withIgnoreLines(existing, lines));
      await repo.status();
    }
  }

  /** Runs a commit; if Git has no name/email for you, asks once and retries. */
  private async withIdentity(repo: Repository, commit: () => Promise<void>): Promise<void> {
    try {
      await commit();
    } catch (err) {
      if (!needsIdentity(err)) {
        throw err;
      }
      const name = await vscode.window.showInputBox({
        title: 'Your name',
        prompt: 'Git labels every shared change with your name and email. They are saved in this project only.',
        ignoreFocusOut: true,
      });
      const email = name && (await vscode.window.showInputBox({ title: 'Your email', prompt: 'Shown next to your changes.', ignoreFocusOut: true }));
      if (!name || !email) {
        throw new Stop();
      }
      await repo.setConfig('user.name', name);
      await repo.setConfig('user.email', email);
      await commit();
    }
  }

  dispose(): void {
    this.repoListener?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/**
 * A GitHub client signed in through VS Code's own GitHub account (Accounts menu); VS Code keeps the
 * token. Under the end-to-end tests only, OVERTEX_E2E_GITHUB_API points it at a local fake server.
 */
async function githubClient(): Promise<GitHubClient> {
  const fake = process.env.OVERTEX_E2E && process.env.OVERTEX_E2E_GITHUB_API;
  if (fake) {
    return new GitHubClient('e2e', fetch, fake);
  }
  let session: vscode.AuthenticationSession | undefined;
  try {
    session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
  } catch {
    session = undefined;
  }
  if (!session) {
    void vscode.window.showWarningMessage('Overtex: inviting a co-author needs you to sign in to GitHub.');
    throw new Stop();
  }
  return new GitHubClient(session.accessToken, fetch);
}

/** Remotes Share Changes may send to: not a co-author's read-only copy. */
function ownRemotes(repo: Repository) {
  return repo.state.remotes.filter((r) => r.pushUrl !== READ_ONLY_PUSH_URL);
}

/** The remote your changes go to, if it is clear which one it is. */
function ownRemote(repo: Repository) {
  const name = pushRemote(
    ownRemotes(repo).map((r) => r.name),
    repo.state.HEAD?.upstream?.remote
  );
  return repo.state.remotes.find((r) => r.name === name);
}

/** Your own copy on GitHub or GitLab, if the project has one. */
function ownCopy(repo: Repository): HostedRepo | undefined {
  const own = ownRemote(repo);
  return parseHostedRemote(own?.pushUrl ?? own?.fetchUrl);
}

/** The name of the remote that already gets changes from this co-author copy, if any. */
function coauthorRemote(repo: Repository, dir: string, target: HostedRepo): string | undefined {
  for (const r of repo.state.remotes) {
    const m = /^git@overtex-([0-9a-f]{16}):(.+)\.git$/.exec(r.fetchUrl ?? '');
    if (m && m[2].toLowerCase() === target.path.toLowerCase() && readMeta(dir, m[1])?.host === target.host) {
      return r.name;
    }
  }
  return undefined;
}

function hostName(host: Host): string {
  return host === 'github.com' ? 'GitHub' : 'GitLab';
}

interface KeyMeta {
  /** invite: made by Create Invite Code; join: made when entering someone's invite. */
  role: 'invite' | 'join';
  /** The co-author copy the key reads, once known. */
  host?: Host;
  path?: string;
}

function newKeyId(): string {
  return randomBytes(8).toString('hex');
}

function readMeta(dir: string, id: string): KeyMeta | undefined {
  if (!validKeyId(id)) {
    return undefined;
  }
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'keys', `${id}.json`), 'utf8'));
    const host = m?.host === 'github.com' || m?.host === 'gitlab.com' ? (m.host as Host) : undefined;
    return m?.role === 'invite' || m?.role === 'join' ? { role: m.role, host, path: typeof m.path === 'string' ? m.path : undefined } : undefined;
  } catch {
    return undefined;
  }
}

function writeMeta(dir: string, id: string, meta: KeyMeta): void {
  fs.writeFileSync(path.join(dir, 'keys', `${id}.json`), JSON.stringify(meta) + '\n');
}

/** Makes a new ed25519 key for the project with ssh-keygen (it comes with Git) and returns its public half. */
async function newKey(dir: string, id: string, meta: KeyMeta): Promise<string> {
  const keys = path.join(dir, 'keys');
  fs.mkdirSync(keys, { recursive: true, mode: 0o700 });
  const file = path.join(keys, id);
  await new Promise<void>((resolve, reject) => {
    execFile('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'overtex', '-f', file], (err) =>
      err ? reject(new Refusal('making a key needs ssh-keygen, which comes with Git. Install Git (or OpenSSH) and try again.')) : resolve()
    );
  });
  fs.chmodSync(file, 0o600);
  const key = normalizePublicKey(fs.readFileSync(`${file}.pub`, 'utf8'));
  if (!key) {
    throw new Refusal('ssh-keygen made a key Overtex cannot read. Try again.');
  }
  writeMeta(dir, id, meta);
  return key;
}

function allChanges(repo: Repository) {
  const s = repo.state;
  return [...s.indexChanges, ...s.workingTreeChanges, ...(s.untrackedChanges ?? [])];
}

function changeCount(repo: Repository): number {
  return new Set(allChanges(repo).map((c) => c.uri.toString())).size;
}

function askMessage(): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Share Changes',
    prompt: 'What did you change? (optional, press Enter to skip)',
    placeHolder: 'Update',
  });
}

function hasConflictMarkers(file: string): boolean {
  try {
    return /^<{7}(?: |$)[\s\S]*^>{7}(?: |$)/m.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false; // Deleted on one side: nothing to mark.
  }
}

async function showConflicts(files: vscode.Uri[], message: string): Promise<void> {
  if (files[0]) {
    await vscode.commands.executeCommand('vscode.open', files[0]);
  }
  void vscode.commands.executeCommand('workbench.view.scm');
  void vscode.window.showWarningMessage(`Overtex: ${message}`);
}

function done(what: string, warnings: string[]): void {
  if (warnings.length) {
    void vscode.window.showWarningMessage(`Overtex: ${what}, but ${warnings.join('; ')}`);
  } else {
    void vscode.window.setStatusBarMessage(`Overtex: ${what}`, 4000);
  }
}
