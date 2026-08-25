/**
 * Value sources and transforms — the vocabulary a rules file is written in.
 *
 * `resolveSource()` turns a `{ type: … }` descriptor into a raw value pulled
 * from the input document; `applyTransforms()` cleans it up. Both are pure and
 * side-effect free apart from pushing notes onto `context.warnings`.
 */

import { splitSheetRef } from './a1.js';
import { evaluateExpression } from './expr.js';

const MONTHS = {
  jan: 1, januar: 1, january: 1, feb: 2, februar: 2, february: 2, mar: 3, mär: 3, maerz: 3, märz: 3, march: 3,
  apr: 4, april: 4, mai: 5, may: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, okt: 10, oct: 10, oktober: 10, october: 10, nov: 11, november: 11,
  dez: 12, dec: 12, dezember: 12, december: 12,
};

export function isEmpty(value) {
  return value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value));
}

function buildRegExp(pattern, flags = '', extra = '') {
  const merged = [...new Set(`${flags}${extra}`.split(''))].join('');
  try {
    return new RegExp(pattern, merged);
  } catch (error) {
    throw new Error(`Invalid regular expression /${pattern}/${merged}: ${error.message}`);
  }
}

function textForScope(source, context) {
  const { doc } = context;
  if (source.page) {
    const page = doc.pages?.find((p) => p.number === Number(source.page));
    return page ? page.text : '';
  }
  if (source.sheet) {
    return doc.lines.filter((line) => line.sheet === source.sheet).map((line) => line.text).join('\n');
  }
  return doc.text;
}

function linesForScope(source, context) {
  const { doc } = context;
  let lines = doc.lines;
  if (source.page) lines = lines.filter((line) => line.page === Number(source.page));
  if (source.sheet) lines = lines.filter((line) => line.sheet === source.sheet);
  return lines;
}

/** Parse a loosely formatted number: "1.234,56 €", "(1,234.56)", "12 %". */
export function parseNumber(value, decimal = 'auto') {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value;
  if (isEmpty(value)) return null;
  let text = String(value).trim();
  const negative = /^\(.*\)$/.test(text) || /-\s*$/.test(text);
  text = text.replace(/^\(|\)$/g, '').replace(/-\s*$/, '').replace(/[\s ']/g, '');
  text = text.replace(/[^\d.,+-]/g, '');
  if (!text) return null;

  let normalised;
  if (decimal === 'de') {
    normalised = text.replace(/\./g, '').replace(',', '.');
  } else if (decimal === 'en') {
    normalised = text.replace(/,/g, '');
  } else {
    const lastComma = text.lastIndexOf(',');
    const lastDot = text.lastIndexOf('.');
    if (lastComma > lastDot) normalised = text.replace(/\./g, '').replace(',', '.');
    else if (lastDot > lastComma) normalised = text.replace(/,/g, '');
    else normalised = text.replace(/[.,]/g, '');
  }
  const num = Number(normalised);
  return Number.isFinite(num) ? (negative ? -num : num) : null;
}

/** Parse a date from the formats German business documents actually use. */
export function parseDate(value, format = 'auto') {
  if (value instanceof Date) return value;
  if (isEmpty(value)) return null;
  const text = String(value).trim();

  if (format && format !== 'auto') {
    const order = [];
    const pattern = format
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/D+|M+|Y+/g, (token) => {
        order.push(token[0]);
        return token.length >= 4 ? '(\\d{4})' : `(\\d{1,${token.length}})`;
      });
    const match = new RegExp(`^${pattern}$`).exec(text);
    if (!match) return null;
    const parts = { D: 1, M: 1, Y: 1970 };
    order.forEach((token, index) => {
      parts[token] = Number(match[index + 1]);
    });
    if (parts.Y < 100) parts.Y += parts.Y < 70 ? 2000 : 1900;
    return new Date(Date.UTC(parts.Y, parts.M - 1, parts.D));
  }

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));

  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/.exec(text);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1])));
  }

  m = /^(\d{1,2})\.?\s*([A-Za-zÄÖÜäöü]+)\.?\s*(\d{2,4})/.exec(text);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) {
      let year = Number(m[3]);
      if (year < 100) year += year < 70 ? 2000 : 1900;
      return new Date(Date.UTC(year, month - 1, Number(m[1])));
    }
  }
  return null;
}

