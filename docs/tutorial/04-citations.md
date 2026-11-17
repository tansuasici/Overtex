# Lesson 4: Citations

**You will:** learn how LaTeX keeps references in a separate file, cite a real paper from its arXiv ID, and check your bibliography for mistakes.

**Time:** 15 minutes. You need an internet connection.

## How citations work

You do not type reference lists by hand. Instead:

1. Each paper you cite is an **entry** in a `.bib` file, with its authors, title, year and so on.
2. Each entry has a short name, its **key**, such as `knuth1984`.
3. In the text you write `\cite{knuth1984}`. LaTeX prints a number like [1] and adds the paper to the reference list at the end, formatted in the style you chose.

## Step 1: Look at the bibliography you already have

Open `refs.bib` from the Explorer. The template put one entry in it:

```bibtex
@book{knuth1984,
  author = {Knuth, Donald E.},
  title = {The {\TeX}book},
  publisher = {Addison-Wesley},
  year = {1984}
}
```

Your introduction already cites it with `\cite{knuth1984}`, which is why the PDF ends with a **References** list holding this book.

`@book` is the entry type, `knuth1984` is the key, and the lines below are fields. Other common types are `@article`, `@inproceedings` and `@misc`.

Now look at the end of `main.tex`:

```latex
\bibliographystyle{plain}
\bibliography{refs}
```

- `\bibliography{refs}` says which `.bib` file to use (without the `.bib`) and prints the reference list here.
- `\bibliographystyle{plain}` picks the look: numbered, sorted by author. Conferences and journals tell you which style to use.

Only papers you `\cite` appear in the list. An entry you never cite is left out.

## Step 2: Cite a paper from its arXiv ID

You want to cite the Transformer paper, "Attention Is All You Need". Its arXiv ID is `1706.03762`.

1. In `main.tex`, put the cursor at the end of a sentence in your introduction, for example after "written with LaTeX".
2. Run **Overtex: Add Citation from DOI or arXiv**.
3. Type `arXiv:1706.03762` and press Enter.

Overtex fetches the paper's BibTeX, adds it to `refs.bib` and types `\cite{vaswani2017attention}` at the cursor. The key is made from the first author's name, the year and the first word of the title that is not "a" or "the", so you can guess it later.

Save. The reference list in the PDF now has two papers.

A DOI works the same way: paste `10.1103/PhysRev.47.777`, or a whole `https://doi.org/…` address.

> **What goes online?** Only the ID you typed, sent to doi.org or arXiv. Overtex uses the internet only when you run a command that needs it; [Privacy and security](../privacy.md) lists them all.

## Step 3: Cite several papers at once

Put two keys in one `\cite`, separated by a comma:

```latex
TeX and Transformers have little in common \cite{knuth1984,vaswani2017attention}.
```

Save. The PDF shows both numbers in one bracket.

## Step 4: The Papers panel

Open the **Papers** view in the Overtex sidebar. It lists every entry in your `.bib` files, in two groups: **Cited** and **Not cited**.

- Each cited paper shows how often you cite it, for example `3×`. Expand it to see every place it is cited, with the section, file and line, and the PDF page once the PDF is built. Click a place to jump there.
- The filter icon at the top shows only the papers you do not cite yet.
- Hover over a paper to see its details.
- With the cursor in your text, click the quote icon beside a paper to cite it there.
- Right-click a paper: **Open Paper Page** opens it on the web, and for arXiv papers **Download Paper PDF from arXiv** saves the PDF into a `papers/` folder, so you can read it in the preview.
- **Add Paper** (the + at the top) adds an entry from a DOI or arXiv ID without citing it, for papers you plan to read.

When typing `\cite{` by hand, VS Code suggests keys as you type. Search by author or title words, not only the key.

## Step 5: Check the bibliography

BibTeX data from the internet is often incomplete, and preprints get published later. Run **Overtex: Check Bibliography**.

It looks up each entry's DOI or arXiv ID and reports in the Problems panel (`⇧⌘M` / `Ctrl+Shift+M`):

- entries missing fields their type needs;
- DOIs that do not exist or point to another paper;
- arXiv preprints that have since been published, with the journal version to cite instead;
- papers that have been retracted.

When it says a preprint has been published, citing the published version is usually better: replace the entry with the one from the DOI it gives you, using **Add Citation from DOI or arXiv**.

## Check yourself

- [ ] `refs.bib` has a `vaswani2017attention` entry.
- [ ] The PDF's reference list has two papers, and the text shows their numbers.
- [ ] The Papers view lists both under **Cited**.

---

**Previous:** [Lesson 3: Structure and math](03-structure-and-math.md) · **Next:** [Lesson 5: Figures and tables](05-figures-and-tables.md)
