// Renders TeX math to SVG with MathJax. Bundled on its own (out/mathRender.js) and loaded on the
// first math hover, so MathJax costs nothing at activation.
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import '@mathjax/src/js/input/tex/base/BaseConfiguration.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import '@mathjax/src/js/input/tex/color/ColorConfiguration.js';
import '@mathjax/src/js/input/tex/cancel/CancelConfiguration.js';
import '@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js';
import '@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js';
import { MathJaxTexFont } from '@mathjax/mathjax-tex-font/js/svg.js';

const PACKAGES = ['base', 'ams', 'newcommand', 'boldsymbol', 'color', 'cancel', 'mathtools', 'textmacros'];

export type RenderResult = { svg: string } | { error: string };

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

type Doc = ReturnType<typeof mathjax.document>;
let cached: { key: string; doc: Doc } | undefined;

/**
 * Renders `tex` to an SVG string, after defining the macros in `preamble` (each a \newcommand-style
 * definition; one that MathJax rejects is skipped). The document is reused while the preamble stays
 * the same, so macros from one file do not leak into another.
 */
export function renderMath(tex: string, display: boolean, preamble: string[]): RenderResult {
  const key = preamble.join('\n');
  if (cached?.key !== key) {
    const doc = mathjax.document('', {
      InputJax: new TeX({ packages: PACKAGES, formatError: (_jax: unknown, err: Error) => { throw err; } }),
      OutputJax: new SVG({ fontCache: 'local', fontData: MathJaxTexFont }),
    });
    for (const def of preamble) {
      try {
        doc.convert(def, { display: false });
      } catch {
        // A definition MathJax cannot handle; the math may still render without it.
      }
    }
    cached = { key, doc };
  }
  try {
    const node = cached.doc.convert(tex, { display });
    return { svg: adaptor.innerHTML(node) };
  } catch (err) {
    // MathJax's TexError is not an Error subclass, but it has a message.
    const message = (err as { message?: unknown })?.message;
    return { error: typeof message === 'string' ? message : String(err) };
  }
}
