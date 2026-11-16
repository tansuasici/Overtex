# Building

Overtex turns your `.tex` sources into a PDF with latexmk, or with Tectonic or Docker if you prefer. This guide covers how it finds the file to build, when it builds, and how to change what builds it.

New to LaTeX? Start with the [tutorial](tutorial/README.md).

## What you need

A TeX distribution that provides `latexmk`, `synctex` and `texcount`: [TeX Live](https://tug.org/texlive/), [MacTeX](https://tug.org/mactex/) or [MiKTeX](https://miktex.org/). MiKTeX also needs Perl for latexmk. Or no distribution at all, with [Tectonic or Docker](#build-tools).

**Overtex: Check LaTeX Installation** looks for latexmk, the selected engine, synctex and TexLab, and says what is missing and how to install it. It notices TeX that is installed but not yet on VS Code's `PATH`, which usually means VS Code needs a restart. With latexmk it also:

- looks up every package and class the open project loads with `kpsewhich`, including those a conference template's own `.cls` or `.sty` asks for, so a missing one shows up before the build fails on it;
- checks that the Times metrics are there for `times`, `mathptmx` and `newtxtext`;
- warns about lineno 5.7, which draws line numbers over the text of two-column pages with LaTeX from June 2025 on.

For what is missing it types the `tlmgr install` command into a terminal, for you to run; it installs nothing itself. MiKTeX's packages are left to MiKTeX Console. If latexmk is missing when Overtex starts, it offers this check once.

## Build

- **On save:** saving a `.tex` or `.bib` file builds the project. Turn this off with `overtex.build.onSave`.
- **By hand:** **Overtex: Build LaTeX Project**, `⌘⌥B` / `Ctrl+Alt+B`.
- **Stop:** **Overtex: Cancel Build**.

One build runs at a time. Saving while a build runs queues one more build; it does not start a second one in parallel.

The status bar shows the build's state. When a build fails, it shows the number of errors; click it to open the build log.

latexmk runs TeX as many times as needed, and runs BibTeX or Biber when the bibliography changed, so cross-references and citations are resolved in one build.

## The main file

A paper split into chapters with `\input` or `\include` has one **main file**, the one with `\documentclass`. Overtex always builds the main file, whichever file you save. It finds it in this order:

1. the `overtex.latex.mainFile` setting, relative to the workspace folder;
2. a magic comment in the first lines of the file you are editing:

   ```latex
   % !TEX root = ../main.tex
   ```

3. the active file, if it has `\documentclass`;
4. a search of the workspace for a file with `\documentclass`.

If your folder holds more than one document, set `overtex.latex.mainFile` or use the magic comment.

## Engines

`overtex.latex.engine` picks the TeX engine latexmk runs:

| Engine | Use it when |
| --- | --- |
| `pdflatex` (default) | Most papers and templates. Fastest. |
| `xelatex` | You need system fonts (`fontspec`) or many non-Latin scripts. |
| `lualatex` | Same as XeLaTeX, and you want Lua scripting or the newest font features. |

When a XeLaTeX, LuaLaTeX or Tectonic build fails on a pdfTeX-only command such as `\pdfoutput`, the error suggests building with pdfLaTeX.

Extra command-line arguments go in `overtex.latex.extraArgs`, for example `["-shell-escape"]` for the `minted` package. A `.latexmkrc` in the project is read as usual.

## Output folder

By default the PDF and the helper files (`.aux`, `.log`, `.synctex.gz`, …) go next to the main file. Set `overtex.latex.outDir` to put them in a folder instead, relative to the main file, for example `build`.

**Overtex: Clean Auxiliary Files** removes the helper files and keeps the PDF.

## Errors and warnings

TeX's errors and warnings go to the **Problems** panel (`⇧⌘M` / `Ctrl+Shift+M`) and are underlined in the editor, at the right file and line, including files pulled in with `\input`. **Overtex: Show Build Log** shows TeX's complete output.

[Lesson 6](tutorial/06-fixing-errors.md) walks through the usual errors, and [Troubleshooting](troubleshooting.md) covers what to do when a build does not finish.

### Stuck builds

A build that prints nothing for five minutes, or keeps printing the same lines, is stopped, and Overtex says why. This catches TeX waiting for input that will never come. Change the time with `overtex.build.stallTimeout`, or set it to `0` to turn it off.

## Build tools

`overtex.latex.tool` says what builds the document. **Overtex: Check LaTeX Installation** looks for what the chosen tool needs, and when nothing is found its **Set Up…** button helps you pick one. Overtex never installs anything by itself.

| Tool | Needs | Good for |
| --- | --- | --- |
| `latexmk` (default) | A TeX distribution: TeX Live, MacTeX or MiKTeX | Everything. All features work. |
| `tectonic` | Only [Tectonic](https://tectonic-typesetting.github.io/) | Little disk space, quick setup |
| `docker` | Docker | A TeX Live you do not install, the same on every machine |

### Tectonic

Tectonic is a single program that downloads the TeX support files a document uses on its first build and caches them. Install it with `brew install tectonic` or from [its installation guide](https://tectonic-typesetting.github.io/book/latest/installation/).

- It always uses XeTeX, so `overtex.latex.engine` does not apply, and pdfLaTeX-only packages may not work.
- **Export for arXiv** and **Check Submission** are not available: they need the list of files TeX read, which Tectonic does not record.
- A build stops at the first error, so you see one error at a time, and the PDF is not updated until it is fixed.
- `.latexmkrc` is not read. `overtex.latex.extraArgs` go to `tectonic -X compile`.
- The first build of a document needs the internet.

### Docker

Overtex runs latexmk inside `overtex.docker.image`, by default `texlive/texlive:latest`. Docker pulls the image on the first build; it takes about 9 GB of disk. Any image that provides latexmk works.

- Only the workspace folder is mounted, so `overtex.latex.outDir` must stay inside it, and files outside it, such as a `texmf` tree in your home folder, are not found.
- The network is off during the build, so a `.latexmkrc` or `-shell-escape` command cannot reach the internet.
- SyncTeX jumps and the word count run on your machine, so they need `synctex` and `texcount` installed there. Compare Versions and the marked-up review PDF need `latexdiff` there too.
- Windows is untested; paths in the build output may not match your files there.

### Programs not on the PATH

If a program is installed somewhere VS Code does not look, give its full path: `overtex.latex.latexmkPath`, `overtex.tectonic.path`, `overtex.docker.path`, `overtex.synctex.path`, `overtex.latexdiff.path` or `overtex.texlab.path`.

## TexLab

[TexLab](https://github.com/latex-lsp/texlab) is an optional helper that checks your LaTeX as you type, before any build, and completes commands, environments, labels and citation keys. Overtex starts it when it is installed (`brew install texlab`, `cargo install texlab` or a release binary). Turn it off with `overtex.texlab.enabled`, or turn on ChkTeX's style warnings with `overtex.texlab.chktex`. If the official TexLab extension is installed, Overtex leaves the language server to it.

## Next to LaTeX Workshop

If LaTeX Workshop is also installed and both build on save, every save runs TeX twice. Overtex notices and offers to turn off one of the two.

## Templates

**Overtex: New LaTeX Document** creates a document from a template in the open folder:

| Template | What you get |
| --- | --- |
| Article | A paper with an abstract and a bibliography (`main.tex` and `refs.bib`) |
| Thesis or Report | Chapters in separate files, a table of contents and a bibliography |
| Presentation | Beamer slides |
| Letter | A formal letter |

**Overtex: Getting Started** opens a short walkthrough on VS Code's Welcome page.
