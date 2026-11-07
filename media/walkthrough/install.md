# Install a TeX distribution

Overtex builds with **latexmk** and a TeX engine (pdfLaTeX, XeLaTeX or LuaLaTeX). Both come with every major TeX distribution:

| System | Install |
| --- | --- |
| macOS | [MacTeX](https://www.tug.org/mactex/), or `brew install --cask mactex-no-gui` |
| Windows | [MiKTeX](https://miktex.org/download) or [TeX Live](https://www.tug.org/texlive/). latexmk needs Perl: TeX Live includes it, MiKTeX users can install [Strawberry Perl](https://strawberryperl.com/). |
| Linux | `sudo apt install texlive-latex-extra latexmk` (Debian, Ubuntu) or `sudo dnf install texlive-scheme-medium latexmk` (Fedora) |

**Restart VS Code after installing** so it sees the new `PATH`. Then run **Check Installation**. It only looks for the programs and never runs them.

If TeX is installed somewhere unusual, set `overtex.latex.latexmkPath` to the full path.
