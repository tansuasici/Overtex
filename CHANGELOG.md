# Changelog

## 0.2.1 (2026-11-08)

- Math hover preview: hovering over inline or display math, or an `equation`, `align`, `gather`, `multline` or similar environment, shows it rendered with MathJax 4. Macros from `\newcommand`, `\renewcommand`, `\providecommand`, `\DeclareMathOperator` and `\def` in the file and the main file are applied; TeX errors are shown in place of the image. MathJax is bundled separately and loaded on the first hover. `overtex.mathPreview.enabled` and `overtex.mathPreview.scale` control it.
- Fixed the PDF preview's dark pages button doing nothing when VS Code could not save `overtex.viewer.colorScheme` (as happens after an update until the window is reloaded). The preview now flips anyway and offers to reload the window.

## 0.2.0 (2026-11-08)

- Editor highlights for LaTeX: `TODO`, `FIXME` and `XXX` comments and `\todo{…}` notes get a background and a scroll bar mark (color `overtex.todoBackground`), and text TeX skips, `\iffalse … \fi` and `comment` environments, is dimmed. `overtex.highlights.enabled` turns them off.
- Word count in the status bar: after each successful build, `texcount` counts the document with its `\input`/`\include` files. `overtex.wordCount.goal` shows progress toward a target (`1,234 / 5,000 words`); the tooltip splits text, headings and captions and shows the words added this session. **Count Words** runs it on demand; `overtex.wordCount.enabled` turns it off.
- Dark PDF preview: `overtex.viewer.colorScheme` (`light`, `dark`, or `auto` to follow the VS Code theme) draws pages as light text on dark gray, keeping the hue of colored text and links. Images are inverted as well. The preview's toolbar button and **Toggle Dark PDF Preview** switch it; only the preview changes, not the PDF.
- **Check Submission** command: builds the project and lists what conferences, journals and arXiv tend to reject: more pages than `overtex.submission.pageLimit`, the `draft` class option, undefined references and citations (`??`) and duplicate labels, bitmap (Type 3) fonts, and `\todo`/TODO/FIXME left in the text (TODO comments are listed separately, since arXiv publishes the source). With `overtex.submission.anonymous` on, it also points at author names, affiliations, `\thanks`, acknowledgments and `pdfauthor` for double-blind review. Findings appear in the Problems panel until the next build.
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
