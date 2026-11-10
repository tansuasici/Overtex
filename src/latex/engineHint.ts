import type { BuildTool, Engine } from './builder';
import type { LogEntry } from './logParser';

const UNDEFINED = 'Undefined control sequence';

/**
 * The first pdfTeX command, such as `\pdfoutput`, that the log calls undefined. TeX shows the
 * undefined command at the end of the first line of its `l.N` context.
 */
export function undefinedPdfTeXCommand(log: string): { command: string; line: number } | undefined {
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(UNDEFINED)) {
      continue;
    }
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const context = lines[j].match(/^l\.(\d+) .*?(\\pdf[A-Za-z]+)\s*$/);
      if (context) {
        return { command: context[2], line: parseInt(context[1], 10) };
      }
      if (/^l\.\d+ /.test(lines[j])) {
        break;
      }
    }
  }
  return undefined;
}

const ENGINE_NAME: Record<Engine, string> = { pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX' };

/** Advice for a document that uses `command`, which only pdfTeX has, built with another engine. */
export function engineMismatchHint(command: string, tool: BuildTool, engine: Engine): string | undefined {
  if (tool === 'tectonic') {
    return `${command} is a pdfTeX command, and Tectonic always uses XeTeX. This document may need pdfLaTeX: set overtex.latex.tool to latexmk and overtex.latex.engine to pdflatex.`;
  }
  if (engine === 'pdflatex') {
    return undefined;
  }
  return `${command} is a pdfTeX command, which ${ENGINE_NAME[engine]} does not have. This document may need pdfLaTeX: set overtex.latex.engine to pdflatex.`;
}

/**
 * Adds the engine advice to the "Undefined control sequence" error for that command and moves that error first,
 * so the failure notification shows it. Returns `entries` unchanged when the log has no such case.
 */
export function withEngineHint(entries: LogEntry[], log: string, tool: BuildTool, engine: Engine): LogEntry[] {
  const found = undefinedPdfTeXCommand(log);
  const hint = found && engineMismatchHint(found.command, tool, engine);
  const index = entries.findIndex((e) => e.severity === 'error' && e.message.startsWith(UNDEFINED) && e.line === found?.line);
  if (!hint || index < 0) {
    return entries;
  }
  const hinted = { ...entries[index], message: `${entries[index].message} ${hint}` };
  return [hinted, ...entries.slice(0, index), ...entries.slice(index + 1)];
}
