// Starter projects for Overtex: New LaTeX Document. No vscode import, so it is unit-testable.

export interface TemplateFile {
  /** Relative to the project folder, with forward slashes. */
  path: string;
  content: string;
}

export interface ProjectTemplate {
  id: string;
  label: string;
  description: string;
  files: TemplateFile[];
  /** The file to open after creating the project; it holds `\documentclass`. */
  main: string;
}

const REFS_BIB = `@book{knuth1984,
  author = {Knuth, Donald E.},
  title = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year = {1984}
}
`;

const ARTICLE = `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{Untitled}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
A short summary of the paper.
\\end{abstract}

\\section{Introduction}
Start writing here. Save to build, then Ctrl/Cmd+click in the PDF to jump back to the source.
Citations come from \\texttt{refs.bib}~\\cite{knuth1984}.

\\bibliographystyle{plain}
\\bibliography{refs}

\\end{document}
`;

const THESIS = `\\documentclass[12pt]{report}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{Thesis Title}
\\author{Your Name}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
A short summary of the thesis.
\\end{abstract}

\\tableofcontents

\\include{chapters/introduction}
\\include{chapters/conclusion}

\\bibliographystyle{plain}
\\bibliography{refs}

\\end{document}
`;

const THESIS_INTRO = `% !TEX root = ../main.tex
\\chapter{Introduction}
\\label{ch:introduction}

Each chapter lives in its own file under \\texttt{chapters/}. Building from here builds
\\texttt{main.tex}, because of the comment on the first line~\\cite{knuth1984}.
`;

const THESIS_CONCLUSION = `% !TEX root = ../main.tex
\\chapter{Conclusion}
\\label{ch:conclusion}

As Chapter~\\ref{ch:introduction} showed, \\ldots
`;

const BEAMER = `\\documentclass{beamer}
\\usetheme{default}
\\setbeamertemplate{navigation symbols}{}

\\title{Presentation Title}
\\author{Your Name}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Outline}
  \\begin{itemize}
    \\item First point
    \\item<2-> Second point, shown on the next slide
  \\end{itemize}
\\end{frame}

\\begin{frame}{An Equation}
  \\[ e^{i\\pi} + 1 = 0 \\]
\\end{frame}

\\end{document}
`;

const LETTER = `\\documentclass[11pt]{letter}
\\usepackage{hyperref}

\\signature{Your Name}
\\address{Street \\\\ City \\\\ Country}

\\begin{document}

\\begin{letter}{Recipient \\\\ Street \\\\ City}
\\opening{Dear Sir or Madam,}

Write the letter here.

\\closing{Yours faithfully,}
\\end{letter}

\\end{document}
`;

export const TEMPLATES: ProjectTemplate[] = [
  {
    id: 'article',
    label: 'Article',
    description: 'Paper with an abstract and a bibliography',
    files: [
      { path: 'main.tex', content: ARTICLE },
      { path: 'refs.bib', content: REFS_BIB },
    ],
    main: 'main.tex',
  },
  {
    id: 'thesis',
    label: 'Thesis or Report',
    description: 'Chapters in separate files, table of contents, bibliography',
    files: [
      { path: 'main.tex', content: THESIS },
      { path: 'chapters/introduction.tex', content: THESIS_INTRO },
      { path: 'chapters/conclusion.tex', content: THESIS_CONCLUSION },
      { path: 'refs.bib', content: REFS_BIB },
    ],
    main: 'main.tex',
  },
  {
    id: 'presentation',
    label: 'Presentation',
    description: 'Beamer slides',
    files: [{ path: 'main.tex', content: BEAMER }],
    main: 'main.tex',
  },
  {
    id: 'letter',
    label: 'Letter',
    description: 'Formal letter',
    files: [{ path: 'main.tex', content: LETTER }],
    main: 'main.tex',
  },
];

/**
 * Where to put a template's files in a folder: the folder itself when none of them exist
 * there yet, else a new subfolder named after the template (`thesis`, `thesis-2`, …), so
 * nothing is overwritten and each project keeps its own build output.
 */
export function placeTemplate(template: ProjectTemplate, exists: (relPath: string) => boolean): string {
  if (!template.files.some((f) => exists(f.path))) {
    return '';
  }
  for (let n = 1; ; n++) {
    const dir = n === 1 ? template.id : `${template.id}-${n}`;
    if (!exists(dir)) {
      return dir;
    }
  }
}
