/**
 * Rules: parsing, normalising and validating the JSON mapping definition.
 *
 * A rules file is the contract between "what Claude wrote" and "what the
 * engine runs", so it is validated up front with messages that name the exact
 * path that is wrong — a rule that fails should tell you which mapping to fix,
 * not just that something went sideways.
 *
 * See docs/RULES.md for the full schema.
 */

import { parseRef, splitSheetRef } from './a1.js';
import { SOURCE_TYPES, TRANSFORM_OPS } from './values.js';

export const RULES_VERSION = 1;

const ROW_SOURCE_TYPES = ['lineRegex', 'lines', 'textRegex', 'sheetRows', 'range'];

class RuleError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'RuleError';
    this.path = path;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkSource(source, path, errors) {
  if (source === null || source === undefined) {
    errors.push(new RuleError(path, 'missing source'));
    return;
  }
  if (!isPlainObject(source)) return; // literal shorthand
  if (!source.type) {
    errors.push(new RuleError(path, 'source needs a "type"'));
    return;
  }
  if (!SOURCE_TYPES.includes(source.type)) {
    errors.push(new RuleError(path, `unknown source type "${source.type}" (known: ${SOURCE_TYPES.join(', ')})`));
    return;
  }
  if (source.type === 'regex' || source.type === 'matchAll') {
    if (!source.pattern) errors.push(new RuleError(path, `source type "${source.type}" needs a "pattern"`));
    else {
      try {
        new RegExp(source.pattern);
      } catch (error) {
        errors.push(new RuleError(path, `invalid regular expression: ${error.message}`));
      }
    }
  }
  if (source.type === 'label' && !source.label) errors.push(new RuleError(path, '"label" source needs a "label"'));
  if (source.type === 'field' && !source.name) errors.push(new RuleError(path, '"field" source needs a "name"'));
  if ((source.type === 'cell' || source.type === 'range') && !source.ref) {
    errors.push(new RuleError(path, `"${source.type}" source needs a "ref" such as "B4"`));
  }
  for (const [index, part] of (source.parts || []).entries()) checkSource(part.source ?? part, `${path}.parts[${index}]`, errors);
  for (const [index, option] of (source.sources || []).entries()) checkSource(option.source ?? option, `${path}.sources[${index}]`, errors);
}

function checkTransforms(transforms, path, errors) {
  if (transforms === undefined) return;
  if (!Array.isArray(transforms)) {
    errors.push(new RuleError(path, 'transform must be an array of steps'));
    return;
  }
  transforms.forEach((step, index) => {
    const op = typeof step === 'string' ? step : step?.op;
    if (!op) errors.push(new RuleError(`${path}[${index}]`, 'transform step needs an "op"'));
    else if (!TRANSFORM_OPS.includes(op)) {
      errors.push(new RuleError(`${path}[${index}]`, `unknown transform "${op}" (known: ${TRANSFORM_OPS.join(', ')})`));
    }
  });
}

function normaliseTarget(target, defaultSheet, path, errors) {
  if (typeof target !== 'string' || !target.trim()) {
    errors.push(new RuleError(path, 'needs a "target" cell such as "B4" or "Angebot!B4"'));
    return null;
  }
  const { sheet, ref } = splitSheetRef(target);
  try {
    parseRef(ref);
  } catch {
    errors.push(new RuleError(path, `"${target}" is not a valid cell reference`));
    return null;
  }
  return { sheet: sheet ?? defaultSheet ?? null, ref: ref.toUpperCase().replace(/\$/g, '') };
}

/**
 * Normalise a rules object (accepts a few friendly shorthands) and collect
 * every problem in one pass.
 *
 * @returns {{ rules: object, errors: RuleError[], warnings: string[] }}
 */
