import { describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError, normalizeUsername, parseGitHubRemote, repoNameFor, validRepoName } from '../src/shared/github';

describe('parseGitHubRemote', () => {
  it('reads https, ssh and scp-style GitHub URLs', () => {
    expect(parseGitHubRemote('https://github.com/ada/thesis.git')).toEqual({ owner: 'ada', name: 'thesis' });
    expect(parseGitHubRemote('https://ada@github.com/ada/thesis')).toEqual({ owner: 'ada', name: 'thesis' });
    expect(parseGitHubRemote('git@github.com:ada/my.paper.git')).toEqual({ owner: 'ada', name: 'my.paper' });
    expect(parseGitHubRemote('ssh://git@github.com/ada/thesis.git')).toEqual({ owner: 'ada', name: 'thesis' });
  });

  it('ignores other hosts and look-alikes', () => {
    expect(parseGitHubRemote('https://gitlab.com/ada/thesis.git')).toBeUndefined();
    expect(parseGitHubRemote('https://github.com.evil.example/ada/thesis')).toBeUndefined();
    expect(parseGitHubRemote('/tmp/own.git')).toBeUndefined();
    expect(parseGitHubRemote(undefined)).toBeUndefined();
  });
});

describe('normalizeUsername', () => {
  it('drops a leading @ and spaces', () => {
    expect(normalizeUsername(' @octo-cat ')).toBe('octo-cat');
  });

  it('rejects what GitHub would not allow', () => {
    expect(normalizeUsername('-bad')).toBeUndefined();
    expect(normalizeUsername('two--dashes')).toBeUndefined();
    expect(normalizeUsername('has space')).toBeUndefined();
    expect(normalizeUsername('a@b.com')).toBeUndefined();
    expect(normalizeUsername('')).toBeUndefined();
  });
});

describe('repoNameFor', () => {
  it('makes a GitHub-safe name from the folder name', () => {
    expect(repoNameFor('Tez Çalışması 2026')).toBe('Tez-Calismasi-2026');
    expect(repoNameFor('..notes..')).toBe('notes');
    expect(repoNameFor('ğ')).toBe('g');
    expect(repoNameFor('***')).toBe('paper');
    expect(validRepoName(repoNameFor('Tez Çalışması'))).toBe(true);
    expect(validRepoName('has space')).toBe(false);
  });
});

function fakeFetch(responses: Record<string, { status: number; body?: unknown }>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, ...init });
    const r = responses[`${init.method} ${url.replace('https://api.github.com', '')}`] ?? { status: 500, body: { message: 'unexpected' } };
    return { status: r.status, json: async () => r.body };
  };
  return { fn, calls };
}

