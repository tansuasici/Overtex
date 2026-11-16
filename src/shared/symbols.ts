// The math symbol palette's symbols and its search. Shared by the extension and the palette's
// webview, so no vscode or Node import.

export type SymbolCategory =
  | 'Greek'
  | 'Relations'
  | 'Operators'
  | 'Arrows'
  | 'Sets and logic'
  | 'Big operators'
  | 'Delimiters'
  | 'Accents and fonts'
  | 'Functions'
  | 'Miscellaneous';

export const CATEGORIES: SymbolCategory[] = [
  'Greek',
  'Relations',
  'Operators',
  'Arrows',
  'Sets and logic',
  'Big operators',
  'Delimiters',
  'Accents and fonts',
  'Functions',
  'Miscellaneous',
];

/** A package a symbol needs; amsfonts' symbols are also in amssymb. */
export type SymbolPackage = 'amssymb' | 'amsfonts' | 'amsmath' | 'mathtools' | 'mathrsfs';

export interface MathSymbol {
  /** What the palette shows and search matches, e.g. `\leq` or `\frac`. Unique. */
  cmd: string;
  /** What is rendered for the preview: the command with sample arguments, e.g. `\frac{a}{b}`. */
  tex: string;
  /** What is inserted, as snippet text: `\frac{$1}{$2}`; tab stops for arguments. */
  snippet: string;
  /** Plain English, e.g. "less than or equal to". */
  name: string;
  /** Other words it is found by. */
  keywords: string[];
  /** The Unicode character, when there is one, so `≤` finds `\leq`. */
  char?: string;
  pkg?: SymbolPackage;
  category: SymbolCategory;
}

type Row = [cmd: string, name: string, char?: string, keywords?: string, pkg?: SymbolPackage];

/** Escapes text for a snippet, where `\`, `$` and `}` are special. */
export function escapeSnippet(text: string): string {
  return text.replace(/[\\$}]/g, '\\$&');
}

/** A symbol with no arguments: rendered and inserted as is. */
function plain(category: SymbolCategory, rows: Row[]): MathSymbol[] {
  return rows.map(([cmd, name, char, keywords, pkg]) => ({
    cmd,
    tex: cmd,
    snippet: escapeSnippet(cmd),
    name,
    keywords: keywords ? keywords.split(' ') : [],
    ...(char && { char }),
    ...(pkg && { pkg }),
    category,
  }));
}

type ArgRow = [cmd: string, args: string[], name: string, keywords?: string, pkg?: SymbolPackage];

/** A command with arguments: `args` are the sample arguments rendered in the preview. */
function withArgs(category: SymbolCategory, rows: ArgRow[]): MathSymbol[] {
  return rows.map(([cmd, args, name, keywords, pkg]) => ({
    cmd,
    tex: cmd + args.map((a) => `{${a}}`).join(''),
    snippet: escapeSnippet(cmd) + args.map((_a, i) => `{$${i + 1}}`).join(''),
    name,
    keywords: keywords ? keywords.split(' ') : [],
    ...(pkg && { pkg }),
    category,
  }));
}

