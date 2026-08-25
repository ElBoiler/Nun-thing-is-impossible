/**
 * Writes values into an existing .xlsx template.
 *
 * The template is the customer's document: layout, styles, print settings,
 * logos and formulas must survive untouched. So this never re-serialises a
 * workbook — it splices `<c>` elements into the sheet XML at byte offsets and
 * copies every other ZIP member through in its original compressed form.
 *
 * Written strings use inline strings (`t="inlineStr"`), which keeps
 * sharedStrings.xml — and therefore every other cell's string index — valid.
 */

import { formatRef, parseRef } from './a1.js';
import { escapeXml, findElements, tokenize } from './xml.js';
import { dateToSerial, resolveSheetPaths } from './xlsx-read.js';
import { readZip, writeZip } from './zip.js';
import { utf8 } from './bytes.js';

const CALC_CHAIN = 'xl/calcChain.xml';

function indexSheet(xml) {
  const info = { sheetData: null, rows: [], cols: [], dimension: null };
  let currentRow = null;
  let currentCell = null;
  let inSheetData = false;
  let lastRowNumber = 0;

  for (const token of tokenize(xml)) {
    if (!inSheetData && token.localName === 'dimension' && token.type !== 'close' && !info.dimension) {
      info.dimension = { start: token.start, end: token.end, attrs: token.attrs };
      continue;
    }
    if (!inSheetData && token.localName === 'col' && token.type !== 'close') {
      info.cols.push(token.attrs);
      continue;
    }
    if (token.localName === 'sheetData') {
      if (token.type === 'self') {
        info.sheetData = { start: token.start, end: token.end, contentStart: token.start, contentEnd: token.start, selfClosed: true };
      } else if (token.type === 'open') {
        inSheetData = true;
        info.sheetData = { start: token.start, contentStart: token.end, selfClosed: false };
      } else if (token.type === 'close' && info.sheetData) {
        inSheetData = false;
        info.sheetData.contentEnd = token.start;
        info.sheetData.end = token.end;
      }
      continue;
    }
    if (!inSheetData) continue;

    if (token.localName === 'row') {
      if (token.type === 'self') {
        const r = Number(token.attrs.r || ++lastRowNumber);
        lastRowNumber = r;
        info.rows.push({ r, attrs: token.attrs, start: token.start, end: token.end, selfClosed: true, cells: [] });
      } else if (token.type === 'open') {
        const r = Number(token.attrs.r || ++lastRowNumber);
        lastRowNumber = r;
        currentRow = { r, attrs: token.attrs, start: token.start, contentStart: token.end, selfClosed: false, cells: [] };
      } else if (token.type === 'close' && currentRow) {
        currentRow.contentEnd = token.start;
        currentRow.end = token.end;
        info.rows.push(currentRow);
        currentRow = null;
      }
      continue;
    }

    if (token.localName === 'c' && currentRow) {
      if (token.type === 'self') {
        currentRow.cells.push(makeCellRecord(currentRow, token, token.end, ''));
      } else if (token.type === 'open') {
        currentCell = { attrs: token.attrs, start: token.start, contentStart: token.end };
      } else if (token.type === 'close' && currentCell) {
        currentRow.cells.push(
          makeCellRecord(currentRow, currentCell, token.end, xml.slice(currentCell.contentStart, token.start)),
        );
        currentCell = null;
      }
    }
  }
  return info;
}

function makeCellRecord(row, token, end, inner) {
  const ref = token.attrs.r;
  let col;
  if (ref) {
    col = parseRef(ref).col;
  } else {
    const previous = row.cells[row.cells.length - 1];
    col = previous ? previous.col + 1 : 1;
  }
  return { ref: ref || formatRef(col, row.r), col, attrs: token.attrs, start: token.start, end, inner };
}

function columnStyle(cols, col) {
  for (const def of cols) {
    const min = Number(def.min || 0);
    const max = Number(def.max || 0);
    if (col >= min && col <= max && def.style !== undefined) return def.style;
  }
  return undefined;
}

function rowStyle(row) {
  if (row && row.attrs && row.attrs.customFormat === '1' && row.attrs.s !== undefined) return row.attrs.s;
  return undefined;
}

function detectType(value, requested) {
  if (requested && requested !== 'auto') return requested;
  if (value === null || value === undefined || value === '') return 'blank';
  if (value instanceof Date) return 'date';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string' && value.startsWith('=')) return 'formula';
  return 'text';
}

