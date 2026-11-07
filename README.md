# Overtex

A LaTeX writing environment inside VS Code: build, live PDF preview and SyncTeX, with no extra setup beyond a TeX distribution.

## Features

- **Build** with latexmk using pdfLaTeX, XeLaTeX or LuaLaTeX. BibTeX/Biber passes run automatically. Builds run on save, and a build requested while another is running is queued, not started in parallel.
- **Problems panel**: TeX errors and warnings are mapped to the right file and line, including files pulled in with `\input`.
- **PDF preview** beside the editor. It reloads after each build and keeps your place.
- **SyncTeX**: `⌘⌥J` / `Ctrl+Alt+J` jumps from the cursor to the PDF; `⌘`/`Ctrl`+click in the PDF jumps back to the source.
- **Citation completion** inside `\cite{…}`, searchable by key, title and author.

## Requirements

A TeX distribution that provides `latexmk` and `synctex`: [TeX Live](https://tug.org/texlive/), [MacTeX](https://tug.org/mactex/) or [MiKTeX](https://miktex.org/) (MiKTeX also needs Perl for latexmk).

## Commands

| Command | Shortcut |
| --- | --- |
| Overtex: Build | `⌘⌥B` / `Ctrl+Alt+B` |
| Overtex: View PDF | `⌘⌥V` / `Ctrl+Alt+V` |
| Overtex: Jump to PDF (forward search) | `⌘⌥J` / `Ctrl+Alt+J` |
| Overtex: Cancel Build, Clean Auxiliary Files, Show Build Log | |

## Settings

| Setting | Default | |
| --- | --- | --- |
| `overtex.latex.mainFile` | | Main file relative to the workspace. Otherwise found from `% !TEX root = …`, the active file, or a workspace search. |
| `overtex.latex.engine` | `pdflatex` | `pdflatex`, `xelatex` or `lualatex`. |
| `overtex.latex.outDir` | | Output directory, relative to the main file. |
| `overtex.latex.extraArgs` | `[]` | Extra latexmk arguments, e.g. `-shell-escape`. |
| `overtex.latex.latexmkPath`, `overtex.synctex.path` | | Executable paths when they are not on `PATH`. |
| `overtex.build.onSave` | `true` | Build when a `.tex` or `.bib` file is saved. |
| `overtex.viewer.autoOpen` | `true` | Open the preview after a successful build. |

If LaTeX Workshop is also installed, disable one of the two for the workspace so files are not built twice on every save.

## License

MIT. Bundles PDF.js (Apache-2.0); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
