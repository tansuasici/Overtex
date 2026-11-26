# Lesson 7: Working with co-authors

**You will:** leave notes on the text, track your edits so a co-author can accept or reject them, go back to an earlier version, and share the project.

**Time:** 20 minutes. The last step needs a GitHub or GitLab account.

## How co-authoring works in Overtex

Overtex works on files on your computer. There is no Overtex server and no account. To work together, each co-author keeps a copy of the project, and the copies are kept in step with **git**, the version-control tool most software is written with. You do not need to learn git: Overtex has two commands, **Share Changes** and **Get Changes**, that do the git work for you.

The first steps of this lesson work on your own, without sharing anything.

## Step 1: Leave a note on the text

1. In `main.tex`, move the mouse to the left of a line in your introduction. A **+** appears beside the line number.
2. Click it, write `Should we cite more related work here?` and click **Add Note**.

The note appears under the line, as a thread: a co-author can reply to it, and either of you can **Resolve** it when it is done. The **Notes** view in the Overtex sidebar lists all notes in the project.

You can also select some text and run **Overtex: Add Note** to attach the note to exactly that text. Notes follow their text when it moves.

Notes are saved in `.overtex/notes.json` in your project, so they are shared along with your files in Step 5. They never appear in the PDF.

## Step 2: Track your changes

When you edit a co-author's text, they want to see what you changed, like Track Changes in Word.

1. Open the **Changes** view in the Overtex sidebar and click **Start Tracking Changes**.
2. In `main.tex`, change a word in your introduction and delete another sentence.

Your edits are marked: added text highlighted, removed text struck through. Above each change are **Accept** and **Reject**.

3. Reject one change. The original text comes back.
4. Run **Overtex: Show Tracked Changes in PDF (latexdiff)**. It builds a copy of the PDF with your changes marked in color, for co-authors who read PDFs rather than LaTeX.
5. When you are done reviewing, click **Stop Tracking Changes** in the Changes view. Your text stays as it is; only the marks go away.

## Step 3: Go back in time

Every time your paper builds, Overtex keeps a snapshot of its sources and PDF. Open the **History** view in the Overtex sidebar.

- Expand a snapshot to see which files changed in it. Click a file to compare that version with the file now, and choose **Restore This Version** to bring it back.
- Right-click a snapshot and choose **Name Snapshot**, for example "First draft". Named snapshots are kept; old unnamed ones are removed after a while.

History is kept on your computer only, not in the project folder, and is not shared.

## Step 4: Share the project

This step puts your project online as a **private** copy that only you and the people you invite can see.

1. Run **Overtex: Share Changes**.
2. Overtex says the folder is not set up for sharing yet and offers **Set Up**. Choose it. This starts keeping versions of your files with git.
3. Overtex asks where to make a private copy, GitHub or GitLab, and to sign in. Use VS Code's own sign-in when it asks.
4. It asks whether to leave build files such as `main.aux` and `main.pdf` out. Choose **Leave Out**: your co-authors build those themselves.
5. Type a short description of what you changed, for example `First draft`, or just press Enter.

Your project is now online. The status bar shows how many changes there are to send (↑) and to get (↓).

## Step 5: Invite a co-author

Run **Overtex: Invite Co-author** and type your co-author's GitHub username. GitHub emails them an invitation. In VS Code with Overtex they run **Overtex: Pending Invitations**, or click the envelope in the status bar, and choose **Join**: Overtex accepts the invitation, gets the project and opens it. See [Joining a project](../collaboration.md#joining-a-project-you-were-invited-to).

From then on, the routine is simple:

- **Before you start writing:** run **Overtex: Get Changes** to get your co-authors' work.
- **When you have done some work:** run **Overtex: Share Changes**, or click the status bar item.

If you both changed the same lines, Overtex does not overwrite anything. It opens the file with both versions marked so you can choose, and you share again.

> **Different accounts, different hosts?** If your co-author is on GitLab, or you do not want to give each other access to your accounts, use invite codes instead: see [Working with co-authors](../collaboration.md). The same guide explains how to work on a project that lives on Overleaf.

## Check yourself

- [ ] Your note appears in the Notes view.
- [ ] You saw an edit marked, and rejected one.
- [ ] The History view has snapshots from your builds.
- [ ] (If you shared the project) the status bar shows the sharing status.

---

**Previous:** [Lesson 6: When something goes wrong](06-fixing-errors.md) · **Next:** [Lesson 8: Submitting](08-submitting.md)
