import * as path from 'path';

/**
 * TeX records file names with symlinks resolved (on macOS the temp dir `/var/...` becomes
 * `/private/var/...`), so inverse search can name a file by a path VS Code does not know, and
 * opening it would give a second tab for a file that is already open. Maps such a path back
 * under the workspace folder it belongs to; returns it unchanged otherwise.
 */
export function toWorkspacePath(file: string, folders: readonly string[], realpath: (p: string) => string): string {
  for (const folder of folders) {
    let real: string;
    try {
      real = realpath(folder);
    } catch {
      continue;
    }
    if (real === folder) {
      continue;
    }
    const rel = path.relative(real, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return path.join(folder, rel);
    }
  }
  return file;
}
