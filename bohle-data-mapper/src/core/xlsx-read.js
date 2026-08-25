/**
 * Reader for .xlsx / .xlsm workbooks.
 *
 * Only what a mapping run needs: sheet names, cell values, number-format aware
 * date handling and header-driven row objects. Charts, pivots and drawings are
 * ignored on read (and preserved untouched on write, see xlsx-write.js).
 */

import { formatRef, numberToColumn, parseRange, parseRef } from './a1.js';
import { decodeXml, findElements, tokenize } from './xml.js';
import { readZip } from './zip.js';

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Excel serial number -> Date (1900 date system, including the 1900 leap-year bug). */
export function serialToDate(serial) {
  const days = serial < 60 ? serial : serial - 1;
  const ms = Math.round(days * 86400000);
  return new Date(Date.UTC(1899, 11, 31) + ms);
}

/** Date -> Excel serial number. */
export function dateToSerial(date) {
  const ms = date.getTime() - Date.UTC(1899, 11, 31);
  const days = ms / 86400000;
  return days < 60 ? days : days + 1;
}

function looksLikeDateFormat(code) {
  // Strip literals and colour/condition sections before sniffing for date tokens.
  const stripped = String(code)
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  return /[dmyhs]/i.test(stripped);
}

class Sheet {
  constructor(name, path, { cells, maxRow, maxCol }) {
    this.name = name;
    this.path = path;
    /** @type {Map<string, object>} keyed by A1 reference */
    this.cells = cells;
    this.maxRow = maxRow;
    this.maxCol = maxCol;
  }

  cell(ref) {
    return this.cells.get(String(ref).toUpperCase().replace(/\$/g, '')) || null;
  }

  /** Typed value of a cell (number | string | boolean | Date | null). */
  value(ref) {
    const cell = this.cell(ref);
    return cell ? cell.value : null;
  }

  /** Display-ish string for a cell. */
  text(ref) {
    const cell = this.cell(ref);
    if (!cell || cell.value === null || cell.value === undefined) return '';
    if (cell.value instanceof Date) return cell.value.toISOString().slice(0, 10);
    return String(cell.value);
  }

  /** Values of an A1 range as a 2D array (row-major). */
  range(a1) {
    const { start, end } = parseRange(a1);
    const rows = [];
    for (let row = start.row; row <= end.row; row++) {
      const line = [];
      for (let col = start.col; col <= end.col; col++) {
        line.push(this.value(formatRef(col, row)));
      }
      rows.push(line);
    }
    return rows;
  }

  /**
   * Rows as objects keyed by the header row's labels (and by column letter),
   * which is what table rules consume.
   */
  rowObjects({ headerRow = 1, startRow = null, endRow = null, stopOnEmpty = true } = {}) {
    const headers = new Map();
    for (let col = 1; col <= this.maxCol; col++) {
      const label = this.text(formatRef(col, headerRow)).trim();
      if (label) headers.set(col, label);
    }
    const first = startRow ?? headerRow + 1;
    const last = endRow ?? this.maxRow;
    const out = [];
    let blanks = 0;
    for (let row = first; row <= last; row++) {
      const record = { _row: row, _cells: {} };
      let empty = true;
      for (let col = 1; col <= this.maxCol; col++) {
        const value = this.value(formatRef(col, row));
        const letter = numberToColumn(col);
        record._cells[letter] = value;
        record[letter] = value;
        const header = headers.get(col);
        if (header && record[header] === undefined) record[header] = value;
        if (value !== null && value !== '' && value !== undefined) empty = false;
      }
      if (empty) {
        blanks++;
        if (stopOnEmpty && blanks >= 2) break;
        continue;
      }
      blanks = 0;
      out.push(record);
    }
    return { headers: [...headers.values()], rows: out };
  }

  /** Compact preview used by the UI. */
  preview(limit = 25) {
    const rows = [];
    for (let row = 1; row <= Math.min(this.maxRow, limit); row++) {
      const line = [];
      for (let col = 1; col <= Math.min(this.maxCol, 20); col++) line.push(this.text(formatRef(col, row)));
      rows.push(line);
    }
    return rows;
  }
}

class Workbook {
  constructor({ archive, sheets, sharedStrings }) {
    this.archive = archive;
    /** @type {Sheet[]} */
    this.sheets = sheets;
    this.sharedStrings = sharedStrings;
  }

  get sheetNames() {
    return this.sheets.map((s) => s.name);
  }

  sheet(name) {
    if (name === null || name === undefined || name === '') return this.sheets[0] || null;
    const wanted = String(name).toLowerCase();
    return this.sheets.find((s) => s.name.toLowerCase() === wanted) || null;
  }

  requireSheet(name) {
    const sheet = this.sheet(name);
    if (!sheet) {
      throw new Error(`Sheet "${name}" not found. Available: ${this.sheetNames.join(', ') || '(none)'}`);
    }
    return sheet;
  }
}

function parseSharedStrings(xml) {
  const strings = [];
  if (!xml) return strings;
  let current = null;
  let inPhonetic = false;
  let textDepth = 0;
  for (const token of tokenize(xml)) {
    if (token.type === 'open' && token.localName === 'si') current = '';
    else if (token.type === 'close' && token.localName === 'si') {
      strings.push(current || '');
      current = null;
    } else if (token.localName === 'rPh' || token.localName === 'phoneticPr') {
      inPhonetic = token.type === 'open';
    } else if (current !== null && !inPhonetic) {
      if (token.type === 'open' && token.localName === 't') textDepth++;
      else if (token.type === 'close' && token.localName === 't') textDepth--;
      else if (token.type === 'text' && textDepth > 0) current += decodeXml(token.value);
    }
  }
  return strings;
}

function parseStyles(xml) {
  const dateStyles = new Set();
  if (!xml) return dateStyles;
  const customFormats = new Map();
  for (const numFmt of findElements(xml, 'numFmt')) {
    const id = Number(numFmt.attrs.numFmtId);
    if (Number.isFinite(id)) customFormats.set(id, numFmt.attrs.formatCode || '');
  }
  const cellXfsBlocks = findElements(xml, 'cellXfs');
  const block = cellXfsBlocks.length ? cellXfsBlocks[cellXfsBlocks.length - 1] : null;
  if (!block) return dateStyles;
  const xfs = findElements(block.text, 'xf');
  xfs.forEach((xf, index) => {
    const id = Number(xf.attrs.numFmtId || 0);
    if (BUILTIN_DATE_FORMATS.has(id)) dateStyles.add(index);
    else if (customFormats.has(id) && looksLikeDateFormat(customFormats.get(id))) dateStyles.add(index);
  });
  return dateStyles;
}

