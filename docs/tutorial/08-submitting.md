# Lesson 8: Submitting

**You will:** check the paper for the things reviewers and arXiv reject, and make the file you upload to arXiv.

**Time:** 15 minutes.

## Step 1: Use the venue's template

Conferences and journals give you a LaTeX template: a class file (`.cls`) or style file (`.sty`), a bibliography style (`.bst`) and an example paper. Their rules on fonts, margins and page count are built into those files, so use them from the start, or at least well before the deadline.

To move your paper into a template:

1. Copy the template's files into your paper's folder.
2. Replace your `\documentclass{article}` and the lines the template's example has in its preamble with the template's.
3. Change `\bibliographystyle{plain}` to the style the template names.
4. Save, and fix what the build reports ([Lesson 6](06-fixing-errors.md)). If the template's class needs a package you do not have, **Check LaTeX Installation** finds it.

## Step 2: Tell Overtex the rules

Open the settings (`⌘,` / `Ctrl+,`), search for `overtex.submission`, and set:

- **Page Limit** to the venue's limit, for example `8`. Overtex counts every page of the PDF, references included, so if the venue does not count references, add their pages to the limit.
- **Anonymous** on, if the venue uses double-blind review, where reviewers must not know who the authors are.

Set them for this workspace (the **Workspace** tab in the settings), since each paper has its own rules.

## Step 3: Check the paper

Run **Overtex: Check Submission**. It builds the paper and lists, in the Problems panel:

- more pages than the limit;
- the `draft` class option left on;
- undefined references and citations (`??`);
- bitmap fonts, which look blurry and that some venues reject;
- `\todo`, TODO and FIXME left in the text, and PDF notes not marked done.

With **Anonymous** on, it also points at author names, affiliations, `\thanks`, acknowledgments and the author name stored in the PDF's properties.

Fix each one, run the check again, and repeat until the list is empty.

## Step 4: Name the version you submit

Open the **History** view, right-click the newest snapshot, choose **Name Snapshot** and call it `Submitted`. When the reviews come back months later, you can open exactly the PDF you sent and compare it with your revision.

## Step 5: Export for arXiv

arXiv wants your LaTeX sources, not just the PDF, and builds the paper itself. Collecting the right files by hand is error-prone.

Run **Overtex: Export for arXiv**. It builds the paper and writes `main-arxiv.zip` next to `main.tex`, containing exactly the files TeX used:

- your `.tex` files, with comments removed, because arXiv publishes the source and comments often hold things you did not mean to publish;
- your figures and any local `.sty` and `.cls` files;
- the `.bbl` file, your formatted bibliography, because arXiv does not run BibTeX.

It leaves out build leftovers, unused files and your notes. If it warns about something arXiv may reject, the message says what.

Upload `main-arxiv.zip` on arXiv's submission page and check the PDF arXiv builds before you confirm.

## You have finished the tutorial

You can now write, cite, illustrate, fix, share and submit a paper. From here:

- The [guides](../README.md#guides) cover every feature in detail, including the ones this tutorial skipped: spelling and grammar checking, word count, to-dos, Zotero, slides, Docker and Tectonic builds.
- [Commands](../reference/commands.md) and [Settings](../reference/settings.md) list everything Overtex can do and how to change it.
- Found a bug or have an idea? [Open an issue](https://github.com/tansuasici/Overtex/issues).

## Check yourself

- [ ] **Check Submission** reports nothing.
- [ ] The History view has a snapshot named `Submitted`.
- [ ] `main-arxiv.zip` exists and contains `main.tex` and a `.bbl` file.

---

**Previous:** [Lesson 7: Working with co-authors](07-co-authors.md) · **Back to the [tutorial overview](README.md)**
