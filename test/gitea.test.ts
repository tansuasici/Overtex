import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { ForgeError } from '../src/shared/forge';
import { CODEBERG_HOST_KEY, GiteaClient, GiteaError } from '../src/shared/gitea';
import { GitLabError } from '../src/shared/gitlab';

const API = 'https://git.example.org/api/v1';
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOvertexTestKeyOvertexTestKeyOvertexTest';

function fake(responses: Record<string, { status: number; body?: unknown }>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string; redirect?: string }[] = [];
  const fn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect?: 'error' }) => {
    calls.push({ url, ...init });
    const r = responses[`${init.method} ${url.replace(API, '')}`] ?? { status: 500, body: { message: 'unexpected' } };
    return { status: r.status, json: async () => r.body };
  };
  return { fn, calls, gt: new GiteaClient('gt-secret', fn, API) };
}

const REPO = { full_name: 'dee/thesis', ssh_url: 'ssh://git@git.example.org:2222/dee/thesis.git', clone_url: 'https://git.example.org/dee/thesis.git' };

describe('GiteaClient', () => {
  it('makes a private, empty repository with the token only in its header and redirects off', async () => {
    const { gt, calls } = fake({ 'POST /user/repos': { status: 201, body: REPO } });
    expect(await gt.createPrivateProject('thesis')).toEqual({ path: 'dee/thesis', sshUrl: REPO.ssh_url, httpUrl: REPO.clone_url });
    expect(calls[0].url).toBe(`${API}/user/repos`);
    expect(JSON.parse(calls[0].body!)).toMatchObject({ name: 'thesis', private: true, auto_init: false });
    expect(calls[0].headers.Authorization).toBe('token gt-secret');
    expect(calls[0].headers['PRIVATE-TOKEN']).toBeUndefined();
    expect(calls[0].redirect).toBe('error');
    expect(calls[0].url).not.toContain('gt-secret');
  });

  it('calls a name you already use a 409 and explains other refusals', async () => {
    for (const [status, re] of [[409, /already have a repository/], [401, /access token/], [403, /Read and Write/], [422, /refused the request: bad name/]] as const) {
      const { gt } = fake({ 'POST /user/repos': { status, body: { message: 'bad name' } } });
      const err = await gt.createPrivateProject('thesis').catch((e) => e);
      expect(err).toBeInstanceOf(GiteaError);
      expect(err).toBeInstanceOf(ForgeError);
      expect(err.status).toBe(status);
      expect(err.message).toMatch(re);
    }
  });

  it('refuses a server that offers no ssh address', async () => {
    const { gt } = fake({ 'POST /user/repos': { status: 201, body: { ...REPO, ssh_url: '' } } });
    expect((await gt.createPrivateProject('thesis').catch((e) => e)).message).toMatch(/ssh/);
  });

  it('reads a repository with owner and name encoded one by one', async () => {
    const { gt, calls } = fake({ 'GET /repos/dee/thesis': { status: 200, body: REPO } });
    expect((await gt.getProject('dee/thesis')).sshUrl).toBe(REPO.ssh_url);
    expect(calls[0].url).toBe(`${API}/repos/dee/thesis`);
    for (const [status, body, re] of [[404, {}, /no repository/], [401, {}, /access token/], [200, { hello: 1 }, /Gitea or Forgejo/], [302, {}, /Gitea or Forgejo/]] as const) {
      const err = await fake({ 'GET /repos/dee/thesis': { status, body } }).gt.getProject('dee/thesis').catch((e) => e);
      expect(err).toBeInstanceOf(GiteaError);
      expect(err.message).toMatch(re);
    }
  });

  it('refuses a path that is not owner/name before calling the server', async () => {
    const { gt, calls } = fake({});
    for (const p of ['lab/papers/thesis', 'thesis', '/thesis']) {
      expect(await gt.getProject(p).catch((e) => e)).toBeInstanceOf(GiteaError);
    }
    expect(calls).toHaveLength(0);
  });

  it('adds a read-only deploy key whose title tells keys apart', async () => {
    const { gt, calls } = fake({ 'POST /repos/dee/thesis/keys': { status: 201, body: {} } });
    expect(await gt.addDeployKey('dee/thesis', 'Overtex co-author', KEY)).toBe('added');
    const body = JSON.parse(calls[0].body!);
    expect(body).toMatchObject({ key: KEY, read_only: true });
    expect(body.title).toMatch(/^Overtex co-author [0-9a-f]{8}$/);
  });

  it('reports a key the repository has already, and explains refusals', async () => {
    const taken = fake({
      'POST /repos/dee/thesis/keys': { status: 422, body: { message: 'key already exists' } },
      'GET /repos/dee/thesis/keys?limit=50': { status: 200, body: [{ key: `${KEY} someone@laptop` }] },
    });
    expect(await taken.gt.addDeployKey('dee/thesis', 'Overtex', KEY)).toBe('already');
    const other = fake({
      'POST /repos/dee/thesis/keys': { status: 422, body: {} },
      'GET /repos/dee/thesis/keys?limit=50': { status: 200, body: [] },
    });
    expect((await other.gt.addDeployKey('dee/thesis', 'Overtex', KEY).catch((e) => e)).message).toMatch(/new code/);
    for (const [status, re] of [[401, /access token/], [403, /admin/], [404, /no repository/]] as const) {
      const err = await fake({ 'POST /repos/dee/thesis/keys': { status } }).gt.addDeployKey('dee/thesis', 'Overtex', KEY).catch((e) => e);
      expect(err).toBeInstanceOf(GiteaError);
      expect(err.message).toMatch(re);
    }
  });

  it('says it could not reach the server when a redirect is refused', async () => {
    const gt = new GiteaClient('t', async () => { throw new TypeError('redirect mode is set to error'); }, API);
    expect((await gt.getProject('a/b').catch((e) => e)).status).toBe(0);
  });
});

describe('forge errors', () => {
  it('share one base class', () => {
    expect(new GitLabError(409, 'x')).toBeInstanceOf(ForgeError);
    expect(new GiteaError(409, 'x')).toBeInstanceOf(ForgeError);
  });
});

describe('Codeberg host key', () => {
  it('matches the fingerprint Codeberg documents', () => {
    const fp = createHash('sha256').update(Buffer.from(CODEBERG_HOST_KEY, 'base64')).digest('base64').replace(/=+$/, '');
    expect(`SHA256:${fp}`).toBe('SHA256:mIlxA9k46MmM6qdJOdMnAQpzGxF4WIVVL+fj+wZbw0g');
  });
});
