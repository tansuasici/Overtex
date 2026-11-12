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

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
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
