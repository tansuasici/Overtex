// Invite codes for co-authors who keep their own copy on GitHub, GitLab or their own Git server. Each
// side gives the other read-only access with a deploy key, so nobody needs the other's account. A code
// carries only a repository address, the server's ssh host key when it is not a well-known one, and a
// public key; it is pasted by a person, so everything in it is checked before it reaches a git remote
// URL, an ssh config file or a known_hosts file. No vscode import: unit tested. Node only (Buffer), so
// it is not in src/shared, which the webview also compiles.
import { createHash } from 'crypto';

/** Hosts whose ssh host keys Overtex ships (KNOWN_HOSTS): their codes need no host key. */
export const HOSTS = ['github.com', 'gitlab.com'] as const;
export type BuiltinHost = (typeof HOSTS)[number];
/** A host name in lower case: a built-in one, or the ssh address of someone's own Git server. */
export type Host = string;

export interface HostedRepo {
  /** The host git reaches the copy at over ssh (for a built-in host, also its web address). */
  host: Host;
  /** The ssh port, when it is not 22. */
  port?: number;
  /** owner/name on GitHub; group/(subgroup/)name on GitLab and others. */
  path: string;
  /** The server's ed25519 host key (base64, as in known_hosts); needed for a host that is not built in. */
  hostKey?: string;
}

/**
 * invite: "give my key read access to your copy, here is where mine is" (from the person inviting).
 * join: the answer, with the joiner's copy and key, and the id of the invite it answers.
 */
export interface Code {
  kind: 'invite' | 'join';
  repo: HostedRepo;
  /** `ssh-ed25519 <base64>`, no comment. */
  key: string;
  /** The inviter's key id: names the invite on both sides. */
  id: string;
}

const PREFIX = { invite: 'overtex-invite:', join: 'overtex-join:' } as const;

/** The pushurl of a co-author remote: Share Changes never sends there (git cannot even try). */
export const READ_ONLY_PUSH_URL = 'overtex-read-only://do-not-push';

/** GitHub's and GitLab's published ed25519 host keys (checked against their SHA256 fingerprints). */
export const KNOWN_HOSTS = [
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  'gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf',
].join('\n') + '\n';

const SEGMENT = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_])?$/;

export function isBuiltinHost(host: unknown): host is BuiltinHost {
  return (HOSTS as readonly unknown[]).includes(host);
}

/**
 * A host name ssh and git may be given: lower-case letters, digits, dots and dashes in DNS labels, with
 * a letter in the last label (or a plain IPv4 address). Nothing ssh could read as an option, a pattern,
 * a token (%) or the end of a line.
 */
export function validHostname(host: unknown): host is Host {
  if (typeof host !== 'string' || host.length > 253) {
    return false;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((n) => Number(n) <= 255);
  }
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
}

export function validPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function validRepoPath(host: string, path: string): boolean {
  if (!validHostname(host) || path.length > 255) {
    return false;
  }
  const parts = path.split('/');
  if (host === 'github.com' && parts.length !== 2) {
    return false;
  }
  return parts.length >= 2 && parts.every((p) => SEGMENT.test(p) && !p.includes('..') && !p.endsWith('.git'));
}

/** Where a remote URL points, on any host. `ssh` says whether `port` is an ssh port or a web one. */
export interface RemoteAddress {
  host: Host;
  port?: number;
  path: string;
  ssh: boolean;
}

/** A remote URL (https, ssh:// or scp-style user@host:path) read as host, port and path, else undefined. */
export function parseRemote(url: string | undefined): RemoteAddress | undefined {
  if (!url) {
    return undefined;
  }
  const text = url.trim();
  let m = /^(https?|ssh):\/\/(?:[^@/]+@)?([^/:@]+)(?::(\d{1,5}))?\/(.+?)(?:\.git)?\/?$/i.exec(text);
  let host: string;
  let port: number | undefined;
  let repoPath: string;
  let ssh: boolean;
  if (m) {
    ssh = m[1].toLowerCase() === 'ssh';
    host = m[2].toLowerCase();
    repoPath = m[4];
    if (m[3]) {
      const given = Number(m[3]);
      if (!validPort(given)) {
        return undefined;
      }
      const standard = ssh ? 22 : m[1].toLowerCase() === 'https' ? 443 : 80;
      port = given === standard ? undefined : given;
    }
  } else {
    m = /^[A-Za-z0-9._-]+@([^/:@]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(text);
    if (!m) {
      return undefined;
    }
    ssh = true;
    host = m[1].toLowerCase();
    repoPath = m[2];
  }
  if (!validRepoPath(host, repoPath)) {
    return undefined;
  }
  return { host, ...(port ? { port } : {}), path: repoPath, ssh };
}

/** The GitHub or GitLab (gitlab.com) repository of a remote URL (https, ssh or scp-style), else undefined. */
export function parseHostedRemote(url: string | undefined): HostedRepo | undefined {
  const r = parseRemote(url);
  if (!r || !isBuiltinHost(r.host) || r.port) {
    return undefined;
  }
  return { host: r.host, path: r.path };
}

export function validKeyId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{16}$/.test(id);
}

