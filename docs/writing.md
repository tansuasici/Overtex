# Writing

The editor features that help while you type: checking and completion, math preview and symbols, labels and references, figures and tables, to-dos, word count and grammar.

## Checking and completion with TexLab

When [TexLab](https://github.com/latex-lsp/texlab) is installed, Overtex starts it and you get, before any build:

- errors such as unbalanced braces, mismatched `\begin`/`\end` and undefined references, as you type;
- completion of commands, environments, `\ref` labels and `\cite` keys;
- hover and go to definition.

Install it with `brew install texlab`, `cargo install texlab` or a release binary on your `PATH`. `overtex.texlab.chktex` adds ChkTeX's style warnings. See [Building](building.md#texlab) for the other settings.

Without TexLab, Overtex still completes citation keys inside `\cite{…}` from the workspace's `.bib` files, searchable by key, title and author.

## Math

### Math preview

Hover over math to see it rendered with MathJax: `$…$`, `\(…\)`, `\[…\]`, `$$…$$`, `equation`, `align`, `gather` and the like. Macros you define with `\newcommand`, `\DeclareMathOperator` or `\def` in the file or the main file are used. A mistake shows MathJax's error message.

MathJax does not load LaTeX packages, so commands from packages it does not know show as undefined in the preview, even when the PDF is fine.

`overtex.mathPreview.enabled` turns it off and `overtex.mathPreview.scale` changes its size.

### Math Symbols

The **Math Symbols** view in the Overtex sidebar has 255 symbols in ten groups. Search by command (`\leq`), character (`≤`), name ("less or equal"), keyword or group.

Click a symbol to insert it in the last LaTeX editor. Outside math it is wrapped in `$…$`, and commands with arguments, such as `\frac{}{}`, get tab stops. The symbols you use most come first.

When a symbol needs `amssymb`, `amsfonts`, `amsmath`, `mathtools` or `mathrsfs` and the document does not load it or a package that provides it, Overtex offers to add the `\usepackage`.

**Overtex: Insert Math Symbol** does the same from a quick pick, without the sidebar.

## Labels and references

### Reference hover

Hover over the key in `\ref`, `\eqref`, `\cref` and the like to see the number and page LaTeX gave it in the last build, for example "Equation (3), page 5", with the equation rendered. A key no `\label` defines, or one added since the last build, says so.

### The Labels panel

The **Labels** view lists every `\label` in the workspace's `.tex` files by kind: sections, figures, tables, equations, theorems and code, with **Undefined references** at the top.

Each row shows how often the label is referenced, or that it is unused, and warns when it is defined more than once. Expand a row to see each definition and reference, and click one to go there.

- **Insert Reference** (the inline button) inserts `\ref{…}` at the cursor.
- **Rename Label** renames the label and every reference to it, in closed files too. Renaming an undefined reference fixes a typo in one step.

`\cref`, `\autoref`, `\hyperref[…]` and similar count as references; comments and verbatim text are skipped.

Go to definition, find references and F2 rename also work on labels in the editor. With TexLab running, they follow TexLab's project (the files linked by `\input`); the panel's own rename covers the whole workspace.

Limits: the panel reads every `.tex` file in the workspace, so unrelated documents in one folder are counted together, and it does not see labels from `\externaldocument` or keys built with macros.

## Figures and tables

| To insert | Do |
| --- | --- |
| A figure | **Overtex: Insert Figure**, or drag a `.png`, `.jpg`, `.pdf` or `.eps` into the editor while holding Shift |
| A table from a file | **Overtex: Insert Table from CSV**, or Shift-drag a `.csv` or `.tsv` file |
| A table from a spreadsheet | Paste the cells, select them, and run **Insert Table from CSV** |

Both get a caption and a unique `\label` to fill in. `\usepackage{graphicx}` or `\usepackage{booktabs}` is added to the main file's preamble when missing.

- **Figures:** an image from outside the main file's folder is copied into `figures/` there.
- **Tables:** special characters are escaped, number columns are right-aligned, and semicolon files with decimal commas (`1,5`) are read correctly.

Undo takes the inserted text back out but leaves a copied image in `figures/`. [Lesson 5](tutorial/05-figures-and-tables.md) walks through both.

## To-dos and highlights

**To-dos:** every `\todo{…}` and `\fixme{…}` in the workspace (from the [todonotes](https://ctan.org/pkg/todonotes) and fixme packages) gets a mark in the gutter and is listed in the **To-dos** view by file. Click one to go there. Options such as `\todo[inline]{…}` and notes over several lines are read; commands in comments, `\iffalse … \fi` and `comment` environments are left out.

**Highlights:** `TODO`, `FIXME` and `XXX` comments and `\todo{…}` notes stand out in the editor and the scroll bar, and text TeX skips (`\iffalse … \fi`, `comment` environments) is dimmed. Change the color with `overtex.todoBackground` in `workbench.colorCustomizations`, or turn it off with `overtex.highlights.enabled`.

## Word count

The status bar shows the word count, counted with `texcount` across `\input` and `\include` files after each successful build. Set `overtex.wordCount.goal` to see progress, such as `1,234 / 5,000 words`. The tooltip splits text, headings and captions, and shows how many words you added this session.

**Overtex: Count Words** counts on demand. `overtex.wordCount.enabled` hides it.

## Spelling and grammar

**Overtex: Check Spelling and Grammar** checks the English of the active `.tex` file with [Harper](https://github.com/Automattic/harper), which runs inside Overtex: nothing to install, and the text never leaves your computer.

Only prose is checked. The preamble, comments, math, `\cite` and `\ref` keys, code and tables are left out; section titles, captions, footnotes and `\emph{…}` text are checked.

Findings go to the Problems panel. Their quick fixes apply a suggestion, add the word to `overtex.grammar.dictionary`, or turn the rule off (`overtex.grammar.disabledRules`).

The language comes from babel, polyglossia or the class options, or from `overtex.grammar.language`. American, British, Australian, Canadian and Indian spelling are told apart.

### Other languages

Harper checks only English. For other languages, run a [LanguageTool](https://languagetool.org/) server on your computer and set `overtex.grammar.engine` to `languagetool`:

```bash
brew install languagetool
brew services start languagetool
```

That server listens on port 8081, the default of `overtex.grammar.url`. With Docker instead:

```bash
docker run -d -p 8010:8010 erikvl87/languagetool
```

and set `overtex.grammar.url` to `http://localhost:8010`. Your text goes only to the address in `overtex.grammar.url`. Neither engine checks Turkish.

`overtex.grammar.checkOnSave` checks on each save. Setting the engine to `off` turns checking off.
