# Changelog

## Unreleased

- **Export for arXiv** command: builds the project, then zips the files TeX read according to latexmk's recorder (sources, figures, local packages, the generated `.bbl`) as `<main>-arxiv.zip`, with comments stripped from `.tex` files (verbatim environments, `\verb` and `\url` are left alone) and `\pdfoutput=1` added for pdfLaTeX. Build files in `overtex.latex.outDir` are moved beside the main file. Warns about a biber `.bbl`, a missing `.bbl`, XeLaTeX/LuaLaTeX, and inputs outside the main file's folder.
- **Add Citation from DOI or arXiv** command: fetches the BibTeX record from doi.org (arXiv papers through their DataCite DOI), gives it a key like `vaswani2017attention`, appends it to the bibliography the main file names (or the workspace's `.bib`, or a new `refs.bib`) and inserts `\cite{key}` at the cursor. A DOI already in the bibliography reuses its entry. The input box is filled from the clipboard when it holds a DOI or arXiv ID.
- **Check LaTeX Installation** command: finds latexmk, the engine, synctex and TexLab with the same `PATH` lookup the build uses, spots TeX that is installed but not on VS Code's `PATH`, and gives install steps for macOS, Windows and Linux. Offered once on startup when latexmk is missing, and from build or SyncTeX errors caused by a missing program.
- **Getting Started** walkthrough on the Welcome page: install TeX, open or create a document, build, preview and SyncTeX, optional TexLab.
- Hovering a key in `\cite{...}` (and natbib/biblatex variants) shows the entry's title, authors, year and abstract from the workspace's `.bib` files. Like `\cite` completion, it is off while TexLab runs, which has its own citation hover.
- Fixed the PDF preview growing and shrinking without stopping in Fit width (or Fit page) mode when the page was just tall enough to need a scrollbar.
- **New LaTeX Document** command: starts a project from a template (Article, Thesis or Report with chapters in separate files, Beamer Presentation, Letter) in the open folder, or in a new subfolder when the files would overwrite something. With no folder open, a one-file template opens as an untitled document and the others ask for a folder.

## 0.1.1 (2026-11-07)

- Releases are published to the Marketplace with trusted publishing (GitHub OIDC) instead of a personal access token. No changes to the extension itself.

## 0.1.0 (2026-11-07)

First release.

- Build with latexmk (pdfLaTeX, XeLaTeX, LuaLaTeX), automatic BibTeX/Biber passes, build on save, cancel.
- Errors and warnings from the TeX log in the Problems panel.
- Built-in PDF preview (PDF.js) that keeps its scroll position across rebuilds.
- SyncTeX forward search (editor → PDF) and inverse search (⌘/Ctrl+click in the PDF → editor).
- Main file detection: setting, `% !TEX root`, `\documentclass`, workspace search.
- Citation key completion from the workspace's `.bib` files.
- Workspace Trust: building and cleaning are disabled in untrusted workspaces.
- Detects a double build with LaTeX Workshop and offers to turn off one of the two.
- TexLab language server integration: live diagnostics while typing, completion for commands, environments, labels and citations, hover and go to definition. Optional; starts only in trusted workspaces and stays off when the TexLab extension is installed. Settings `overtex.texlab.enabled`, `overtex.texlab.path`, `overtex.texlab.chktex`.
- SyncTeX works with PDFs built by other tools (absolute input paths) and with projects opened through a symlinked path.
