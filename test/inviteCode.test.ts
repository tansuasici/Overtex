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
  hostKeyFingerprint,
  isOurSshCommand,
  knownHosts,
  normalizeHostKey,
  normalizePublicKey,
  parseCode,
  parseHostedRemote,
  parseRemote,
  safeConfigPath,
  sameCopy,
  serverPath,
  sshCommand,
  sshConfig,
  validRepoPath,
  webOrigin,
  type Code,
} from '../src/inviteCode';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const ID = '0123456789abcdef';
// A throwaway ed25519 key standing in for a self-hosted server's ssh host key.
const HK = 'AAAAC3NzaC1lZDI1NTE5AAAAIIFgkwzRnszZU1AVKiUnTlzdOmYymkYRp9XWJfr0zia2';
const HK_FP = 'SHA256:5DKfg78FuawoA2x62WDFx4eCmQoE4TJ2BeCulr7XrR8';

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
    expect(() => parseCode(raw('overtex-invite', { v: 3 }))).toThrow(/newer Overtex/);
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

describe('codes for a Git server of your own (v2)', () => {
  const own = { host: 'git.uni-example.edu', port: 2222, path: 'lab/thesis', hostKey: HK };

  it('keeps v1 byte for byte for GitHub and GitLab, so older Overtex still reads them', () => {
    const text = encodeCode({ kind: 'invite', repo: { host: 'github.com', path: 'ada/thesis' }, key: KEY, id: ID });
    const body = Buffer.from(text.slice('overtex-invite:'.length), 'base64url').toString('utf8');
    expect(body).toBe(JSON.stringify({ v: 1, host: 'github.com', path: 'ada/thesis', key: KEY, id: ID }));
  });

  it('round-trips host, port, path and host key', () => {
    const code: Code = { kind: 'invite', repo: own, key: KEY, id: ID };
    const text = encodeCode(code);
    expect(JSON.parse(Buffer.from(text.slice('overtex-invite:'.length), 'base64url').toString()).v).toBe(2);
    expect(parseCode(text)).toEqual(code);
    const noPort = { kind: 'join' as const, repo: { host: 'gitlab.example.org', path: 'a/b/c', hostKey: HK }, key: KEY, id: ID };
    expect(parseCode(encodeCode(noPort))).toEqual(noPort);
  });

  it('will not make a v2 code without a host key', () => {
    expect(() => encodeCode({ kind: 'invite', repo: { host: 'git.example.org', path: 'a/b' }, key: KEY, id: ID })).toThrow(/host key/);
  });

  it('turns down a v2 code that names a built-in host, port 22, or anything odd', () => {
    const base = { v: 2, host: 'git.example.org', path: 'a/b', hk: HK, key: KEY, id: ID };
    expect(parseCode(raw('overtex-invite', base)).repo.host).toBe('git.example.org');
    const bad: Record<string, unknown>[] = [
      { host: 'github.com' },
      { host: 'gitlab.com' },
      { host: 'git.example.org\\n  ProxyCommand x' },
      { host: '-oProxyCommand=x' },
      { host: 'Git.Example.org' },
      { host: 'git.example.org port' },
      { host: '*' },
      { host: 'host%h' },
      { port: 22 },
      { port: 0 },
      { port: 70000 },
      { port: '2222' },
      { port: 22.5 },
      { hk: undefined },
      { hk: `${HK} extra` },
      { hk: `${HK}\\nevil.example ssh-ed25519 ${HK}` },
      { hk: 'AAAAB3NzaC1yc2EAAAADAQABAAABAQ' },
      { hk: KEY },
    ];
    for (const change of bad) {
      expect(() => parseCode(raw('overtex-invite', { ...base, ...change })), JSON.stringify(change)).toThrow(/damaged/);
    }
    // v1 never names another host.
    expect(() => parseCode(raw('overtex-invite', { v: 1, host: 'git.example.org', path: 'a/b', key: KEY, id: ID }))).toThrow(/damaged/);
  });

  it('checks host keys and shows their fingerprint like ssh does', () => {
    expect(normalizeHostKey(HK)).toBe(HK);
    expect(normalizeHostKey(`${HK}=`)).toBeUndefined();
    expect(hostKeyFingerprint(HK)).toBe(HK_FP);
  });

  it('compares copies by host, port and path', () => {
    expect(sameCopy({ host: 'h.example', path: 'A/b' }, { host: 'h.example', port: 22, path: 'a/B' })).toBe(true);
    expect(sameCopy({ host: 'h.example', port: 2222, path: 'a/b' }, { host: 'h.example', path: 'a/b' })).toBe(false);
    expect(sameCopy({ host: 'h.example', path: 'a/b' }, { host: 'i.example', path: 'a/b' })).toBe(false);
    expect(sameCopy({ host: 'h.example' }, { host: 'h.example', path: 'a/b' })).toBe(false);
  });
});

