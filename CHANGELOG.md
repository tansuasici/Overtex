# Changelog

## Unreleased

- TexLab language server integration: live diagnostics while typing, completion for commands, environments, labels and citations, hover and go to definition. Optional; starts only in trusted workspaces and stays off when the TexLab extension is installed. New settings `overtex.texlab.enabled`, `overtex.texlab.path`, `overtex.texlab.chktex`.

## 0.1.0

- Build with latexmk (pdfLaTeX, XeLaTeX, LuaLaTeX), automatic BibTeX/Biber passes, build on save, cancel.
- Errors and warnings from the TeX log in the Problems panel.
- Built-in PDF preview (PDF.js) that keeps its scroll position across rebuilds.
- SyncTeX forward search (editor → PDF) and inverse search (⌘/Ctrl+click in the PDF → editor).
- Main file detection: setting, `% !TEX root`, `\documentclass`, workspace search.
- Citation key completion from the workspace's `.bib` files.
- Workspace Trust: building and cleaning are disabled in untrusted workspaces.
- Detects a double build with LaTeX Workshop and offers to turn off one of the two.
