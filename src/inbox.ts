// Invitations waiting for you: GitHub repositories someone invited you to edit, and GitLab projects
// someone added you to. Overtex looks for them quietly (only with a sign-in or token you already gave
// it, never asking for one in the background), shows how many there are in the status bar, and lets you
// join, decline or open them without leaving VS Code. Joining clones the project into your projects
// folder (overtex.projectsFolder) and opens it.
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GitExtension } from './types/git';
import { GitHubClient, GitHubError, type Invitation } from './shared/github';
import { GitLabClient } from './shared/gitlab';
import { ForgeError } from './shared/forge';
import { validRepoPath } from './inviteCode';
import { cloneFolderName, projectsFolder, shouldCheck } from './joinProject';
import { gitlabServers, tokenKey } from './gitSync';

/** globalState keys. Nothing here is a secret: names of projects and when Overtex last looked. */
const LAST_CHECK = 'overtex.inbox.lastCheck';
const ITEMS = 'overtex.inbox.items';
const NOTIFIED = 'overtex.inbox.notified';
const GITLAB = 'overtex.inbox.gitlab';
const TO_CLONE = 'overtex.inbox.toClone';

const STARTUP_EVERY = 10 * 60_000;
const FOCUS_EVERY = 15 * 60_000;

/** Something waiting for you. */
export interface InboxItem {
  /** Stable across checks: names it in the notified list. */
  key: string;
  kind: 'github' | 'gitlab' | 'joined';
  /** owner/name or group/name, checked. */
  label: string;
  /** GitHub, gitlab.com or the server's host. */
  site: string;
  /** Your server's web address, for GitLab (and joined GitLab projects). */
  web?: string;
  /** The login of whoever invited you (GitHub only). */
  from?: string;
  inviteId?: number;
  expired?: boolean;
  /** https address, built from the checked label, never taken from an answer as is. */
  cloneUrl: string;
  /** The repository's own name: the folder it is cloned into. */
  name: string;
}

/**
 * What the end-to-end tests pass to Overtex: Pending Invitations, so nothing waits on a prompt.
 * `label` picks the project, `choice` is the button pressed (a decline is then not asked again),
 * `folder` is the projects folder.
 */
export interface InboxArgs {
  label?: string;
  choice?: string;
  folder?: string;
}

interface GitLabState {
  /** ISO time: projects you were added to after this are new. */
  since: string;
  pending: InboxItem[];
}

export function registerInbox(context: vscode.ExtensionContext): void {
  const inbox = new Inbox(context);
  context.subscriptions.push(
    inbox,
    vscode.commands.registerCommand('overtex.pendingInvitations', (args?: InboxArgs) => inbox.open(args))
  );
  inbox.start();
}

