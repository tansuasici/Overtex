import { describe, expect, it } from 'vitest';
import { isHeadingLine } from '../src/shared/headings';

describe('isHeadingLine', () => {
  it.each([
    '\\section{Introduction}',
    '\\section*{Acknowledgements}',
    '\\subsection[Short]{A much longer title}',
    '  \\subsubsection {Indented}',
    '\\chapter{One}',
    '\\part{First}',
    '\\paragraph{Run-in}',
    '\\addchap{Preface}',
    '\\begin{frame}{Results}',
    '\\begin{frame}',
    '\\frametitle{Results}',
    '\\section{Mixed} text after it',
  ])('finds %s', (line) => {
    expect(isHeadingLine(line)).toBe(true);
  });

  it.each([
    '% \\section{Commented out}',
    'Text and then \\section{late}',
    '\\sectionmark{Header}',
    '\\subsectionfont{\\large}',
    '\\section',
    '\\begin{figure}',
    '\\end{frame}',
    '',
  ])('ignores %s', (line) => {
    expect(isHeadingLine(line)).toBe(false);
  });
});
