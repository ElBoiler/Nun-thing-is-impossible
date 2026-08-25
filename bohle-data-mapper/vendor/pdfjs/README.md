# Vendored pdf.js

pdf.js 6.2.108 (Apache License 2.0, see LICENSE), copied from the `pdfjs-dist`
package by `npm run vendor:pdfjs`. Do not edit these files by hand.

- `pdf.mjs` — minified `legacy/build/pdf.min.mjs`
- `pdf.worker.mjs` — minified `legacy/build/pdf.worker.min.mjs`

The legacy build is used on purpose: it runs unchanged in the extension page
and in Node, so the test suite exercises the same extractor the app uses.

Not vendored: `standard_fonts/`, `cmaps/` and `wasm/`. They matter for
*rendering* glyphs, decoding images and predefined CJK encodings; this project
only reads the text layer, and extraction was verified byte-identical with and
without the standard font data. If a document ever needs them, copy the folder
here and pass `standardFontDataUrl` in src/core/pdf-text.js.
