import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { auxText, describeAuxLabel, parseAux, readAuxLabels } from '../src/latex/aux';

// What pdflatex with hyperref and cleveref wrote for a small document.
const HYPERREF_AUX = String.raw`\relax
\providecommand\hyper@newdestlabel[2]{}
\gdef\newlabelxx#1#2#3#4#5#6{\oldnewlabel{#1}{{#2}{#3}}}
\@writefile{toc}{\contentsline {section}{\numberline {1}Intro}{1}{section.1}\protected@file@percent }
\newlabel{sec:a}{{1}{1}{Intro}{section.1}{}}
\newlabel{sec:a@cref}{{[section][1][]1}{[1][1][]1}}
\newlabel{eq:a}{{1}{1}{Intro}{equation.1.1}{}}
\newlabel{eq:a@cref}{{[equation][1][]1}{[1][1][]1}}
\gdef \@abspage@last{1}
`;

describe('parseAux', () => {
  it('reads hyperref labels with their cleveref type', () => {
    const { labels } = parseAux(HYPERREF_AUX);
    expect([...labels.keys()]).toEqual(['sec:a', 'eq:a']);
    expect(labels.get('sec:a')).toEqual({ number: '1', page: '1', title: 'Intro', type: 'section' });
    expect(labels.get('eq:a')).toEqual({ number: '1', page: '1', title: 'Intro', type: 'equation' });
  });

  it('reads plain LaTeX labels, with TeX in the number', () => {
    const { labels } = parseAux('\\newlabel{fig:x}{{\\relax 2.3}{iv}}\n\\newlabel{it:y}{{\\textup {(ii)}}{12}}\n');
    expect(labels.get('fig:x')).toEqual({ number: '2.3', page: 'iv' });
    expect(labels.get('it:y')).toEqual({ number: '(ii)', page: '12' });
  });

  it('keeps nested braces in titles balanced', () => {
    const { labels } = parseAux('\\newlabel{sec:b}{{A.1}{7}{Proof of {\\em Lemma}~3}{appendix.A}{}}');
    expect(labels.get('sec:b')).toEqual({ number: 'A.1', page: '7', title: 'Proof of Lemma 3' });
  });

  it('leaves out subcaption repeats and lines it cannot read', () => {
    const { labels } = parseAux('\\newlabel{sub@fig:c}{{a}{3}}\n\\newlabel{fig:c}{{1a}{3}}\n\\newlabel{broken}{{1}\n\\newlabel{}{{2}{2}}');
    expect([...labels.keys()]).toEqual(['fig:c']);
  });

  it('lists the files \\include wrote', () => {
    expect(parseAux('\\@input{chapters/one.aux}\n\\@input{two.aux}').inputs).toEqual(['chapters/one.aux', 'two.aux']);
  });
});

describe('readAuxLabels', () => {
  const root = path.resolve('/project/out');
  const files: Record<string, string> = {
    [path.join(root, 'main.aux')]: '\\@input{ch/one.aux}\n\\newlabel{a}{{1}{1}}\n\\@input{main.aux}',
    [path.join(root, 'ch/one.aux')]: '\\newlabel{b}{{2.1}{4}}\n\\@input{missing.aux}',
  };
  const read = (file: string) => files[file];

  it('follows \\@input from the main .aux, once per file', () => {
    const labels = readAuxLabels(path.join(root, 'main.aux'), read);
    expect(labels && Object.fromEntries(labels)).toEqual({ a: { number: '1', page: '1' }, b: { number: '2.1', page: '4' } });
  });

  it('is undefined when there was no build', () => {
    expect(readAuxLabels(path.join(root, 'other.aux'), read)).toBeUndefined();
  });
});

describe('auxText', () => {
  it('prints what simple TeX prints', () => {
    expect(auxText('\\relax {\\bf 3}')).toBe('3');
    expect(auxText('Results~and\\nobreakspace {}Discussion')).toBe('Results and Discussion');
    expect(auxText('Cost \\& \\textit {time}')).toBe('Cost & time');
  });
});

describe('describeAuxLabel', () => {
  it('puts equation numbers in parentheses', () => {
    expect(describeAuxLabel({ number: '3', page: '5', title: 'Intro', type: 'equation' }, 'Equations')).toBe('Equation (3), page 5');
  });

  it('names a section by its title', () => {
    expect(describeAuxLabel({ number: '2.1', page: '4', title: 'Results', type: 'subsection' }, undefined)).toBe('Section 2.1 Results, page 4');
  });

  it('falls back to the kind found in the source without cleveref', () => {
    expect(describeAuxLabel({ number: '2', page: '3', title: 'Method' }, 'Figures')).toBe('Figure 2, page 3');
    expect(describeAuxLabel({ number: '4', page: '' }, undefined)).toBe('4');
  });

  it('capitalizes a cleveref type it does not know', () => {
    expect(describeAuxLabel({ number: '1', page: '2', type: 'hypothesis' }, 'Theorems')).toBe('Hypothesis 1, page 2');
  });
});