export const SYMBOLS: MathSymbol[] = [
  ...plain('Greek', [
    ['\\alpha', 'alpha', 'α'],
    ['\\beta', 'beta', 'β'],
    ['\\gamma', 'gamma', 'γ'],
    ['\\delta', 'delta', 'δ'],
    ['\\epsilon', 'epsilon', 'ϵ', 'lunate'],
    ['\\varepsilon', 'epsilon (curly)', 'ε', 'variant'],
    ['\\zeta', 'zeta', 'ζ'],
    ['\\eta', 'eta', 'η'],
    ['\\theta', 'theta', 'θ'],
    ['\\vartheta', 'theta (script)', 'ϑ', 'variant'],
    ['\\iota', 'iota', 'ι'],
    ['\\kappa', 'kappa', 'κ'],
    ['\\lambda', 'lambda', 'λ', 'wavelength eigenvalue'],
    ['\\mu', 'mu', 'μ', 'mean micro'],
    ['\\nu', 'nu', 'ν', 'frequency'],
    ['\\xi', 'xi', 'ξ'],
    ['\\pi', 'pi', 'π'],
    ['\\varpi', 'pi (variant)', 'ϖ', 'variant omega'],
    ['\\rho', 'rho', 'ρ', 'density correlation'],
    ['\\varrho', 'rho (variant)', 'ϱ', 'variant'],
    ['\\sigma', 'sigma', 'σ', 'standard deviation'],
    ['\\varsigma', 'sigma (final)', 'ς', 'variant'],
    ['\\tau', 'tau', 'τ'],
    ['\\upsilon', 'upsilon', 'υ'],
    ['\\phi', 'phi', 'ϕ', 'straight'],
    ['\\varphi', 'phi (curly)', 'φ', 'variant'],
    ['\\chi', 'chi', 'χ', 'chi-squared'],
    ['\\psi', 'psi', 'ψ', 'wave function'],
    ['\\omega', 'omega', 'ω', 'angular frequency'],
    ['\\Gamma', 'Gamma (capital)', 'Γ', 'uppercase'],
    ['\\Delta', 'Delta (capital)', 'Δ', 'uppercase change difference'],
    ['\\Theta', 'Theta (capital)', 'Θ', 'uppercase'],
    ['\\Lambda', 'Lambda (capital)', 'Λ', 'uppercase'],
    ['\\Xi', 'Xi (capital)', 'Ξ', 'uppercase'],
    ['\\Pi', 'Pi (capital)', 'Π', 'uppercase'],
    ['\\Sigma', 'Sigma (capital)', 'Σ', 'uppercase covariance'],
    ['\\Upsilon', 'Upsilon (capital)', 'ϒ', 'uppercase'],
    ['\\Phi', 'Phi (capital)', 'Φ', 'uppercase'],
    ['\\Psi', 'Psi (capital)', 'Ψ', 'uppercase'],
    ['\\Omega', 'Omega (capital)', 'Ω', 'uppercase ohm'],
    ['\\digamma', 'digamma', 'ϝ', '', 'amssymb'],
    ['\\varkappa', 'kappa (variant)', 'ϰ', 'variant', 'amssymb'],
  ]),
  ...plain('Relations', [
    ['=', 'equals', '=', 'equal'],
    ['\\neq', 'not equal to', '≠', 'ne unequal different'],
    ['<', 'less than', '<'],
    ['>', 'greater than', '>'],
    ['\\leq', 'less than or equal to', '≤', 'le'],
    ['\\geq', 'greater than or equal to', '≥', 'ge'],
    ['\\leqslant', 'less than or equal to (slanted)', '⩽', 'le', 'amssymb'],
    ['\\geqslant', 'greater than or equal to (slanted)', '⩾', 'ge', 'amssymb'],
    ['\\ll', 'much less than', '≪'],
    ['\\gg', 'much greater than', '≫'],
    ['\\approx', 'approximately equal to', '≈', 'about roughly'],
    ['\\sim', 'similar to', '∼', 'tilde distributed asymptotic'],
    ['\\simeq', 'similar or equal to', '≃', 'homotopy'],
    ['\\cong', 'congruent to', '≅', 'isomorphic'],
    ['\\equiv', 'equivalent to', '≡', 'identical congruence mod'],
    ['\\propto', 'proportional to', '∝'],
    ['\\doteq', 'approaches the limit', '≐', 'dot equal'],
    ['\\coloneqq', 'defined as', '≔', 'colon equals definition assign', 'mathtools'],
    ['\\triangleq', 'defined as (delta)', '≜', 'definition equal', 'amssymb'],
    ['\\prec', 'precedes', '≺'],
    ['\\succ', 'succeeds', '≻'],
    ['\\preceq', 'precedes or equal to', '⪯'],
    ['\\succeq', 'succeeds or equal to', '⪰'],
    ['\\perp', 'perpendicular to', '⊥', 'orthogonal independent'],
    ['\\parallel', 'parallel to', '∥'],
    ['\\mid', 'divides', '∣', 'given bar such that conditional'],
    ['\\nmid', 'does not divide', '∤', 'not', 'amssymb'],
    ['\\models', 'models', '⊨', 'entails satisfies'],
    ['\\vdash', 'proves', '⊢', 'turnstile derives'],
    ['\\lesssim', 'less than or similar to', '≲', 'approximately', 'amssymb'],
    ['\\gtrsim', 'greater than or similar to', '≳', 'approximately', 'amssymb'],
  ]),
  ...plain('Operators', [
    ['+', 'plus', '+', 'add'],
    ['-', 'minus', '−', 'subtract'],
    ['\\pm', 'plus or minus', '±', 'plus-minus'],
    ['\\mp', 'minus or plus', '∓', 'minus-plus'],
    ['\\times', 'times', '×', 'multiply cross product'],
    ['\\div', 'divided by', '÷', 'division'],
    ['\\cdot', 'dot (centred)', '⋅', 'multiply dot product'],
    ['\\ast', 'asterisk', '∗', 'star convolution'],
    ['\\star', 'star', '⋆'],
    ['\\circ', 'composition', '∘', 'ring compose degree'],
    ['\\bullet', 'bullet', '∙'],
    ['\\oplus', 'circled plus', '⊕', 'direct sum xor'],
    ['\\ominus', 'circled minus', '⊖'],
    ['\\otimes', 'circled times', '⊗', 'tensor product kronecker'],
    ['\\odot', 'circled dot', '⊙', 'hadamard elementwise'],
    ['\\wedge', 'logical and', '∧', 'wedge exterior'],
    ['\\vee', 'logical or', '∨', 'vee'],
    ['\\cap', 'intersection', '∩', 'cap'],
    ['\\cup', 'union', '∪', 'cup'],
    ['\\setminus', 'set minus', '∖', 'difference backslash'],
    ['\\nabla', 'nabla', '∇', 'gradient del'],
    ['\\partial', 'partial derivative', '∂', 'partial'],
    ['\\dagger', 'dagger', '†', 'adjoint conjugate transpose'],
    ['\\wr', 'wreath product', '≀'],
  ]),
  ...plain('Arrows', [
    ['\\to', 'to', '→', 'right arrow maps tends limit function'],
    ['\\rightarrow', 'right arrow', '→', 'to'],
    ['\\leftarrow', 'left arrow', '←', 'gets'],
    ['\\leftrightarrow', 'left-right arrow', '↔', 'both'],
    ['\\Rightarrow', 'implies', '⇒', 'double right arrow'],
    ['\\Leftarrow', 'is implied by', '⇐', 'double left arrow'],
    ['\\Leftrightarrow', 'if and only if', '⇔', 'iff equivalent double'],
    ['\\implies', 'implies (long)', '⟹', 'long double right arrow', 'amsmath'],
    ['\\iff', 'if and only if (long)', '⟺', 'equivalent long double'],
    ['\\mapsto', 'maps to', '↦', 'function'],
    ['\\longrightarrow', 'long right arrow', '⟶', 'to'],
    ['\\longmapsto', 'long maps to', '⟼', 'function'],
    ['\\hookrightarrow', 'hook right arrow', '↪', 'injection embedding inclusion'],
    ['\\twoheadrightarrow', 'two-headed right arrow', '↠', 'surjection onto', 'amssymb'],
    ['\\uparrow', 'up arrow', '↑', 'increasing'],
    ['\\downarrow', 'down arrow', '↓', 'decreasing'],
    ['\\updownarrow', 'up-down arrow', '↕'],
    ['\\nearrow', 'north-east arrow', '↗'],
    ['\\searrow', 'south-east arrow', '↘'],
    ['\\rightleftharpoons', 'equilibrium', '⇌', 'harpoons reversible'],
    ['\\leadsto', 'leads to', '⇝', 'squiggly', 'amssymb'],
  ]),
  ...plain('Sets and logic', [
    ['\\in', 'element of', '∈', 'in member belongs'],
    ['\\notin', 'not an element of', '∉', 'not in member'],
    ['\\ni', 'contains as member', '∋', 'owns'],
    ['\\subset', 'subset of', '⊂', 'proper'],
    ['\\supset', 'superset of', '⊃'],
    ['\\subseteq', 'subset of or equal to', '⊆'],
    ['\\supseteq', 'superset of or equal to', '⊇'],
    ['\\subsetneq', 'proper subset of', '⊊', 'not equal', 'amssymb'],
    ['\\emptyset', 'empty set', '∅', 'null'],
    ['\\varnothing', 'empty set (round)', '∅', 'null', 'amssymb'],
    ['\\forall', 'for all', '∀', 'every universal quantifier'],
    ['\\exists', 'there exists', '∃', 'existential quantifier some'],
    ['\\nexists', 'there does not exist', '∄', 'not exists', 'amssymb'],
    ['\\neg', 'not', '¬', 'negation lnot'],
    ['\\land', 'and', '∧', 'conjunction'],
    ['\\lor', 'or', '∨', 'disjunction'],
    ['\\top', 'top', '⊤', 'true tautology'],
    ['\\bot', 'bottom', '⊥', 'false contradiction'],
    ['\\therefore', 'therefore', '∴', 'hence', 'amssymb'],
    ['\\because', 'because', '∵', 'since', 'amssymb'],
    ['\\aleph', 'aleph', 'ℵ', 'cardinal infinity hebrew'],
    ['\\infty', 'infinity', '∞', 'infinite'],
  ]),
  ...plain('Big operators', [
    ['\\sum', 'sum', '∑', 'summation sigma'],
    ['\\prod', 'product', '∏', 'pi'],
    ['\\coprod', 'coproduct', '∐'],
    ['\\int', 'integral', '∫'],
    ['\\iint', 'double integral', '∬', 'surface', 'amsmath'],
    ['\\iiint', 'triple integral', '∭', 'volume', 'amsmath'],
    ['\\oint', 'contour integral', '∮', 'closed line'],
    ['\\bigcup', 'union (big)', '⋃', 'n-ary'],
    ['\\bigcap', 'intersection (big)', '⋂', 'n-ary'],
    ['\\bigoplus', 'direct sum (big)', '⨁', 'n-ary'],
    ['\\bigotimes', 'tensor product (big)', '⨂', 'n-ary'],
    ['\\bigwedge', 'logical and (big)', '⋀', 'n-ary'],
    ['\\bigvee', 'logical or (big)', '⋁', 'n-ary'],
  ]),
  ...plain('Delimiters', [
    ['\\langle', 'left angle bracket', '⟨', 'inner product bra'],
    ['\\rangle', 'right angle bracket', '⟩', 'inner product ket'],
    ['\\lfloor', 'left floor', '⌊', 'round down'],
    ['\\rfloor', 'right floor', '⌋', 'round down'],
    ['\\lceil', 'left ceiling', '⌈', 'round up'],
    ['\\rceil', 'right ceiling', '⌉', 'round up'],
    ['\\{', 'left brace', '{', 'curly set'],
    ['\\}', 'right brace', '}', 'curly set'],
    ['\\lvert', 'left bar', '|', 'absolute value', 'amsmath'],
    ['\\rvert', 'right bar', '|', 'absolute value', 'amsmath'],
    ['\\lVert', 'left double bar', '‖', 'norm', 'amsmath'],
    ['\\rVert', 'right double bar', '‖', 'norm', 'amsmath'],
  ]),
  {
    cmd: '\\left( \\right)',
    tex: '\\left( x \\right)',
    snippet: '\\\\left( $1 \\\\right)',
    name: 'parentheses (sized)',
    keywords: ['brackets', 'auto', 'size', 'left', 'right'],
    category: 'Delimiters',
  },
  ...withArgs('Accents and fonts', [
    ['\\hat', ['x'], 'hat', 'circumflex estimate estimator'],
    ['\\widehat', ['xy'], 'wide hat', 'circumflex estimate'],
    ['\\bar', ['x'], 'bar', 'macron mean average'],
    ['\\overline', ['xy'], 'overline', 'bar conjugate closure mean'],
    ['\\underline', ['xy'], 'underline'],
    ['\\tilde', ['x'], 'tilde', 'approximation'],
    ['\\widetilde', ['xy'], 'wide tilde'],
    ['\\vec', ['x'], 'vector arrow', 'vector'],
    ['\\overrightarrow', ['AB'], 'arrow over', 'vector segment'],
    ['\\dot', ['x'], 'dot', 'time derivative'],
    ['\\ddot', ['x'], 'double dot', 'second time derivative'],
    ['\\check', ['x'], 'check', 'caron háček'],
    ['\\acute', ['x'], 'acute accent'],
    ['\\grave', ['x'], 'grave accent'],
    ['\\breve', ['x'], 'breve'],
    ['\\overbrace', ['xy'], 'overbrace', 'brace above'],
    ['\\underbrace', ['xy'], 'underbrace', 'brace below'],
    ['\\mathbb', ['R'], 'blackboard bold', 'double struck reals integers naturals field', 'amsfonts'],
    ['\\mathcal', ['L'], 'calligraphic', 'script'],
    ['\\mathscr', ['L'], 'script (formal)', 'calligraphic rsfs', 'mathrsfs'],
    ['\\mathfrak', ['g'], 'fraktur', 'gothic lie algebra ideal', 'amsfonts'],
    ['\\mathbf', ['x'], 'bold', 'vector matrix'],
    ['\\boldsymbol', ['\\alpha'], 'bold symbol', 'bold greek vector', 'amsmath'],
    ['\\mathrm', ['d'], 'roman (upright)', 'upright differential'],
    ['\\mathit', ['xy'], 'italic'],
    ['\\mathsf', ['x'], 'sans-serif'],
    ['\\mathtt', ['x'], 'typewriter', 'monospace'],
    ['\\text', ['if'], 'text in math', 'words roman', 'amsmath'],
    ['\\operatorname', ['rank'], 'operator name', 'function upright', 'amsmath'],
  ]),
  ...withArgs('Functions', [
    ['\\frac', ['a', 'b'], 'fraction', 'divide over ratio'],
    ['\\dfrac', ['a', 'b'], 'fraction (display size)', 'divide over', 'amsmath'],
    ['\\tfrac', ['a', 'b'], 'fraction (text size)', 'divide over', 'amsmath'],
    ['\\sqrt', ['x'], 'square root', 'radical'],
    ['\\binom', ['n', 'k'], 'binomial coefficient', 'choose combination', 'amsmath'],
    ['\\overset', ['!', '='], 'symbol over', 'stack above', 'amsmath'],
    ['\\underset', ['x', '\\min'], 'symbol under', 'stack below', 'amsmath'],
    ['\\stackrel', ['?', '='], 'stack relation', 'over above'],
    ['\\xrightarrow', ['f'], 'arrow with label', 'extensible right arrow', 'amsmath'],
  ]),
  ...plain('Functions', [
    ['\\sin', 'sine', '', 'trigonometric'],
    ['\\cos', 'cosine', '', 'trigonometric'],
    ['\\tan', 'tangent', '', 'trigonometric'],
    ['\\arcsin', 'arcsine', '', 'inverse trigonometric'],
    ['\\arccos', 'arccosine', '', 'inverse trigonometric'],
    ['\\arctan', 'arctangent', '', 'inverse trigonometric'],
    ['\\sinh', 'hyperbolic sine', '', 'hyperbolic'],
    ['\\cosh', 'hyperbolic cosine', '', 'hyperbolic'],
    ['\\tanh', 'hyperbolic tangent', '', 'hyperbolic activation'],
    ['\\exp', 'exponential', '', 'e power'],
    ['\\log', 'logarithm', '', 'log'],
    ['\\ln', 'natural logarithm', '', 'log'],
    ['\\lim', 'limit', '', 'tends'],
    ['\\limsup', 'limit superior', '', 'lim sup'],
    ['\\liminf', 'limit inferior', '', 'lim inf'],
    ['\\sup', 'supremum', '', 'least upper bound'],
    ['\\inf', 'infimum', '', 'greatest lower bound'],
    ['\\max', 'maximum', '', 'largest'],
    ['\\min', 'minimum', '', 'smallest'],
    ['\\arg', 'argument', '', 'angle phase'],
    ['\\det', 'determinant', '', 'matrix'],
    ['\\dim', 'dimension', ''],
    ['\\ker', 'kernel', '', 'null space'],
    ['\\deg', 'degree', '', 'polynomial'],
    ['\\gcd', 'greatest common divisor', '', 'gcd'],
    ['\\Pr', 'probability', '', 'chance'],
    ['\\bmod', 'modulo (binary)', '', 'mod remainder'],
  ]),
  ...withArgs('Functions', [['\\pmod', ['n'], 'modulo (in parentheses)', 'mod congruence']]),
  ...plain('Miscellaneous', [
    ['\\ldots', 'dots (low)', '…', 'ellipsis'],
    ['\\cdots', 'dots (centred)', '⋯', 'ellipsis'],
    ['\\vdots', 'dots (vertical)', '⋮', 'ellipsis'],
    ['\\ddots', 'dots (diagonal)', '⋱', 'ellipsis'],
    ['\\prime', 'prime', '′', 'derivative'],
    ['\\hbar', 'h-bar', 'ℏ', 'planck reduced'],
    ['\\ell', 'script l', 'ℓ', 'ell length norm'],
    ['\\Re', 'real part', 'ℜ', 'fraktur'],
    ['\\Im', 'imaginary part', 'ℑ', 'fraktur'],
    ['\\wp', 'Weierstrass p', '℘', 'power set'],
    ['\\angle', 'angle', '∠'],
    ['\\triangle', 'triangle', '△'],
    ['\\square', 'square', '□', 'box', 'amssymb'],
    ['\\blacksquare', 'filled square', '■', 'qed end of proof', 'amssymb'],
    ['\\checkmark', 'check mark', '✓', 'tick', 'amssymb'],
    ['\\surd', 'root sign', '√', 'radical'],
    ['\\flat', 'flat', '♭', 'music'],
    ['\\sharp', 'sharp', '♯', 'music'],
    ['\\clubsuit', 'club', '♣', 'cards'],
    ['\\heartsuit', 'heart', '♡', 'cards'],
    ['\\quad', 'space (quad)', '', 'spacing gap'],
    ['\\qquad', 'space (two quads)', '', 'spacing gap'],
    ['\\,', 'thin space', '', 'spacing'],
  ]).map((s) => (s.name.includes('space') ? { ...s, tex: `|${s.cmd}|` } : s)),
];

