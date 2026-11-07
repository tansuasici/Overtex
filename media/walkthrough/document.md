# Open or create a LaTeX document

Open a folder that contains your `.tex` files. Overtex finds the main document by itself: the file with `\documentclass`, or the one a `% !TEX root = main.tex` comment points to.

**New Document** creates `main.tex` in the open folder from a small template. With no folder open, it opens an untitled document instead.

To pin the main file, set `overtex.latex.mainFile`.
