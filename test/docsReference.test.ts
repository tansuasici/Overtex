import { readdirSync, readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs build script without type declarations
import { buildCommands, buildSettings, COMMANDS_PATH, SETTINGS_PATH } from '../scripts/docsReference.mjs';

const DOCS = path.resolve(__dirname, '..', 'docs');

// Windows checkouts may turn LF into CRLF.
const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdownFiles(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []
  );
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
function anchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/ /g, '-');
}

describe('docs/', () => {
  it('lists the commands package.json has (run node scripts/docsReference.mjs)', () => {
    expect(read(COMMANDS_PATH)).toBe(buildCommands());
  });

  it('lists the settings package.json has (run node scripts/docsReference.mjs)', () => {
    expect(read(SETTINGS_PATH)).toBe(buildSettings());
  });

  it('has no broken relative links or anchors', () => {
    const broken: string[] = [];
    for (const file of markdownFiles(DOCS)) {
      const text = read(file).replace(/```[\s\S]*?```/g, '');
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^[a-z]+:/i.test(target)) {
          continue;
        }
        const [rel, hash] = target.split('#');
        const dest = rel ? path.resolve(path.dirname(file), rel) : file;
        if (!existsSync(dest)) {
          broken.push(`${path.relative(DOCS, file)} → ${target}`);
          continue;
        }
        if (hash && dest.endsWith('.md')) {
          const anchors = [...read(dest).matchAll(/^#+ (.+)$/gm)].map((h) => anchor(h[1]));
          if (!anchors.includes(hash)) {
            broken.push(`${path.relative(DOCS, file)} → ${target}`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
