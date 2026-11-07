import * as path from 'path';

/**
 * Resolves a command the way a shell would: a path is checked as is, a bare name is looked up
 * on PATH (with PATHEXT on Windows). Returns undefined when nothing executable is found.
 */
export function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isFile: (candidate: string) => boolean
): string | undefined {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const extensions =
    platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const withExtensions = (base: string) => extensions.map((ext) => base + ext);

  const hasSeparator = command.includes('/') || (platform === 'win32' && command.includes('\\'));
  if (hasSeparator || p.isAbsolute(command)) {
    return withExtensions(command).find(isFile);
  }

  const pathValue = (platform === 'win32' ? env.Path ?? env.PATH : env.PATH) ?? '';
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const found = withExtensions(p.join(dir, command)).find(isFile);
    if (found) {
      return found;
    }
  }
  return undefined;
}
