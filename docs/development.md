# Development

How to build Overtex from source, run its tests, use its API from another extension, and release it.

## Set up

You need Node.js 22 and, for the end-to-end tests, a TeX distribution with latexmk and synctex.

```bash
git clone https://github.com/tansuasici/Overtex.git
cd Overtex
npm ci
npm run build
```

| Script | Does |
| --- | --- |
| `npm run build` | Bundles the extension and the PDF viewer into `out/` |
| `npm run typecheck` | Type-checks without emitting |
| `npm test` | Unit tests with vitest |
| `npm run test:e2e` | Starts VS Code with the extension; needs latexmk and synctex on the `PATH` |

To try your changes, build and open a VS Code window that runs this checkout:

```bash
code --extensionDevelopmentPath="$PWD" path/to/a/latex/project
```

## Layout

| Path | Holds |
| --- | --- |
| `src/extension.ts` | Activation; registers commands and views |
| `src/api.ts` | The public API other extensions use |
| `src/latex/` | VS Code-independent logic: builds, log parsing, main-file detection, BibTeX, labels, latexdiff, submission and arXiv checks, templates |
| `src/viewer/`, `src/pdf/` | The PDF preview panel, and reading and annotating PDFs |
| `src/synctex/` | SyncTeX forward and reverse search |
| `src/shared/` | Code shared with the viewer and with git hosts (GitHub, GitLab, Gitea) |
| `src/*.ts` | One file per feature: commands and views |
| `test/` | Unit tests |
| `docs/` | This documentation |

Keep logic that does not need VS Code in `src/latex/` or `src/shared/`, so it can be unit-tested.

## API for other extensions

Overtex returns an API from `activate()`. Overleaf Connect uses it to build after a sync.

```ts
import * as vscode from 'vscode';

const api = vscode.extensions.getExtension('tansuasici.overtex')?.exports;
if (api?.version === 1) {
  api.onDidEndBuild((result) => { /* … */ });
  await api.build();
}
```

| Member | |
| --- | --- |
| `version` | `1`. Bumped on breaking changes. |
| `build(mainFile?)` | Builds `mainFile` or the detected main file. Resolves to `undefined` if there is nothing to build. |
| `onDidStartBuild` | Event with `{ mainFile }`. |
| `onDidEndBuild` | Event with the build result. |
| `viewPdf()` | Opens the preview. |
| `forwardSearch()` | Jumps from the cursor to the PDF. |

The types are in [`src/api.ts`](../src/api.ts). Its `e2e` member exists only under the end-to-end tests and is not part of the API.

## Documentation

The guides and the tutorial are written by hand. The [command](reference/commands.md) and [settings](reference/settings.md) references are generated from `package.json`:

```bash
node scripts/docsReference.mjs
```

`npm test` fails when they are out of date, or when a relative link or `#anchor` in `docs/` does not resolve. After changing a command, menu or setting, run the script and commit the result.

Write docs in plain English, for someone who has not used LaTeX tools before: what the reader does, then what happens.

## Release

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Merge to `main`.
3. Push a tag `v<version>`, for example `v0.3.0`.

The **Release** workflow (`.github/workflows/release.yml`) checks that the tag matches `package.json`, runs the type check, unit and end-to-end tests, packages the VSIX and:

- publishes to the Visual Studio Marketplace with `vsce publish --oidc` (trusted publishing, no token in the repository);
- publishes to Open VSX when the `OVSX_PAT` secret is set;
- creates a GitHub release with the VSIX attached.

## License

MIT. Overtex bundles PDF.js and MathJax, both Apache-2.0; see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
