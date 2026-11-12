// Where a person keeps their Git projects online, GitHub or GitLab, guessed from what this computer
// already shows. Overtex then puts their copy of a project there without asking which one. Nothing goes
// over the network and no secret is read: only remote URLs, host names in Git and ssh config, and
// whether a GitLab token or a GitHub sign-in exists.
import { HOSTS, parseHostedRemote, type Host } from './inviteCode';

export interface HostEvidence {
  /** Remote URLs of this project's own remotes (not a co-author's read-only copy). */
  project: string[];
  /** Remote URLs of the other Git projects open in VS Code. */
  others: string[];
  /** Overtex already keeps a GitLab access token. */
  gitlabToken: boolean;
  /** Names (never values) of the global Git config entries, one per line. */
  gitConfigNames: string;
  /** The text of ~/.ssh/config, if there is one. */
  sshConfig: string;
  /** VS Code is already signed in to GitHub with repository access. */
  githubSession: boolean;
}

export interface HostGuess {
  /** undefined: nothing points either way, or both equally. */
  host: Host | undefined;
  /**
   * Reach the copy over ssh rather than https: what this person's other remotes for that host use.
   * undefined: nothing on this computer says.
   */
  ssh: boolean | undefined;
  /** Plain-language reason, for the confirmation. */
  why: string;
}

// A remote of this very project outweighs everything else; a GitHub sign-in in VS Code is the weakest
// sign, since VS Code users are often signed in to GitHub for other reasons.
const WEIGHT = { project: 20, other: 3, gitlabToken: 4, gitConfig: 2, sshConfig: 2, githubSession: 1 };

function hostIn(text: string, host: Host): boolean {
  return new RegExp(`(^|[^A-Za-z0-9.-])${host.replace(/\./g, '\\.')}([^A-Za-z0-9.-]|$)`, 'i').test(text);
}

/**
 * The host a Git config entry name is about: credential.<url>.helper, url.<base>.insteadOf and the like
 * carry a URL between the first and the last dot.
 */
function configHost(name: string): string | undefined {
  const first = name.indexOf('.');
  const last = name.lastIndexOf('.');
  if (first < 0 || last <= first) {
    return undefined;
  }
  const url = name.slice(first + 1, last);
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([^:/]+)/i.exec(url);
  return m?.[1].toLowerCase();
}

function isSsh(url: string): boolean {
  return /^(ssh:\/\/|git@)/.test(url.trim());
}

export function guessOwnHost(e: HostEvidence): HostGuess {
  const score: Record<Host, number> = { 'github.com': 0, 'gitlab.com': 0 };
  const reasons: Record<Host, string[]> = { 'github.com': [], 'gitlab.com': [] };
  const urls: Record<Host, string[]> = { 'github.com': [], 'gitlab.com': [] };

  for (const url of new Set(e.project)) {
    const r = parseHostedRemote(url);
    if (r) {
      score[r.host] += WEIGHT.project;
      urls[r.host].push(url);
      reasons[r.host].push('this project already has a copy there');
    }
  }
  const othersSeen: Record<Host, number> = { 'github.com': 0, 'gitlab.com': 0 };
  for (const url of new Set(e.others)) {
    const r = parseHostedRemote(url);
    if (r) {
      score[r.host] += WEIGHT.other;
      urls[r.host].push(url);
      othersSeen[r.host]++;
    }
  }
  for (const host of HOSTS) {
    if (othersSeen[host]) {
      reasons[host].push(`${othersSeen[host] === 1 ? 'another project' : 'other projects'} you have open use it`);
    }
  }
  if (e.gitlabToken) {
    score['gitlab.com'] += WEIGHT.gitlabToken;
    reasons['gitlab.com'].push('you gave Overtex a GitLab token');
  }
  const configLines = e.gitConfigNames.split(/\r?\n/);
  const sshLines = e.sshConfig.split(/\r?\n/).filter((l) => /^\s*(host|hostname)\b/i.test(l));
  for (const host of HOSTS) {
    if (configLines.some((l) => configHost(l.trim()) === host)) {
      score[host] += WEIGHT.gitConfig;
      reasons[host].push('your Git settings name it');
    }
    if (sshLines.some((l) => hostIn(l, host))) {
      score[host] += WEIGHT.sshConfig;
      reasons[host].push('your ssh settings name it');
    }
  }
  if (e.githubSession) {
    score['github.com'] += WEIGHT.githubSession;
    reasons['github.com'].push('VS Code is signed in to GitHub');
  }

  const [a, b] = HOSTS;
  const host = score[a] === score[b] ? undefined : score[a] > score[b] ? a : b;
  if (!host) {
    return { host: undefined, ssh: undefined, why: '' };
  }
  const ssh = urls[host].filter(isSsh).length;
  const https = urls[host].length - ssh;
  const sshNamed = sshLines.some((l) => hostIn(l, host));
  const way = ssh || https ? ssh > https : sshNamed ? true : undefined;
  return { host, ssh: way, why: reasons[host][0] ?? '' };
}
