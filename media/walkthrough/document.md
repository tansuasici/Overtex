# Open or create a LaTeX document

Open a folder that contains your `.tex` files. Overtex finds the main document by itself: the file with `\documentclass`, or the one a `% !TEX root = main.tex` comment points to.

**New Document** starts from a template: Article, Thesis or Report (chapters in separate files), Presentation (Beamer) or Letter. The files go into the open folder, or into a new subfolder if they would overwrite something. With no folder open, a one-file template opens as an untitled document and the others ask where to create the project.

To pin the main file, set `overtex.latex.mainFile`.
