// The environment Overtex runs TeX tools in. No vscode import, so it is unit-testable.
import * as fs from 'fs';
import { standardTexDirs, withTexDirs } from './setup';

/** The standard TeX folders on this machine, which a VS Code started from the Dock may not have on PATH. */
export function installedTexDirs(): string[] {
  const listDir = (dir: string) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  return standardTexDirs(process.platform, process.env, listDir).filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/** `base` with this machine's TeX folders after its PATH, so TeX tools and what they call are found. */
export function texEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return withTexDirs(base, process.platform, installedTexDirs());
}
