import { describe, expect, it } from 'vitest';
import { TEMPLATES, placeTemplate } from '../src/latex/templates';

describe('TEMPLATES', () => {
  it('each has a unique id and a main file with \\documentclass', () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) {
      const main = t.files.find((f) => f.path === t.main);
      expect(main?.content, t.id).toMatch(/^\\documentclass/m);
    }
  });

  it('points every split-out file back to its root document', () => {
    for (const t of TEMPLATES) {
      for (const f of t.files.filter((f) => f.path.endsWith('.tex') && f.path !== t.main)) {
        expect(f.content, f.path).toMatch(/^% !TEX root = \.\.\/main\.tex/);
      }
    }
  });

  it('ships the .bib a template cites from', () => {
    for (const t of TEMPLATES) {
      const usesBib = t.files.some((f) => f.content.includes('\\bibliography{refs}'));
      expect(t.files.some((f) => f.path === 'refs.bib'), t.id).toBe(usesBib);
    }
  });
});

describe('placeTemplate', () => {
  const thesis = TEMPLATES.find((t) => t.id === 'thesis')!;

  it('uses the folder itself when nothing would be overwritten', () => {
    expect(placeTemplate(thesis, () => false)).toBe('');
  });

  it('moves into a fresh subfolder when any file already exists', () => {
    expect(placeTemplate(thesis, (p) => p === 'refs.bib')).toBe('thesis');
    expect(placeTemplate(thesis, (p) => ['main.tex', 'thesis', 'thesis-2'].includes(p))).toBe('thesis-3');
  });
});
