// harper.js reads a file:// binary from `new URL(binary).pathname`, which keeps %20 and the like
// and on Windows starts with /C:/, so an install path with a space, a non-ASCII letter or a drive
// letter fails. fs takes the URL itself and decodes it properly. Used by esbuild.mjs for the
// bundle and by vitest.config.mts for the tests, so both run the same code.

/** Matches harper.js's module that loads the binary. */
export const harperBinaryModule = /harper\.js[\\/]dist[\\/]BinaryModule-[^\\/]*\.js$/;

/** `code` of that module, reading the binary from the URL itself. */
export function patchHarperBinaryRead(code) {
  const broken = 'fs.readFile(new URL(binary).pathname,';
  if (!code.includes(broken)) {
    throw new Error('harper.js no longer reads its binary as expected; check scripts/harperFileUrl.mjs');
  }
  return code.replace(broken, 'fs.readFile(new URL(binary),');
}