/** A public ed25519 key in OpenSSH form, comment dropped; undefined if it is anything else. */
export function normalizePublicKey(text: unknown): string | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }
  const m = /^ssh-ed25519 ([A-Za-z0-9+/]{68})(?: [^\r\n]*)?\r?\n?$/.exec(text.trim());
  if (!m) {
    return undefined;
  }
  const blob = Buffer.from(m[1], 'base64');
  const type = 'ssh-ed25519';
  const ok =
    blob.length === 4 + type.length + 4 + 32 &&
    blob.readUInt32BE(0) === type.length &&
    blob.toString('latin1', 4, 4 + type.length) === type &&
    blob.readUInt32BE(4 + type.length) === 32 &&
    blob.toString('base64') === m[1];
  return ok ? `ssh-ed25519 ${m[1]}` : undefined;
}

/** A server's web address as Overtex keeps it (https, no credentials, query or trailing slash), else undefined. */
export function webOrigin(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  const sub = url.pathname.replace(/\/+$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !validHostname(url.hostname) || !/^(?:\/[A-Za-z0-9._~-]+)*$/.test(sub)) {
    return undefined;
  }
  return `${url.origin}${sub}`;
}

/** A project path in an https address, without the sub-path a server is served under (if any). */
export function serverPath(web: string, urlPath: string): string | undefined {
  const sub = new URL(web).pathname.replace(/^\/+|\/+$/g, '');
  if (!sub) {
    return urlPath;
  }
  return urlPath.toLowerCase().startsWith(`${sub.toLowerCase()}/`) ? urlPath.slice(sub.length + 1) : undefined;
}

/** An ed25519 host key's base64 blob, checked and re-encoded; undefined if it is anything else. */
export function normalizeHostKey(blob: unknown): string | undefined {
  // The blob alone: no comment or anything else after it.
  return typeof blob === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(blob) ? normalizePublicKey(`ssh-ed25519 ${blob}`)?.slice('ssh-ed25519 '.length) : undefined;
}

/** The SHA256 fingerprint ssh shows for a host key blob (`SHA256:…`). */
export function hostKeyFingerprint(blob: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

/** A copy on a built-in host at the standard port: its address needs no host key. */
function builtinCopy(repo: HostedRepo): boolean {
  return isBuiltinHost(repo.host) && !repo.port;
}

export function encodeCode(code: Code): string {
  const r = code.repo;
  let data: Record<string, unknown>;
  if (builtinCopy(r)) {
    data = { v: 1, host: r.host, path: r.path, key: code.key, id: code.id };
  } else {
    const hostKey = normalizeHostKey(r.hostKey);
    if (!hostKey || !validRepoPath(r.host, r.path) || (r.port !== undefined && !validPort(r.port))) {
      throw new Error(`Overtex has no host key for ${r.host}.`);
    }
    // v2: a code older Overtex versions turn down with "update Overtex", rather than misread.
    data = { v: 2, host: r.host, ...(r.port && r.port !== 22 ? { port: r.port } : {}), path: r.path, hk: hostKey, key: code.key, id: code.id };
  }
  return PREFIX[code.kind] + Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
}

/** Reads a pasted code; spaces and line breaks a mail program added are ignored. Throws a message. */
export function parseCode(text: string): Code {
  const compact = text.replace(/\s+/g, '');
  const kind = compact.startsWith(PREFIX.invite) ? 'invite' : compact.startsWith(PREFIX.join) ? 'join' : undefined;
  if (!kind) {
    throw new Error('That is not an Overtex invite code. It starts with "overtex-invite:" or "overtex-join:".');
  }
  const body = compact.slice(PREFIX[kind].length);
  let data: any;
  try {
    if (!/^[A-Za-z0-9_-]{1,2000}$/.test(body)) {
      throw new Error();
    }
    data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new Error('The code is incomplete. Copy the whole code again.');
  }
  if (data?.v !== 1 && data?.v !== 2) {
    throw new Error('The code comes from a newer Overtex. Update Overtex and try again.');
  }
  const damaged = new Error('The code is damaged. Ask for a new one.');
  const key = normalizePublicKey(data.key);
  if (typeof data.host !== 'string' || typeof data.path !== 'string' || !validRepoPath(data.host, data.path) || !key || !validKeyId(data.id)) {
    throw damaged;
  }
  if (data.v === 1) {
    if (!isBuiltinHost(data.host)) {
      throw damaged;
    }
    return { kind, repo: { host: data.host, path: data.path }, key, id: data.id };
  }
  // A code may never bring its own key for a host Overtex pins itself.
  const hostKey = normalizeHostKey(data.hk);
  if (isBuiltinHost(data.host) || !hostKey || (data.port !== undefined && (!validPort(data.port) || data.port === 22))) {
    throw damaged;
  }
  return { kind, repo: { host: data.host, ...(data.port ? { port: data.port } : {}), path: data.path, hostKey }, key, id: data.id };
}

/** Whether two copies are the same: same host, port and path (paths in any case). */
export function sameCopy(a: { host?: string; port?: number; path?: string }, b: { host?: string; port?: number; path?: string }): boolean {
  return a.host === b.host && (a.port ?? 22) === (b.port ?? 22) && !!a.path && a.path.toLowerCase() === b.path?.toLowerCase();
}

/** The ssh host name a co-author remote uses, so that only it uses the project key. */
export function sshAlias(id: string): string {
  return `overtex-${id}`;
}

export function coauthorUrl(repo: HostedRepo, id: string): string {
  return `git@${sshAlias(id)}:${repo.path}.git`;
}

/** A remote name for a co-author's copy that is not taken yet. */
export function coauthorRemoteName(repo: HostedRepo, taken: string[]): string {
  const owner = repo.path.split('/')[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const base = owner ? `coauthor-${owner}` : 'coauthor';
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!taken.includes(name)) {
      return name;
    }
  }
}

