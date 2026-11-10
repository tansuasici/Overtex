import { defineConfig } from 'vitest/config';
import { harperBinaryModule, patchHarperBinaryRead } from './scripts/harperFileUrl.mjs';

export default defineConfig({
  plugins: [
    {
      name: 'harper-file-url',
      transform: (code, id) => (harperBinaryModule.test(id) ? patchHarperBinaryRead(code) : undefined),
    },
  ],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    // Run harper.js through Vite so the plugin above patches it as esbuild.mjs does for the bundle.
    server: { deps: { inline: [/harper\.js/] } },
  },
});
