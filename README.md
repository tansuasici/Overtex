<p align="center">
  <img src="https://raw.githubusercontent.com/tansuasici/Overtex/main/media/icon.png" width="96" alt="Overtex icon">
</p>

<h1 align="center">Overtex</h1>

<p align="center">
  A LaTeX writing environment inside VS Code: build, PDF preview and SyncTeX, with nothing to set up beyond a TeX distribution.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=tansuasici.overtex"><img src="https://vsmarketplacebadges.dev/version/tansuasici.overtex.svg" alt="Marketplace version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=tansuasici.overtex"><img src="https://vsmarketplacebadges.dev/installs/tansuasici.overtex.svg" alt="Installs"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

## Install

Install **Overtex** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=tansuasici.overtex), or run:

```bash
code --install-extension tansuasici.overtex
```

You also need a TeX distribution; see [Requirements](#requirements).

## Quick start

1. Run **Overtex: Check LaTeX Installation** to confirm latexmk and your engine are found.
2. Open a folder with a `.tex` file, or run **Overtex: New LaTeX Document** and pick a template (Article, Thesis or Report, Presentation, Letter).
3. Save. Overtex builds with latexmk and opens the PDF beside the editor.
4. Press `⌘⌥J` / `Ctrl+Alt+J` to jump to the cursor's spot in the PDF, and `⌘`/`Ctrl`+click in the PDF to jump back.

**Overtex: Getting Started** walks through the same steps on the Welcome page.

## Features

- **Build** with latexmk using pdfLaTeX, XeLaTeX or LuaLaTeX. BibTeX/Biber passes run automatically. Builds run on save, and a build requested while another is running is queued, not started in parallel.
- **Problems panel**: TeX errors and warnings are mapped to the right file and line, including files pulled in with `\input`.
- **PDF preview** beside the editor. It reloads after each build and keeps your place. **Dark pages** (the toolbar's ◐ button, **Toggle Dark PDF Preview**, or `overtex.viewer.colorScheme`) show light text on a dark gray page; colors keep their hue, but figures and photos are inverted too. Set it to `auto` to follow the VS Code theme.
- **SyncTeX**: `⌘⌥J` / `Ctrl+Alt+J` jumps from the cursor to the PDF; `⌘`/`Ctrl`+click in the PDF jumps back to the source.
- **Live checking and completion** with [TexLab](https://github.com/latex-lsp/texlab), when it is installed: errors such as unbalanced braces, mismatched environments and undefined references appear as you type, before any build, and completion covers commands, environments, `\ref` labels and `\cite` keys. Hover and go to definition come with it.
- **Highlights**: `TODO`, `FIXME` and `XXX` comments and `\todo{…}` notes stand out in the editor and the scroll bar, and text TeX skips (`\iffalse … \fi`, `comment` environments) is dimmed. Change the color with `overtex.todoBackground` in `workbench.colorCustomizations`.
- **Math preview**: hover over math (`$…$`, `\(…\)`, `\[…\]`, `$$…$$`, `equation`, `align`, `gather` and the like) to see it rendered with [MathJax](https://www.mathjax.org/). Macros you define with `\newcommand`, `\DeclareMathOperator` or `\def` in the file or the main file are used; a mistake shows MathJax's error instead. Packages MathJax does not have are not loaded, so their commands show as undefined.
- **Citation completion** inside `\cite{…}` from the workspace's `.bib` files, searchable by key, title and author, when TexLab is not available.
- **Add Citation from DOI or arXiv**: paste a DOI (`10.1103/PhysRev.47.777`) or an arXiv ID (`arXiv:1706.03762`, or the abs URL) and Overtex fetches the BibTeX from doi.org, adds it to your `.bib` with a readable key, and inserts the `\cite` at the cursor.
- **Cite from Zotero**: with Zotero and its [Better BibTeX](https://retorque.re/zotero-better-bibtex/) add-on running, opens Zotero's picker, adds what you pick to your `.bib` under the citation keys Zotero shows, and inserts the `\cite` at the cursor. Papers already in the `.bib` are reused, and local attachment paths are left out. It talks only to Zotero on your computer.
- **Export for arXiv**: builds the project and writes `main-arxiv.zip` beside the main file with exactly the files TeX read: your `.tex` sources, figures, local `.sty`/`.cls` files and the generated `.bbl` (arXiv does not run BibTeX), without build leftovers. Comments are removed from `.tex` files, since arXiv publishes the source, and `\pdfoutput=1` is added for pdfLaTeX projects. It warns about things arXiv may reject: a biber `.bbl`, a missing `.bbl`, a XeLaTeX or LuaLaTeX build, or inputs from outside the main file's folder.
- **Word count** in the status bar, counted with `texcount` across `\input`/`\include` files after each successful build. Set `overtex.wordCount.goal` to see `1,234 / 5,000 words`; the tooltip splits text, headings and captions and shows how many words you added this session. **Overtex: Count Words** counts on demand.
- **Check Bibliography**: checks the `.bib` in the editor (or the ones the main file names) for entries missing fields their type needs, DOIs that do not exist, point at a different paper or repeat another entry's, and arXiv preprints that have since been published, with the journal and DOI to cite instead. It looks DOIs up on doi.org (Crossref and DataCite) and arXiv IDs on the arXiv API. Findings go to the Problems panel; entries that could not be reached are marked as unchecked, not wrong. Add Citation and Check Bibliography are the only Overtex features that use the internet, and only when you run them.
- **Compare Versions**: marks up what changed between two git commits, a commit and the files on disk, or two `.tex` files, with deleted and added text shown in the PDF. Changes in `\input` files are included. It runs [latexdiff](https://ctan.org/pkg/latexdiff), which comes with TeX Live and MiKTeX, and writes `main-diff.pdf`; your sources and git state are not touched.
- **Check Submission**: builds the project and lists what reviewers and arXiv tend to reject: more pages than `overtex.submission.pageLimit`, the `draft` class option, undefined references and citations (`??`), bitmap (Type 3) fonts, and `\todo`/TODO/FIXME left in the text. For double-blind review, turn on `overtex.submission.anonymous` and it also points at author names, affiliations, `\thanks`, acknowledgments and `pdfauthor`. Findings go to the Problems panel and are cleared by the next build. Fonts inside included PDF figures are not checked.

## Requirements

A TeX distribution that provides `latexmk`, `synctex` and `texcount`: [TeX Live](https://tug.org/texlive/), [MacTeX](https://tug.org/mactex/) or [MiKTeX](https://miktex.org/) (MiKTeX also needs Perl for latexmk).

**Overtex: Check LaTeX Installation** looks for latexmk, the selected engine, synctex and TexLab, and says what is missing and how to install it on your system. It also notices TeX that is installed but not yet on VS Code's `PATH`, which usually means VS Code needs a restart. If latexmk is missing when Overtex starts, it offers this check once. **Overtex: Getting Started** opens a short walkthrough: install, open a document, build, preview and SyncTeX.

Optional: [TexLab](https://github.com/latex-lsp/texlab#installation) for live checking and completion (`brew install texlab`, `cargo install texlab`, or a release binary on `PATH`). If the official TexLab extension is installed, Overtex leaves the language server to it.

## Commands

| Command | Shortcut |
| --- | --- |
| Overtex: Build | `⌘⌥B` / `Ctrl+Alt+B` |
| Overtex: View PDF | `⌘⌥V` / `Ctrl+Alt+V` |
| Overtex: Jump to PDF (forward search) | `⌘⌥J` / `Ctrl+Alt+J` |
| Overtex: Cancel Build, Clean Auxiliary Files, Show Build Log, Toggle Dark PDF Preview | |
| Overtex: Add Citation from DOI or arXiv, Cite from Zotero, Check Bibliography, Compare Versions, Export for arXiv, Check Submission, Count Words | |
| Overtex: Check LaTeX Installation, New LaTeX Document, Getting Started | |

## Settings

| Setting | Default | |
| --- | --- | --- |
| `overtex.latex.mainFile` | | Main file relative to the workspace. Otherwise found from `% !TEX root = …`, the active file, or a workspace search. |
| `overtex.latex.engine` | `pdflatex` | `pdflatex`, `xelatex` or `lualatex`. |
| `overtex.latex.outDir` | | Output directory, relative to the main file. |
| `overtex.latex.extraArgs` | `[]` | Extra latexmk arguments, e.g. `-shell-escape`. |
| `overtex.latex.latexmkPath`, `overtex.synctex.path`, `overtex.latexdiff.path`, `overtex.texlab.path` | | Executable paths when they are not on `PATH`. |
| `overtex.zotero.url` | `http://127.0.0.1:23119` | Zotero's local server, for Cite from Zotero. Change it for Juris-M (port 24119) or a remote window. |
| `overtex.texlab.enabled` | `true` | Run the TexLab language server. |
| `overtex.texlab.chktex` | `false` | Show ChkTeX style warnings while typing (through TexLab). |
| `overtex.build.onSave` | `true` | Build when a `.tex` or `.bib` file is saved. |
| `overtex.viewer.autoOpen` | `true` | Open the preview after a successful build. |
| `overtex.viewer.colorScheme` | `light` | `light`, `dark` (inverted pages) or `auto` (dark with a dark theme). |
| `overtex.highlights.enabled` | `true` | Highlight TODO notes and dim `\iffalse` and `comment` blocks. |
| `overtex.mathPreview.enabled` | `true` | Show rendered math when hovering over it. |
| `overtex.mathPreview.scale` | `1` | Size of the math preview. |
| `overtex.wordCount.enabled` | `true` | Show the word count in the status bar. |
| `overtex.wordCount.goal` | `0` | Word target; `0` means none. |
| `overtex.submission.pageLimit` | `0` | Page limit for **Check Submission**; `0` means none. |
| `overtex.submission.anonymous` | `false` | Also look for author information, for double-blind review. |

## LaTeX Workshop

If LaTeX Workshop is installed and both extensions build on save, every save would run TeX twice. Overtex detects this and offers to turn off either LaTeX Workshop's auto-build or its own build on save.

## Workspace Trust

latexmk can run code from a project's `.latexmkrc`, so in an [untrusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust) Overtex does not build, clean, compare versions or start TexLab, and ignores workspace values of `overtex.latex.latexmkPath`, `overtex.latex.extraArgs`, `overtex.synctex.path`, `overtex.latexdiff.path`, `overtex.texlab.path` and `overtex.zotero.url`. Opening an existing PDF still works. Trust the folder to enable building.

## Development

```bash
npm ci
npm run build       # bundle the extension and the PDF viewer into out/
npm run typecheck
npm test            # unit tests (vitest)
npm run test:e2e    # runs VS Code with the extension; needs latexmk and synctex on PATH
```

After a build, `code --extensionDevelopmentPath="$PWD" path/to/project` opens a VS Code window that runs this checkout. Bugs and ideas go to [GitHub Issues](https://github.com/tansuasici/Overtex/issues); see the [changelog](CHANGELOG.md) for what changed in each release.

## License

MIT. Bundles PDF.js and MathJax (both Apache-2.0); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