export function normaliseRules(input) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(input)) {
    return { rules: null, errors: [new RuleError('rules', 'expected a JSON object')], warnings };
  }
  if (input.version !== undefined && Number(input.version) !== RULES_VERSION) {
    warnings.push(`Rules declare version ${input.version}; this build understands version ${RULES_VERSION}.`);
  }

  const defaultSheet = input.output?.sheet ?? null;

  // fields: array of { name, source, … } or an object keyed by name
  const rawFields = Array.isArray(input.fields)
    ? input.fields
    : Object.entries(input.fields || {}).map(([name, value]) => ({ name, ...(isPlainObject(value) ? value : { source: value }) }));
  const fields = rawFields.map((field, index) => {
    const path = `fields[${index}]${field?.name ? ` (${field.name})` : ''}`;
    if (!field?.name) errors.push(new RuleError(path, 'field needs a "name"'));
    const source = field.source ?? field.from;
    checkSource(source, `${path}.source`, errors);
    checkTransforms(field.transform ?? field.transforms, `${path}.transform`, errors);
    return {
      name: field.name,
      source,
      transform: field.transform ?? field.transforms ?? [],
      required: Boolean(field.required),
      description: field.description ?? '',
    };
  });

  const rawCells = Array.isArray(input.cells)
    ? input.cells
    : Object.entries(input.cells || {}).map(([target, value]) => ({ target, ...(isPlainObject(value) ? value : { source: { type: 'literal', value } }) }));
  const cells = rawCells.map((cell, index) => {
    const path = `cells[${index}]${cell?.target ? ` (${cell.target})` : ''}`;
    const target = normaliseTarget(cell?.target, defaultSheet, path, errors);
    const source = cell?.source ?? cell?.value ?? cell?.from;
    checkSource(source, `${path}.source`, errors);
    checkTransforms(cell?.transform ?? cell?.transforms, `${path}.transform`, errors);
    return {
      target,
      source,
      transform: cell?.transform ?? cell?.transforms ?? [],
      type: cell?.type ?? 'auto',
      required: Boolean(cell?.required),
      skipIfEmpty: cell?.skipIfEmpty !== false,
      description: cell?.description ?? '',
    };
  });

  const tables = (input.tables || []).map((table, index) => {
    const path = `tables[${index}]${table?.name ? ` (${table.name})` : ''}`;
    const rows = table?.rows;
    if (!isPlainObject(rows)) {
      errors.push(new RuleError(`${path}.rows`, 'needs a row source object'));
    } else if (!ROW_SOURCE_TYPES.includes(rows.type)) {
      errors.push(new RuleError(`${path}.rows`, `unknown row source "${rows.type}" (known: ${ROW_SOURCE_TYPES.join(', ')})`));
    } else if ((rows.type === 'lineRegex' || rows.type === 'textRegex') && !rows.pattern) {
      errors.push(new RuleError(`${path}.rows`, `"${rows.type}" needs a "pattern"`));
    }

    const target = table?.target ?? {};
    let startRow = target.startRow;
    let startColumn = null;
    if (target.startCell) {
      try {
        const parsed = parseRef(splitSheetRef(target.startCell).ref);
        startRow = startRow ?? parsed.row;
        startColumn = parsed.col;
      } catch {
        errors.push(new RuleError(`${path}.target.startCell`, `"${target.startCell}" is not a valid cell reference`));
      }
    }
    if (!startRow) errors.push(new RuleError(`${path}.target`, 'needs a "startRow" (or "startCell")'));

    const columns = (table?.columns || []).map((column, columnIndex) => {
      const columnPath = `${path}.columns[${columnIndex}]`;
      if (!column?.column && !column?.target && column?.offset === undefined) {
        errors.push(new RuleError(columnPath, 'needs a "column" such as "C"'));
      }
      checkSource(column?.source ?? column?.value, `${columnPath}.source`, errors);
      checkTransforms(column?.transform ?? column?.transforms, `${columnPath}.transform`, errors);
      return {
        column: column?.column ?? column?.target ?? null,
        offset: column?.offset,
        source: column?.source ?? column?.value,
        transform: column?.transform ?? column?.transforms ?? [],
        type: column?.type ?? 'auto',
        description: column?.description ?? '',
      };
    });
    if (!columns.length) errors.push(new RuleError(`${path}.columns`, 'a table needs at least one column mapping'));

    return {
      name: table?.name ?? `table${index + 1}`,
      rows: rows || {},
      filter: table?.filter ?? null,
      limit: table?.limit ?? null,
      skip: Number(table?.skip ?? 0),
      target: {
        sheet: target.sheet ?? defaultSheet ?? null,
        startRow: Number(startRow || 1),
        startColumn,
        rowStep: Number(target.rowStep ?? 1),
        maxRows: Number(target.maxRows ?? 1000),
        clearRows: Number(target.clearRows ?? 0),
      },
      columns,
    };
  });

  const rules = {
    version: RULES_VERSION,
    name: input.name ?? 'Unnamed mapping',
    description: input.description ?? '',
    input: { type: input.input?.type ?? 'any' },
    output: { sheet: defaultSheet, fileName: input.output?.fileName ?? null },
    options: {
      failOnMissingField: input.options?.failOnMissingField ?? false,
      decimal: input.options?.decimal ?? 'auto',
    },
    fields,
    cells,
    tables,
  };

  if (!fields.length && !cells.length && !tables.length) {
    errors.push(new RuleError('rules', 'nothing to do — define at least one of "cells", "tables" or "fields"'));
  }
  return { rules, errors, warnings };
}

/** Parse rules from JSON text (or accept an object) and validate them. */
export function parseRules(input) {
  let parsed = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) throw new Error('No rules provided');
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Rules are not valid JSON: ${error.message}`);
    }
  }
  const { rules, errors, warnings } = normaliseRules(parsed);
  if (errors.length) {
    const list = errors.slice(0, 12).map((error) => `  • ${error.message}`).join('\n');
    const more = errors.length > 12 ? `\n  … and ${errors.length - 12} more` : '';
    throw new Error(`Rules are not valid:\n${list}${more}`);
  }
  return { rules, warnings };
}

export { RuleError, ROW_SOURCE_TYPES };