export function formatDate(date, format = 'DD.MM.YYYY') {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  if (format === 'iso') return date.toISOString().slice(0, 10);
  return format
    .replace(/YYYY/g, String(date.getUTCFullYear()))
    .replace(/YY/g, pad(date.getUTCFullYear() % 100))
    .replace(/MM/g, pad(date.getUTCMonth() + 1))
    .replace(/DD/g, pad(date.getUTCDate()))
    .replace(/hh/g, pad(date.getUTCHours()))
    .replace(/mm/g, pad(date.getUTCMinutes()));
}

function asText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatDate(value, 'DD.MM.YYYY');
  if (Array.isArray(value)) return value.map(asText).join(' ');
  return String(value);
}

/* ------------------------------------------------------------------ sources */

const SOURCES = {
  literal(source) {
    return source.value ?? null;
  },

  field(source, context) {
    if (!(source.name in context.fields)) {
      throw new Error(`Unknown field "${source.name}" — declare it in "fields" before using it`);
    }
    return context.fields[source.name];
  },

  regex(source, context) {
    const haystack = textForScope(source, context);
    const regex = buildRegExp(source.pattern, source.flags ?? 'm', 'g');
    const occurrence = Number(source.occurrence ?? 1);
    let match;
    let seen = 0;
    while ((match = regex.exec(haystack))) {
      seen++;
      if (seen === occurrence) {
        const group = source.group ?? (match.length > 1 ? 1 : 0);
        return match[group] ?? null;
      }
      if (match.index === regex.lastIndex) regex.lastIndex++;
    }
    return null;
  },

  matchAll(source, context) {
    const haystack = textForScope(source, context);
    const regex = buildRegExp(source.pattern, source.flags ?? 'm', 'g');
    const group = source.group ?? 1;
    const out = [];
    let match;
    while ((match = regex.exec(haystack))) {
      out.push(match[group] ?? match[0]);
      if (match.index === regex.lastIndex) regex.lastIndex++;
    }
    return source.join === undefined ? out : out.join(source.join);
  },

  label(source, context) {
    const lines = linesForScope(source, context);
    const labelRegex = source.regex
      ? buildRegExp(source.label, source.flags ?? 'i')
      : buildRegExp(String(source.label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const occurrence = Number(source.occurrence ?? 1);
    let seen = 0;
    for (let i = 0; i < lines.length; i++) {
      const match = labelRegex.exec(lines[i].text);
      if (!match) continue;
      seen++;
      if (seen < occurrence) continue;
      let candidate;
      if (source.mode === 'nextLine') {
        candidate = (lines[i + 1]?.text ?? '').trim();
      } else if (source.mode === 'wholeLine') {
        candidate = lines[i].text.trim();
      } else {
        candidate = lines[i].text.slice(match.index + match[0].length).replace(/^\s*[:\-–]?\s*/, '').trim();
        if (!candidate && source.fallbackNextLine !== false) candidate = (lines[i + 1]?.text ?? '').trim();
      }
      if (source.pattern) {
        const extracted = buildRegExp(source.pattern, source.patternFlags ?? '').exec(candidate);
        return extracted ? (extracted[source.group ?? (extracted.length > 1 ? 1 : 0)] ?? null) : null;
      }
      return candidate || null;
    }
    return null;
  },

  line(source, context) {
    const lines = linesForScope(source, context);
    if (source.match !== undefined) {
      const regex = buildRegExp(source.match, source.flags ?? 'i');
      const index = lines.findIndex((line) => regex.test(line.text));
      if (index === -1) return null;
      const target = lines[index + Number(source.offset ?? 0)];
      return target ? target.text : null;
    }
    const index = Number(source.index ?? 0);
    const target = index < 0 ? lines[lines.length + index] : lines[index];
    return target ? target.text : null;
  },

  cell(source, context) {
    const { sheet, ref } = splitSheetRef(source.ref ?? '');
    const target = context.doc.requireSheet(source.sheet ?? sheet ?? null);
    return target.value(ref);
  },

  range(source, context) {
    const { sheet, ref } = splitSheetRef(source.ref ?? '');
    const target = context.doc.requireSheet(source.sheet ?? sheet ?? null);
    const values = target.range(ref).flat().filter((value) => !isEmpty(value));
    if (source.join !== undefined) return values.map(asText).join(source.join);
    if (source.aggregate === 'sum') return values.reduce((total, value) => total + (parseNumber(value) ?? 0), 0);
    if (source.aggregate === 'count') return values.length;
    if (source.aggregate === 'first') return values[0] ?? null;
    if (source.aggregate === 'last') return values[values.length - 1] ?? null;
    return values;
  },

  group(source, context) {
    if (!context.row) throw new Error('"group" can only be used inside a table column');
    const groups = context.row._groups || [];
    return groups[Number(source.index ?? 1)] ?? null;
  },

  column(source, context) {
    if (!context.row) throw new Error('"column" can only be used inside a table column');
    const key = source.name ?? source.letter;
    if (key === undefined) throw new Error('"column" needs a "name" or "letter"');
    if (context.row[key] !== undefined) return context.row[key];
    const lowered = String(key).toLowerCase();
    const match = Object.keys(context.row).find((name) => name.toLowerCase() === lowered);
    return match ? context.row[match] : null;
  },

  rowIndex(source, context) {
    return (context.row?._index ?? 0) + Number(source.offset ?? 0);
  },

  rowNumber(source, context) {
    return (context.row?._row ?? null) === null ? null : context.row._row + Number(source.offset ?? 0);
  },

  lineText(source, context) {
    return context.row?._line ?? null;
  },

  meta(source, context) {
    switch (source.key) {
      case 'fileName': return context.doc.fileName;
      case 'pageCount': return context.doc.pageCount;
      case 'sheetNames': return context.doc.sheets.join(', ');
      case 'today': return new Date();
      case 'now': return new Date();
      case 'ruleName': return context.ruleName ?? '';
      default:
        throw new Error(`Unknown meta key "${source.key}"`);
    }
  },

  concat(source, context) {
    const parts = (source.parts || []).map((part) => asText(resolveValue(part, context)));
    return parts.join(source.separator ?? '');
  },

  coalesce(source, context) {
    for (const option of source.sources || []) {
      const value = resolveValue(option, context);
      if (!isEmpty(value)) return value;
    }
    return null;
  },

  expr(source, context) {
    return evaluateExpression(source.expression ?? source.expr ?? '', {
      fields: context.fields,
      row: context.row || {},
      file: context.doc.fileName,
      page: context.doc.pageCount,
    });
  },
};

/** Resolve a `{ type, … }` source descriptor (without transforms). */
export function resolveSource(source, context) {
  if (source === null || source === undefined) return null;
  if (typeof source === 'string' || typeof source === 'number' || typeof source === 'boolean') return source;
  const handler = SOURCES[source.type];
  if (!handler) {
    throw new Error(`Unknown source type "${source.type}". Known types: ${Object.keys(SOURCES).join(', ')}`);
  }
  return handler(source, context);
}

/* --------------------------------------------------------------- transforms */

const TRANSFORMS = {
  trim: (value) => (typeof value === 'string' ? value.trim() : value),
  collapse: (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value),
  upper: (value) => asText(value).toUpperCase(),
  lower: (value) => asText(value).toLowerCase(),
  title: (value) => asText(value).toLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (all, sep, ch) => sep + ch.toUpperCase()),
  text: (value) => asText(value),
  replace: (value, step) => {
    const text = asText(value);
    if (step.regex) return text.replace(buildRegExp(step.find, step.flags ?? 'g'), step.with ?? '');
    return text.split(step.find ?? '').join(step.with ?? '');
  },
  extract: (value, step) => {
    const match = buildRegExp(step.pattern, step.flags ?? '').exec(asText(value));
    if (!match) return null;
    return match[step.group ?? (match.length > 1 ? 1 : 0)] ?? null;
  },
  number: (value, step) => parseNumber(value, step.decimal ?? 'auto'),
  round: (value, step) => {
    const num = parseNumber(value);
    if (num === null) return null;
    const factor = 10 ** Number(step.digits ?? 2);
    return Math.round((num + Number.EPSILON) * factor) / factor;
  },
  multiply: (value, step) => {
    const num = parseNumber(value);
    return num === null ? null : num * Number(step.by ?? 1);
  },
  add: (value, step) => {
    const num = parseNumber(value);
    return num === null ? null : num + Number(step.by ?? 0);
  },
  abs: (value) => {
    const num = parseNumber(value);
    return num === null ? null : Math.abs(num);
  },
  date: (value, step) => {
    const date = parseDate(value, step.from ?? 'auto');
    if (!date) return step.keepOnFailure === false ? null : value;
    return step.to && step.to !== 'date' ? formatDate(date, step.to) : date;
  },
  split: (value, step) => {
    const parts = asText(value).split(step.separator ?? ' ');
    const index = Number(step.index ?? 0);
    return (index < 0 ? parts[parts.length + index] : parts[index]) ?? null;
  },
  slice: (value, step) => asText(value).slice(Number(step.start ?? 0), step.end === undefined ? undefined : Number(step.end)),
  pad: (value, step) => {
    const text = asText(value);
    const length = Number(step.length ?? 0);
    const fill = String(step.char ?? '0');
    return step.side === 'end' ? text.padEnd(length, fill) : text.padStart(length, fill);
  },
  prefix: (value, step) => (isEmpty(value) ? value : `${step.text ?? ''}${asText(value)}`),
  suffix: (value, step) => (isEmpty(value) ? value : `${asText(value)}${step.text ?? ''}`),
  map: (value, step) => {
    const table = step.values || {};
    const key = asText(value);
    if (key in table) return table[key];
    const lowered = Object.keys(table).find((name) => name.toLowerCase() === key.toLowerCase());
    if (lowered !== undefined) return table[lowered];
    return step.default !== undefined ? step.default : (step.keepUnmapped === false ? null : value);
  },
  default: (value, step) => (isEmpty(value) ? step.value ?? null : value),
  expr: (value, step, context) => evaluateExpression(step.expression ?? step.expr ?? '', {
    value,
    fields: context.fields,
    row: context.row || {},
  }),
  boolean: (value, step) => {
    const text = asText(value).trim().toLowerCase();
    const truthy = (step.true || ['ja', 'yes', 'x', 'true', '1', 'wahr']).map((v) => String(v).toLowerCase());
    return truthy.includes(text);
  },
};

/** Run a transform pipeline over a raw value. */
export function applyTransforms(value, transforms, context) {
  let current = value;
  for (const step of transforms || []) {
    const descriptor = typeof step === 'string' ? { op: step } : step;
    const handler = TRANSFORMS[descriptor.op];
    if (!handler) {
      throw new Error(`Unknown transform "${descriptor.op}". Known: ${Object.keys(TRANSFORMS).join(', ')}`);
    }
    // Most transforms have nothing sensible to do with an empty value; `default`
    // and `expr` explicitly do.
    if (isEmpty(current) && !['default', 'expr', 'text', 'map'].includes(descriptor.op)) continue;
    current = handler(current, descriptor, context);
  }
  return current;
}

/** Resolve a source and run its transforms in one step. */
export function resolveValue(descriptor, context) {
  if (descriptor === null || descriptor === undefined) return null;
  if (typeof descriptor !== 'object' || Array.isArray(descriptor)) return descriptor;
  const source = descriptor.source ?? descriptor;
  const raw = resolveSource(source, context);
  return applyTransforms(raw, descriptor.transform || descriptor.transforms, context);
}

export const SOURCE_TYPES = Object.keys(SOURCES);
export const TRANSFORM_OPS = Object.keys(TRANSFORMS);
export { asText };
