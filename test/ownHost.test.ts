import { describe, expect, it } from 'vitest';
import { guessOwnHost, type HostEvidence } from '../src/ownHost';
import { GitLabClient, GitLabError, validProjectName } from '../src/shared/gitlab';

const none: HostEvidence = { project: [], others: [], gitlabToken: false, gitConfigNames: '', sshConfig: '', githubSession: false };
const guess = (e: Partial<HostEvidence>) => guessOwnHost({ ...none, ...e });

describe('guessOwnHost', () => {
  it('cannot tell with nothing to go on, or with equal signs', () => {
    expect(guess({}).host).toBeUndefined();
    expect(guess({ others: ['https://github.com/a/b.git', 'git@gitlab.com:a/c.git'] }).host).toBeUndefined();
  });

  it('follows the remotes of your other projects, over ssh if they use ssh', () => {
    expect(guess({ others: ['git@gitlab.com:bo/thesis.git'] })).toMatchObject({ host: 'gitlab.com', ssh: true });
    expect(guess({ others: ['https://gitlab.com/bo/thesis.git'] })).toMatchObject({ host: 'gitlab.com', ssh: false });
    expect(guess({ gitlabToken: true })).toMatchObject({ host: 'gitlab.com', ssh: undefined });
    expect(guess({ others: ['https://github.com/bo/a.git', 'https://github.com/bo/b.git', 'git@gitlab.com:bo/c.git'] }).host).toBe('github.com');
  });

  it('a GitHub sign-in in VS Code does not outweigh GitLab evidence', () => {
    expect(guess({ githubSession: true }).host).toBe('github.com');
    expect(guess({ githubSession: true, gitlabToken: true }).host).toBe('gitlab.com');
    expect(guess({ githubSession: true, others: ['git@gitlab.com:bo/c.git'] }).host).toBe('gitlab.com');
    expect(guess({ githubSession: true, gitConfigNames: 'url.git@gitlab.com:.insteadof' }).host).toBe('gitlab.com');
  });

  it("this project's own remote outweighs a few other signs", () => {
    expect(
      guess({ project: ['https://github.com/bo/paper.git'], others: ['git@gitlab.com:bo/a.git', 'git@gitlab.com:bo/b.git'], gitlabToken: true }).host
    ).toBe('github.com');
  });

  it('reads host names in Git and ssh settings, not look-alikes', () => {
    expect(guess({ gitConfigNames: 'user.name\ncredential.https://github.com.helper' }).host).toBe('github.com');
    expect(guess({ gitConfigNames: 'credential.https://notgithub.com.helper\nurl.https://github.com.evil.example/.insteadof' }).host).toBeUndefined();
    expect(guess({ sshConfig: 'Host work\n  HostName gitlab.com\n  IdentityFile ~/.ssh/work' })).toMatchObject({ host: 'gitlab.com', ssh: true });
    expect(guess({ sshConfig: '# github.com is mentioned only in a comment\nHost *\n  ServerAliveInterval 30' }).host).toBeUndefined();
  });

  it('ignores remotes that are not on GitHub or GitLab, and says why it chose', () => {
    expect(guess({ others: ['https://git.overleaf.com/abc', 'git@overtex-0123456789abcdef:ada/paper.git'] }).host).toBeUndefined();
    expect(guess({ gitlabToken: true }).why).toBe('you gave Overtex a GitLab token');
  });
});

describe('GitLabClient.createPrivateProject', () => {
  function fake(status: number, body: unknown) {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const fn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, ...init });
      return { status, json: async () => body };
    };
    return { fn, calls };
  }

  it('makes a private project without a README, with the token only in its header', async () => {
    const { fn, calls } = fake(201, {
      path_with_namespace: 'bo/paper',
      ssh_url_to_repo: 'git@gitlab.com:bo/paper.git',
      http_url_to_repo: 'https://gitlab.com/bo/paper.git',
    });
    expect(await new GitLabClient('glpat-secret', fn).createPrivateProject('paper')).toEqual({
      path: 'bo/paper',
      sshUrl: 'git@gitlab.com:bo/paper.git',
      httpUrl: 'https://gitlab.com/bo/paper.git',
    });
    expect(calls).toHaveLength(1);
    expect(`${calls[0].method} ${calls[0].url}`).toBe('POST https://gitlab.com/api/v4/projects');
    expect(JSON.parse(calls[0].body!)).toMatchObject({ name: 'paper', path: 'paper', visibility: 'private', initialize_with_readme: false });
    expect(calls[0].headers['PRIVATE-TOKEN']).toBe('glpat-secret');
    expect(calls[0].url + calls[0].body).not.toContain('glpat-secret');
  });

  it('turns a taken name into 409, and keeps other failures plain', async () => {
    const taken = await new GitLabClient('t', fake(400, { message: { name: ['has already been taken'], path: ['has already been taken'] } }).fn)
      .createPrivateProject('paper')
      .catch((e) => e);
    expect(taken).toBeInstanceOf(GitLabError);
    expect(taken.status).toBe(409);
    expect(taken.message).toContain('"paper"');
    expect((await new GitLabClient('t', fake(401, {}).fn).createPrivateProject('p').catch((e) => e)).status).toBe(401);
    expect((await new GitLabClient('t', fake(403, {}).fn).createPrivateProject('p').catch((e) => e)).message).toContain('"api" scope');
    expect((await new GitLabClient('t', fake(201, { path_with_namespace: 'bo/p' }).fn).createPrivateProject('p').catch((e) => e)).message).toContain(
      'did not say where'
    );
  });

  it('accepts only names GitLab takes as a path', () => {
    for (const ok of ['paper', 'Tez-Calismasi', 'thesis.v2', 'a']) {
      expect(validProjectName(ok)).toBe(true);
    }
    for (const bad of ['', '-paper', 'paper-', 'paper.git', 'a..b', 'a b', 'ç']) {
      expect(validProjectName(bad)).toBe(false);
    }
  });
});