const STOPWORDS = new Set(['or', 'and', 'of', 'the', 'to', 'a', 'an', 'than', 'with']);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter(Boolean);
}

/** How well one query term matches a symbol; 0 for not at all. */
function termScore(sym: MathSymbol, term: string): number {
  const bare = sym.cmd.replace(/^\\/, '').toLowerCase();
  const raw = sym.cmd.toLowerCase();
  if (term === raw || term === bare) {
    return 100;
  }
  if (sym.char && term === sym.char.toLowerCase()) {
    return 100;
  }
  const nameWords = words(sym.name);
  if (nameWords.includes(term)) {
    return 60;
  }
  const keywordWords = sym.keywords.map((k) => k.toLowerCase());
  if (keywordWords.includes(term)) {
    return 50;
  }
  if (term.length >= 2 && (bare.startsWith(term.replace(/^\\/, '')) || raw.startsWith(term))) {
    return 70;
  }
  if (term.length >= 2 && nameWords.some((w) => w.startsWith(term))) {
    return 45;
  }
  if (term.length >= 2 && keywordWords.some((w) => w.startsWith(term))) {
    return 35;
  }
  if (term.length >= 3 && bare.includes(term)) {
    return 25;
  }
  if (term.length >= 3 && words(sym.category).some((w) => w.startsWith(term))) {
    return 20;
  }
  return 0;
}

