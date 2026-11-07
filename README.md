# Overtex

A LaTeX writing environment inside VS Code: build, live PDF preview and SyncTeX, with no extra setup beyond a TeX distribution.

## Features

- **Build** with latexmk using pdfLaTeX, XeLaTeX or LuaLaTeX. BibTeX/Biber passes run automatically. Builds run on save, and a build requested while another is running is queued, not started in parallel.
- **Problems panel**: TeX errors and warnings are mapped to the right file and line, including files pulled in with `\input`.
- **PDF preview** beside the editor. It reloads after each build and keeps your place.
- **SyncTeX**: `⌘⌥J` / `Ctrl+Alt+J` jumps from the cursor to the PDF; `⌘`/`Ctrl`+click in the PDF jumps back to the source.
- **Live checking and completion** with [TexLab](https://github.com/latex-lsp/texlab), when it is installed: errors such as unbalanced braces, mismatched environments and undefined references appear as you type, before any build, and completion covers commands, environments, `\ref` labels and `\cite` keys. Hover and go to definition come with it.
- **Citation completion** inside `\cite{…}` from the workspace's `.bib` files, searchable by key, title and author, when TexLab is not available.

## Requirements

A TeX distribution that provides `latexmk` and `synctex`: [TeX Live](https://tug.org/texlive/), [MacTeX](https://tug.org/mactex/) or [MiKTeX](https://miktex.org/) (MiKTeX also needs Perl for latexmk).

Optional: [TexLab](https://github.com/latex-lsp/texlab#installation) for live checking and completion (`brew install texlab`, `cargo install texlab`, or a release binary on `PATH`). If the official TexLab extension is installed, Overtex leaves the language server to it.

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
| `overtex.latex.latexmkPath`, `overtex.synctex.path`, `overtex.texlab.path` | | Executable paths when they are not on `PATH`. |
| `overtex.texlab.enabled` | `true` | Run the TexLab language server. |
| `overtex.texlab.chktex` | `false` | Show ChkTeX style warnings while typing (through TexLab). |
| `overtex.build.onSave` | `true` | Build when a `.tex` or `.bib` file is saved. |
| `overtex.viewer.autoOpen` | `true` | Open the preview after a successful build. |

## LaTeX Workshop

If LaTeX Workshop is installed and both extensions build on save, every save would run TeX twice. Overtex detects this and offers to turn off either LaTeX Workshop's auto-build or its own build on save.

## Workspace Trust

latexmk can run code from a project's `.latexmkrc`, so in an [untrusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust) Overtex does not build, clean or start TexLab, and ignores workspace values of `overtex.latex.latexmkPath`, `overtex.latex.extraArgs`, `overtex.synctex.path` and `overtex.texlab.path`. Opening an existing PDF still works. Trust the folder to enable building.

## License

MIT. Bundles PDF.js (Apache-2.0); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
