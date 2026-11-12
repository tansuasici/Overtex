import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { GitLabClient, GitLabError } from '../src/shared/gitlab';
import { startingRef } from '../src/shared/gitSync';
import {
  KNOWN_HOSTS,
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
  validRepoPath,
  type Code,
} from '../src/inviteCode';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const ID = '0123456789abcdef';

function raw(kind: string, data: unknown): string {
  return `${kind}:${Buffer.from(JSON.stringify(data)).toString('base64url')}`;
}

describe('invite codes', () => {
  it('round-trips, ignoring line breaks a mail program added', () => {
    const code: Code = { kind: 'invite', repo: { host: 'gitlab.com', path: 'lab/papers/thesis' }, key: KEY, id: ID };
    const text = encodeCode(code);
    expect(text.startsWith('overtex-invite:')).toBe(true);
    expect(parseCode(`  ${text.slice(0, 20)}\n  ${text.slice(20)} `)).toEqual(code);
    expect(parseCode(encodeCode({ ...code, kind: 'join' })).kind).toBe('join');
  });

  it('rejects other text, cut-off codes and newer versions in plain words', () => {
    expect(() => parseCode('hello')).toThrow(/not an Overtex invite code/);
    expect(() => parseCode('overtex-invite:abc')).toThrow(/incomplete/);
    expect(() => parseCode(raw('overtex-invite', { v: 2 }))).toThrow(/newer Overtex/);
  });

  it('rejects anything that could reach a remote URL or the ssh config', () => {
    const ok = { v: 1, host: 'github.com', path: 'ada/thesis', key: KEY, id: ID };
    for (const bad of [
      { ...ok, host: 'evil.example' },
      { ...ok, host: 'github.com\nHost *' },
      { ...ok, path: 'ada/thesis\n  ProxyCommand x' },
      { ...ok, path: 'ada/../x' },
      { ...ok, path: 'ada' },
      { ...ok, path: 'a/b/c' },
      { ...ok, path: '-oProxyCommand=x/y' },
      { ...ok, key: `${KEY}\nHost *` },
      { ...ok, key: 'ssh-rsa AAAA' },
      { ...ok, id: '../../etc' },
      { ...ok, id: ID.toUpperCase() },
    ]) {
      expect(() => parseCode(raw('overtex-invite', bad))).toThrow(/damaged/);
    }
  });

  it('checks repository paths per host', () => {
    expect(validRepoPath('github.com', 'ada/my.paper')).toBe(true);
    expect(validRepoPath('gitlab.com', 'group/sub/paper')).toBe(true);
    expect(validRepoPath('github.com', 'group/sub/paper')).toBe(false);
    expect(validRepoPath('github.com', 'ada/paper.git')).toBe(false);
    expect(validRepoPath('github.com', 'ada/.hidden')).toBe(false);
  });

  it('reads GitHub and GitLab remotes only', () => {
    expect(parseHostedRemote('https://gitlab.com/lab/papers/thesis.git')).toEqual({ host: 'gitlab.com', path: 'lab/papers/thesis' });
    expect(parseHostedRemote('git@github.com:ada/thesis.git')).toEqual({ host: 'github.com', path: 'ada/thesis' });
    expect(parseHostedRemote('https://github.com.evil.example/ada/thesis')).toBeUndefined();
    expect(parseHostedRemote(`git@overtex-${ID}:ada/thesis.git`)).toBeUndefined();
  });

  it('keeps a public ed25519 key without its comment', () => {
    expect(normalizePublicKey(`${KEY} someone@laptop\n`)).toBe(KEY);
    expect(normalizePublicKey(KEY.replace('AAAAC3', 'AAAAB3'))).toBeUndefined();
    expect(normalizePublicKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toBeUndefined();
  });

  it('names co-author remotes after the owner, without clashes', () => {
    const repo = { host: 'github.com' as const, path: 'Ada.L/thesis' };
    expect(coauthorRemoteName(repo, ['origin'])).toBe('coauthor-ada-l');
    expect(coauthorRemoteName(repo, ['coauthor-ada-l'])).toBe('coauthor-ada-l-2');
    expect(coauthorUrl(repo, ID)).toBe(`git@overtex-${ID}:Ada.L/thesis.git`);
  });
});

describe('project ssh config', () => {
  it('gives each co-author remote only its key and the pinned host key, and leaves other hosts alone', () => {
    const text = sshConfig('/p/.git/overtex', [{ id: ID, host: 'gitlab.com' }]);
    expect(text).toContain(`Host overtex-${ID}\n  HostName gitlab.com\n`);
    expect(text).toContain(`IdentityFile "/p/.git/overtex/keys/${ID}"`);
    expect(text).toContain('IdentitiesOnly yes');
    expect(text).toContain('StrictHostKeyChecking yes');
    expect(text).toContain('Host * !overtex-*\n  Include ~/.ssh/config');
    expect(() => sshConfig('/p"/x', [])).toThrow();
    expect(safeConfigPath('/Users/ada/Tez Çalışması/.git/overtex')).toBe(true);
    expect(safeConfigPath('C:\\x')).toBe(false);
  });

  it('only replaces an ssh command it set itself', () => {
    expect(isOurSshCommand(undefined)).toBe(true);
    expect(isOurSshCommand(sshCommand('/p/.git/overtex/ssh_config'))).toBe(true);
    expect(isOurSshCommand('ssh -i ~/.ssh/work')).toBe(false);
  });

  it('pins the published host keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-kh-'));
    try {
      fs.writeFileSync(path.join(dir, 'known_hosts'), KNOWN_HOSTS);
      const out = execFileSync('ssh-keygen', ['-lf', path.join(dir, 'known_hosts')], { encoding: 'utf8' });
      expect(out).toContain('SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU');
      expect(out).toContain('SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes ssh use only the project key for the alias (ssh -G)', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'overtex ı-')), 'overtex').replace(/\\/g, '/');
    try {
      fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'ssh_config'), sshConfig(dir, [{ id: ID, host: 'github.com' }]));
      const g = execFileSync('ssh', ['-G', '-F', path.join(dir, 'ssh_config'), `overtex-${ID}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(g).toMatch(/^hostname github\.com$/m);
      expect(g).toMatch(/^identitiesonly yes$/m);
      expect(g.match(/^identityfile .*$/gm)).toEqual([`identityfile ${dir}/keys/${ID}`]);
    } finally {
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });
});

describe('startingRef', () => {
  it('starts an empty project from the first copy that has the branch, else main or master', () => {
    expect(startingRef(['origin/main', 'coauthor-ada/main'], ['origin', 'coauthor-ada'], 'main')).toEqual({ ref: 'origin/main', branch: 'main' });
    expect(startingRef(['coauthor-ada/master'], ['origin', 'coauthor-ada'], 'main')).toEqual({ ref: 'coauthor-ada/master', branch: 'master' });
    expect(startingRef([], ['origin'], 'main')).toBeUndefined();
  });
});

describe('GitLabClient.addDeployKey', () => {
  function fake(responses: Record<string, { status: number; body?: unknown }>) {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const fn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, ...init });
      const r = responses[`${init.method} ${url.replace('https://gitlab.com/api/v4', '')}`] ?? { status: 500, body: { message: 'unexpected' } };
      return { status: r.status, json: async () => r.body };
    };
    return { fn, calls };
  }
  const base = '/projects/lab%2Fpapers%2Fthesis/deploy_keys';

  it('adds a key that cannot push, with the token only in its header', async () => {
    const { fn, calls } = fake({ [`POST ${base}`]: { status: 201, body: {} } });
    expect(await new GitLabClient('glpat-secret', fn).addDeployKey('lab/papers/thesis', 'Overtex', KEY)).toBe('added');
    expect(JSON.parse(calls[0].body!)).toEqual({ title: 'Overtex', key: KEY, can_push: false });
    expect(calls[0].headers['PRIVATE-TOKEN']).toBe('glpat-secret');
    expect(calls[0].url).not.toContain('glpat');
  });

  it('reports a key the project has already, and explains refusals', async () => {
    const taken = fake({
      [`POST ${base}`]: { status: 400, body: { message: { 'deploy_key.fingerprint': ['has already been taken'] } } },
      [`GET ${base}?per_page=100`]: { status: 200, body: [{ key: KEY }] },
    });
    expect(await new GitLabClient('t', taken.fn).addDeployKey('lab/papers/thesis', 'Overtex', KEY)).toBe('already');
    for (const [status, re] of [[401, /access token/], [403, /maintainer/], [404, /no project/]] as const) {
      const { fn } = fake({ [`POST ${base}`]: { status } });
      const err = await new GitLabClient('t', fn).addDeployKey('lab/papers/thesis', 'Overtex', KEY).catch((e) => e);
      expect(err).toBeInstanceOf(GitLabError);
      expect(err.message).toMatch(re);
    }
  });
});
