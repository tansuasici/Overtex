# Lesson 6: When something goes wrong

**You will:** make the four mistakes everyone makes, see how Overtex reports each one, and fix them.

**Time:** 15 minutes.

Everyone's LaTeX breaks. The skill is reading what TeX tells you. In this lesson you break the paper on purpose, so the messages are familiar when they come for real.

## How errors are reported

When a build fails, Overtex reads TeX's log and shows:

- a red squiggle under the line with the problem, with the message on hover;
- the same message in the **Problems** panel (`⇧⌘M` / `Ctrl+Shift+M`), where clicking it takes you to the line;
- the error count in the status bar.

The PDF keeps showing the last version that built, so you can keep reading while you fix things.

## Step 1: A command that does not exist

In the introduction, write a misspelled command:

```latex
This is \emphh{important}.
```

Save. The Problems panel says **Undefined control sequence** and points at the line. TeX does not know `\emphh`. Fix it to `\emph` and save; the error goes away.

This is the most common error. It usually means a typo, or a command from a package you have not loaded with `\usepackage`.

## Step 2: A missing brace

Delete the closing `}` of a `\section{…}`:

```latex
\section{Results
```

Save. TeX's message may point at a line further down than your mistake: it only notices that something is wrong when it runs into the next thing that does not fit. Look at the line it names **and the lines above it**.

If TexLab is installed (see [Lesson 1](01-setup.md#step-5-check-the-installation)), the squiggle appears as you type, before you save, and points at the right place more often.

Put the brace back and save.

## Step 3: A package you do not have

Add this line to the preamble:

```latex
\usepackage{nonexistentpkg}
```

Save. The message says the file `nonexistentpkg.sty` was not found. A package is a `.sty` file, a class is a `.cls` file, and TeX looks for them in your TeX distribution and in your paper's folder.

When this happens with a real package:

1. Run **Overtex: Check LaTeX Installation**. It looks up every package and class your project loads and lists the missing ones.
2. With TeX Live or MacTeX it types the `tlmgr install` command for them into a terminal. Read it and press Enter to run it. (MiKTeX installs missing packages from its own MiKTeX Console.)
3. If the file came with a conference or journal template, it is not in TeX Live at all: copy it from the template into your paper's folder.

Delete the line and save.

## Step 4: Undefined references

Refer to a label that does not exist:

```latex
See Section~\ref{sec:conclusion}.
```

Save. This is not an error, so the PDF is built, but it shows **??** where the number should be, and the Problems panel shows a warning that the reference `sec:conclusion` is undefined. The same happens with `\cite` and a key that is not in your `.bib` file.

The **Labels** view lists it under **Undefined references** at the top. Either add the missing `\label`, or, if it is a typo, rename the undefined reference there to the right label.

Delete the line and save.

## Step 5: Read the build log

The full output of TeX is in the build log. Run **Overtex: Show Build Log**.

It is long and noisy, but two kinds of lines matter:

- lines starting with `!` are errors;
- lines with `Warning` are warnings, such as overfull boxes (a line that sticks out into the margin) and undefined references.

When the Problems panel is not enough, search the log for `!`.

## Step 6: When the PDF itself looks wrong

Some problems are not errors:

| You see | Cause | Fix |
| --- | --- | --- |
| `??` in the text | Undefined reference or citation | Step 4 |
| A line sticking out into the margin | TeX could not break the line, often because of a long URL or word | Rephrase, or for URLs use `\url{…}` |
| The preview stays empty | The build never finished | Check the Problems panel and the build log |
| Strange characters | A character your engine cannot print | Use XeLaTeX or LuaLaTeX, see [Building](../building.md) |

[Troubleshooting](../troubleshooting.md) has more.

## Check yourself

- [ ] You found the "Undefined control sequence" error from the Problems panel.
- [ ] You know where Check LaTeX Installation puts the command for missing packages.
- [ ] Your paper builds again without errors.

---

**Previous:** [Lesson 5: Figures and tables](05-figures-and-tables.md) · **Next:** [Lesson 7: Working with co-authors](07-co-authors.md)
