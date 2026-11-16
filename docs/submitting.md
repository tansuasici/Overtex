# Submitting

Two commands for the end of a paper: one to catch what reviewers and arXiv reject, one to make the file arXiv wants. [Lesson 8](tutorial/08-submitting.md) walks through them.

## Check Submission

**Overtex: Check Submission** builds the project and lists, in the Problems panel:

- more pages than `overtex.submission.pageLimit`;
- the `draft` class option;
- undefined references and citations (`??`);
- bitmap (Type 3) fonts;
- `\todo`, TODO and FIXME left in the text;
- [PDF notes](pdf-preview.md#pdf-notes) not marked done.

With `overtex.submission.anonymous` on, for double-blind review, it also points at author names, affiliations, `\thanks`, acknowledgments and the `pdfauthor` property.

Findings are cleared by the next build. Fonts inside included PDF figures are not checked.

### Settings

Set these per paper, in the **Workspace** tab of the settings:

| Setting | Default | |
| --- | --- | --- |
| `overtex.submission.pageLimit` | `0` | Page limit; `0` means none. Every page counts, references included. |
| `overtex.submission.anonymous` | `false` | Also look for author information. |

If the venue does not count references toward the limit, add their pages to the number you set.

## Export for arXiv

**Overtex: Export for arXiv** builds the project and writes `main-arxiv.zip` beside the main file, with exactly the files TeX read:

- your `.tex` sources, with comments removed, since arXiv publishes the source;
- figures, and local `.sty` and `.cls` files;
- the generated `.bbl`, since arXiv does not run BibTeX.

Build leftovers, unused files and PDF notes are left out. For pdfLaTeX projects, `\pdfoutput=1` is added.

It warns about things arXiv may reject:

- a `.bbl` made by Biber;
- a missing `.bbl`;
- a XeLaTeX or LuaLaTeX build;
- inputs from outside the main file's folder.

Check Submission and Export for arXiv need latexmk (directly or in Docker). They are not available with Tectonic; see [Building](building.md#tectonic).

## Before you press submit

1. Run **Check Bibliography** ([Bibliography](bibliography.md#check-bibliography)).
2. Run **Check Submission** until it reports nothing.
3. Name the snapshot you submit in the History view, for example "Submitted" ([History](reviewing.md#history)).
4. For arXiv, upload `main-arxiv.zip` and check the PDF arXiv builds before you confirm.
