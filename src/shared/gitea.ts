// Gitea and Forgejo REST calls (Codeberg runs Forgejo) for co-author invite codes. No vscode import, so
// they are unit tested with a fake fetch. The access token goes only into the Authorization header of
// requests to the API base of the server it was entered for; it is never logged or put in a message.

import { createHash } from 'crypto';
import { CreatedProject, Fetch, ForgeError } from './forge';

export const CODEBERG_WEB = 'https://codeberg.org';
/** Codeberg's ed25519 host key, as documented (SHA256:mIlxA9k46MmM6qdJOdMnAQpzGxF4WIVVL+fj+wZbw0g). */
export const CODEBERG_HOST_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIIVIC02vnjFyL+I4RHfvIGNtOgJMe769VTF1VR4EB3ZB';

/** A failed Gitea or Forgejo call, with the HTTP status and a message the person can act on. */
export class GiteaError extends ForgeError {}

const TOKEN_HINT = 'It needs "repository" and "user" set to Read and Write.';

/** owner and name from "owner/name"; anything else is not a Gitea repository path. */
function split(repoPath: string): [string, string] {
  const parts = repoPath.split('/');
  if (parts.length !== 2 || parts.some((p) => !p)) {
    throw new GiteaError(400, `${repoPath} is not an owner/name repository path.`);
  }
  return [parts[0], parts[1]];
}

/** "type base64" of an OpenSSH public key line, without its comment. */
function keyBody(key: string): string {
  return key.trim().split(/\s+/).slice(0, 2).join(' ');
}

export class GiteaClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: Fetch,
    /** e.g. https://codeberg.org/api/v1 */
    private readonly base: string
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `token ${this.token}`,
          'User-Agent': 'Overtex',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        // The token is for this server only: a redirect elsewhere would take the header along.
        redirect: 'error',
      });
    } catch {
      throw new GiteaError(0, 'Could not reach the server. Check your internet connection and try again.');
    }
    const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, data };
  }

  private project(status: number, data: any, missing: string): CreatedProject {
    const fields = [data?.full_name, data?.ssh_url, data?.clone_url];
    if (fields.some((f) => typeof f !== 'string')) {
      throw new GiteaError(status, missing);
    }
    if (!data.ssh_url) {
      throw new GiteaError(status, 'The server does not offer ssh access to repositories, which Overtex needs.');
    }
    return { path: data.full_name, sshUrl: data.ssh_url, httpUrl: data.clone_url };
  }

  private refused(status: number, data: any): GiteaError {
    if (status === 401) {
      return new GiteaError(401, 'The server did not accept the access token. Make a new one and try again.');
    }
    if (status === 403) {
      return new GiteaError(403, `The server did not let this token do that. ${TOKEN_HINT}`);
    }
    const detail = typeof data?.message === 'string' && data.message ? data.message : `HTTP ${status}`;
    return new GiteaError(status, `The server refused the request: ${detail}.`);
  }

  /** Makes a private, empty repository under your own account. A name you already use comes back as 409. */
  async createPrivateProject(name: string): Promise<CreatedProject> {
    const { status, data } = await this.call('POST', '/user/repos', {
      name,
      private: true,
      auto_init: false,
      description: 'LaTeX project shared with Overtex',
    });
    if (status === 201 || status === 200) {
      return this.project(status, data, 'The server made the repository but did not say where it is. Look for it there.');
    }
    if (status === 409) {
      throw new GiteaError(409, `You already have a repository called "${name}". Pick another name.`);
    }
    throw this.refused(status, data);
  }

  /** A repository the token can see, with the addresses the server gives for it (its ssh one in particular). */
  async getProject(repoPath: string): Promise<CreatedProject> {
    const [owner, name] = split(repoPath);
    const { status, data } = await this.call('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    if (status === 200) {
      return this.project(status, data, `The server did not answer like Gitea or Forgejo does for ${repoPath}.`);
    }
    if (status === 404) {
      throw new GiteaError(404, `The server has no repository ${repoPath} that this token can see.`);
    }
    if (status === 401) {
      throw this.refused(status, data);
    }
    throw new GiteaError(status, `The server did not answer like Gitea or Forgejo does (HTTP ${status}).`);
  }

  /** Gives a public key read-only access to the repository (a deploy key). */
  async addDeployKey(repoPath: string, title: string, key: string): Promise<'added' | 'already'> {
    const [owner, name] = split(repoPath);
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/keys`;
    // Gitea wants titles unique within a repository, so a later key from the same co-author gets its own.
    const tag = createHash('sha256').update(keyBody(key)).digest('hex').slice(0, 8);
    const { status, data } = await this.call('POST', base, { title: `${title.slice(0, 80)} ${tag}`, key, read_only: true });
    if (status === 201 || status === 200) {
      return 'added';
    }
    if (status === 422) {
      const list = await this.call('GET', `${base}?limit=50`);
      if (list.status === 200 && Array.isArray(list.data) && list.data.some((k: any) => typeof k?.key === 'string' && keyBody(k.key) === keyBody(key))) {
        return 'already';
      }
      throw new GiteaError(422, 'The server already uses that key somewhere you cannot see. Ask your co-author for a new code.');
    }
    if (status === 403) {
      throw new GiteaError(403, `Only an admin of ${repoPath} can give access. ${TOKEN_HINT}`);
    }
    if (status === 404) {
      throw new GiteaError(404, `The server has no repository ${repoPath} that this token can see.`);
    }
    throw this.refused(status, data);
  }
}
