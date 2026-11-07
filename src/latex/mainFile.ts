import * as fs from 'fs';
import * as path from 'path';

const MAGIC_ROOT = /^\s*%\s*!\s*TeX\s+root\s*=\s*(.+?)\s*$/im;
const DOCUMENTCLASS = /^[^%\n]*\\documentclass\b/m;
const SKIP_DIRS = new Set(['node_modules', '.git', '.research', 'out', 'build']);
const MAX_DEPTH = 4;

export interface MainFileContext {
  /** Workspace root, used for the configured main file and the fallback search. */
  workspaceRoot?: string;
  /** `overtex.latex.mainFile`, relative to the workspace root. */
  configured?: string;
  /** The .tex document the user is editing, if any. */
  active?: { path: string; text: string };
}

/**
 * Finds the root document to build. Order: configured setting, `% !TEX root`
 * magic comment in the active file, the active file itself if it has a
 * `\documentclass`, then a search of the workspace.
 */
export function findMainFile(ctx: MainFileContext): string | null {
  if (ctx.configured && ctx.workspaceRoot) {
    return path.resolve(ctx.workspaceRoot, ctx.configured);
  }

  if (ctx.active) {
    const magic = ctx.active.text.match(MAGIC_ROOT);
    if (magic) {
      return path.resolve(path.dirname(ctx.active.path), magic[1]);
    }
    if (DOCUMENTCLASS.test(ctx.active.text)) {
      return ctx.active.path;
    }
  }

  if (ctx.workspaceRoot) {
    const found = searchWorkspace(ctx.workspaceRoot);
    if (found) {
      return found;
    }
  }

  return ctx.active?.path ?? null;
}

/** Breadth-first, so the shallowest root document wins; `main.tex` wins ties. */
function searchWorkspace(root: string): string | null {
  let level = [root];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const candidates: string[] = [];
    const next: string[] = [];
    for (const dir of level) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            next.push(full);
          }
        } else if (entry.name.endsWith('.tex') && isRootDocument(full)) {
          candidates.push(full);
        }
      }
    }
    if (candidates.length > 0) {
      return candidates.find((c) => path.basename(c) === 'main.tex') ?? candidates.sort()[0];
    }
    level = next;
  }
  return null;
}

function isRootDocument(file: string): boolean {
  try {
    return DOCUMENTCLASS.test(fs.readFileSync(file, 'utf-8'));
  } catch {
    return false;
  }
}
