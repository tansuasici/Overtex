# Lesson 5: Figures and tables

**You will:** add an image and a table to the paper, let LaTeX place and number them, and refer to them from the text.

**Time:** 15 minutes.

## How figures and tables work

In LaTeX, a figure or table is a **float**: you say what it contains and give it a caption and a label, and LaTeX decides where on the page it goes, usually at the top of a page near where you wrote it. That is why papers say "see Figure 2" rather than "see the figure below". You refer to it with `\ref`, as you did for sections in [Lesson 3](03-structure-and-math.md).

## Step 1: Add a figure

You need an image file. Any `.png` or `.jpg` will do, for example a screenshot. PDF and EPS images work too.

1. In `main.tex`, put the cursor on an empty line in the Results section.
2. Run **Overtex: Insert Figure** and pick your image.

Overtex inserts:

```latex
\begin{figure}[htbp]
  \centering
  \includegraphics[width=0.8\linewidth]{figures/screenshot.png}
  \caption{}
  \label{fig:screenshot}
\end{figure}
```

The cursor is in the caption. Type one sentence that describes the figure, for example `Our model's results.`, and save.

What each line does:

- `[htbp]` lets LaTeX put the figure **h**ere, at the **t**op or **b**ottom of a page, or on a **p**age of floats.
- `\centering` centers it.
- `\includegraphics[width=0.8\linewidth]{…}` draws the image at 80% of the text width. Change `0.8` to resize it.
- `\label{fig:…}` comes after `\caption`, because the caption is what gets the number.

If the image was not already in your paper's folder, Overtex copied it into a `figures/` folder there, so the project keeps everything it needs.

> **Faster:** drag an image from Finder or Explorer into the editor **while holding Shift**. Overtex inserts the same figure where you drop it. Without Shift, VS Code opens the image instead.

## Step 2: Add a table from data

Tables in LaTeX are tedious to type by hand. Overtex makes them from spreadsheet data.

1. Create a file called `results.csv` in your paper's folder with this content:

   ```text
   Model,Accuracy,Parameters
   Baseline,71.2,1.1M
   Ours,84.6,1.3M
   ```

2. Put the cursor below your figure, run **Overtex: Insert Table from CSV**, and pick `results.csv`.

Overtex inserts a `table` with a caption above it, as is customary for tables, and adds `\usepackage{booktabs}` to the preamble, which gives tables clean horizontal rules. Number columns are right-aligned. Type a caption and save.

> **From a spreadsheet:** copy cells in Excel, Numbers or Google Sheets, paste them into `main.tex`, select the pasted text and run **Insert Table from CSV**. It turns the selection into a table in place.

## Step 3: Refer to them

In the Results section, write:

```latex
Figure~\ref{fig:screenshot} shows our results, and
Table~\ref{tab:results} compares the two models.
```

Use the labels Overtex gave your figure and table. If you are not sure what they are, open the **Labels** view: they are listed under Figures and Tables. You can also put the cursor where the reference goes and click the insert button beside a label there.

Save. The PDF says "Figure 1" and "Table 1".

## Step 4: When a float ends up in the wrong place

LaTeX sometimes puts a figure a page later than you expect. Usually that is fine: readers follow the number, not the position. If it really matters:

- Write the figure earlier in the source, near the paragraph that first mentions it.
- Make it smaller so it fits.
- Do not fight LaTeX with `[h!]` everywhere; check the final layout once, just before you submit.

## Check yourself

- [ ] The PDF shows your image with "Figure 1:" and your caption below it.
- [ ] The PDF shows a table with "Table 1:" and your caption above it.
- [ ] The text says "Figure 1" and "Table 1", without `??`.

---

**Previous:** [Lesson 4: Citations](04-citations.md) · **Next:** [Lesson 6: When something goes wrong](06-fixing-errors.md)
