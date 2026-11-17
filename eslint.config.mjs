// Lint for the extension, the webviews and the tests. Type checking is tsc's job (npm run typecheck).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.vscode-test/**', 'out/**', 'out-e2e/**', 'node_modules/**', 'profile/**', '**/*.vsix'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', URL: 'readonly' },
    },
    rules: {
      // tsc reports unused names already (noUnusedLocals / noUnusedParameters).
      '@typescript-eslint/no-unused-vars': 'off',
      eqeqeq: ['error', 'smart'],
      'no-console': 'off',
      // A closure that runs later may read a let assigned once below it.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
  {
    // JSON from the GitHub, GitLab and Gitea APIs from invite codes and stored server records is checked field by field;
    // tests cast to reach into results.
    files: ['src/shared/github.ts', 'src/shared/gitlab.ts', 'src/shared/gitea.ts', 'src/inviteCode.ts', 'src/gitSync.ts', 'test/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  }
);
