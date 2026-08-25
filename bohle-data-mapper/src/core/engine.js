/**
 * The mapping engine: input document + template + rules -> filled workbook.
 *
 * Everything it does is reported back cell by cell. A mapping run that quietly
 * writes the wrong thing into an offer is worse than one that fails, so each
 * write carries where the value came from, what it became, and whether it
 * landed — that is what the run report in the UI shows.
 */

import { formatRef, numberToColumn, columnToNumber, parseRange } from './a1.js';
import { parseRules } from './rules.js';
import { applyTransforms, asText, isEmpty, resolveSource } from './values.js';
import { evaluateExpression } from './expr.js';
import { writeIntoTemplate } from './xlsx-write.js';

/** Build the row records a table rule iterates over. */
export function extractRows(spec, context) {
  const { doc } = context;
  const rows = [];

  const pushLineRow = (line, groups, extra = {}) => {
    rows.push({
      _index: rows.length,
      _line: line?.text ?? '',
      _page: line?.page ?? null,
      _row: null,
      _groups: groups,
      ...extra,
    });
  };

  if (spec.type === 'lineRegex' || spec.type === 'lines') {
    let lines = doc.lines;
    if (spec.page) lines = lines.filter((line) => line.page === Number(spec.page));
    if (spec.sheet) lines = lines.filter((line) => line.sheet === spec.sheet);

    const startAfter = spec.startAfter ? new RegExp(spec.startAfter, spec.flags ?? 'i') : null;
    const startAt = spec.startAt ? new RegExp(spec.startAt, spec.flags ?? 'i') : null;
    const stopAt = spec.stopAt ? new RegExp(spec.stopAt, spec.flags ?? 'i') : null;
    const include = spec.include ? new RegExp(spec.include, spec.flags ?? 'i') : null;
    const exclude = spec.exclude ? new RegExp(spec.exclude, spec.flags ?? 'i') : null;
    const pattern = spec.pattern ? new RegExp(spec.pattern, spec.flags ?? '') : null;

    let active = !startAfter && !startAt;
    for (const line of lines) {
      if (!active) {
        if (startAfter && startAfter.test(line.text)) {
          active = true;
          continue;
        }
        if (startAt && startAt.test(line.text)) active = true;
        else continue;
      }
      if (stopAt && stopAt.test(line.text)) break;
      if (include && !include.test(line.text)) continue;
      if (exclude && exclude.test(line.text)) continue;
      if (pattern) {
        const match = pattern.exec(line.text);
        if (!match) continue;
        pushLineRow(line, [...match], { ...(match.groups || {}) });
      } else {
        if (!line.text.trim()) continue;
        pushLineRow(line, [line.text]);
      }
    }
    return rows;
  }

  if (spec.type === 'textRegex') {
    const regex = new RegExp(spec.pattern, `${spec.flags ?? ''}g`.replace(/g{2,}/, 'g'));
    let match;
    while ((match = regex.exec(doc.text))) {
      pushLineRow({ text: match[0], page: null }, [...match], { ...(match.groups || {}) });
      if (match.index === regex.lastIndex) regex.lastIndex++;
    }
    return rows;
  }

  if (spec.type === 'sheetRows') {
    const sheet = doc.requireSheet(spec.sheet ?? null);
    const { rows: records } = sheet.rowObjects({
      headerRow: Number(spec.headerRow ?? 1),
      startRow: spec.startRow ? Number(spec.startRow) : null,
      endRow: spec.endRow ? Number(spec.endRow) : null,
      stopOnEmpty: spec.stopOnEmpty !== false,
    });
    return records.map((record, index) => ({ ...record, _index: index, _line: '', _page: null, _groups: [] }));
  }

  if (spec.type === 'range') {
    const sheet = doc.requireSheet(spec.sheet ?? null);
    const { start, end } = parseRange(spec.ref ?? 'A1');
    const out = [];
    for (let row = start.row; row <= end.row; row++) {
      const record = { _index: out.length, _row: row, _line: '', _page: null, _groups: [] };
      let empty = true;
      for (let col = start.col; col <= end.col; col++) {
        const value = sheet.value(formatRef(col, row));
        record[numberToColumn(col)] = value;
        if (!isEmpty(value)) empty = false;
      }
      if (!empty || spec.keepEmptyRows) out.push(record);
    }
    return out;
  }

  throw new Error(`Unknown row source "${spec.type}"`);
}

