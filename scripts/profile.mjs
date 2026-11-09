// Builds profile/Overtex.code-profile, the VS Code profile that README's
// "Writing in a clean profile" section imports. Run: node scripts/profile.mjs
//
// A .code-profile nests JSON in strings: `settings` is a string holding
// {"settings": "<settings.json text>"} and `extensions` is a string holding
// the extension list. VS Code quietly skips a resource it cannot read, so
// the file is generated rather than written by hand.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PROFILE_PATH = fileURLToPath(new URL('../profile/Overtex.code-profile', import.meta.url));

// Documented settings only. The Activity Bar and status bar stay: the Papers
// and Labels views and the word count live there. Nothing machine-specific
// (build tool, executable paths) goes in a profile meant to be shared.
export const PROFILE_SETTINGS = {
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.layoutControl.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.disableAIFeatures': true,
  'breadcrumbs.enabled': false,
  'editor.minimap.enabled': false,
  'editor.stickyScroll.enabled': false,
  'editor.wordWrap': 'on',
  'editor.fontSize': 15,
  'editor.lineHeight': 1.6,
  'editor.renderLineHighlight': 'gutter',
};

export const PROFILE_EXTENSIONS = [{ id: 'tansuasici.overtex', displayName: 'Overtex' }];

export function buildProfile() {
  const settingsText = JSON.stringify(PROFILE_SETTINGS, null, 2);
  const extensions = PROFILE_EXTENSIONS.map(({ id, displayName }) => ({
    identifier: { id },
    displayName,
    preRelease: false,
  }));
  return JSON.stringify(
    {
      name: 'Overtex',
      icon: 'book',
      settings: JSON.stringify({ settings: settingsText }),
      extensions: JSON.stringify(extensions),
    },
    null,
    2,
  ) + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(PROFILE_PATH, buildProfile());
  console.log(`Wrote ${PROFILE_PATH}`);
}
