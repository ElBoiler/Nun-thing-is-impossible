/**
 * Refresh the vendored pdf.js build from node_modules.
 *
 *   npm run vendor:pdfjs
 *
 * The extension has no build step, so pdf.js is committed under vendor/pdfjs/
 * rather than resolved from node_modules at runtime. The *legacy* build is used
 * deliberately: it is the only one that runs both in the extension page and in
 * plain Node, which keeps `npm test` able to exercise the real extractor.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'node_modules', 'pdfjs-dist');
const TARGET = join(ROOT, 'vendor', 'pdfjs');

const { version } = JSON.parse(readFileSync(join(SOURCE, 'package.json'), 'utf8'));

mkdirSync(TARGET, { recursive: true });
const files = [
  ['legacy/build/pdf.min.mjs', 'pdf.mjs'],
  ['legacy/build/pdf.worker.min.mjs', 'pdf.worker.mjs'],
  ['LICENSE', 'LICENSE'],
];
for (const [from, to] of files) {
  copyFileSync(join(SOURCE, from), join(TARGET, to));
  console.log(`vendor/pdfjs/${to}`);
}

writeFileSync(
  join(TARGET, 'README.md'),
  `# Vendored pdf.js\n\n`
  + `pdf.js ${version} (Apache License 2.0, see LICENSE), copied from the \`pdfjs-dist\`\n`
  + `package by \`npm run vendor:pdfjs\`. Do not edit these files by hand.\n\n`
  + `- \`pdf.mjs\` — minified \`legacy/build/pdf.min.mjs\`\n`
  + `- \`pdf.worker.mjs\` — minified \`legacy/build/pdf.worker.min.mjs\`\n\n`
  + `The legacy build is used on purpose: it runs unchanged in the extension page\n`
  + `and in Node, so the test suite exercises the same extractor the app uses.\n\n`
  + `Not vendored: \`standard_fonts/\`, \`cmaps/\` and \`wasm/\`. They matter for\n`
  + `*rendering* glyphs, decoding images and predefined CJK encodings; this project\n`
  + `only reads the text layer, and extraction was verified byte-identical with and\n`
  + `without the standard font data. If a document ever needs them, copy the folder\n`
  + `here and pass \`standardFontDataUrl\` in src/core/pdf-text.js.\n`,
);
console.log(`vendor/pdfjs/README.md (pdf.js ${version})`);
