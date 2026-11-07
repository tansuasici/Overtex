import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const pdfjs = 'node_modules/pdfjs-dist';
const webviewOut = 'out/webview';

function copyPdfjsAssets() {
  mkdirSync(webviewOut, { recursive: true });
  cpSync(`${pdfjs}/legacy/build/pdf.worker.min.mjs`, `${webviewOut}/pdf.worker.min.mjs`);
  for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
    cpSync(`${pdfjs}/${dir}`, `${webviewOut}/${dir}`, { recursive: true });
  }
}

/** @type {esbuild.BuildOptions} */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  }),
  esbuild.context({
    ...shared,
    entryPoints: { pdfViewer: 'webview/pdfViewer.ts' },
    outdir: webviewOut,
    platform: 'browser',
    format: 'esm',
    target: 'chrome108',
    alias: { 'pdfjs-dist': `./${pdfjs}/legacy/build/pdf.mjs` },
    loader: { '.css': 'css' },
  }),
]);

rmSync('out', { recursive: true, force: true });
copyPdfjsAssets();

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
