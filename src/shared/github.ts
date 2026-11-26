// GitHub REST calls for Invite Co-author, and the plain-language helpers around them. No vscode import,
// so they are unit tested with a fake fetch. The token goes only into the Authorization header of
// requests to the API base; it is never logged or put in a message.

export const GITHUB_API = 'https://api.github.com';

export interface GitHubRepo {
  owner: string;
  name: string;
}

export interface CreatedRepo extends GitHubRepo {
  htmlUrl: string;
  cloneUrl: string;
}

/** A failed GitHub call, with the HTTP status and a message the person can act on. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** owner/name of a GitHub remote URL (https, ssh or scp-style), else undefined. */
export function parseGitHubRemote(url: string | undefined): GitHubRepo | undefined {
  if (!url) {
    return undefined;
  }
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], name: m[2] } : undefined;
}

/** A GitHub username typed by a person: leading @ and spaces dropped, undefined if it cannot be one. */
export function normalizeUsername(input: string): string | undefined {
  const name = input.trim().replace(/^@/, '');
  return /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/.test(name) ? name : undefined;
}

/** Letters NFKD does not split into a base letter plus a mark. */
const SPECIAL_LETTERS: Record<string, string> = {
  ı: 'i',
  İ: 'I',
  ł: 'l',
  Ł: 'L',
  ø: 'o',
  Ø: 'O',
  đ: 'd',
  Đ: 'D',
  ß: 'ss',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
};

/** A repository name GitHub accepts, made from the project folder's name. */
export function repoNameFor(folder: string): string {
  const name = folder
    .replace(/[ıİłŁøØđĐßæÆœŒ]/g, (c) => SPECIAL_LETTERS[c] ?? c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100);
  return name || 'paper';
}

export function validRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..';
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect?: 'error' }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: Fetch,
    private readonly base = GITHUB_API
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'Overtex',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // The token is for GitHub only: a redirect elsewhere would take the header along.
      redirect: 'error',
      });
    } catch {
      throw new GitHubError(0, 'Could not reach GitHub. Check your internet connection and try again.');
    }
    const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, data };
  }

  /** The signed-in account's login. */
  async login(): Promise<string> {
    const { status, data } = await this.call('GET', '/user');
    if (status !== 200 || typeof data?.login !== 'string') {
      throw failure(status, data);
    }
    return data.login;
  }

  /** Creates a private, empty repository under your account. */
  async createPrivateRepo(name: string): Promise<CreatedRepo> {
    const { status, data } = await this.call('POST', '/user/repos', {
      name,
      private: true,
      auto_init: false,
      description: 'LaTeX project shared with Overtex',
    });
    if (status === 422 && /already exists/i.test(JSON.stringify(data?.errors ?? data?.message ?? ''))) {
      throw new GitHubError(422, `You already have a repository called "${name}" on GitHub. Pick another name.`);
    }
    if (status !== 201) {
      throw failure(status, data);
    }
    return { owner: data.owner.login, name: data.name, htmlUrl: data.html_url, cloneUrl: data.clone_url };
  }

  /**
   * Invites a GitHub user to edit the repository. 'invited' means GitHub emails them an invitation to
   * accept; 'already' means they can edit it already.
   */
  async invite(repo: GitHubRepo, username: string): Promise<'invited' | 'already'> {
    const { status, data } = await this.call(
      'PUT',
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/collaborators/${encodeURIComponent(username)}`,
      { permission: 'push' }
    );
    if (status === 201) {
      return 'invited';
    }
    if (status === 204) {
      return 'already';
    }
    if (status === 404) {
      throw new GitHubError(404, `GitHub has no user "${username}", or you cannot manage ${repo.owner}/${repo.name}. Check the spelling of the username.`);
    }
    if (status === 403) {
      throw new GitHubError(
        403,
        `Only the owner of ${repo.owner}/${repo.name} (or an admin) can invite people. Ask them to invite ${username}, or share the project from your own copy.`
      );
    }
    throw failure(status, data);
  }

  /**
   * Invitations to other people's repositories waiting for you to accept or decline, newest first.
   * Entries GitHub sends in a shape Overtex does not expect are left out.
   */
  async invitations(): Promise<Invitation[]> {
    const { status, data } = await this.call('GET', '/user/repository_invitations?per_page=100');
    if (status !== 200 || !Array.isArray(data)) {
      throw failure(status, data);
    }
    return data
      .map(asInvitation)
      .filter((i): i is Invitation => !!i)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Accepts an invitation: you can then edit the repository. */
  async acceptInvitation(id: number): Promise<void> {
    await this.answerInvitation('PATCH', id);
  }

  /** Declines an invitation: the owner has to invite you again to let you in. */
  async declineInvitation(id: number): Promise<void> {
    await this.answerInvitation('DELETE', id);
  }

  private async answerInvitation(method: 'PATCH' | 'DELETE', id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new GitHubError(0, 'That is not a GitHub invitation.');
    }
    const { status, data } = await this.call(method, `/user/repository_invitations/${id}`);
    if (status === 204) {
      return;
    }
    if (status === 404) {
      throw new GitHubError(404, 'GitHub no longer has that invitation: it was answered, withdrawn or has run out. Ask the owner to invite you again.');
    }
    if (status === 409 || status === 410) {
      throw new GitHubError(status, 'That invitation has run out (GitHub keeps them for 7 days). Ask the owner to invite you again.');
    }
    throw failure(status, data);
  }

  /**
   * Gives a public key read-only access to the repository (a deploy key). 'already' means the
   * repository has that key already. GitHub lets a key be a deploy key of one repository only.
   */
  async addDeployKey(repo: GitHubRepo, title: string, key: string): Promise<'added' | 'already'> {
    const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/keys`;
    const { status, data } = await this.call('POST', base, { title, key, read_only: true });
    if (status === 201) {
      return 'added';
    }
    if (status === 422) {
      const list = await this.call('GET', `${base}?per_page=100`);
      if (list.status === 200 && Array.isArray(list.data) && list.data.some((k: any) => typeof k?.key === 'string' && k.key.trim().startsWith(key))) {
        return 'already';
      }
      throw new GitHubError(422, 'GitHub already uses that key for another repository. Ask your co-author for a new code.');
    }
    if (status === 404 || status === 403) {
      throw new GitHubError(
        status,
        `Overtex could not give access to ${repo.owner}/${repo.name}: only its owner (or an admin) can, and the repository has to exist.`
      );
    }
    throw failure(status, data);
  }
}

/** An invitation to edit someone else's GitHub repository. */
export interface Invitation {
  id: number;
  repo: GitHubRepo;
  /** The login of the person who invited you. */
  inviter: string;
  /** https://github.com/owner/name.git, rebuilt from owner/name rather than taken from the answer. */
  cloneUrl: string;
  createdAt: string;
  /** GitHub keeps an invitation for 7 days; after that it can only be declined. */
  expired: boolean;
}

const LOGIN = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;

/** An invitation from GitHub's answer, or undefined if it does not look like one. */
export function asInvitation(raw: any): Invitation | undefined {
  const id = raw?.id;
  const full = raw?.repository?.full_name;
  const inviter = raw?.inviter?.login;
  if (!Number.isSafeInteger(id) || id <= 0 || typeof full !== 'string' || typeof inviter !== 'string' || !LOGIN.test(inviter)) {
    return undefined;
  }
  const [owner, name, ...rest] = full.split('/');
  if (rest.length || !owner || !LOGIN.test(owner) || !name || !validRepoName(name)) {
    return undefined;
  }
  return {
    id,
    repo: { owner, name },
    inviter,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
    expired: raw.expired === true,
  };
}

function failure(status: number, data: any): GitHubError {
  if (status === 401) {
    return new GitHubError(401, 'GitHub did not accept your sign-in. Sign out of GitHub in VS Code (Accounts menu) and try again.');
  }
  if (status === 403 && /rate limit/i.test(String(data?.message ?? ''))) {
    return new GitHubError(403, 'GitHub is limiting requests right now. Try again in a few minutes.');
  }
  const detail = typeof data?.message === 'string' ? data.message : `HTTP ${status}`;
  return new GitHubError(status, `GitHub refused the request: ${detail}.`);
}
