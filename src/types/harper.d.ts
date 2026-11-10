// The part of harper.js (Apache-2.0) that Overtex uses. The package's own declarations are only
// reachable through its `exports` map, which `"module": "commonjs"` resolution does not read.
declare module 'harper.js' {
  export interface Span {
    start: number;
    end: number;
  }

  export interface Suggestion {
    get_replacement_text(): string;
    /** 0 replace, 1 remove, 2 insert after. */
    kind(): number;
  }

  export interface Lint {
    /** UTF-16 offsets into the linted text. */
    span(): Span;
    message(): string;
    /** The category, such as `Spelling` or `Agreement`. */
    lint_kind(): string;
    suggestions(): Suggestion[];
  }

  export interface LintOptions {
    language?: 'plaintext' | 'markdown' | 'typst';
  }

  export type LintConfig = Record<string, boolean | null>;

  export interface BinaryModule {
    readonly url: string | URL;
  }

  export class LocalLinter {
    constructor(init: { binary: BinaryModule; dialect?: number });
    setup(): Promise<void>;
    /** Lints keyed by the name of the rule that found them, the key `setLintConfig` takes. */
    organizedLints(text: string, options?: LintOptions): Promise<Record<string, Lint[]>>;
    getDefaultLintConfig(): Promise<LintConfig>;
    setLintConfig(config: LintConfig): Promise<void>;
    setDialect(dialect: number): Promise<void>;
    importWords(words: string[]): Promise<void>;
    clearWords(): Promise<void>;
    dispose(): Promise<void>;
  }

  export function createBinaryModuleFromUrl(url: string | URL, glueFlavor?: 'full' | 'slim'): BinaryModule;
}
