# Live checking with TexLab (optional)

Install [TexLab](https://github.com/latex-lsp/texlab#installation) to get live diagnostics, completion for commands, environments, labels and citations, hover and go to definition. On macOS: `brew install texlab`.

Overtex starts TexLab on its own when it finds it on `PATH`. Without TexLab, Overtex still completes citations from your `.bib` files.

If the TexLab extension is installed, Overtex leaves the language server to that extension.
