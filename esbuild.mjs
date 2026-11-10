import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

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

function copyHarperBinary() {
  mkdirSync('out', { recursive: true });
  cpSync('node_modules/harper.js/dist/harper_wasm_slim_bg.wasm', 'out/harper_wasm_slim_bg.wasm');
}

// harper.js reads a file:// binary from `new URL(binary).pathname`, which keeps %20 and the like
// and on Windows starts with /C:/, so an install path with a space, a non-ASCII letter or a drive
// letter fails. fs takes the URL itself and decodes it properly.
/** @type {esbuild.Plugin} */
const harperFileUrl = {
  name: 'harper-file-url',
  setup(build) {
    build.onLoad({ filter: /harper\.js[\\/]dist[\\/]BinaryModule-[^\\/]*\.js$/ }, (args) => {
      const code = readFileSync(args.path, 'utf8');
      const broken = 'fs.readFile(new URL(binary).pathname,';
      if (!code.includes(broken)) {
        throw new Error('harper.js no longer reads its binary as expected; check harperFileUrl in esbuild.mjs');
      }
      return { contents: code.replace(broken, 'fs.readFile(new URL(binary),'), loader: 'js' };
    });
  },
};

// MathJax's output modules import their default font (New Computer Modern, ~1 MB) through the
// package's '#default-font' import map. The math preview uses the smaller TeX font instead.
/** @type {esbuild.Plugin} */
const mathjaxTexFont = {
  name: 'mathjax-tex-font',
  setup(build) {
    build.onResolve({ filter: /^#default-font\// }, (args) => ({
      path: resolve('node_modules/@mathjax/mathjax-tex-font/mjs', args.path.slice('#default-font/'.length)),
    }));
  },
};

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
  // Loaded with require() on the first math hover, so MathJax is not parsed at activation.
  esbuild.context({
    ...shared,
    entryPoints: ['src/math/render.ts'],
    outfile: 'out/mathRender.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    plugins: [mathjaxTexFont],
  }),
  // Loaded with require() on the first spelling and grammar check.
  esbuild.context({
    ...shared,
    entryPoints: ['src/harperLoader.ts'],
    outfile: 'out/harperLinter.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    plugins: [harperFileUrl],
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
copyHarperBinary();

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