/** Every path written into the ssh config: no quote, newline or other character ssh would read as syntax. */
export function safeConfigPath(p: string): boolean {
  return !/["\r\n\t\0`$\\%]/.test(p);
}

export interface AliasEntry {
  id: string;
  host: Host;
  port?: number;
  hostKey?: string;
}

/** An entry that may go into the ssh config: a built-in host, or another one with its host key. */
function usable(e: AliasEntry): boolean {
  if (!validKeyId(e.id) || !validHostname(e.host) || (e.port !== undefined && !validPort(e.port))) {
    return false;
  }
  return isBuiltinHost(e.host) && !e.port ? true : !isBuiltinHost(e.host) && !!normalizeHostKey(e.hostKey);
}

/**
 * The project's own ssh config: one block per co-author remote with only its project key and the
 * pinned host key, then everything else exactly as without Overtex (the person's own ssh config).
 * `dir` is the folder with `keys/` and `known_hosts`, with forward slashes.
 */
export function sshConfig(dir: string, entries: AliasEntry[]): string {
  if (!safeConfigPath(dir)) {
    throw new Error('The project folder has a character ssh cannot read in its path.');
  }
  const blocks = entries.filter(usable).map((e) =>
    [
      `Host ${sshAlias(e.id)}`,
      `  HostName ${e.host}`,
      ...(e.port && e.port !== 22 ? [`  Port ${e.port}`] : []),
      '  User git',
      `  IdentityFile "${dir}/keys/${e.id}"`,
      '  IdentitiesOnly yes',
      // A built-in host's key is the one Overtex ships; any other host's key is the one its code brought,
      // kept under the remote's own name so that no code can stand in for another host's key.
      `  HostKeyAlias ${isBuiltinHost(e.host) ? e.host : sshAlias(e.id)}`,
      `  UserKnownHostsFile "${dir}/known_hosts"`,
      '  StrictHostKeyChecking yes',
      '  HostKeyAlgorithms ssh-ed25519',
      '',
    ].join('\n')
  );
  return [
    '# Written by Overtex for co-author copies. Changes here are overwritten.',
    '',
    ...blocks,
    'Host * !overtex-*',
    '  Include ~/.ssh/config',
    '  Include /etc/ssh/ssh_config',
    '',
  ].join('\n');
}

/** The project's known_hosts: the built-in keys, then each other co-author host's key under its alias. */
export function knownHosts(entries: AliasEntry[]): string {
  const lines = entries
    .filter((e) => usable(e) && !isBuiltinHost(e.host))
    .flatMap((e) => {
      const key = `ssh-ed25519 ${normalizeHostKey(e.hostKey)}`;
      const alias = sshAlias(e.id);
      // ssh looks an alias up as given; the [alias]:port form covers an ssh that adds the port anyway.
      return e.port && e.port !== 22 ? [`${alias} ${key}`, `[${alias}]:${e.port} ${key}`] : [`${alias} ${key}`];
    });
  return KNOWN_HOSTS + lines.map((l) => `${l}\n`).join('');
}

/** The value of core.sshCommand that makes git use the project's ssh config. */
export function sshCommand(configFile: string): string {
  return `ssh -F "${configFile}"`;
}

/** Whether an existing core.sshCommand was set by Overtex (so it may be replaced). */
export function isOurSshCommand(value: string | undefined): boolean {
  return !value || /^ssh -F "[^"]*\/overtex\/ssh_config"$/.test(value.trim());
}