function resolveTargetColumn(column, table, index) {
  if (column.column !== null && column.column !== undefined && column.column !== '') {
    return typeof column.column === 'number' ? column.column : columnToNumber(String(column.column).replace(/\d+$/, ''));
  }
  if (column.offset !== undefined) return (table.target.startColumn ?? 1) + Number(column.offset);
  return (table.target.startColumn ?? 1) + index;
}

/** Collapse repeated writes to the same cell, keeping the last one. */
function dedupeWrites(writes) {
  const byCell = new Map();
  for (const write of writes) byCell.set(`${write.sheet ?? ''}!${write.ref}`, write);
  return [...byCell.values()];
}

/**
 * Run a set of rules against a loaded document and an .xlsx template.
 *
 * @param {object} params
 * @param {import('./document.js').SourceDocument} params.doc loaded input file
 * @param {ArrayBuffer|Uint8Array} params.templateBytes the .xlsx template
 * @param {object|string} params.rules rules object or JSON text
 * @returns {Promise<{bytes: Uint8Array, report: object}>}
 */
export async function runMapping({ doc, templateBytes, rules: rawRules }) {
  const started = Date.now();
  const { rules, warnings: ruleWarnings } = parseRules(rawRules);

  if (rules.input.type !== 'any' && rules.input.type !== doc.kind) {
    throw new Error(`These rules expect a ${rules.input.type.toUpperCase()} input, but "${doc.fileName}" is a ${doc.kind.toUpperCase()} file.`);
  }

  const context = { doc, fields: {}, row: null, warnings: [...ruleWarnings], ruleName: rules.name };
  const report = {
    ruleName: rules.name,
    input: { fileName: doc.fileName, kind: doc.kind, summary: doc.describe() },
    fields: [],
    cells: [],
    tables: [],
    warnings: context.warnings,
    errors: [],
    writeCount: 0,
    durationMs: 0,
  };
  const writes = [];

  // 1. Named fields, in declaration order so later fields can reference earlier ones.
  for (const field of rules.fields) {
    const entry = { name: field.name, value: null, status: 'ok', description: field.description };
    try {
      const raw = resolveSource(field.source, context);
      const value = applyTransforms(raw, field.transform, context);
      context.fields[field.name] = value;
      entry.value = value;
      if (isEmpty(value)) {
        entry.status = field.required ? 'missing' : 'empty';
        if (field.required) {
          const message = `Required field "${field.name}" could not be found in ${doc.fileName}`;
          if (rules.options.failOnMissingField) throw new Error(message);
          report.errors.push(message);
        }
      }
    } catch (error) {
      context.fields[field.name] = null;
      entry.status = 'error';
      entry.message = error.message;
      report.errors.push(`Field "${field.name}": ${error.message}`);
      if (rules.options.failOnMissingField) throw error;
    }
    report.fields.push(entry);
  }

  // 2. Single cells.
  for (const cell of rules.cells) {
    const entry = {
      target: `${cell.target?.sheet ? `${cell.target.sheet}!` : ''}${cell.target?.ref ?? '?'}`,
      value: null,
      status: 'ok',
      description: cell.description,
    };
    try {
      const raw = resolveSource(cell.source, context);
      const value = applyTransforms(raw, cell.transform, context);
      entry.value = value;
      if (isEmpty(value) && cell.skipIfEmpty && cell.type !== 'blank') {
        entry.status = cell.required ? 'missing' : 'empty';
        if (cell.required) report.errors.push(`Required cell ${entry.target} has no value`);
      } else {
        writes.push({ sheet: cell.target.sheet, ref: cell.target.ref, value, type: cell.type });
      }
    } catch (error) {
      entry.status = 'error';
      entry.message = error.message;
      report.errors.push(`Cell ${entry.target}: ${error.message}`);
    }
    report.cells.push(entry);
  }

  // 3. Repeating tables.
  for (const table of rules.tables) {
    const tableReport = {
      name: table.name,
      rowCount: 0,
      skipped: 0,
      startRow: table.target.startRow,
      sheet: table.target.sheet,
      status: 'ok',
      sample: [],
    };
    try {
      let rows = extractRows(table.rows, context);
      if (table.skip) rows = rows.slice(table.skip);
      if (table.filter) {
        const before = rows.length;
        rows = rows.filter((row) => {
          try {
            const keep = evaluateExpression(table.filter, { fields: context.fields, row });
            return keep !== false && keep !== '' && keep !== 0 && keep !== null;
          } catch (error) {
            context.warnings.push(`Table "${table.name}" filter failed on a row: ${error.message}`);
            return true;
          }
        });
        tableReport.skipped = before - rows.length;
      }
      if (table.limit) rows = rows.slice(0, Number(table.limit));
      if (rows.length > table.target.maxRows) {
        context.warnings.push(`Table "${table.name}" produced ${rows.length} rows; writing the first ${table.target.maxRows}.`);
        rows = rows.slice(0, table.target.maxRows);
      }

      // Blank out placeholder rows in the template so a re-run never leaves
      // stale values below the new data.
      for (let i = 0; i < table.target.clearRows; i++) {
        const rowNumber = table.target.startRow + i * table.target.rowStep;
        table.columns.forEach((column, index) => {
          writes.push({
            sheet: table.target.sheet,
            ref: formatRef(resolveTargetColumn(column, table, index), rowNumber),
            value: null,
            type: 'blank',
          });
        });
      }

      rows.forEach((row, rowIndex) => {
        const rowNumber = table.target.startRow + rowIndex * table.target.rowStep;
        const sampleRow = { row: rowNumber, values: {} };
        table.columns.forEach((column, index) => {
          const targetColumn = resolveTargetColumn(column, table, index);
          const ref = formatRef(targetColumn, rowNumber);
          try {
            const rowContext = { ...context, row };
            const raw = resolveSource(column.source, rowContext);
            const value = applyTransforms(raw, column.transform, rowContext);
            writes.push({ sheet: table.target.sheet, ref, value, type: column.type });
            if (rowIndex < 5) sampleRow.values[numberToColumn(targetColumn)] = value;
          } catch (error) {
            report.errors.push(`Table "${table.name}" ${ref}: ${error.message}`);
          }
        });
        if (rowIndex < 5) tableReport.sample.push(sampleRow);
      });
      tableReport.rowCount = rows.length;
      if (!rows.length) {
        tableReport.status = 'empty';
        context.warnings.push(`Table "${table.name}" matched no rows in ${doc.fileName}.`);
      }
    } catch (error) {
      tableReport.status = 'error';
      tableReport.message = error.message;
      report.errors.push(`Table "${table.name}": ${error.message}`);
    }
    report.tables.push(tableReport);
  }

  if (!writes.length) {
    throw new Error('The rules produced no values to write. Check the run report for fields that stayed empty.');
  }

  // Last write wins per cell, so a table that blanks its placeholder rows and
  // then fills them again is counted (and written) once.
  const effective = dedupeWrites(writes);
  const { bytes, warnings: writeWarnings, sheetsTouched } = await writeIntoTemplate(templateBytes, effective);
  context.warnings.push(...writeWarnings);
  report.writeCount = effective.filter((write) => write.type !== 'blank').length;
  report.clearedCount = effective.length - report.writeCount;
  report.sheetsTouched = sheetsTouched;
  report.durationMs = Date.now() - started;

  return { bytes, report, rules, writes: effective };
}

/** Suggested output file name: template name + input name + date. */
export function suggestFileName(rules, inputName, templateName) {
  if (rules?.output?.fileName) return rules.output.fileName;
  const base = (templateName || 'ausgabe').replace(/\.[^.]+$/, '');
  const stem = (inputName || '').replace(/\.[^.]+$/, '');
  const date = new Date().toISOString().slice(0, 10);
  return `${base}${stem ? `_${stem}` : ''}_${date}.xlsx`.replace(/[\\/:*?"<>|]+/g, '-');
}

export { asText };
