# The PDF preview

Overtex shows the PDF in a tab beside your source. It reloads after each build, keeps your place, and links every spot in the PDF to the line that made it.

## Open and place the preview

- The preview opens by itself after a successful build. Turn that off with `overtex.viewer.autoOpen`.
- **Overtex: View PDF**, `⌘⌥V` / `Ctrl+Alt+V`, opens it by hand.
- Drag its tab to any split, like any editor tab.
- **Move PDF Preview to New Window** (the window button in its tab bar) puts it in a window of its own, for a second screen.

The preview stays where you put it, and after a window reload it comes back with the same PDF and page.

## SyncTeX: jump between source and PDF

SyncTeX is a map, written by each build, from places in the PDF to lines in your source.

- **Source to PDF:** put the cursor on a line and press `⌘⌥J` / `Ctrl+Alt+J` (**SyncTeX: Jump to PDF**). The preview scrolls to that spot and marks it.
- **PDF to source:** hold `⌘` (macOS) or `Ctrl` and click in the PDF. The editor opens the file and puts the cursor on the word you clicked.
- **Follow the Outline:** go to a heading from the Outline view, the breadcrumbs or **Go to Symbol** (`⌘⇧O` / `Ctrl+Shift+O`), and the open preview scrolls to it. If the PDF is older than your source, Overtex builds first, which saves your unsaved files. Moving the cursor with the keyboard or mouse does not scroll the preview, and nothing opens a closed preview.

Jumps need the `synctex` program, which comes with TeX Live, MacTeX and MiKTeX. If a jump lands on the wrong line, see [Troubleshooting](troubleshooting.md#synctex-jumps-to-the-wrong-place).

## Find in the PDF

Press `⌘F` / `Ctrl+F` in the preview, or click the magnifier in its toolbar, and type. Every match is highlighted, the count shows where you are ("2 / 7"), and the preview scrolls to the first match from the page you are on.

- `Enter` and `Shift+Enter` go to the next and previous match, as do `F3` and `Shift+F3` (and `⌘G` / `⇧⌘G` on a Mac). The arrows in the bar do the same.
- **Aa** matches case, and **ab** matches whole words only.
- `Esc` closes the bar and clears the highlights.

Search reads the text in the PDF, so a word split by a hyphen at the end of a line, or one set with a ligature such as "fi", is still found. Without **Aa**, Turkish ı, i, I and İ all match each other. After a rebuild the same search runs again on the new PDF.

## Dark pages

The ◐ button in the preview's toolbar, or **Toggle Dark PDF Preview**, shows light text on a dark gray page. Colors keep their hue, but figures and photos are inverted too.

`overtex.viewer.colorScheme` sets it for good: `light`, `dark`, or `auto` to follow the VS Code theme. It only changes how the preview looks; the PDF file is not changed.

## Present slides

The ▭ button in the toolbar, or **Present PDF as Slides**, shows one page at a time on black, fit to the preview. It is meant for Beamer talks but works with any PDF.

| Key | Does |
| --- | --- |
| → ↓ Space Page Down Enter, or a click | Next slide |
| ← ↑ Page Up Backspace | Previous slide |
| Home / End | First / last slide |
| Esc | Stop presenting |

A rebuild keeps the slide you are on, and **SyncTeX: Jump to PDF** shows the slide for the line the cursor is on.

**For a projector:** run **Move PDF Preview to New Window**, move that window to the projector, and make it full screen with **View: Toggle Full Screen**.

## PDF notes

PDF notes are sticky notes pinned to a spot on a PDF page, for your own reading and reviewing.

- **Add:** double-click a spot on a page.
- **Edit or delete:** click the pin.
- **Hide all:** the notes button in the toolbar.
- **To-do list:** mark a note done from its editor, or open the note list from the toolbar (the button shows the number of open notes) to tick notes off, jump to them, and hide the done ones.

Notes are saved in `main.overtex-notes.json` beside the main file, so builds and Clean leave them alone, and you can commit them to share them. Export for arXiv leaves them out, and they are never written into the PDF itself.

A PDF note stays at its spot on its page: if an edit moves the text, the note does not follow it. For notes that follow the text, use [notes on the source](reviewing.md#notes-on-the-text).

To send PDF notes to someone who does not use Overtex, see [Export PDF with Notes](reviewing.md#export-pdf-with-notes).

## Other PDFs

The preview also opens the PDFs of papers in your bibliography, from the [Papers panel](bibliography.md#the-papers-panel). Your draft comes back on the next build or **View PDF**.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `overtex.viewer.autoOpen` | `true` | Open the preview after a successful build. |
| `overtex.viewer.colorScheme` | `light` | `light`, `dark` or `auto`. |
| `overtex.viewer.followOutline` | `true` | Scroll the preview to a heading you go to from the Outline view, the breadcrumbs or Go to Symbol. |
| `overtex.synctex.path` | | Full path to `synctex` if it is not on the `PATH`. |
