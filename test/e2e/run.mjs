// Runs test/e2e/suite.ts inside a real VS Code with Overtex loaded from this checkout.
// Needs latexmk and synctex on PATH; the TexLab steps run when texlab is on PATH too. Usage: npm run test:e2e
import { runTests } from '@vscode/test-electron';
import { execFileSync } from 'node:child_process';
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

// The last three flags: a test window behind other windows otherwise stops drawing, and the viewer
// steps time out in about half of the local runs.
const launchArgs = (dir) => [dir, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];

// The TexLab run: a project in a folder whose path VS Code and texlab spell differently in a URI,
// and a file next to it in a folder whose name has [ ], which texlab cannot read.
const texlabBox = fs.mkdtempSync(path.join(os.tmpdir(), 'overtex-e2e-texlab-'));
const texlabWorkspace = path.join(texlabBox, "Drive'ım (1)", 'paper');
const texlabFiles = {
  'main.tex': [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\input{chapters/intro}',
    'See Section~\\ref{sec:intro} and \\cite{knuth1984}.',
    '\\bibliographystyle{plain}',
    '\\bibliography{refs}',
    'Missing: \\ref{sec:nowhere}.',
    '\\end{document}',
    '',
  ].join('\n'),
  'chapters/intro.tex': ['\\section{Introduction}\\label{sec:intro}', 'Text.', ''].join('\n'),
  'refs.bib': '@book{knuth1984, author = {Donald E. Knuth}, title = {The {\\TeX}book}, year = {1984}}\n',
  '.vscode/settings.json': JSON.stringify({ 'overtex.texlab.enabled': true, 'overtex.build.onSave': false, 'overtex.viewer.autoOpen': false }),
  '../../draft [v2]/notes.tex': 'Notes \\ref{a}.\n',
};
for (const [name, text] of Object.entries(texlabFiles)) {
  fs.mkdirSync(path.dirname(path.join(texlabWorkspace, name)), { recursive: true });
  fs.writeFileSync(path.join(texlabWorkspace, name), text);
}

/** Whether texlab runs here. CI sets OVERTEX_E2E_TEXLAB=required so a missing texlab fails the run. */
function hasTexlab() {
  try {
    execFileSync('texlab', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'out-e2e', 'suite.js'),
    extensionTestsEnv: { OVERTEX_E2E: '1' },
    launchArgs: launchArgs(workspace),
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}

if (hasTexlab()) {
  console.log('TexLab:');
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, 'out-e2e', 'texlab.js'),
      extensionTestsEnv: { OVERTEX_E2E: '1' },
      launchArgs: launchArgs(texlabWorkspace),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
} else if (process.env.OVERTEX_E2E_TEXLAB === 'required') {
  console.error('texlab is not on PATH, and OVERTEX_E2E_TEXLAB=required');
  process.exitCode = 1;
} else {
  console.log('TexLab: skipped, texlab is not on PATH');
}

fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(texlabBox, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });
