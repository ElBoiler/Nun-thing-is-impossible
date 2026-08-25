/**
 * One shape for both input kinds.
 *
 * A rule should not care whether "Auftragsnummer" came out of a PDF text line
 * or a spreadsheet cell, so both are loaded into the same `SourceDocument`:
 * `lines` + `text` for everything, `workbook`/`sheets` when the input is a
 * spreadsheet.
 */

import { fromLatin1, toBytes } from './bytes.js';
import { readPdf } from './pdf-text.js';
import { readXlsx } from './xlsx-read.js';

/** Sniff the file kind from magic bytes first, filename second. */
export function detectKind(bytes, fileName = '') {
  const head = fromLatin1(toBytes(bytes).subarray(0, 8));
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('PK')) return 'xlsx';
  const extension = fileName.toLowerCase().split('.').pop();
  if (extension === 'pdf') return 'pdf';
  if (['xlsx', 'xlsm', 'xltx', 'xltm'].includes(extension)) return 'xlsx';
  if (extension === 'xls') return 'xls';
  return 'unknown';
}

class SourceDocument {
  constructor(properties) {
    Object.assign(this, properties);
  }

  /** All text lines, optionally restricted to one page (PDF). */
  linesOf(page = null) {
    return page ? this.lines.filter((line) => line.page === page) : this.lines;
  }

  sheet(name) {
    if (!this.workbook) return null;
    return this.workbook.sheet(name);
  }

  requireSheet(name) {
    if (!this.workbook) throw new Error('This rule reads spreadsheet cells, but the input file is not a workbook');
    return this.workbook.requireSheet(name);
  }

  /** Short human summary for the UI. */
  describe() {
    if (this.kind === 'pdf') {
      return `${this.pageCount} page${this.pageCount === 1 ? '' : 's'}, ${this.lines.length} text lines`;
    }
    return `${this.sheets.length} sheet${this.sheets.length === 1 ? '' : 's'}: ${this.sheets.join(', ')}`;
  }
}

/**
 * Load a PDF or workbook into the common document model.
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {string} fileName
 */
export async function loadSourceDocument(bytes, fileName = '') {
  const data = toBytes(bytes);
  const kind = detectKind(data, fileName);

  if (kind === 'pdf') {
    const pdf = await readPdf(data);
    return new SourceDocument({
      kind: 'pdf',
      fileName,
      byteLength: data.byteLength,
      pageCount: pdf.pageCount,
      pages: pdf.pages,
      lines: pdf.lines.map((line) => ({
        text: line.text,
        page: line.page,
        index: line.index,
        x: line.x,
        y: line.y,
        items: line.items,
      })),
      text: pdf.text,
      workbook: null,
      sheets: [],
    });
  }

  if (kind === 'xlsx') {
    const workbook = await readXlsx(data);
    const lines = [];
    for (const sheet of workbook.sheets) {
      for (const row of sheet.preview(Number.MAX_SAFE_INTEGER)) {
        const text = row.join('\t').replace(/\t+$/, '');
        if (text.trim()) lines.push({ text, page: 1, sheet: sheet.name, index: lines.length, x: 0, y: 0 });
      }
    }
    return new SourceDocument({
      kind: 'xlsx',
      fileName,
      byteLength: data.byteLength,
      pageCount: workbook.sheets.length,
      pages: [],
      lines,
      text: lines.map((line) => line.text).join('\n'),
      workbook,
      sheets: workbook.sheetNames,
    });
  }

  if (kind === 'xls') {
    throw new Error('Legacy .xls files are not supported. Save the file as .xlsx and try again.');
  }
  throw new Error(`Unsupported input file "${fileName || 'file'}" — expected a PDF or an Excel workbook`);
}

export { SourceDocument };
