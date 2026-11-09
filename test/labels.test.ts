import { describe, expect, it } from 'vitest';

import { LabelEntry, groupLabels, labelSummary, mergeLabels, occurrenceAt, refCommand, renameProblem, scanLabels } from '../src/latex/labels';

const keys = (list: { key: string }[]) => list.map((o) => o.key);
const refsOf = (text: string) => keys(scanLabels(text).refs);
const labelsOf = (text: string) => keys(scanLabels(text).labels);
const kindOf = (text: string) => scanLabels(text).labels[0]?.kind;

describe('scanLabels', () => {
  it('reports the position of the key itself', () => {
    const { labels, refs } = scanLabels('first\n  \\label{ a:b }\nsee \\ref{a:b}.');
    expect(labels[0]).toMatchObject({ key: 'a:b', line: 1, start: 10, end: 13 });
    expect(refs[0]).toMatchObject({ key: 'a:b', line: 2, start: 9, end: 12 });
  });

  it('keeps line numbers with Windows line ends', () => {
    expect(scanLabels('a\r\nb\r\n\\label{c}\r\n').labels[0]).toMatchObject({ line: 2, start: 7, end: 8 });
  });

  it('finds the common reference commands, starred and with options', () => {
    expect(
      refsOf('\\ref{a} \\ref*{b} \\eqref{c} \\pageref{d} \\autoref{e} \\nameref{f} \\vref[x][y]{g} \\subref*{h} \\Cref{i} \\zref[page]{j}')
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  });

  it('splits lists in cleveref commands, with each key at its own position', () => {
    const { refs } = scanLabels('\\cref{a, bb ,c}');
    expect(refs.map((r) => [r.key, r.start, r.end])).toEqual([
      ['a', 6, 7],
      ['bb', 9, 11],
      ['c', 13, 14],
    ]);
  });

  it('does not split a plain \\ref at a comma', () => {
    expect(refsOf('\\ref{a,b}')).toEqual(['a,b']);
  });

  it('reads both keys of a range', () => {
    expect(refsOf('\\crefrange{a}{b} \\vrefrange[x]{c}{d}')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reads the key in \\hyperref but not its text', () => {
    expect(refsOf('\\hyperref[sec:a]{Section \\ref{sec:b}} \\hyperref{http://x}{y}{z}{w}')).toEqual(['sec:a', 'sec:b']);
  });

  it('finds \\label and its relatives, with an optional type', () => {
    expect(labelsOf('\\label{a} \\zlabel{b} \\label[theorem]{c}')).toEqual(['a', 'b', 'c']);
  });

  it('skips comments but not an escaped percent', () => {
    expect(labelsOf('% \\label{a}\n50\\% \\label{b} % \\label{c}')).toEqual(['b']);
  });

  it('skips a line break followed by a word', () => {
    expect(labelsOf('x\\\\label{a}')).toEqual([]);
    expect(labelsOf('x\\\\\\label{a}')).toEqual(['a']);
  });

  it('does not match longer command names', () => {
    expect(refsOf('\\reference{a} \\refstepcounter{b}')).toEqual([]);
    expect(labelsOf('\\labelsep{a}')).toEqual([]);
  });

  it('skips verbatim text', () => {
    const text = [
      '\\begin{verbatim}',
      '\\label{a}',
      '\\end{verbatim}',
      '\\begin{comment}',
      '\\ref{b}',
      '\\end{comment}',
      '\\verb|\\label{c}| \\lstinline!\\ref{d}! \\label{e}',
      '\\begin{verbatim}\\label{f}\\end{verbatim}\\label{g}',
    ].join('\n');
    expect(labelsOf(text)).toEqual(['e', 'g']);
    expect(refsOf(text)).toEqual([]);
  });

  it('keeps columns after inline verbatim', () => {
    expect(scanLabels('\\verb|x| \\label{a}').labels[0]).toMatchObject({ start: 16, end: 17 });
  });

  it('ignores keys built from macros or parameters', () => {
    expect(refsOf('\\newcommand{\\figref}[1]{Figure~\\ref{fig:#1}} \\ref{\\mykey} \\ref{a}')).toEqual(['a']);
    expect(labelsOf('\\label{#1}')).toEqual([]);
  });

  it('reads labels from listing options', () => {
    const { labels } = scanLabels('\\begin{lstlisting}[caption=x, label=lst:a]\n\\label{no}\n\\end{lstlisting}\n\\lstinputlisting[label={b}]{f.py}');
    expect(labels.map((l) => [l.key, l.start, l.kind])).toEqual([
      ['lst:a', 36, 'Code'],
      ['b', 24, 'Code'],
    ]);
  });

  it('shortens long lines around the key', () => {
    const { refs } = scanLabels(`${'x'.repeat(200)} \\ref{a} ${'y'.repeat(200)}`);
    expect(refs[0].excerpt.startsWith('…')).toBe(true);
    expect(refs[0].excerpt.endsWith('…')).toBe(true);
    expect(refs[0].excerpt).toContain('\\ref{a}');
    expect(refs[0].excerpt.length).toBeLessThan(100);
  });
});

describe('label kinds', () => {
  it('goes by the prefix first', () => {
    expect(kindOf('\\label{fig:a}')).toBe('Figures');
    expect(kindOf('\\label{Tab:a}')).toBe('Tables');
    expect(kindOf('\\begin{figure}\\label{eq:a}\\end{figure}')).toBe('Equations');
  });

  it('goes by the innermost known environment without a prefix', () => {
    expect(kindOf('\\begin{figure*}\n\\label{a}\n\\end{figure*}')).toBe('Figures');
    expect(kindOf('\\begin{table}\\begin{center}\\label{a}\\end{center}\\end{table}')).toBe('Tables');
    expect(kindOf('\\begin{align*}\\label{a}\\end{align*}')).toBe('Equations');
    expect(kindOf('\\begin{theorem}\\label{a}\\end{theorem}')).toBe('Theorems');
    expect(kindOf('\\section{S}\\begin{enumerate}\\item\\label{a}\\end{enumerate}')).toBe('Other');
  });

  it('forgets an environment once it ends', () => {
    expect(kindOf('\\begin{figure}\\end{figure}\n\\label{a}')).toBe('Other');
  });

  it('counts a label after a section heading as that section', () => {
    expect(kindOf('\\section{S}\n\\label{a}')).toBe('Sections');
    expect(kindOf('\\label{a}\n\\section{S}')).toBe('Other');
  });

  it('does not take an unknown prefix for a kind', () => {
    expect(kindOf('\\label{foo:a}')).toBe('Other');
  });
});

describe('mergeLabels and groupLabels', () => {
  const entries = mergeLabels([
    { file: 'a.tex', scan: scanLabels('\\section{A}\\label{sec:a}\n\\label{fig:b} \\label{fig:b}\n\\ref{missing} \\ref{fig:b}') },
    { file: 'b.tex', scan: scanLabels('\\ref{fig:b} \\ref{missing}\n\\label{fig:10} \\label{fig:9}') },
  ]);
  const byKey = (key: string) => entries.find((e) => e.key === key) as LabelEntry;

  it('collects definitions and references across files', () => {
    expect(byKey('fig:b').definitions.map((d) => d.file)).toEqual(['a.tex', 'a.tex']);
    expect(byKey('fig:b').references.map((r) => r.file)).toEqual(['a.tex', 'b.tex']);
    expect(byKey('missing').kind).toBeUndefined();
  });

  it('puts undefined references first and leaves out empty groups', () => {
    expect(groupLabels(entries).map((g) => [g.group, keys(g.entries)])).toEqual([
      ['Undefined references', ['missing']],
      ['Sections', ['sec:a']],
      ['Figures', ['fig:9', 'fig:10', 'fig:b']],
    ]);
  });

  it('summarizes use and duplicates', () => {
    expect(labelSummary(byKey('sec:a'))).toBe('unused');
    expect(labelSummary(byKey('fig:b'))).toBe('defined 2×, 2 refs');
    expect(labelSummary(byKey('missing'))).toBe('2 refs');
    expect(labelSummary(mergeLabels([{ file: 'c', scan: scanLabels('\\label{a}\\ref{a}') }])[0])).toBe('1 ref');
  });
});

describe('renameProblem', () => {
  const entries = mergeLabels([{ file: 'a.tex', scan: scanLabels('\\label{a} \\label{b} \\ref{typo} \\ref{other}') }]);

  it('rejects what cannot be a key', () => {
    expect(renameProblem(entries, 'a', '  ')).toBeTruthy();
    for (const bad of ['a b', 'a,b', 'a{b', 'a%b', 'a#b', 'a\\b']) {
      expect(renameProblem(entries, 'a', bad), bad).toBeTruthy();
    }
    expect(renameProblem(entries, 'a', 'fig:new_name-2')).toBeUndefined();
  });

  it('rejects taking the name of another label', () => {
    expect(renameProblem(entries, 'a', 'b')).toContain('already');
  });

  it('allows the current name and a name only references use', () => {
    expect(renameProblem(entries, 'a', 'a')).toBeUndefined();
    expect(renameProblem(entries, 'a', 'typo')).toBeUndefined();
  });

  it('allows fixing an undefined reference by pointing it at a label', () => {
    expect(renameProblem(entries, 'typo', 'a')).toBeUndefined();
  });
});

describe('occurrenceAt', () => {
  const scan = scanLabels('\\label{ab} text\nsee \\cref{ab,cd}');

  it('finds the key under the cursor, at both ends', () => {
    expect(occurrenceAt(scan, 0, 7)?.key).toBe('ab');
    expect(occurrenceAt(scan, 0, 9)?.key).toBe('ab');
    expect(occurrenceAt(scan, 1, 13)?.key).toBe('cd');
  });

  it('finds nothing elsewhere', () => {
    expect(occurrenceAt(scan, 0, 3)).toBeUndefined();
    expect(occurrenceAt(scan, 0, 12)).toBeUndefined();
    expect(occurrenceAt(scan, 5, 0)).toBeUndefined();
  });
});

describe('refCommand', () => {
  it('uses \\eqref for equations', () => {
    const [eq, fig] = mergeLabels([{ file: 'a', scan: scanLabels('\\label{eq:a} \\label{fig:a}') }]);
    expect(refCommand(eq)).toBe('\\eqref{eq:a}');
    expect(refCommand(fig)).toBe('\\ref{fig:a}');
  });
});
