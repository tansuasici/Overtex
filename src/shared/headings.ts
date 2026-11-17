/**
 * The commands that start an entry in the Outline view: sectioning commands (KOMA's unnumbered ones
 * too) and Beamer frames. A line counts when it starts with one, so commented-out headings do not.
 */
const HEADING = /^\s*\\(?:(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|addpart|addchap|addsec|minisec)\b\*?\s*(?:\[[^\]]*\]\s*)?\{|frametitle\b|begin\s*\{frame\})/;

/** Whether `line` is where a heading starts. */
export function isHeadingLine(line: string): boolean {
  return HEADING.test(line);
}
