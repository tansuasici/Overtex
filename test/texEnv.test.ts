import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { installedTexDirs, texEnv } from '../src/latex/texEnv';

describe('texEnv', () => {
  it('lists only TeX folders that exist', () => {
    for (const dir of installedTexDirs()) {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
  });

  it('keeps the base PATH first and adds the installed TeX folders after it', () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    const env = texEnv({ PATH: ['/only/here'].join(sep), OTHER: 'x' });
    const parts = (env.PATH ?? '').split(sep);
    expect(parts[0]).toBe('/only/here');
    expect(parts.slice(1)).toEqual(installedTexDirs());
    expect(env.OTHER).toBe('x');
  });
});