function serializeCell(ref, style, value, type) {
  const styleAttr = style === undefined || style === null || style === '' ? '' : ` s="${escapeXml(style)}"`;
  const head = `<c r="${ref}"${styleAttr}`;
  switch (type) {
    case 'blank':
      return `${head}/>`;
    case 'formula': {
      const formula = String(value).replace(/^=/, '');
      return `${head}><f>${escapeXml(formula)}</f></c>`;
    }
    case 'number': {
      const num = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
      if (!Number.isFinite(num)) return `${head} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
      return `${head}><v>${num}</v></c>`;
    }
    case 'boolean':
      return `${head} t="b"><v>${value ? 1 : 0}</v></c>`;
    case 'date': {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) {
        return `${head} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
      }
      return `${head}><v>${dateToSerial(date)}</v></c>`;
    }
    default:
      return `${head} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }
}

/**
 * Apply cell writes to one worksheet XML document.
 * Returns `{ xml, warnings }`.
 */
export function applyCellWrites(xml, writes) {
  const warnings = [];
  if (!writes.length) return { xml, warnings };

  const info = indexSheet(xml);
  if (!info.sheetData) throw new Error('Worksheet XML has no <sheetData> element');

  const rowsByNumber = new Map(info.rows.map((row) => [row.r, row]));
  const sortedRows = [...info.rows].sort((a, b) => a.r - b.r);

  // Group the writes per row so a new row is emitted once with all its cells.
  const byRow = new Map();
  let maxRow = info.rows.length ? Math.max(...info.rows.map((r) => r.r)) : 0;
  let maxCol = 0;
  for (const write of writes) {
    const { col, row } = parseRef(write.ref);
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push({ ...write, col, row, ref: formatRef(col, row) });
    if (row > maxRow) maxRow = row;
    if (col > maxCol) maxCol = col;
  }

  const edits = [];
  for (const [rowNumber, rowWrites] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    rowWrites.sort((a, b) => a.col - b.col);
    const existingRow = rowsByNumber.get(rowNumber);

    if (!existingRow) {
      const cells = rowWrites
        .map((write) => serializeCell(
          write.ref,
          write.style ?? columnStyle(info.cols, write.col),
          write.value,
          detectType(write.value, write.type),
        ))
        .join('');
      const rowXml = `<row r="${rowNumber}">${cells}</row>`;
      const nextRow = sortedRows.find((row) => row.r > rowNumber);
      const position = nextRow ? nextRow.start : info.sheetData.contentEnd;
      edits.push({ pos: position, del: 0, text: rowXml, order: rowNumber });
      continue;
    }

    if (existingRow.selfClosed) {
      // `<row r="5"/>` -> reopen it so cells have somewhere to live.
      const attrs = Object.entries(existingRow.attrs)
        .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
        .join('');
      const cells = rowWrites
        .map((write) => serializeCell(
          write.ref,
          write.style ?? rowStyle(existingRow) ?? columnStyle(info.cols, write.col),
          write.value,
          detectType(write.value, write.type),
        ))
        .join('');
      edits.push({ pos: existingRow.start, del: existingRow.end - existingRow.start, text: `<row${attrs}>${cells}</row>`, order: 0 });
      continue;
    }

    const cellsByColumn = new Map(existingRow.cells.map((cell) => [cell.col, cell]));
    for (const write of rowWrites) {
      const existing = cellsByColumn.get(write.col);
      const style = write.style
        ?? (existing ? existing.attrs.s : undefined)
        ?? rowStyle(existingRow)
        ?? columnStyle(info.cols, write.col);
      const text = serializeCell(write.ref, style, write.value, detectType(write.value, write.type));

      if (existing) {
        if (/<f[\s>][^>]*t="shared"/.test(existing.inner) && /ref="/.test(existing.inner)) {
          warnings.push(`${write.ref} replaces the master cell of a shared formula; dependent formulas may be lost.`);
        }
        edits.push({ pos: existing.start, del: existing.end - existing.start, text, order: write.col * 2 + 1 });
      } else {
        const next = existingRow.cells.find((cell) => cell.col > write.col);
        const position = next ? next.start : existingRow.contentEnd;
        edits.push({ pos: position, del: 0, text, order: write.col * 2 });
      }
    }
  }

  if (info.sheetData.selfClosed) {
    const inner = edits
      .sort((a, b) => a.order - b.order)
      .map((edit) => edit.text)
      .join('');
    const replaced = `${xml.slice(0, info.sheetData.start)}<sheetData>${inner}</sheetData>${xml.slice(info.sheetData.end)}`;
    return { xml: updateDimension(replaced, maxRow, maxCol), warnings };
  }

  edits.sort((a, b) => a.pos - b.pos || a.order - b.order);
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    if (edit.pos < cursor) throw new Error('Internal error: overlapping worksheet edits');
    out += xml.slice(cursor, edit.pos) + edit.text;
    cursor = edit.pos + edit.del;
  }
  out += xml.slice(cursor);

  return { xml: updateDimension(out, maxRow, maxCol), warnings };
}

function updateDimension(xml, maxRow, maxCol) {
  const match = /<dimension\s+ref="([^"]+)"\s*\/?>/.exec(xml);
  if (!match) return xml;
  const [, ref] = match;
  const parts = ref.split(':');
  const end = parts[1] || parts[0];
  let endCol;
  let endRow;
  try {
    ({ col: endCol, row: endRow } = parseRef(end));
  } catch {
    return xml;
  }
  const start = parts[1] ? parts[0] : 'A1';
  const newEnd = formatRef(Math.max(endCol, maxCol || 1), Math.max(endRow, maxRow || 1));
  const replacement = `<dimension ref="${start}:${newEnd}"/>`;
  return xml.slice(0, match.index) + replacement + xml.slice(match.index + match[0].length);
}

function ensureFullCalcOnLoad(workbookXml) {
  const calcPr = /<calcPr\b[^>]*\/?>/.exec(workbookXml);
  if (calcPr) {
    let tag = calcPr[0];
    if (/fullCalcOnLoad=/.test(tag)) {
      tag = tag.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"');
    } else {
      tag = tag.replace(/\/?>$/, (suffix) => ` fullCalcOnLoad="1"${suffix}`);
    }
    return workbookXml.slice(0, calcPr.index) + tag + workbookXml.slice(calcPr.index + calcPr[0].length);
  }
  // calcPr must come after <sheets>/<definedNames> but before the tail elements.
  const anchors = ['<oleSize', '<customWorkbookViews', '<pivotCaches', '<smartTagPr', '<smartTagTypes', '<webPublishing', '<fileRecoveryPr', '<webPublishObjects', '<extLst', '</workbook>'];
  let position = workbookXml.length;
  for (const anchor of anchors) {
    const index = workbookXml.indexOf(anchor);
    if (index !== -1 && index < position) position = index;
  }
  return `${workbookXml.slice(0, position)}<calcPr calcId="0" fullCalcOnLoad="1"/>${workbookXml.slice(position)}`;
}

function removeCalcChainReferences(contentTypesXml, relsXml) {
  const contentTypes = contentTypesXml
    ? contentTypesXml.replace(/<Override[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, '')
    : contentTypesXml;
  let rels = relsXml;
  if (rels) {
    for (const rel of findElements(rels, 'Relationship')) {
      if ((rel.attrs.Target || '').endsWith('calcChain.xml')) {
        rels = rels.slice(0, rel.start) + rels.slice(rel.end);
        break;
      }
    }
  }
  return { contentTypes, rels };
}

/**
 * Write values into an .xlsx template.
 *
 * @param {ArrayBuffer|Uint8Array} templateBytes the untouched template file
 * @param {Array<{sheet?: string, ref: string, value: *, type?: string, style?: string}>} writes
 * @returns {Promise<{bytes: Uint8Array, warnings: string[], sheetsTouched: string[]}>}
 */
export async function writeIntoTemplate(templateBytes, writes) {
  const archive = readZip(templateBytes);
  const workbookXml = await archive.textOf('xl/workbook.xml');
  if (!workbookXml) throw new Error('Template is not an Excel workbook (xl/workbook.xml missing)');
  const relsXml = await archive.textOf('xl/_rels/workbook.xml.rels');
  const sheetMetas = resolveSheetPaths(workbookXml, relsXml);
  if (!sheetMetas.length) throw new Error('Template contains no worksheets');

  // Last write wins per cell: rules may blank a block of template rows and
  // then fill some of them again in the same run.
  const deduped = new Map();
  for (const write of writes) {
    const name = write.sheet;
    const meta = name
      ? sheetMetas.find((s) => s.name.toLowerCase() === String(name).toLowerCase())
      : sheetMetas[0];
    if (!meta) {
      throw new Error(`Template has no sheet named "${name}". Available: ${sheetMetas.map((s) => s.name).join(', ')}`);
    }
    const { col, row } = parseRef(write.ref);
    deduped.set(`${meta.path}!${formatRef(col, row)}`, { meta, write: { ...write, ref: formatRef(col, row) } });
  }

  const byPath = new Map();
  const warnings = [];
  for (const { meta, write } of deduped.values()) {
    if (!byPath.has(meta.path)) byPath.set(meta.path, { meta, writes: [] });
    byPath.get(meta.path).writes.push(write);
  }

  const replacements = new Map();
  const removals = new Set();
  const sheetsTouched = [];

  for (const [path, group] of byPath) {
    const sheetXml = await archive.textOf(path);
    if (sheetXml === null) throw new Error(`Template is missing worksheet part "${path}"`);
    const result = applyCellWrites(sheetXml, group.writes);
    replacements.set(path, utf8(result.xml));
    warnings.push(...result.warnings.map((text) => `${group.meta.name}: ${text}`));
    sheetsTouched.push(group.meta.name);
  }

  if (byPath.size) {
    replacements.set('xl/workbook.xml', utf8(ensureFullCalcOnLoad(workbookXml)));
    if (archive.has(CALC_CHAIN)) {
      // Excel rebuilds the calculation chain; a stale one against edited cells
      // is the classic "we need to repair your workbook" prompt.
      removals.add(CALC_CHAIN);
      const contentTypesXml = await archive.textOf('[Content_Types].xml');
      const cleaned = removeCalcChainReferences(contentTypesXml, relsXml);
      if (cleaned.contentTypes) replacements.set('[Content_Types].xml', utf8(cleaned.contentTypes));
      if (cleaned.rels) replacements.set('xl/_rels/workbook.xml.rels', utf8(cleaned.rels));
    }
  }

  const files = [];
  for (const name of archive.names) {
    if (removals.has(name)) continue;
    if (replacements.has(name)) files.push({ name, data: replacements.get(name) });
    else files.push({ name, passthrough: archive.entry(name) });
  }

  return { bytes: await writeZip(files), warnings, sheetsTouched };
}
