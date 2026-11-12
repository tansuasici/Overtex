// GitLab REST calls for co-author invite codes. No vscode import, so they are unit tested with a fake
// fetch. The access token goes only into the PRIVATE-TOKEN header of requests to the API base; it is
// never logged or put in a message.

export const GITLAB_API = 'https://gitlab.com/api/v4';

/** A failed GitLab call, with the HTTP status and a message the person can act on. */
export class GitLabError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export class GitLabClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: Fetch,
    private readonly base = GITLAB_API
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'PRIVATE-TOKEN': this.token,
          'User-Agent': 'Overtex',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitLabError(0, 'Could not reach GitLab. Check your internet connection and try again.');
    }
    const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, data };
  }

  /** Gives a public key read-only access to the project (a deploy key). */
  async addDeployKey(projectPath: string, title: string, key: string): Promise<'added' | 'already'> {
    const base = `/projects/${encodeURIComponent(projectPath)}/deploy_keys`;
    const { status, data } = await this.call('POST', base, { title, key, can_push: false });
    if (status === 201 || status === 200) {
      return 'added';
    }
    if (status === 400 && /already been taken/i.test(JSON.stringify(data ?? ''))) {
      const list = await this.call('GET', `${base}?per_page=100`);
      if (list.status === 200 && Array.isArray(list.data) && list.data.some((k: any) => typeof k?.key === 'string' && k.key.trim().startsWith(key))) {
        return 'already';
      }
      throw new GitLabError(400, 'GitLab already uses that key for a project you cannot see. Ask your co-author for a new code.');
    }
    if (status === 401) {
      throw new GitLabError(401, 'GitLab did not accept the access token. Make a new one and try again.');
    }
    if (status === 403) {
      throw new GitLabError(
        403,
        `Only a maintainer of ${projectPath} can give access, and the token needs the "api" scope.`
      );
    }
    if (status === 404) {
      throw new GitLabError(404, `GitLab has no project ${projectPath} that this token can see.`);
    }
    const detail = typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : `HTTP ${status}`;
    throw new GitLabError(status, `GitLab refused the request: ${detail}.`);
  }
}
