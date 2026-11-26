import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { cloneFolderName, projectsFolder, shouldCheck } from '../src/joinProject';
import { GitLabClient, GitLabError } from '../src/shared/gitlab';

describe('projectsFolder', () => {
  const home = path.join(path.sep, 'home', 'ada');
  it('defaults to ~/Overtex', () => {
    expect(projectsFolder(undefined, home)).toBe(path.join(home, 'Overtex'));
    expect(projectsFolder('  ', home)).toBe(path.join(home, 'Overtex'));
    expect(projectsFolder('relative/dir', home)).toBe(path.join(home, 'Overtex'));
  });
  it('expands ~ and keeps absolute folders', () => {
    expect(projectsFolder('~', home)).toBe(home);
    expect(projectsFolder('~/Papers', home)).toBe(path.join(home, 'Papers'));
    const abs = path.join(path.sep, 'data', 'tex');
    expect(projectsFolder(abs, home)).toBe(abs);
  });
});

describe('cloneFolderName', () => {
  it('uses the repository name, numbered when taken', () => {
    expect(cloneFolderName('paper', () => false)).toBe('paper');
    const taken = new Set(['paper', 'paper-2']);
    expect(cloneFolderName('paper', (f) => taken.has(f))).toBe('paper-3');
  });
  it('refuses names that could leave the folder', () => {
    for (const bad of ['..', '.', '../x', 'a/b', 'a\\b', '', '-rf', 'a b']) {
      expect(cloneFolderName(bad, () => false)).toBeUndefined();
    }
  });
});

describe('shouldCheck', () => {
  it('looks when it never looked, when enough time passed, or when the clock went back', () => {
    expect(shouldCheck(1000, undefined, 600)).toBe(true);
    expect(shouldCheck(1000, 500, 600)).toBe(false);
    expect(shouldCheck(1100, 500, 600)).toBe(true);
    expect(shouldCheck(100, 500, 600)).toBe(true);
    expect(shouldCheck(1000, 500, 0)).toBe(true);
  });
});

describe('GitLabClient.joinedSince', () => {
  function fake(status: number, body: unknown) {
    const urls: string[] = [];
    const fn = async (url: string, init: { method: string; headers: Record<string, string> }) => {
      urls.push(`${init.method} ${url}`);
      return { status, json: async () => body };
    };
    return { fn, urls };
  }

  it('asks for joined events from the day before and keeps only the newer ones', async () => {
    const { fn, urls } = fake(200, [
      { project_id: 7, created_at: '2026-11-20T09:00:00.000Z' },
      { project_id: 8, created_at: '2026-11-20T11:00:00.000+00:00' },
      { project_id: -1, created_at: '2026-11-21T00:00:00Z' },
      { project_id: 9 },
      { project_id: 10, created_at: '2026-11-21T08:00:00Z' },
    ]);
    const got = await new GitLabClient('t', fn).joinedSince('2026-11-20T10:00:00.000Z');
    expect(got).toEqual([
      { projectId: 8, at: '2026-11-20T11:00:00.000+00:00' },
      { projectId: 10, at: '2026-11-21T08:00:00Z' },
    ]);
    expect(urls).toEqual(['GET https://gitlab.com/api/v4/events?action=joined&after=2026-11-19&sort=asc&per_page=100']);
  });

  it('says when the token is refused or the answer is not GitLab\'s', async () => {
    const refused = await new GitLabClient('t', fake(401, {}).fn).joinedSince('2026-11-20T10:00:00Z').catch((e) => e);
    expect(refused).toBeInstanceOf(GitLabError);
    expect(refused.status).toBe(401);
    const odd = await new GitLabClient('t', fake(200, { not: 'a list' }).fn).joinedSince('2026-11-20T10:00:00Z').catch((e) => e);
    expect(odd).toBeInstanceOf(GitLabError);
  });
});
