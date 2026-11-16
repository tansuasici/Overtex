# Bibliography

How to add papers to your `.bib` file, cite them, keep the file correct, and keep the papers' PDFs at hand. If you have never used BibTeX, [Lesson 4](tutorial/04-citations.md) explains it first.

## Add a citation from a DOI or arXiv ID

**Overtex: Add Citation from DOI or arXiv** takes:

- a DOI, such as `10.1103/PhysRev.47.777`;
- an arXiv ID, such as `arXiv:1706.03762`, or its `arxiv.org/abs/…` address.

Overtex fetches the BibTeX from doi.org, adds it to your `.bib` file with a readable key, and inserts `\cite{…}` at the cursor.

The key is the first author's surname, the year and the first important word of the title, for example `vaswani2017attention`. If that key is taken, a letter is added: `vaswani2017attentiona`.

This is one of the few features that uses the internet; see [Privacy](privacy.md).

## Cite from Zotero

If you keep your papers in [Zotero](https://www.zotero.org/), install its [Better BibTeX](https://retorque.re/zotero-better-bibtex/) add-on and keep Zotero running. Then **Overtex: Cite from Zotero**:

1. opens Zotero's picker;
2. adds what you pick to your `.bib` file under the citation keys Zotero shows;
3. inserts `\cite{…}` at the cursor.

Papers already in the `.bib` are reused, and local attachment paths are left out. It talks only to Zotero on your computer, at `overtex.zotero.url` (`http://127.0.0.1:23119`; use port 24119 for Juris-M).

## Citation completion

Inside `\cite{…}`, completion offers the keys of the workspace's `.bib` files, searchable by key, title and author. With TexLab installed, TexLab provides it.

## The Papers panel

The **Papers** view in the Overtex sidebar lists the papers in the workspace's `.bib` files, grouped into **Cited** and **Not cited**. Sort by year, author or title with the sort button, and filter with `⌘F` / `Ctrl+F` in the panel.

| Action | Where |
| --- | --- |
| Cite the paper at the cursor | Inline quote button, or right-click |
| Open its PDF | Click it (without a PDF, this shows its `.bib` entry), or right-click → **Open Paper PDF** |
| Download its PDF from arXiv | Inline download button |
| Show its entry in the `.bib` | Right-click → **Show Paper in Bibliography** |
| Open its page on the web | Right-click → **Open Paper Page** |
| Add a paper | **Add Paper** (+) in the title bar |

**Add Paper** takes a DOI, an arXiv ID, or BibTeX from the clipboard. Local attachment paths in pasted BibTeX are left out.

### Where paper PDFs come from

A paper's PDF is taken from its `file` field (as Zotero, JabRef and Mendeley write it, or a plain path), otherwise from `papers/<key>.pdf` beside the `.bib` file. The download button saves arXiv PDFs there. Whether `papers/` goes into git is up to your `.gitignore`.

A paper opens in the same tab as your draft's preview; the draft comes back on the next build or **View PDF**.

## Check Bibliography

**Overtex: Check Bibliography** checks the `.bib` file in the editor, or the ones the main file names, for:

- entries missing fields their type needs;
- DOIs that do not exist, point at a different paper, or repeat another entry's DOI;
- arXiv preprints that have since been published, with the journal and DOI to cite instead;
- retracted papers (an error), expressions of concern (a warning), and corrections or newer versions (a note), with the date, DOI and a link to the notice.

It looks DOIs up on doi.org (Crossref and DataCite, including Retraction Watch notices) and arXiv IDs on the arXiv API. Findings go to the Problems panel. Entries that could not be reached are marked as unchecked, not as wrong.

Run it before you submit. Many venues also ask that a published version be cited instead of its preprint.
