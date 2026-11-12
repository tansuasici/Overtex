// Invite codes for co-authors who keep their own copy on GitHub or GitLab. Each side gives the other
// read-only access with a deploy key, so nobody needs the other's account. A code carries only a
// repository address and a public key; it is pasted by a person, so everything in it is checked
// before it reaches a git remote URL or an ssh config file. No vscode import: unit tested.

export const HOSTS = ['github.com', 'gitlab.com'] as const;
export type Host = (typeof HOSTS)[number];

export interface HostedRepo {
  host: Host;
  /** owner/name on GitHub; group/(subgroup/)name on GitLab. */
  path: string;
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

export function validRepoPath(host: string, path: string): host is Host {
  if (!(HOSTS as readonly string[]).includes(host) || path.length > 255) {
    return false;
  }
  const parts = path.split('/');
  if (host === 'github.com' && parts.length !== 2) {
    return false;
  }
  return parts.length >= 2 && parts.every((p) => SEGMENT.test(p) && !p.includes('..') && !p.endsWith('.git'));
}

/** The GitHub or GitLab repository of a remote URL (https, ssh or scp-style), else undefined. */
export function parseHostedRemote(url: string | undefined): HostedRepo | undefined {
  if (!url) {
    return undefined;
  }
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)(github\.com|gitlab\.com)[/:](.+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m || !validRepoPath(m[1], m[2])) {
    return undefined;
  }
  return { host: m[1] as Host, path: m[2] };
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
    blob.readUInt32BE(4 + type.length) === 32;
  return ok ? `ssh-ed25519 ${m[1]}` : undefined;
}

export function encodeCode(code: Code): string {
  const json = JSON.stringify({ v: 1, host: code.repo.host, path: code.repo.path, key: code.key, id: code.id });
  return PREFIX[code.kind] + Buffer.from(json, 'utf8').toString('base64url');
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
  if (data?.v !== 1) {
    throw new Error('The code comes from a newer Overtex. Update Overtex and try again.');
  }
  const key = normalizePublicKey(data.key);
  if (typeof data.host !== 'string' || typeof data.path !== 'string' || !validRepoPath(data.host, data.path) || !key || !validKeyId(data.id)) {
    throw new Error('The code is damaged. Ask for a new one.');
  }
  return { kind, repo: { host: data.host, path: data.path }, key, id: data.id };
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
  const blocks = entries
    .filter((e) => validKeyId(e.id) && (HOSTS as readonly string[]).includes(e.host))
    .map((e) =>
      [
        `Host ${sshAlias(e.id)}`,
        `  HostName ${e.host}`,
        '  User git',
        `  IdentityFile "${dir}/keys/${e.id}"`,
        '  IdentitiesOnly yes',
        `  HostKeyAlias ${e.host}`,
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

/** The value of core.sshCommand that makes git use the project's ssh config. */
export function sshCommand(configFile: string): string {
  return `ssh -F "${configFile}"`;
}

/** Whether an existing core.sshCommand was set by Overtex (so it may be replaced). */
export function isOurSshCommand(value: string | undefined): boolean {
  return !value || /^ssh -F "[^"]*\/overtex\/ssh_config"$/.test(value.trim());
}
