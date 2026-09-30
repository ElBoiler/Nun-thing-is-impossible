/**
 * Node shims for the vendored pdf.js build.
 *
 * pdf.js touches a handful of browser globals at import time. In the extension
 * they exist; in Node they do not, and pdf.js tries to fill the gap with the
 * optional native package `@napi-rs/canvas`. Depending on that would mean a
 * ~40 MB native binary in every checkout, purely so the tests can run — and
 * this project never renders a glyph, it only reads the text layer.
 *
 * So: define the minimum pdf.js needs to load and extract text. `??=` means the
 * browser's real implementations are never touched.
 *
 * pdf.js still prints one `Cannot load "@napi-rs/canvas"` warning on the first
 * import in Node. It is expected and harmless — text extraction works, as
 * test/run.mjs asserts on every run.
 *
 * MUST be imported before vendor/pdfjs/pdf.mjs: ES modules are evaluated in
 * import order, so the shim has to be declared first.
 */

/** A 2-D affine matrix, the subset pdf.js uses outside of rendering. */
class NodeDOMMatrix {
  constructor(init) {
    let values = [1, 0, 0, 1, 0, 0];
    if (typeof init === 'string') {
      const numbers = init.match(/[-+0-9.eE]+/g);
      if (numbers && numbers.length === 6) values = numbers.map(Number);
    } else if (Array.isArray(init) && init.length === 6) {
      values = init.map(Number);
    } else if (init && typeof init === 'object') {
      values = [init.a ?? 1, init.b ?? 0, init.c ?? 0, init.d ?? 1, init.e ?? 0, init.f ?? 0];
    }
    [this.a, this.b, this.c, this.d, this.e, this.f] = values;
  }

  multiplySelf(other) {
    const { a, b, c, d, e, f } = this;
    this.a = a * other.a + c * other.b;
    this.b = b * other.a + d * other.b;
    this.c = a * other.c + c * other.d;
    this.d = b * other.c + d * other.d;
    this.e = a * other.e + c * other.f + e;
    this.f = b * other.e + d * other.f + f;
    return this;
  }

  multiply(other) {
    return new NodeDOMMatrix(this).multiplySelf(other);
  }

  scaleSelf(x = 1, y = x) {
    this.a *= x;
    this.b *= x;
    this.c *= y;
    this.d *= y;
    return this;
  }

  scale(x, y) {
    return new NodeDOMMatrix(this).scaleSelf(x, y);
  }

  translateSelf(x = 0, y = 0) {
    this.e += this.a * x + this.c * y;
    this.f += this.b * x + this.d * y;
    return this;
  }

  translate(x, y) {
    return new NodeDOMMatrix(this).translateSelf(x, y);
  }

  transformPoint(point = {}) {
    const x = point.x ?? 0;
    const y = point.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f };
  }
}

globalThis.DOMMatrix ??= NodeDOMMatrix;
// Only ever constructed while drawing, which this project does not do.
globalThis.Path2D ??= class Path2D {};
globalThis.ImageData ??= class ImageData {};

export { NodeDOMMatrix };