class Inbox implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('overtex.invitations', vscode.StatusBarAlignment.Left, 48);
  private readonly disposables: vscode.Disposable[] = [this.item];
  private checking: Promise<InboxItem[]> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.item.name = 'Overtex Invitations';
    this.item.command = 'overtex.pendingInvitations';
  }

  start(): void {
    this.show(this.cached());
    // The end-to-end tests check every request: they look only when the command runs.
    if (process.env.OVERTEX_E2E) {
      return;
    }
    const timer = setTimeout(() => void this.quietly(STARTUP_EVERY), 5000);
    this.disposables.push(
      { dispose: () => clearTimeout(timer) },
      vscode.window.onDidChangeWindowState((s) => s.focused && void this.quietly(FOCUS_EVERY)),
      vscode.authentication.onDidChangeSessions((e) => e.provider.id === 'github' && void this.quietly(0))
    );
  }

  /** Overtex: Pending Invitations. Asks you to sign in to GitHub if you have not. */
  async open(args?: InboxArgs): Promise<string | undefined> {
    let items: InboxItem[];
    try {
      items = await this.check(true);
    } catch (err) {
      void vscode.window.showErrorMessage(`Overtex: ${message(err)}`);
      return undefined;
    }
    if (args?.label !== undefined) {
      const item = items.find((i) => i.label === args.label);
      return item && this.offer(item, args);
    }
    if (!items.length) {
      void vscode.window.showInformationMessage(
        'Overtex: no invitations are waiting. When someone invites you to their project, it shows up here and in the status bar.'
      );
      return undefined;
    }
    const chosen =
      items.length === 1
        ? items[0]
        : (
            await vscode.window.showQuickPick(
              items.map((i) => ({ label: i.label, description: describe(i), item: i })),
              { title: 'Overtex: invitations waiting for you', placeHolder: 'Pick a project to join, decline or open' }
            )
          )?.item;
    return chosen && this.offer(chosen);
  }

  /** A background look, at most every `every` ms across all windows. Errors stay quiet. */
  private async quietly(every: number): Promise<void> {
    if (!shouldCheck(Date.now(), this.context.globalState.get<number>(LAST_CHECK), every)) {
      this.show(this.cached());
      return;
    }
    let items: InboxItem[];
    try {
      items = await this.check(false);
    } catch {
      return;
    }
    const notified = new Set(this.context.globalState.get<string[]>(NOTIFIED) ?? []);
    const fresh = items.filter((i) => !notified.has(i.key) && !i.expired);
    if (!fresh.length) {
      return;
    }
    await this.context.globalState.update(NOTIFIED, [...notified, ...fresh.map((i) => i.key)].slice(-200));
    if (fresh.length === 1) {
      await this.offer(fresh[0]);
    } else if ((await vscode.window.showInformationMessage(`Overtex: ${fresh.length} new project invitations are waiting for you.`, 'Show')) === 'Show') {
      await this.open();
    }
  }

  /** Looks for invitations now. `interactive`: you asked, so GitHub may ask you to sign in. */
  private check(interactive: boolean): Promise<InboxItem[]> {
    this.checking ??= this.doCheck(interactive).finally(() => (this.checking = undefined));
    return this.checking;
  }

  private async doCheck(interactive: boolean): Promise<InboxItem[]> {
    await this.context.globalState.update(LAST_CHECK, Date.now());
    const gh = await githubClient(interactive);
    const github = gh ? (await gh.invitations()).map(fromInvitation) : [];
    const gitlab = await this.gitlabItems(interactive);
    const joined = this.context.globalState.get<InboxItem[]>(TO_CLONE) ?? [];
    const items = [...joined, ...github.filter((g) => !joined.some((j) => j.label === g.label && j.site === g.site)), ...gitlab];
    await this.context.globalState.update(ITEMS, items);
    this.show(items);
    return items;
  }

  /** New GitLab projects on each server you gave Overtex a token for. A server that fails is skipped. */
  private async gitlabItems(interactive: boolean): Promise<InboxItem[]> {
    const states = { ...(this.context.globalState.get<Record<string, GitLabState>>(GITLAB) ?? {}) };
    const out: InboxItem[] = [];
    const fake = process.env.OVERTEX_E2E && process.env.OVERTEX_E2E_GITLAB_API;
    if (process.env.OVERTEX_E2E && !fake) {
      // The tests never reach a real server.
      return out;
    }
    for (const web of gitlabServers(this.context)) {
      const token = fake ? 'e2e' : await this.context.secrets.get(tokenKey(web));
      if (!token) {
        continue;
      }
      const now = new Date().toISOString();
      const state = states[web];
      if (!state) {
        // The first look only notes the time: projects you were in already are not news.
        states[web] = { since: now, pending: [] };
        continue;
      }
      try {
        const client = new GitLabClient(token, fetch, fake || `${web}/api/v4`);
        let since = state.since;
        for (const e of await client.joinedSince(state.since)) {
          const p = await client.getProject(String(e.projectId)).catch(() => undefined);
          const item = p && fromGitLab(web, p.path);
          if (item && !state.pending.some((x) => x.key === item.key)) {
            state.pending.push(item);
          }
          since = Date.parse(e.at) > Date.parse(since) ? new Date(Date.parse(e.at)).toISOString() : since;
        }
        state.since = since;
      } catch (err) {
        if (interactive && !(err instanceof ForgeError && err.status === 401)) {
          void vscode.window.showWarningMessage(`Overtex: could not look for new projects on ${siteOf(web)}: ${message(err)}`);
        }
      }
      out.push(...state.pending);
    }
    await this.context.globalState.update(GITLAB, states);
    return out;
  }

  /**
   * The question for one item, with the buttons that answer it. Gives the folder the project was
   * cloned into, or 'declined' / 'forgotten'.
   */
  private async offer(item: InboxItem, args?: InboxArgs): Promise<string | undefined> {
    const ask = async (text: string, warn: boolean, ...buttons: string[]) =>
      args?.choice ?? (warn ? vscode.window.showWarningMessage(text, ...buttons) : vscode.window.showInformationMessage(text, ...buttons));
    try {
      if (item.kind === 'github' && item.expired) {
        const c = await ask(
          `Overtex: ${item.from}'s invitation to ${item.label} has run out (GitHub keeps them for 7 days). Ask ${item.from} to invite you again.`,
          true,
          'Remove It'
        );
        return c === 'Remove It' ? this.decline(item, false) : undefined;
      }
      if (item.kind === 'github') {
        const c = await ask(`Overtex: ${item.from} invited you to edit ${item.label} on GitHub.`, false, 'Join', 'Decline', 'Later');
        if (c === 'Join') {
          return await this.join(item, args?.folder);
        }
        return c === 'Decline' ? await this.decline(item, !args?.choice) : undefined;
      }
      const what = item.kind === 'gitlab' ? `You were added to ${item.label} on ${item.site}.` : `You joined ${item.label}, but it is not on this computer yet.`;
      const c = await ask(`Overtex: ${what}`, false, 'Open', 'Later', "Don't Show Again");
      if (c === 'Open') {
        return await this.cloneAndOpen(item, args?.folder);
      }
      if (c === "Don't Show Again") {
        await this.forget(item);
        return 'forgotten';
      }
      return undefined;
    } catch (err) {
      void vscode.window.showErrorMessage(`Overtex: ${message(err)}`);
      return undefined;
    }
  }

  private async join(item: InboxItem, folder?: string): Promise<string | undefined> {
    const gh = await githubClient(true);
    if (!gh || item.inviteId === undefined) {
      return undefined;
    }
    await gh.acceptInvitation(item.inviteId);
    // Accepted: GitHub forgets the invitation, so Overtex remembers the project until it is cloned.
    const joined: InboxItem = { ...item, kind: 'joined', key: `joined:${item.site}:${item.label}`, inviteId: undefined };
    const list = (this.context.globalState.get<InboxItem[]>(TO_CLONE) ?? []).filter((j) => j.key !== joined.key);
    await this.context.globalState.update(TO_CLONE, [...list, joined]);
    await this.drop(item);
    // Still listed if the clone fails, so Open can try again.
    await this.context.globalState.update(ITEMS, [joined, ...this.cached().filter((i) => i.key !== joined.key)]);
    return this.cloneAndOpen(joined, folder);
  }

  private async decline(item: InboxItem, ask: boolean): Promise<string | undefined> {
    if (ask) {
      const c = await vscode.window.showWarningMessage(
        `Decline ${item.from}'s invitation to ${item.label}?`,
        { modal: true, detail: `${item.from} would have to invite you again to let you in.` },
        'Decline'
      );
      if (c !== 'Decline') {
        return undefined;
      }
    }
    const gh = await githubClient(true);
    if (!gh || item.inviteId === undefined) {
      return undefined;
    }
    await gh.declineInvitation(item.inviteId);
    await this.drop(item);
    vscode.window.setStatusBarMessage(`Overtex: declined the invitation to ${item.label}.`, 5000);
    return 'declined';
  }

  /** Clones the project into your projects folder and opens it. */
  private async cloneAndOpen(item: InboxItem, folder?: string): Promise<string> {
    const base = projectsFolder(folder ?? vscode.workspace.getConfiguration('overtex').get<string>('projectsFolder'), os.homedir());
    fs.mkdirSync(base, { recursive: true });
    const name = cloneFolderName(item.name, (f) => fs.existsSync(path.join(base, f)));
    const target = name && path.join(base, name);
    const rel = target && path.relative(base, target);
    if (!target || !rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Overtex cannot make a folder for "${item.name}" in ${base}.`);
    }
    const header = await this.authHeader(item);
    const url = process.env.OVERTEX_E2E && process.env.OVERTEX_E2E_CLONE_BASE ? `${process.env.OVERTEX_E2E_CLONE_BASE}/${item.label}.git` : item.cloneUrl;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Overtex: getting ${item.label}` },
      () => clone(url, target, header)
    );
    if (item.kind !== 'github') {
      await this.forget(item);
    }
    const uri = vscode.Uri.file(target);
    if (process.env.OVERTEX_E2E) {
      return target;
    }
    // Opening the folder in this window restarts the extension host: nothing may come after it.
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: !!vscode.workspace.workspaceFolders?.length });
    return target;
  }

  /**
   * The Authorization header git sends for this one clone, to the project's own server only. It goes
   * to git in its environment (not its arguments or a file), so it is not kept in the clone's config.
   */
  private async authHeader(item: InboxItem): Promise<{ origin: string; value: string } | undefined> {
    if (process.env.OVERTEX_E2E) {
      return undefined;
    }
    if (item.site === 'GitHub') {
      const session = await vscode.authentication.getSession('github', ['repo'], { silent: true }).then(
        (s) => s,
        () => undefined
      );
      return session && { origin: 'https://github.com/', value: basic(`x-access-token:${session.accessToken}`) };
    }
    const token = item.web && (await this.context.secrets.get(tokenKey(item.web)));
    return token ? { origin: `${item.web}/`, value: basic(`oauth2:${token}`) } : undefined;
  }

  private async forget(item: InboxItem): Promise<void> {
    await this.drop(item);
    const joined = (this.context.globalState.get<InboxItem[]>(TO_CLONE) ?? []).filter((j) => j.key !== item.key);
    await this.context.globalState.update(TO_CLONE, joined);
    const states = { ...(this.context.globalState.get<Record<string, GitLabState>>(GITLAB) ?? {}) };
    for (const s of Object.values(states)) {
      s.pending = s.pending.filter((p) => p.key !== item.key);
    }
    await this.context.globalState.update(GITLAB, states);
    this.show(this.cached());
  }

  /** Takes an item off the list shown in the status bar. */
  private async drop(item: InboxItem): Promise<void> {
    await this.context.globalState.update(
      ITEMS,
      this.cached().filter((i) => i.key !== item.key)
    );
    this.show(this.cached());
  }

  private cached(): InboxItem[] {
    const items = this.context.globalState.get<unknown>(ITEMS);
    return Array.isArray(items) ? (items as InboxItem[]) : [];
  }

  private show(items: InboxItem[]): void {
    const n = items.filter((i) => !i.expired).length;
    if (!n) {
      this.item.hide();
      return;
    }
    this.item.text = `$(mail) ${n}`;
    this.item.tooltip = `Overtex: ${n} project invitation${n === 1 ? '' : 's'} waiting for you. Click to see them.`;
    this.item.show();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/**
 * GitHub through VS Code's own account. In the background only a sign-in you already gave Overtex is
 * used; `ask` lets VS Code ask you to sign in.
 */
async function githubClient(ask: boolean): Promise<GitHubClient | undefined> {
  const fake = process.env.OVERTEX_E2E && process.env.OVERTEX_E2E_GITHUB_API;
  if (fake) {
    return new GitHubClient('e2e', fetch, fake);
  }
  if (process.env.OVERTEX_E2E) {
    return undefined;
  }
  const session = await vscode.authentication.getSession('github', ['repo'], ask ? { createIfNone: true } : { silent: true }).then(
    (s) => s,
    () => undefined
  );
  if (!session && ask) {
    void vscode.window.showWarningMessage('Overtex: seeing your GitHub invitations needs you to sign in to GitHub.');
  }
  return session && new GitHubClient(session.accessToken, fetch);
}

function fromInvitation(i: Invitation): InboxItem {
  const label = `${i.repo.owner}/${i.repo.name}`;
  return { key: `github:${i.id}`, kind: 'github', label, site: 'GitHub', from: i.inviter, inviteId: i.id, expired: i.expired, cloneUrl: i.cloneUrl, name: i.repo.name };
}

/** A GitLab project as an inbox item, if its path is one Overtex accepts for that server. */
export function fromGitLab(web: string, projectPath: string): InboxItem | undefined {
  const host = new URL(web).hostname;
  if (!validRepoPath(host, projectPath)) {
    return undefined;
  }
  const name = projectPath.split('/').pop()!;
  return { key: `gitlab:${web}:${projectPath}`, kind: 'gitlab', label: projectPath, site: siteOf(web), web, cloneUrl: `${web}/${projectPath}.git`, name };
}

function siteOf(web: string): string {
  return new URL(web).host;
}

function describe(i: InboxItem): string {
  if (i.kind === 'joined') {
    return 'joined, not on this computer yet';
  }
  if (i.kind === 'gitlab') {
    return `added on ${i.site}`;
  }
  return i.expired ? `from ${i.from}, ran out` : `from ${i.from} on GitHub`;
}

function basic(userPass: string): string {
  return `Basic ${Buffer.from(userPass, 'utf8').toString('base64')}`;
}

function message(err: unknown): string {
  return err instanceof GitHubError || err instanceof ForgeError || err instanceof Error ? err.message : String(err);
}

async function gitPath(): Promise<string> {
  try {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    const exports = ext && (ext.isActive ? ext.exports : await ext.activate());
    return exports?.enabled ? exports.getAPI(1).git.path : 'git';
  } catch {
    return 'git';
  }
}

/** git clone, with no prompts; the header (if any) only for the project's own server. */
async function clone(url: string, target: string, header: { origin: string; value: string } | undefined): Promise<void> {
  const git = await gitPath();
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (header) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.${header.origin}.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: ${header.value}`;
  }
  await new Promise<void>((resolve, reject) => {
    execFile(git, ['clone', '--', url, target], { env, timeout: 10 * 60_000 }, (err, _stdout, stderr) => {
      if (!err) {
        resolve();
        return;
      }
      const why = /Authentication failed|could not read Username|403|401/i.test(stderr)
        ? 'the server did not let you in. Check that you accepted the invitation with the same account.'
        : /not found|does not exist/i.test(stderr)
          ? 'the project was not found. It may have been renamed or removed.'
          : 'git could not clone it. Check your internet connection and try again.';
      reject(new Error(`Could not get ${url}: ${why}`));
    });
  });
}
