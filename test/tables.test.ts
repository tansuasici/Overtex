import { describe, expect, it } from 'vitest';
import { columnSpec, escapeLatex, isNumeric, parseDelimited, tableSegments } from '../src/latex/tables';
import { segmentsText } from '../src/latex/figures';

describe('parseDelimited', () => {
  it('reads plain comma-separated rows', () => {
    expect(parseDelimited('a,b,c\n1,2,3\n')).toEqual({ rows: [['a', 'b', 'c'], ['1', '2', '3']], delimiter: ',' });
  });

  it('strips a byte order mark and reads CRLF line ends', () => {
    expect(parseDelimited('﻿name,age\r\nAda,36\r\n')?.rows).toEqual([['name', 'age'], ['Ada', '36']]);
  });

  it('honours quotes holding the delimiter, line breaks and doubled quotes', () => {
    const text = 'title,note\n"Smith, J.","said ""hi""\nthen left"\n';
    expect(parseDelimited(text)?.rows).toEqual([['title', 'note'], ['Smith, J.', 'said "hi"\nthen left']]);
  });

  it('picks semicolons over the commas in decimal numbers', () => {
    const data = parseDelimited('Ölçüm;Değer\nA;1,5\nB;2,25\n');
    expect(data?.delimiter).toBe(';');
    expect(data?.rows).toEqual([['Ölçüm', 'Değer'], ['A', '1,5'], ['B', '2,25']]);
  });

  it('picks tabs for text pasted from a spreadsheet', () => {
    expect(parseDelimited('x\ty, z\n1\t2\n')).toEqual({ rows: [['x', 'y, z'], ['1', '2']], delimiter: '\t' });
  });

  it('pads short rows and skips blank lines', () => {
    expect(parseDelimited('a,b,c\n\n1,2\n')?.rows).toEqual([['a', 'b', 'c'], ['1', '2', '']]);
  });

  it('gives undefined for empty text or fewer columns than asked for', () => {
    expect(parseDelimited('  \n')).toBeUndefined();
    expect(parseDelimited('just a sentence', 2)).toBeUndefined();
  });
});

describe('escapeLatex', () => {
  it('escapes the characters LaTeX treats specially, backslash first', () => {
    expect(escapeLatex('50% & $5 #1 a_b {x} ~ ^ \\')).toBe(
      '50\\% \\& \\$5 \\#1 a\\_b \\{x\\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{}'
    );
  });

  it('turns line breaks inside a cell into spaces', () => {
    expect(escapeLatex('two\r\n  lines')).toBe('two lines');
  });
});

describe('column alignment', () => {
  it('recognises numbers in both decimal styles', () => {
    expect(isNumeric('-1.5', false)).toBe(true);
    expect(isNumeric('1,234.5', false)).toBe(true);
    expect(isNumeric('12%', false)).toBe(true);
    expect(isNumeric('1e-3', false)).toBe(true);
    expect(isNumeric('1,5', true)).toBe(true);
    expect(isNumeric('1.234,5', true)).toBe(true);
    expect(isNumeric('1,5', false)).toBe(false);
    expect(isNumeric('n/a', false)).toBe(false);
  });

  it('right-aligns number columns, ignoring the header and empty cells', () => {
    expect(columnSpec([['Name', 'Score', 'Mix'], ['a', '1', 'x'], ['b', '', '2']], true, false)).toBe('lrl');
  });
});

describe('tableSegments', () => {
  it('builds a booktabs table with the caption above', () => {
    const segments = tableSegments([['Name', 'Score'], ['A_1', '3.5'], ['B', '10']], { label: 'tab:results' });
    expect(segmentsText(segments)).toBe(
      [
        '\\begin{table}[htbp]',
        '  \\centering',
        '  \\caption{Caption}',
        '  \\label{tab:results}',
        '  \\begin{tabular}{lr}',
        '    \\toprule',
        '    Name & Score \\\\',
        '    \\midrule',
        '    A\\_1 & 3.5 \\\\',
        '    B & 10 \\\\',
        '    \\bottomrule',
        '  \\end{tabular}',
        '\\end{table}',
        '',
      ].join('\n')
    );
    expect(segments.filter((s) => typeof s !== 'string')).toEqual([{ placeholder: 'Caption' }, { placeholder: 'tab:results' }]);
  });

  it('leaves out the midrule without a header', () => {
    const text = segmentsText(tableSegments([['1', '2']], { label: 'tab:t', header: false }));
    expect(text).not.toContain('\\midrule');
    expect(text).toContain('\\begin{tabular}{rr}');
  });
});
