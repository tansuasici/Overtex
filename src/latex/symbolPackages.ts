import { hasPackage } from './figures';
import type { SymbolPackage } from '../shared/symbols';

// Packages that also provide a symbol package's commands, so a preamble with one of them needs
// nothing added.
const FONT_PACKAGES = ['newtxmath', 'newpxmath', 'mathabx', 'unicode-math', 'stix', 'stix2'];
const PROVIDERS: Record<SymbolPackage, string[]> = {
  amssymb: ['amssymb', ...FONT_PACKAGES],
  amsfonts: ['amsfonts', 'amssymb', ...FONT_PACKAGES],
  amsmath: ['amsmath', 'mathtools'],
  mathtools: ['mathtools'],
  mathrsfs: ['mathrsfs'],
};

// Classes that load amsmath themselves.
const AMSMATH_CLASSES = ['amsart', 'amsbook', 'amsproc'];

function documentClass(text: string): string | undefined {
  const m = /^[^%\n]*\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/m.exec(text);
  return m?.[1].trim();
}

/** Whether the main file's preamble already provides what `pkg`'s symbols need. */
export function symbolPackageLoaded(mainText: string, pkg: SymbolPackage): boolean {
  if (PROVIDERS[pkg].some((p) => hasPackage(mainText, p))) {
    return true;
  }
  return pkg === 'amsmath' && AMSMATH_CLASSES.includes(documentClass(mainText) ?? '');
}
