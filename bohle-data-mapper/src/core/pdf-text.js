/**
 * PDF text extraction, backed by pdf.js.
 *
 * pdf.js is vendored under vendor/pdfjs/ (Apache-2.0) rather than pulled from
 * node_modules at runtime, because the extension has no build step. The
 * *legacy* build is used on purpose: it is the one that runs both in the
 * extension page and in plain Node, so `npm test` exercises the same extractor
 * the app uses.
 *
 * What this module adds on top of `getTextContent()` is the part the rules
 * depend on: glyph runs are placed in page (device) coordinates, honouring page
 * rotation, and then reassembled into positioned *lines* — because a mapping
 * rule like `^(\d+)\s+(.+?)\s+([\d.,]+)$` is written against lines, not against
 * the fragments a PDF happens to be built from.
 *
 * Out of scope on purpose: encrypted PDFs and scanned pages with no text layer.
 * Both fail with an explicit message rather than silently producing nothing.
 */

import * as pdfjs from '../../vendor/pdfjs/pdf.mjs';
import { toBytes } from './bytes.js';

const WORKER_URL = new URL('../../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;

/**
 * Point pdf.js at the vendored worker — but only in a browser. In Node there is
 * no `Worker`, and pdf.js falls back to running on the main thread by itself.
 */
function configureWorker() {
  if (typeof Worker === 'undefined') return;
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL;
}

/**
 * Group positioned glyph runs into lines.
 *
 * Items arrive in the order the content stream draws them, which is rarely
 * reading order, so they are sorted top-to-bottom then left-to-right and
 * grouped by baseline. A gap wider than a fraction of the font size becomes a
 * space, which is what keeps table columns apart.
 */
export function assembleLines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  let current = null;

  for (const item of sorted) {
    const tolerance = Math.max(1.5, (item.height || 10) * 0.4);
    if (!current || Math.abs(current.y - item.y) > tolerance) {
      current = { y: item.y, items: [item] };
      lines.push(current);
    } else {
      current.items.push(item);
      current.y = (current.y * (current.items.length - 1) + item.y) / current.items.length;
    }
  }

  return lines
    .map((line, index) => {
      line.items.sort((a, b) => a.x - b.x);
      let text = '';
      let previousEnd = null;
      for (const item of line.items) {
        if (previousEnd !== null) {
          const gap = item.x - previousEnd;
          const threshold = Math.max(1, (item.height || 10) * 0.18);
          if (gap > threshold && !/\s$/.test(text) && !/^\s/.test(item.text)) text += ' ';
        }
        text += item.text;
        previousEnd = item.x + item.width;
      }
      return {
        index,
        y: line.y,
        x: line.items.length ? line.items[0].x : 0,
        text: text.replace(/\s+/g, ' ').trim(),
        items: line.items,
      };
    })
    .filter((line) => line.text.length > 0);
}

function describeError(error) {
  const name = error?.name || '';
  if (name === 'PasswordException') {
    return 'This PDF is password protected. Remove the protection and try again.';
  }
  if (name === 'InvalidPDFException') {
    return `This file is not a readable PDF (${error.message}).`;
  }
  return null;
}

/**
 * Extract the text layer of a PDF.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{password?: string}} [options]
 * @returns {Promise<{pageCount:number, pages:Array, lines:Array, text:string}>}
 */
export async function readPdf(input, { password } = {}) {
  configureWorker();

  const task = pdfjs.getDocument({
    // pdf.js transfers the buffer to its worker and detaches it, so hand it a
    // copy — the caller still owns the bytes it passed in.
    data: new Uint8Array(toBytes(input)),
    password,
    // MV3 forbids eval, and nothing here renders glyphs or fetches assets.
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    // Routine "standard font data not provided" notices are expected: we read
    // the text layer and never draw it. Real problems still surface.
    verbosity: pdfjs.VerbosityLevel?.ERRORS ?? 0,
  });

  let pdf;
  try {
    pdf = await task.promise;
  } catch (error) {
    const message = describeError(error);
    await task.destroy().catch(() => {});
    throw message ? new Error(message) : error;
  }

  try {
    const pages = [];
    const allLines = [];
    let lineCounter = 0;

    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      // The viewport transform maps text space to page coordinates with a
      // top-left origin and applies /Rotate, so rotated pages read correctly.
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      // Applied by hand rather than through pdf.js's Util, whose signature has
      // changed between versions; this is stable across vendored upgrades.
      const [va, vb, vc, vd, ve, vf] = viewport.transform;
      const items = [];
      for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        const tx = item.transform[4];
        const ty = item.transform[5];
        const x = va * tx + vc * ty + ve;
        const y = vb * tx + vd * ty + vf;
        items.push({
          text: item.str,
          x,
          y,
          width: item.width,
          height: item.height || Math.hypot(item.transform[2], item.transform[3]),
          font: item.fontName,
        });
      }

      const lines = assembleLines(items).map((line) => ({ ...line, page: number, index: lineCounter++ }));
      allLines.push(...lines);
      pages.push({
        number,
        width: viewport.width,
        height: viewport.height,
        items,
        lines,
        text: lines.map((line) => line.text).join('\n'),
      });
      page.cleanup();
    }

    const text = pages.map((page) => page.text).join('\n');
    if (!text.trim() && pages.length) {
      throw new Error(
        'No text layer found — this PDF looks like a scan. Run OCR on it first (e.g. "Text erkennen" in Acrobat) and try again.',
      );
    }

    return { pageCount: pages.length, pages, lines: allLines, text };
  } finally {
    await task.destroy().catch(() => {});
  }
}
