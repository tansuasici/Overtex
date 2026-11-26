// Pure helpers for joining a project you were invited to: where its folder goes on your computer. No
// vscode import, so they are unit tested.
import * as path from 'path';

/** The projects folder from the setting: `~` is your home folder, an empty or relative value means ~/Overtex. */
export function projectsFolder(setting: string | undefined, home: string): string {
  const raw = (setting ?? '').trim();
  const expanded = raw === '~' ? home : raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(home, raw.slice(2)) : raw;
  return expanded && path.isAbsolute(expanded) ? path.normalize(expanded) : path.join(home, 'Overtex');
}

/**
 * A folder name for the project inside the projects folder: the repository's name, with -2, -3, … when a
 * folder of that name is there already. undefined if the name could step out of the folder.
 */
export function cloneFolderName(name: string, exists: (folder: string) => boolean): string | undefined {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || /^\.+$/.test(name) || name.startsWith('-')) {
    return undefined;
  }
  for (let n = 1; n < 1000; n++) {
    const folder = n === 1 ? name : `${name}-${n}`;
    if (!exists(folder)) {
      return folder;
    }
  }
  return undefined;
}

/** Whether a background look is due: never looked, or the last look was at least `every` ms ago. */
export function shouldCheck(now: number, last: number | undefined, every: number): boolean {
  return typeof last !== 'number' || !Number.isFinite(last) || now - last >= every || now < last;
}