/**
 * The symbols matching `query`, best first: by command (`leq`, `\leq`), character (`≤`), name or
 * keyword (`less or equal`). Every word must match. Ties go to the more used, then the list order.
 * An empty query gives the most used first, then the rest in list order.
 */
export function searchSymbols(query: string, usage: Record<string, number> = {}, symbols: MathSymbol[] = SYMBOLS): MathSymbol[] {
  const trimmed = query.trim().toLowerCase();
  const uses = (s: MathSymbol) => usage[s.cmd] ?? 0;
  const ranked = (scored: { sym: MathSymbol; score: number; index: number }[]) =>
    scored
      .sort((a, b) => b.score - a.score || uses(b.sym) - uses(a.sym) || a.index - b.index)
      .map((x) => x.sym);
  if (!trimmed) {
    return ranked(symbols.map((sym, index) => ({ sym, score: 0, index })));
  }
  let terms = trimmed.split(/\s+/);
  const content = terms.filter((t) => !STOPWORDS.has(t));
  if (content.length) {
    terms = content;
  }
  const whole = trimmed.replace(/\s+/g, ' ');
  const scored: { sym: MathSymbol; score: number; index: number }[] = [];
  symbols.forEach((sym, index) => {
    let score = 0;
    for (const term of terms) {
      const s = termScore(sym, term);
      if (!s) {
        return;
      }
      score += s;
    }
    if (sym.name.toLowerCase() === whole) {
      score += 50;
    }
    scored.push({ sym, score, index });
  });
  return ranked(scored);
}

/** The most used symbols, most used first, at most `limit`. */
export function frequentSymbols(usage: Record<string, number>, limit: number, symbols: MathSymbol[] = SYMBOLS): MathSymbol[] {
  return symbols
    .filter((s) => (usage[s.cmd] ?? 0) > 0)
    .sort((a, b) => (usage[b.cmd] ?? 0) - (usage[a.cmd] ?? 0))
    .slice(0, limit);
}
