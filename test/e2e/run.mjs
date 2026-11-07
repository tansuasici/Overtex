// Runs test/e2e/suite.ts inside a real VS Code with Overtex loaded from this checkout.
// Needs latexmk and synctex on PATH. Usage: npm run test:e2e
import { runTests } from '@vscode/test-electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// A three-page document: page 2 comes from main.tex, page 3 from an \input file.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-e2e-'));
const files = {
  'main.tex': [
    '\\documentclass{article}',
    '\\begin{document}',
    'First page.',
    '\\newpage',
    'Second page: the forward search target in the main file.',
    '\\newpage',
    '\\input{chapters/part}',
    '\\end{document}',
    '',
  ].join('\n'),
  'chapters/part.tex': ['% !TEX root = ../main.tex', 'Third page: the forward search target in an input file.', ''].join('\n'),
  '.vscode/settings.json': JSON.stringify({
    'overtex.texlab.enabled': false,
    'overtex.build.onSave': false,
    'overtex.viewer.autoOpen': true,
  }),
};
for (const [name, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
  fs.writeFileSync(path.join(workspace, name), text);
}

// A fresh profile with the walkthrough's open-on-install off: the walkthrough editor would otherwise
// open at a random point during the run and take focus from the viewer steps.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-e2e-user-'));
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(
  path.join(userData, 'User', 'settings.json'),
  JSON.stringify({ 'workbench.welcomePage.walkthroughs.openOnInstall': false, 'workbench.startupEditor': 'none' })
);

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'out-e2e', 'suite.js'),
    extensionTestsEnv: { OVERTEX_E2E: '1' },
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`],
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
}
