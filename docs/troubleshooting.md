# Troubleshooting

Start with **Overtex: Check LaTeX Installation**: it finds most setup problems and says how to fix them. For errors in your own LaTeX, see [Lesson 6](tutorial/06-fixing-errors.md).

## Nothing builds

- **Is the folder trusted?** In an untrusted workspace Overtex does not build. Trust the folder; see [Workspace Trust](privacy.md#workspace-trust).
- **Is there a main file?** Overtex builds the file with `\documentclass`. If the folder has none, or more than one, set `overtex.latex.mainFile` or add `% !TEX root = main.tex` at the top of your other files. See [The main file](building.md#the-main-file).
- **Is build on save off?** Check `overtex.build.onSave`, or build by hand with `⌘⌥B` / `Ctrl+Alt+B`.

## TeX is not found after installing it

VS Code reads the `PATH` when it starts, so a TeX distribution installed while it was open is not seen. **Quit VS Code completely and open it again.** Check LaTeX Installation tells you when TeX is installed but not on VS Code's `PATH`.

If TeX is installed somewhere unusual, give the full path to latexmk in `overtex.latex.latexmkPath` (and to the other programs in their `….path` settings).

## A package or class is missing

The build says a `.sty` or `.cls` file was not found.

1. Run **Check LaTeX Installation**. It lists every package and class your project loads that is missing, including those a conference template's own class asks for.
2. With TeX Live or MacTeX, it types the `tlmgr install` command into a terminal. Read it and press Enter. With MiKTeX, install the package from MiKTeX Console.
3. If the file belongs to a conference or journal template, it is not in TeX Live: copy it from the template into your paper's folder.

With TeX Live, `tlmgr` may need `sudo`, or `tlmgr update --self` first if it says it is out of date.

## The build never finishes

A build that prints nothing for five minutes, or keeps printing the same lines, is stopped as stuck, and Overtex says why. Usually TeX stopped to ask for input, for example after a file it could not find. Read the end of **Show Build Log**.

Stop a build yourself with **Overtex: Cancel Build**. Change the time limit with `overtex.build.stallTimeout`.

## The build fails with no clear error

- Open **Show Build Log** and search for lines starting with `!`.
- Run **Clean Auxiliary Files** and build again. A broken `.aux` file from an interrupted build can keep failing.
- If XeLaTeX, LuaLaTeX or Tectonic fails on `\pdfoutput` or another pdfTeX-only command, build with pdfLaTeX (`overtex.latex.engine`).

## The preview stays empty or old

- The preview shows the last PDF that built. If the latest build failed, fix the errors in the Problems panel.
- Run **Overtex: View PDF** (`⌘⌥V` / `Ctrl+Alt+V`) to open it by hand.
- With `overtex.latex.outDir` set, the PDF is in that folder.

## SyncTeX jumps to the wrong place

- Build again: the SyncTeX map is written by each build, so it is wrong after edits that have not been built yet.
- Jumps need the `synctex` program. Check LaTeX Installation looks for it; with Docker, it must be installed on your machine too.
- Text that a macro produces, or text from an included PDF, maps only roughly.

## `??` in the PDF

An undefined reference or citation. Check the **Labels** view's **Undefined references** for the key; for citations, check that the key is in your `.bib` file and that the bibliography commands are in the document. See [Lesson 6](tutorial/06-fixing-errors.md#step-4-undefined-references).

## Every save builds twice

LaTeX Workshop is building on save too. Overtex offers to turn one of them off; see [Next to LaTeX Workshop](building.md#next-to-latex-workshop).

## Share Changes does not work

- The folder needs git and an online copy. Share Changes offers to set both up.
- Sign in with VS Code's Accounts menu when it asks.
- A conflict stops the share until you pick a version in the marked file; see [Conflicts](collaboration.md#conflicts).

## Still stuck?

[Open an issue](https://github.com/tansuasici/Overtex/issues) with what you did, what you expected, and the relevant part of **Show Build Log**. Do not paste tokens or anything private.