function parseSheetXml(xml, { sharedStrings, dateStyles }) {
  const cells = new Map();
  let maxRow = 0;
  let maxCol = 0;

  let cell = null;
  let inValue = false;
  let inFormula = false;
  let inInline = 0;
  let inInlineText = 0;

  const finish = () => {
    if (!cell) return;
    const { col, row } = parseRef(cell.ref);
    let value = null;
    let kind = 'empty';
    switch (cell.t) {
      case 's': {
        const index = Number(cell.raw);
        value = sharedStrings[index] ?? '';
        kind = 'text';
        break;
      }
      case 'inlineStr':
        value = cell.inline;
        kind = 'text';
        break;
      case 'str':
        value = cell.raw;
        kind = 'text';
        break;
      case 'b':
        value = cell.raw === '1' || cell.raw === 'true';
        kind = 'boolean';
        break;
      case 'e':
        value = cell.raw;
        kind = 'error';
        break;
      default: {
        if (cell.raw === '' || cell.raw === null || cell.raw === undefined) {
          value = null;
          kind = 'empty';
        } else {
          const num = Number(cell.raw);
          if (Number.isFinite(num)) {
            if (cell.s !== null && dateStyles.has(cell.s)) {
              value = serialToDate(num);
              kind = 'date';
            } else {
              value = num;
              kind = 'number';
            }
          } else {
            value = cell.raw;
            kind = 'text';
          }
        }
      }
    }
    if (value !== null || cell.formula) {
      cells.set(cell.ref, {
        ref: cell.ref,
        row,
        col,
        kind,
        value,
        raw: cell.raw,
        style: cell.s,
        formula: cell.formula || null,
      });
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }
    cell = null;
  };

  let currentRow = 0;
  for (const token of tokenize(xml)) {
    if (token.type === 'open' && token.localName === 'row') {
      currentRow = Number(token.attrs.r || currentRow + 1);
      if (currentRow > maxRow) maxRow = currentRow;
      continue;
    }
    if (token.localName === 'c' && (token.type === 'open' || token.type === 'self')) {
      finish();
      const ref = token.attrs.r
        ? token.attrs.r.toUpperCase()
        : formatRef(1, currentRow); // extremely rare: cells without refs
      const styleAttr = token.attrs.s;
      cell = {
        ref,
        t: token.attrs.t || 'n',
        s: styleAttr === undefined ? null : Number(styleAttr),
        raw: '',
        inline: '',
        formula: '',
      };
      if (token.type === 'self') finish();
      continue;
    }
    if (token.type === 'close' && token.localName === 'c') {
      finish();
      continue;
    }
    if (!cell) continue;

    if (token.localName === 'v') {
      if (token.type === 'open') inValue = true;
      else if (token.type === 'close') inValue = false;
    } else if (token.localName === 'f') {
      if (token.type === 'open') inFormula = true;
      else if (token.type === 'close') inFormula = false;
    } else if (token.localName === 'is') {
      if (token.type === 'open') inInline++;
      else if (token.type === 'close') inInline--;
    } else if (token.localName === 't' && inInline > 0) {
      if (token.type === 'open') inInlineText++;
      else if (token.type === 'close') inInlineText--;
    } else if (token.type === 'text') {
      if (inValue) cell.raw += decodeXml(token.value);
      else if (inFormula) cell.formula += decodeXml(token.value);
      else if (inInlineText > 0) cell.inline += decodeXml(token.value);
    }
  }
  finish();

  return { cells, maxRow, maxCol };
}

/** Map sheet name -> part path, using workbook.xml plus its relationships. */
export function resolveSheetPaths(workbookXml, relsXml) {
  const rels = new Map();
  for (const rel of findElements(relsXml || '', 'Relationship')) {
    rels.set(rel.attrs.Id, rel.attrs.Target);
  }
  const sheets = [];
  for (const sheet of findElements(workbookXml, 'sheet')) {
    const rid = sheet.attrs['r:id'] || sheet.attrs.id || sheet.attrs['relationship:id'];
    let target = rels.get(rid) || `worksheets/${sheet.attrs.name}.xml`;
    if (target.startsWith('/')) target = target.slice(1);
    const path = target.startsWith('xl/') ? target : `xl/${target}`.replace('xl/../', '');
    sheets.push({
      name: sheet.attrs.name || `Sheet${sheets.length + 1}`,
      sheetId: sheet.attrs.sheetId,
      rid,
      state: sheet.attrs.state || 'visible',
      path,
    });
  }
  return sheets;
}

/** Read a workbook from an ArrayBuffer/Uint8Array. */
export async function readXlsx(input) {
  const archive = readZip(input);
  const workbookXml = await archive.textOf('xl/workbook.xml');
  if (!workbookXml) throw new Error('Not an Excel workbook: xl/workbook.xml is missing');
  const relsXml = await archive.textOf('xl/_rels/workbook.xml.rels');
  const sharedStrings = parseSharedStrings(await archive.textOf('xl/sharedStrings.xml'));
  const dateStyles = parseStyles(await archive.textOf('xl/styles.xml'));

  const sheets = [];
  for (const meta of resolveSheetPaths(workbookXml, relsXml)) {
    const xml = await archive.textOf(meta.path);
    if (xml === null) continue;
    sheets.push(new Sheet(meta.name, meta.path, parseSheetXml(xml, { sharedStrings, dateStyles })));
  }
  if (!sheets.length) throw new Error('Workbook contains no readable worksheets');

  return new Workbook({ archive, sheets, sharedStrings });
}

export { Sheet, Workbook };
