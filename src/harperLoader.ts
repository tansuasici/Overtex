// Loads Harper's English grammar checker, compiled to WebAssembly. Bundled on its own
// (out/harperLinter.js) and required on the first check, so activation does not parse it.
import { createBinaryModuleFromUrl, LocalLinter } from 'harper.js';
import { pathToFileURL } from 'url';

/** A linter over the slim Harper binary at `wasmPath`. */
export function createHarperLinter(wasmPath: string): LocalLinter {
  return new LocalLinter({ binary: createBinaryModuleFromUrl(pathToFileURL(wasmPath).href, 'slim') });
}