describe('remote and server addresses', () => {
  it('reads remotes on any host, with ports', () => {
    expect(parseRemote('git@git.example.org:lab/thesis.git')).toEqual({ host: 'git.example.org', path: 'lab/thesis', ssh: true });
    expect(parseRemote('ssh://git@git.example.org:2222/lab/thesis.git')).toEqual({ host: 'git.example.org', port: 2222, path: 'lab/thesis', ssh: true });
    expect(parseRemote('ssh://git@git.example.org:22/lab/thesis')).toEqual({ host: 'git.example.org', path: 'lab/thesis', ssh: true });
    expect(parseRemote('https://git.example.org:8443/lab/thesis.git')).toEqual({ host: 'git.example.org', port: 8443, path: 'lab/thesis', ssh: false });
    expect(parseRemote('https://git.example.org:443/lab/thesis')).toEqual({ host: 'git.example.org', path: 'lab/thesis', ssh: false });
    expect(parseRemote('ssh://git@git.example.org:99999/a/b')).toBeUndefined();
    expect(parseRemote('git@-oProxyCommand=x:a/b')).toBeUndefined();
    expect(parseRemote('/local/path')).toBeUndefined();
    // Only github.com and gitlab.com at their usual port count as built in.
    expect(parseHostedRemote('git@git.example.org:a/b.git')).toBeUndefined();
    expect(parseHostedRemote('ssh://git@gitlab.com:2222/a/b.git')).toBeUndefined();
  });

  it('keeps only plain https server addresses', () => {
    expect(webOrigin(' https://GitLab.Example.edu/ ')).toBe('https://gitlab.example.edu');
    expect(webOrigin('https://example.edu:8443/gitlab/')).toBe('https://example.edu:8443/gitlab');
    for (const bad of ['http://gitlab.example.edu', 'https://user:pw@gitlab.example.edu', 'https://gitlab.example.edu/?x=1', 'https://gitlab.example.edu/#a', 'https://', 'gitlab.example.edu', 'https://localhost', 'file:///etc']) {
      expect(webOrigin(bad), bad).toBeUndefined();
    }
  });

  it('strips the sub-path a server is served under from an https remote', () => {
    expect(serverPath('https://gitlab.example.edu', 'lab/thesis')).toBe('lab/thesis');
    expect(serverPath('https://example.edu/gitlab', 'gitlab/lab/thesis')).toBe('lab/thesis');
    expect(serverPath('https://example.edu/gitlab', 'other/lab/thesis')).toBeUndefined();
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

describe('project ssh config for a server of your own', () => {
  const entry = { id: ID, host: 'git.example.org', port: 2222, hostKey: HK };

  it('pins the code\'s host key under the remote\'s own alias, never under the host name', () => {
    const text = knownHosts([entry, { id: 'fedcba9876543210', host: 'gitlab.com' }]);
    expect(text.startsWith(KNOWN_HOSTS)).toBe(true);
    expect(text).toContain(`overtex-${ID} ssh-ed25519 ${HK}\n`);
    expect(text).toContain(`[overtex-${ID}]:2222 ssh-ed25519 ${HK}\n`);
    expect(text).not.toMatch(/^git\.example\.org /m);
    // An entry without a key, or a built-in host with a port, adds nothing.
    expect(knownHosts([{ id: ID, host: 'git.example.org' }, { id: ID, host: 'gitlab.com', port: 2222, hostKey: HK }])).toBe(KNOWN_HOSTS);
    const cfg = sshConfig('/p/.git/overtex', [{ id: ID, host: 'git.example.org' }]);
    expect(cfg).not.toContain('Host overtex-');
  });

  it('makes ssh reach the server at its port with only the project key and the pinned key (ssh -G)', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-own-')), 'overtex').replace(/\\/g, '/');
    try {
      fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'known_hosts'), knownHosts([entry]));
      fs.writeFileSync(path.join(dir, 'ssh_config'), sshConfig(dir, [entry]));
      const g = execFileSync('ssh', ['-G', '-F', path.join(dir, 'ssh_config'), `overtex-${ID}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(g).toMatch(/^hostname git\.example\.org$/m);
      expect(g).toMatch(/^port 2222$/m);
      expect(g).toMatch(new RegExp(`^hostkeyalias overtex-${ID}$`, 'm'));
      expect(g).toMatch(/^stricthostkeychecking (yes|true)$/m);
      expect(g.match(/^identityfile .*$/gm)).toEqual([`identityfile ${dir}/keys/${ID}`]);
      const found = execFileSync('ssh-keygen', ['-F', `[overtex-${ID}]:2222`, '-f', path.join(dir, 'known_hosts')], { encoding: 'utf8' });
      expect(found).toContain(HK);
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

describe('GitLabClient on a server of your own', () => {
  it('calls that server only, with redirects turned off, and reads a project\'s addresses', async () => {
    const calls: { url: string; redirect?: string; headers: Record<string, string> }[] = [];
    const fn = async (url: string, init: { method: string; headers: Record<string, string>; redirect?: 'error' }) => {
      calls.push({ url, redirect: init.redirect, headers: init.headers });
      return {
        status: 200,
        json: async () => ({ path_with_namespace: 'lab/thesis', ssh_url_to_repo: 'ssh://git@git.example.org:2222/lab/thesis.git', http_url_to_repo: 'https://git.example.org/lab/thesis.git' }),
      };
    };
    const gl = new GitLabClient('tok', fn, 'https://git.example.org/api/v4');
    expect(await gl.getProject('lab/thesis')).toEqual({ path: 'lab/thesis', sshUrl: 'ssh://git@git.example.org:2222/lab/thesis.git', httpUrl: 'https://git.example.org/lab/thesis.git' });
    expect(calls[0].url).toBe('https://git.example.org/api/v4/projects/lab%2Fthesis');
    expect(calls[0].redirect).toBe('error');
    expect(calls[0].headers['PRIVATE-TOKEN']).toBe('tok');
  });

  it('explains a missing project, a bad token and a server that is not GitLab', async () => {
    for (const [status, body, re] of [[404, {}, /no project/], [401, {}, /access token/], [200, { hello: 1 }, /answer like GitLab/], [302, {}, /answer like GitLab/]] as const) {
      const gl = new GitLabClient('t', async () => ({ status, json: async () => body }), 'https://git.example.org/api/v4');
      const err = await gl.getProject('a/b').catch((e) => e);
      expect(err).toBeInstanceOf(GitLabError);
      expect(err.message).toMatch(re);
    }
  });

  it('says it could not reach the server when a redirect is refused', async () => {
    const gl = new GitLabClient('t', async () => { throw new TypeError('redirect mode is set to error'); }, 'https://git.example.org/api/v4');
    expect((await gl.getProject('a/b').catch((e) => e)).status).toBe(0);
  });
});
