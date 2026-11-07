import { describe, expect, it } from 'vitest';
import { hasBuildConflict } from '../src/latex/conflicts';

describe('hasBuildConflict', () => {
  const base = { latexWorkshopInstalled: true, latexWorkshopAutoBuild: undefined, overtexBuildOnSave: true };

  it('flags LaTeX Workshop with its default auto-build', () => {
    expect(hasBuildConflict(base)).toBe(true);
  });

  it('flags any auto-build mode other than "never"', () => {
    expect(hasBuildConflict({ ...base, latexWorkshopAutoBuild: 'onSave' })).toBe(true);
    expect(hasBuildConflict({ ...base, latexWorkshopAutoBuild: 'onFileChange' })).toBe(true);
  });

  it('is quiet when LaTeX Workshop auto-build is off', () => {
    expect(hasBuildConflict({ ...base, latexWorkshopAutoBuild: 'never' })).toBe(false);
  });

  it('is quiet when Overtex build on save is off', () => {
    expect(hasBuildConflict({ ...base, overtexBuildOnSave: false })).toBe(false);
  });

  it('is quiet when LaTeX Workshop is not installed', () => {
    expect(hasBuildConflict({ ...base, latexWorkshopInstalled: false })).toBe(false);
  });
});
