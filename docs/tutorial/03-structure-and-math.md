# Lesson 3: Structure and math

**You will:** organize the paper into sections, write lists and equations, and refer to them by number so the numbers stay right when you move things around.

**Time:** 20 minutes.

Keep working in `main.tex` from [Lesson 2](02-first-document.md). Save after each step and watch the PDF.

## Step 1: Sections

Add these lines below your introduction, before `\bibliographystyle`:

```latex
\section{Method}
We describe our method here.

\subsection{Data}
Where the data comes from.

\subsection{Model}
How the model works.

\section{Results}
What we found.
```

LaTeX numbers sections for you: Method is 2, Data is 2.1. Move the Results section above Method and save: the numbers change by themselves. You never type a number.

The levels you will use most are `\section`, `\subsection` and `\subsubsection`. Add a `*` to leave a heading unnumbered: `\section*{Acknowledgments}`.

## Step 2: Emphasis and lists

Inside the Data subsection, write:

```latex
The data has \emph{three} parts:
\begin{itemize}
  \item a training set,
  \item a validation set,
  \item a test set.
\end{itemize}
```

- `\emph{…}` emphasizes a word, usually in italics. `\textbf{…}` makes bold text.
- `itemize` makes a bulleted list. Change it to `enumerate` (both the `\begin` and the `\end`) for a numbered list.

## Step 3: Math in the text

Math goes between dollar signs. In the Model subsection, write:

```latex
For an input $x$, the model predicts $\hat{y} = f(x)$
with error $\epsilon \sim \mathcal{N}(0, \sigma^2)$.
```

Inside `$…$`, letters become italic math variables, `^` makes a superscript and `_` a subscript. Use braces for more than one character: `x^{2n}`, not `x^2n`.

**Preview without building:** hover the mouse over anything between the dollar signs. Overtex shows the formula rendered, which is handy for long ones.

## Step 4: Equations on their own line

For an equation you want to refer to, use the `equation` environment and give it a **label**:

```latex
We minimize the squared error
\begin{equation}
  L(\theta) = \frac{1}{n} \sum_{i=1}^{n} \bigl(y_i - f_\theta(x_i)\bigr)^2 .
  \label{eq:loss}
\end{equation}
```

The equation gets a number on the right, (1). `\label{eq:loss}` gives that number a name you can use elsewhere. The `eq:` part is only a habit that tells you what kind of thing the label is; `sec:`, `fig:` and `tab:` are common too.

## Step 5: Find a symbol you do not know

You need ≤ but do not know its command?

1. Click the Overtex icon in the Activity Bar and open the **Math Symbols** view.
2. Find ≤ (search for "less" or browse the groups).
3. Click it. Overtex types `\leq` at the cursor.

Write `$L(\theta) \leq 1$` somewhere in the text and save.

## Step 6: Refer to things by name

Give the Method section a label, right after its heading:

```latex
\section{Method}
\label{sec:method}
```

Now refer to the section and the equation in Results:

```latex
\section{Results}
As explained in Section~\ref{sec:method}, we minimize
the loss in Equation~\eqref{eq:loss}.
```

Save. The PDF says "Section 2" and "Equation (1)".

- `\ref` prints the number; `\eqref` prints an equation number in parentheses.
- `~` is a space that never breaks a line, so "Section" and "2" stay together.

> **Why `??`** For a moment after you add a reference the PDF may show **??**. LaTeX learns the numbers in one run and prints them in the next; Overtex runs it as often as needed, so the `??` goes away when the build finishes. If it stays, the label does not exist: see [Lesson 6](06-fixing-errors.md#step-4-undefined-references).

**Check a reference without looking at the PDF:** hover over `sec:method` in `\ref{sec:method}`. Overtex shows the number and page from the last build.

## Step 7: The Labels panel

Open the **Labels** view in the Overtex sidebar. It lists every label in your project by kind: sections, equations, and later figures and tables. Each row says how often the label is used.

Try two things:

- Click a reference under a label to jump to it.
- Right-click `eq:loss`, choose **Rename Label**, and rename it to `eq:mse`. Overtex changes the `\label` and every `\eqref` at once.

## Check yourself

- [ ] Reordering sections renumbers them.
- [ ] Hovering over math shows the rendered formula.
- [ ] The PDF says "Section 2" and "Equation (1)", without `??`.
- [ ] The Labels view lists `sec:method` and your equation label, each used once.

---

**Previous:** [Lesson 2: Your first document](02-first-document.md) · **Next:** [Lesson 4: Citations](04-citations.md)
