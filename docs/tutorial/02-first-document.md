# Lesson 2: Your first document

**You will:** create a paper from a template, learn what each part of a LaTeX file does, build it, and jump between the source and the PDF.

**Time:** 15 minutes.

## How LaTeX works

In a word processor you format text as you see it. In LaTeX you write plain text with commands that describe the **structure** ("this is a section title", "this is an equation"), and TeX decides how it looks. You **build** the file to get a PDF.

Overtex builds every time you save, so in practice you type on the left and see the PDF on the right.

## Step 1: Make a folder for the paper

Each paper lives in its own folder, because building creates helper files next to your source.

1. Create an empty folder somewhere, for example `my-paper` in your Documents.
2. In VS Code, choose **File > Open Folder…** and open it.
3. When VS Code asks **Do you trust the authors of the files in this folder?**, choose **Yes, I trust the authors**. Overtex does not build in an untrusted folder, because a LaTeX project can run programs during the build. You made this folder yourself, so it is safe. [Why this matters](../privacy.md#workspace-trust).

## Step 2: Create the paper from a template

Run **Overtex: New LaTeX Document** and choose **Article**.

Overtex creates two files in the folder and opens `main.tex`:

- `main.tex`, your paper;
- `refs.bib`, your bibliography, with one example book in it.

## Step 3: Read the file

`main.tex` starts like this:

```latex
\documentclass{article}
\usepackage{amsmath}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Untitled}
\author{}
\date{\today}

\begin{document}
\maketitle
```

A LaTeX file has two parts.

**The preamble** is everything before `\begin{document}`. Nothing in it is printed; it sets the document up.

- `\documentclass{article}` picks the kind of document. A **class** sets the page size, fonts and headings. `article` is the standard one for papers; journals and conferences ship their own classes.
- `\usepackage{…}` loads a **package**, an add-on. `amsmath` adds better math, `graphicx` adds images and `hyperref` makes references and URLs clickable in the PDF.
- `\title`, `\author` and `\date` store the title information.

**The body** is everything between `\begin{document}` and `\end{document}`. This is what is printed.

- `\maketitle` prints the title, author and date stored above.
- `\begin{abstract} … \end{abstract}` is an **environment**: a block with a beginning and an end that is formatted in a special way.
- `\section{Introduction}` starts a numbered section.

A few characters are special in LaTeX: `\` starts a command, `{ }` group things, `%` starts a comment (the rest of the line is ignored), and `$` starts and ends math. To print them, write `\%`, `\$`, `\{` and `\}`.

## Step 4: Build

1. Change `\title{Untitled}` to a title of your own, and put your name in `\author{}`.
2. Save with `⌘S` / `Ctrl+S`.

The status bar at the bottom shows that the build is running. After a few seconds the PDF opens beside the editor.

> **Nothing happened?** Run **Overtex: Show Build Log** to see what TeX printed, and see [Lesson 6](06-fixing-errors.md).

Look at the folder in the Explorer: besides `main.pdf`, there are files such as `main.aux`, `main.log` and `main.synctex.gz`. TeX needs these between runs. You can ignore them; **Overtex: Clean Auxiliary Files** removes them.

## Step 5: Write something

Under `\section{Introduction}`, replace the line that starts with "Start writing here" with a paragraph of your own. Leave an empty line, then write a second paragraph. Keep the line with `\cite{knuth1984}`; you will need it in Lesson 4.

```latex
\section{Introduction}
This is my first paper written with LaTeX.
Lines next to each other join into one paragraph.

An empty line starts a new paragraph.
Citations come from \texttt{refs.bib}~\cite{knuth1984}.
```

Save, and look at the PDF. Notice that:

- line breaks in the source do not matter; only an empty line starts a new paragraph;
- TeX chooses the line breaks and hyphenation in the PDF itself.

## Step 6: Jump between source and PDF

With long documents, finding "where is this sentence in the PDF?" gets tedious. SyncTeX does it for you.

- **Source to PDF:** put the cursor in your paragraph and press `⌘⌥J` / `Ctrl+Alt+J`. The PDF scrolls to that spot and highlights it.
- **PDF to source:** hold `⌘` (macOS) or `Ctrl` and click a word in the PDF. The editor jumps to that word.

## Step 7: Find your way around the preview

- Zoom with the toolbar, or with `⌘`/`Ctrl` and the mouse wheel.
- The preview keeps your place when the PDF is rebuilt.
- Drag the preview's tab to put it anywhere, or use **Move PDF Preview to New Window** to put it on a second screen.
- The ◐ button shows dark pages, which is easier on the eyes at night.

## Check yourself

- [ ] Saving `main.tex` updates the PDF.
- [ ] `⌘⌥J` / `Ctrl+Alt+J` shows the cursor's place in the PDF.
- [ ] `⌘`/`Ctrl`+click in the PDF takes you back to the source.
- [ ] You can tell which part of `main.tex` is the preamble and which is the body.

---

**Previous:** [Lesson 1: Set up](01-setup.md) · **Next:** [Lesson 3: Structure and math](03-structure-and-math.md)
