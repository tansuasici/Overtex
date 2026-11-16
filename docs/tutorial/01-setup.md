# Lesson 1: Set up

**You will:** install the three things Overtex needs and check that they work together.

**Time:** 10 minutes, plus the TeX download.

## How the pieces fit

Writing in LaTeX takes three programs:

1. **VS Code**, the editor you type in.
2. **A TeX distribution**, the program that turns your `.tex` text file into a PDF. TeX Live is the most common one. It is large because it contains thousands of packages, fonts and tools.
3. **Overtex**, the VS Code extension that connects the two: it runs TeX when you save, shows the PDF, and points at your mistakes.

## Step 1: Install VS Code

Download VS Code from [code.visualstudio.com](https://code.visualstudio.com/) and install it like any other app. Open it once to check that it starts.

## Step 2: Install a TeX distribution

| Your system | Install |
| --- | --- |
| macOS | [MacTeX](https://tug.org/mactex/). Download `MacTeX.pkg` and open it. |
| Windows | [TeX Live](https://tug.org/texlive/windows.html). Run `install-tl-windows.exe` and accept the defaults. |
| Linux | [TeX Live](https://tug.org/texlive/quickinstall.html), or your distribution's packages, for example `sudo apt install texlive-full latexmk` on Debian and Ubuntu. |

The full installation takes a while. While it runs, go on with step 3.

> **Short on disk space?** [Tectonic](https://tectonic-typesetting.github.io/) is a small TeX engine that downloads only what your document needs. It works for most papers, but some Overtex features need a full distribution. See [Build tools](../building.md#build-tools) for the trade-offs.

## Step 3: Install Overtex

1. In VS Code, open the **Extensions** view: click the square icon in the bar on the left, or press `⇧⌘X` / `Ctrl+Shift+X`.
2. Search for **Overtex**.
3. Click **Install** on the Overtex extension by tansuasici.

An Overtex icon now appears in the bar on the left (the Activity Bar). It opens the Overtex sidebar, which you will use from lesson 3 on.

## Step 4: Restart VS Code

When the TeX installation has finished, quit VS Code completely and open it again. VS Code reads the list of installed programs (the `PATH`) only when it starts, so it cannot see TeX until you restart it.

## Step 5: Check the installation

Open the Command Palette (`⇧⌘P` / `Ctrl+Shift+P`), type `check latex` and run **Overtex: Check LaTeX Installation**.

Overtex looks for:

- **latexmk**, which runs TeX as many times as needed and runs BibTeX for the bibliography;
- **your engine**, pdfLaTeX by default;
- **synctex**, which links positions in the PDF to lines in your source;
- **latexdiff**, which marks up changes between versions (lesson 7);
- **TexLab**, an optional helper for completion and live checking.

If something is missing, the message says what and how to install it. If TeX is installed but not found, VS Code usually needs the restart from step 4.

TexLab is optional. To install it later: `brew install texlab` on macOS, or a release binary from [the TexLab project](https://github.com/latex-lsp/texlab#installation).

## Check yourself

- [ ] **Overtex: Check LaTeX Installation** says latexmk, pdfLaTeX and synctex were found.
- [ ] The Overtex icon is in the Activity Bar.

## Optional: a quiet writing profile

If you also use VS Code for programming, you can keep LaTeX in its own [profile](https://code.visualstudio.com/docs/configure/profiles), a separate set of settings and extensions:

1. Run **Profiles: Import Profile…**.
2. Paste this address and press Enter:

   ```text
   https://raw.githubusercontent.com/tansuasici/Overtex/main/profile/Overtex.code-profile
   ```

3. Choose **Create**.

The new profile has Overtex installed. It hides the minimap, breadcrumbs, sticky scroll, tips and AI chat, and wraps long lines. Switch between profiles from **Profile** in the gear menu at the bottom left.

---

**Next:** [Lesson 2: Your first document](02-first-document.md)
