import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  figureSegments,
  freeName,
  graphicsPath,
  hasPackage,
  isImage,
  isInside,
  isTableFile,
  packageInsertLine,
  safeFileName,
  segmentsText,
  slug,
  uniqueLabel,
} from '../src/latex/figures';

const root = path.resolve('/project');

describe('file kinds', () => {
  it('knows the images pdflatex can include and the table files', () => {
    expect(isImage('a/plot.PNG')).toBe(true);
    expect(isImage('scan.jpeg')).toBe(true);
    expect(isImage('vector.pdf')).toBe(true);
    expect(isImage('logo.svg')).toBe(false);
    expect(isTableFile('data.csv')).toBe(true);
    expect(isTableFile('data.TSV')).toBe(true);
    expect(isTableFile('data.xlsx')).toBe(false);
  });
});

describe('graphicsPath', () => {
  it('is relative to the main file folder with forward slashes', () => {
    expect(graphicsPath(path.join(root, 'figures', 'plot.png'), root)).toBe('figures/plot.png');
    expect(graphicsPath(path.join(root, 'plot.pdf'), root)).toBe('plot.pdf');
  });

  it('tells files inside the project from those outside', () => {
    expect(isInside(path.join(root, 'figures', 'a.png'), root)).toBe(true);
    expect(isInside(path.resolve('/elsewhere/a.png'), root)).toBe(false);
    expect(isInside(root, root)).toBe(false);
  });
});

describe('labels and names', () => {
  it('slugs file names, Turkish letters included', () => {
    expect(slug('Grafik Sonuç_1.png')).toBe('grafik-sonuc-1');
    expect(slug('Işık Ölçümü.pdf')).toBe('isik-olcumu');
    expect(slug('Ğüş.csv')).toBe('gus');
    expect(slug('---.png')).toBe('item');
  });

  it('adds a number until the label is free', () => {
    expect(uniqueLabel('fig', 'plot', new Set())).toBe('fig:plot');
    expect(uniqueLabel('fig', 'plot', new Set(['fig:plot', 'fig:plot-2']))).toBe('fig:plot-3');
  });

  it('makes copied file names safe and free', () => {
    expect(safeFileName('My Plot (final).PNG')).toBe('my-plot-final.png');
    const taken = new Set(['plot.png', 'plot-2.png']);
    expect(freeName('plot.png', (n) => taken.has(n))).toBe('plot-3.png');
    expect(freeName('new.png', (n) => taken.has(n))).toBe('new.png');
  });
});

describe('figureSegments', () => {
  it('builds a centred figure with caption and label tab stops', () => {
    const segments = figureSegments({ file: 'figures/plot.png', label: 'fig:plot' });
    expect(segmentsText(segments)).toBe(
      [
        '\\begin{figure}[htbp]',
        '  \\centering',
        '  \\includegraphics[width=0.8\\linewidth]{figures/plot.png}',
        '  \\caption{Caption}',
        '  \\label{fig:plot}',
        '\\end{figure}',
        '',
      ].join('\n')
    );
  });
});

describe('preamble packages', () => {
  const doc = [
    '\\documentclass[11pt]{article}',
    '\\usepackage[utf8]{inputenc}',
    '% \\usepackage{booktabs}',
    '\\usepackage{amsmath, graphicx}',
    '',
    '\\begin{document}',
    '\\usepackage{hyperref}',
    '\\end{document}',
  ].join('\n');

  it('finds packages in lists and with options, not in comments or the body', () => {
    expect(hasPackage(doc, 'graphicx')).toBe(true);
    expect(hasPackage(doc, 'inputenc')).toBe(true);
    expect(hasPackage(doc, 'booktabs')).toBe(false);
    expect(hasPackage(doc, 'hyperref')).toBe(false);
    expect(hasPackage('\\RequirePackage{booktabs}', 'booktabs')).toBe(true);
  });

  it('puts new packages after the last \\usepackage', () => {
    expect(packageInsertLine(doc)).toBe(4);
  });

  it('falls back to after \\documentclass, even when its options span lines', () => {
    expect(packageInsertLine('\\documentclass{article}\n\\begin{document}\n')).toBe(1);
    expect(packageInsertLine('\\documentclass[\n  a4paper\n]{article}\n\\title{x}\n')).toBe(3);
  });

  it('has no place for packages in a file without \\documentclass', () => {
    expect(packageInsertLine('\\section{Intro}\nText.\n')).toBeUndefined();
  });
});
