# Reviewing

Tools for reading a draft critically, alone or with co-authors: notes on the text, Track Changes, comparing versions, review copies of the PDF, and the version history.

## Notes on the text

Notes are comment threads attached to text in a `.tex` file, like comments in Word or Google Docs.

- **Add:** click the **+** beside a line, or select text and run **Overtex: Add Note** (VS Code's **Comments: Add Comment** works too).
- **Answer:** anyone can reply, resolve and reopen a note, or delete a note or a single comment.
- **See all:** the **Notes** view in the Overtex sidebar lists every note in the project.

The author is your `git config user.name` (your system user name in an untrusted workspace), and each comment carries its date.

### Where notes are kept

Notes are saved in `.overtex/notes.json` at the root of the workspace folder. Commit and push that file to share them; [Share Changes](collaboration.md) does it for you. There is no Overtex server.

The file changes only when a note is added, answered, resolved, deleted or attached, never just because you edited the text. That keeps merge conflicts rare. If the file cannot be read (a git conflict left in it, say), notes become read-only and the file is not overwritten until you fix it.

### Notes follow their text

Each note remembers its text and a little of the text around it. After an edit, a pull or a checkout, it moves to where that text is now, picks the nearest place when the text appears more than once, and still finds a sentence after a small change inside it.

A note whose text is gone is listed under **Orphaned** in the Notes view. Select the text it belongs to and choose **Attach to Selection**, or delete it.

These notes are separate from [PDF notes](pdf-preview.md#pdf-notes), which are pinned to a spot on a PDF page.

## Track Changes

Track Changes marks every edit so that you, or a co-author, can accept or reject it.

1. In the **Changes** view, click **Start Tracking Changes**.
2. Edit as usual. Added lines and words are highlighted; removed words are struck through, with the full text on hover.
3. Above each change, **Accept** keeps it and **Reject** undoes it. Reject is one edit, so Undo brings the change back.

The Changes view lists changed, new and deleted files with their number of changes. Click a file for a side-by-side diff, or accept or reject all its changes at once.

**Show Tracked Changes in PDF (latexdiff)** builds a copy of the PDF with the changes marked in color, compared with the text as it was when tracking started, including `\input` files.

**Stop Tracking Changes** removes the marks and keeps the text as it is. The copy of the original text is kept with the version history, outside the project, and is removed when you stop.

## Compare Versions

**Overtex: Compare Versions (latexdiff)** marks up what changed between:

- two git commits;
- a commit and the files on disk;
- two `.tex` files.

Changes in `\input` files are included. It writes `main-diff.pdf` with deleted and added text shown in the PDF; your sources and git state are not touched. It needs [latexdiff](https://ctan.org/pkg/latexdiff), which comes with TeX Live and MiKTeX.

## Export Review PDF

**Overtex: Export Review PDF** writes `main-review.pdf`, a copy to send to co-authors or reviewers, with:

- line numbers, so comments can say "line 132";
- your open PDF notes as margin notes beside the lines they were pinned to;
- if you pick a version, the changes since then marked up as in Compare Versions.

Your sources are not changed; the copy is built in a temporary folder. It uses the `lineno` and `marginnote` packages.

## Export PDF with Notes

**Overtex: Export PDF with Notes** writes `main-notes.pdf`: the PDF as it is now, with your open PDF notes as standard sticky notes. Co-authors can read and answer them in Acrobat, Preview, Zotero or any PDF reader. Nothing is rebuilt and the original PDF is not changed.

## History

After each successful build, Overtex keeps a snapshot of the document's sources (`.tex`, `.bib`, `.sty`, `.cls` and the like in the main file's folder) and its PDF. They are listed in the **History** view, newest first.

| To | Do |
| --- | --- |
| Take a snapshot without building | **Save Snapshot** |
| See what a snapshot changed | Expand it |
| Compare a file with the file now | Click it, or **Compare File with Current** |
| Bring back a file | **Restore This Version** |
| Open the PDF as it was | **Open Snapshot PDF** |
| Mark up all changes since then | **Compare Snapshot with Current (latexdiff)** |
| Keep a snapshot for good | **Name Snapshot**, for example "Submitted" |

Unnamed snapshots past `overtex.history.maxSnapshots` (50) are removed, oldest first; named ones are always kept. A build that changed no source updates the newest snapshot's PDF instead of adding one. Figures are not kept, and `overtex.history.keepPdf` controls whether PDFs are.

Snapshots live in VS Code's storage for the workspace, not in your project folder, and nothing is committed to git. They are your own and are not shared with co-authors.