describe('GitHubClient', () => {
  it('sends the token only in the Authorization header to the API', async () => {
    const { fn, calls } = fakeFetch({ 'GET /user': { status: 200, body: { login: 'ada' } } });
    expect(await new GitHubClient('tok', fn).login()).toBe('ada');
    expect(calls[0].url).toBe('https://api.github.com/user');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect(calls[0].url).not.toContain('tok');
    expect(JSON.stringify(calls[0].headers)).not.toMatch(/@/);
  });

  it('creates a private repository', async () => {
    const { fn, calls } = fakeFetch({
      'POST /user/repos': {
        status: 201,
        body: { name: 'thesis', owner: { login: 'ada' }, html_url: 'https://github.com/ada/thesis', clone_url: 'https://github.com/ada/thesis.git' },
      },
    });
    const repo = await new GitHubClient('t', fn).createPrivateRepo('thesis');
    expect(repo).toEqual({ owner: 'ada', name: 'thesis', htmlUrl: 'https://github.com/ada/thesis', cloneUrl: 'https://github.com/ada/thesis.git' });
    expect(JSON.parse(calls[0].body!)).toMatchObject({ name: 'thesis', private: true });
  });

  it('says plainly when the name is taken', async () => {
    const { fn } = fakeFetch({ 'POST /user/repos': { status: 422, body: { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] } } });
    await expect(new GitHubClient('t', fn).createPrivateRepo('thesis')).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/already have/) });
  });

  it('invites with push access and knows existing collaborators', async () => {
    const { fn, calls } = fakeFetch({
      'PUT /repos/ada/thesis/collaborators/bob': { status: 201, body: {} },
      'PUT /repos/ada/thesis/collaborators/cy': { status: 204 },
    });
    const gh = new GitHubClient('t', fn);
    expect(await gh.invite({ owner: 'ada', name: 'thesis' }, 'bob')).toBe('invited');
    expect(await gh.invite({ owner: 'ada', name: 'thesis' }, 'cy')).toBe('already');
    expect(JSON.parse(calls[0].body!)).toEqual({ permission: 'push' });
  });

  it('explains refusals', async () => {
    const { fn } = fakeFetch({
      'PUT /repos/ada/thesis/collaborators/nobody': { status: 404, body: { message: 'Not Found' } },
      'PUT /repos/ada/thesis/collaborators/x': { status: 403, body: { message: 'Must have admin rights' } },
      'GET /user': { status: 401, body: { message: 'Bad credentials' } },
    });
    const gh = new GitHubClient('t0ken', fn);
    await expect(gh.invite({ owner: 'ada', name: 'thesis' }, 'nobody')).rejects.toThrow(/no user "nobody"/);
    await expect(gh.invite({ owner: 'ada', name: 'thesis' }, 'x')).rejects.toThrow(/Only the owner/);
    await expect(gh.login()).rejects.toBeInstanceOf(GitHubError);
    await expect(gh.login()).rejects.toThrow(/did not accept your sign-in/);
    const errors = await Promise.all([gh.invite({ owner: 'ada', name: 'thesis' }, 'nobody'), gh.login()].map((p) => p.catch((e: Error) => e.message)));
    expect(errors.join(' ')).not.toMatch(/Bearer|t0ken/);
  });

  it('says when GitHub cannot be reached, without the token', async () => {
    const gh = new GitHubClient('secret-token', async () => {
      throw new TypeError('fetch failed');
    });
    const err = await gh.login().catch((e: GitHubError) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).message).toMatch(/Could not reach GitHub/);
    expect((err as GitHubError).message).not.toContain('secret-token');
  });
});

describe('GitHubClient.addDeployKey', () => {
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

  it('adds a read-only key', async () => {
    const { fn, calls } = fakeFetch({ 'POST /repos/ada/thesis/keys': { status: 201, body: {} } });
    expect(await new GitHubClient('tok', fn).addDeployKey({ owner: 'ada', name: 'thesis' }, 'Overtex', key)).toBe('added');
    expect(JSON.parse(calls[0].body!)).toEqual({ title: 'Overtex', key, read_only: true });
  });

  it('reports a key the repository has already', async () => {
    const { fn } = fakeFetch({
      'POST /repos/ada/thesis/keys': { status: 422, body: { message: 'Validation Failed' } },
      'GET /repos/ada/thesis/keys?per_page=100': { status: 200, body: [{ key: `${key} overtex` }] },
    });
    expect(await new GitHubClient('tok', fn).addDeployKey({ owner: 'ada', name: 'thesis' }, 'Overtex', key)).toBe('already');
  });

  it('explains a key used on another repository, and a repository you do not own', async () => {
    const used = fakeFetch({
      'POST /repos/ada/thesis/keys': { status: 422, body: { message: 'Validation Failed' } },
      'GET /repos/ada/thesis/keys?per_page=100': { status: 200, body: [] },
    });
    await expect(new GitHubClient('tok', used.fn).addDeployKey({ owner: 'ada', name: 'thesis' }, 'Overtex', key)).rejects.toThrow(/new code/);
    const notOwner = fakeFetch({ 'POST /repos/ada/thesis/keys': { status: 404, body: { message: 'Not Found' } } });
    await expect(new GitHubClient('tok', notOwner.fn).addDeployKey({ owner: 'ada', name: 'thesis' }, 'Overtex', key)).rejects.toThrow(/only its owner/);
  });
});
