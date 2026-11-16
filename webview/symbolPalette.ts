import type { FromPaletteMessage, PaletteSymbol, ToPaletteMessage } from '../src/shared/symbolMessages';
import { CATEGORIES, SYMBOLS, frequentSymbols, searchSymbols } from '../src/shared/symbols';
import type { MathSymbol } from '../src/shared/symbols';
import './symbolPalette.css';

declare function acquireVsCodeApi(): { postMessage(msg: FromPaletteMessage): void };

const vscode = acquireVsCodeApi();
const search = document.getElementById('search') as HTMLInputElement;
const list = document.getElementById('symbols') as HTMLDivElement;

const FREQUENT = 16;
let rendered = new Map<string, PaletteSymbol>();
let usage: Record<string, number> = {};

function button(sym: MathSymbol): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'symbol';
  b.setAttribute('role', 'listitem');
  b.dataset.cmd = sym.cmd;
  const label = `${sym.cmd} — ${sym.name}${sym.pkg ? ` (${sym.pkg})` : ''}`;
  b.title = label;
  b.setAttribute('aria-label', label);
  const svg = rendered.get(sym.cmd)?.svg;
  if (svg) {
    // Our own MathJax output for our own fixed list of commands.
    b.innerHTML = svg;
  } else {
    b.textContent = sym.cmd;
  }
  b.addEventListener('click', () => vscode.postMessage({ type: 'insert', cmd: sym.cmd }));
  return b;
}

function section(title: string, symbols: MathSymbol[]): HTMLElement | undefined {
  if (!symbols.length) {
    return undefined;
  }
  const el = document.createElement('section');
  const h = document.createElement('h2');
  h.textContent = title;
  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.append(...symbols.map(button));
  el.append(h, grid);
  return el;
}

/** Shows what `query` finds, or every category with the most used first; returns the commands shown. */
function show(query: string): string[] {
  const sections: (HTMLElement | undefined)[] = [];
  let shown: MathSymbol[];
  if (query.trim()) {
    shown = searchSymbols(query, usage);
    sections.push(shown.length ? section(`${shown.length} found`, shown) : empty(query));
  } else {
    const frequent = frequentSymbols(usage, FREQUENT);
    sections.push(section('Frequently used', frequent));
    for (const category of CATEGORIES) {
      sections.push(section(category, SYMBOLS.filter((s) => s.category === category)));
    }
    shown = [...frequent, ...SYMBOLS];
  }
  list.replaceChildren(...sections.filter((s): s is HTMLElement => !!s));
  return shown.map((s) => s.cmd);
}

function empty(query: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = `No symbol matches “${query}”.`;
  return p;
}

search.addEventListener('input', () => show(search.value));
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = list.querySelector<HTMLButtonElement>('button.symbol');
    first?.click();
  } else if (e.key === 'ArrowDown') {
    list.querySelector<HTMLButtonElement>('button.symbol')?.focus();
    e.preventDefault();
  }
});

window.addEventListener('message', (event: MessageEvent<ToPaletteMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'symbols':
      rendered = new Map(msg.symbols.map((s) => [s.cmd, s]));
      usage = msg.usage;
      show(search.value);
      vscode.postMessage({ type: 'shown' });
      return;
    case 'usage':
      usage = msg.usage;
      if (!search.value.trim()) {
        show('');
      }
      return;
    case 'search':
      search.value = msg.query;
      vscode.postMessage({ type: 'searched', cmds: show(msg.query) });
      return;
  }
});

vscode.postMessage({ type: 'ready' });
