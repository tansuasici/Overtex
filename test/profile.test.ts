import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs build script without type declarations
import { buildProfile, PROFILE_PATH, PROFILE_SETTINGS } from '../scripts/profile.mjs';

describe('Overtex.code-profile', () => {
  // Windows checkouts may turn LF into CRLF.
  const committed = readFileSync(PROFILE_PATH, 'utf8').replace(/\r\n/g, '\n');
  const profile = JSON.parse(committed);

  it('matches what scripts/profile.mjs generates', () => {
    expect(committed).toBe(buildProfile());
  });

  it('carries settings in the nesting VS Code reads on import', () => {
    const settings = JSON.parse(JSON.parse(profile.settings).settings);
    expect(settings).toEqual(PROFILE_SETTINGS);
    expect(settings['editor.minimap.enabled']).toBe(false);
  });

  it('installs Overtex and nothing else', () => {
    const extensions = JSON.parse(profile.extensions);
    expect(extensions.map((e: { identifier: { id: string } }) => e.identifier.id)).toEqual(['tansuasici.overtex']);
  });

  it('leaves out machine-specific Overtex settings', () => {
    const settings = JSON.parse(JSON.parse(profile.settings).settings);
    expect(Object.keys(settings).filter((k) => k.startsWith('overtex.'))).toEqual([]);
    expect(profile.name).toBe('Overtex');
  });
});
