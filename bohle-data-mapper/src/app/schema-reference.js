/**
 * One description of the rules vocabulary, used in three places: the Help tab,
 * the prompt handed to Claude, and docs/RULES.md (kept in sync by hand).
 *
 * If you add a source or transform in src/core/values.js, add it here too —
 * otherwise Claude will never write a rule that uses it.
 */

export const SOURCE_REFERENCE = [
  { type: 'literal', args: 'value', description: 'Fester Wert.' },
  { type: 'field', args: 'name', description: 'Ein zuvor unter "fields" definierter Wert.' },
  { type: 'regex', args: 'pattern, flags?, group?, occurrence?, page?', description: 'Erster (oder n-ter) Treffer eines regulären Ausdrucks im Gesamttext.' },
  { type: 'matchAll', args: 'pattern, group?, join?', description: 'Alle Treffer; mit "join" zu einem Text verbunden.' },
  { type: 'label', args: 'label, mode?, pattern?, occurrence?, regex?', description: 'Wert hinter einer Beschriftung. mode: sameLine (Standard), nextLine, wholeLine.' },
  { type: 'line', args: 'index | match + offset', description: 'Ganze Textzeile über Position oder Suchmuster.' },
  { type: 'cell', args: 'ref, sheet?', description: 'Zelle der Eingangs-Excel, z. B. "Kopf!B2".' },
  { type: 'range', args: 'ref, sheet?, join? | aggregate?', description: 'Bereich der Eingangs-Excel. aggregate: sum, count, first, last.' },
  { type: 'group', args: 'index', description: 'Nur in Tabellen: Klammergruppe des Zeilen-Regex (1 = erste Gruppe).' },
  { type: 'column', args: 'name | letter', description: 'Nur in Tabellen: Spalte der Quellzeile über Überschrift oder Buchstabe.' },
  { type: 'rowIndex', args: 'offset?', description: 'Nur in Tabellen: laufender Index der Zeile (0-basiert).' },
  { type: 'rowNumber', args: 'offset?', description: 'Nur in Tabellen: Zeilennummer in der Quelltabelle.' },
  { type: 'lineText', args: '—', description: 'Nur in Tabellen: die vollständige Quellzeile.' },
  { type: 'meta', args: 'key', description: 'fileName, pageCount, sheetNames, today, now, ruleName.' },
  { type: 'concat', args: 'parts[], separator?', description: 'Mehrere Quellen aneinanderhängen.' },
  { type: 'coalesce', args: 'sources[]', description: 'Erste Quelle, die nicht leer ist.' },
  { type: 'expr', args: 'expression', description: 'Formel über Felder und Tabellenspalten, z. B. "round(Menge * Einzelpreis, 2)".' },
];

export const TRANSFORM_REFERENCE = [
  { op: 'trim', args: '—', description: 'Leerzeichen am Rand entfernen.' },
  { op: 'collapse', args: '—', description: 'Mehrfache Leerzeichen zu einem zusammenfassen.' },
  { op: 'upper / lower / title', args: '—', description: 'Groß-/Kleinschreibung.' },
  { op: 'text', args: '—', description: 'In Text umwandeln.' },
  { op: 'replace', args: 'find, with, regex?, flags?', description: 'Ersetzen (wörtlich oder als regulärer Ausdruck).' },
  { op: 'extract', args: 'pattern, group?', description: 'Teil per regulärem Ausdruck herausziehen.' },
  { op: 'number', args: 'decimal? ("de" | "en" | "auto")', description: '"1.234,56 €" → 1234.56.' },
  { op: 'round', args: 'digits?', description: 'Kaufmännisch runden.' },
  { op: 'multiply / add', args: 'by', description: 'Rechnen.' },
  { op: 'abs', args: '—', description: 'Betrag.' },
  { op: 'date', args: 'from?, to?', description: 'Datum erkennen; ohne "to" entsteht ein echtes Datum, mit z. B. "DD.MM.YYYY" ein Text.' },
  { op: 'split', args: 'separator, index', description: 'Trennen und ein Stück übernehmen (negativer Index zählt von hinten).' },
  { op: 'slice', args: 'start, end?', description: 'Zeichen ausschneiden.' },
  { op: 'pad', args: 'length, char?, side?', description: 'Auffüllen, z. B. Positionsnummern.' },
  { op: 'prefix / suffix', args: 'text', description: 'Text davor bzw. dahinter setzen.' },
  { op: 'map', args: 'values, default?', description: 'Werte übersetzen, z. B. {"Stk": "Stück"}.' },
  { op: 'default', args: 'value', description: 'Ersatzwert, wenn leer.' },
  { op: 'boolean', args: 'true?', description: 'Ja/Nein-Erkennung.' },
  { op: 'expr', args: 'expression', description: 'Formel; der bisherige Wert steht als "value" zur Verfügung.' },
];

export const ROW_SOURCE_REFERENCE = [
  { type: 'lineRegex', args: 'pattern, startAfter?, startAt?, stopAt?, include?, exclude?, page?, flags?', description: 'Eine Zeile je Textzeile, die dem Muster entspricht. Die Klammergruppen stehen als "group" zur Verfügung.' },
  { type: 'lines', args: 'startAfter?, stopAt?, include?, exclude?', description: 'Rohe Textzeilen ohne Muster; nutzbar über "lineText".' },
  { type: 'textRegex', args: 'pattern, flags?', description: 'Mehrzeilige Datensätze über den Gesamttext.' },
  { type: 'sheetRows', args: 'sheet, headerRow?, startRow?, endRow?', description: 'Zeilen einer Excel-Tabelle; Spalten über "column" mit der Überschrift.' },
  { type: 'range', args: 'sheet, ref', description: 'Zeilen eines Bereichs; Spalten über "column" mit dem Buchstaben.' },
];

export const CELL_TYPES = ['auto', 'text', 'number', 'date', 'boolean', 'formula', 'blank'];

export const SCHEMA_SKELETON = `{
  "version": 1,
  "name": "Kurzer Name des Mappings",
  "input": { "type": "pdf" | "xlsx" | "any" },
  "output": { "sheet": "Name des Zielblatts" },

  "fields": [
    { "name": "auftragsnummer",
      "source": { "type": "regex", "pattern": "Auftragsnummer:?\\\\s*([A-Z0-9-]+)" },
      "transform": [{ "op": "trim" }],
      "required": true }
  ],

  "cells": [
    { "target": "B4", "source": { "type": "field", "name": "auftragsnummer" } },
    { "target": "Kalkulation!B6", "source": { "type": "field", "name": "datum" }, "type": "date" }
  ],

  "tables": [
    { "name": "positionen",
      "rows": { "type": "lineRegex", "pattern": "^(\\\\d+)\\\\s+(.+?)\\\\s+([\\\\d.,]+)$" },
      "target": { "sheet": "Kalkulation", "startRow": 12, "maxRows": 200, "clearRows": 20 },
      "columns": [
        { "column": "A", "source": { "type": "group", "index": 1 }, "type": "number" },
        { "column": "B", "source": { "type": "group", "index": 2 } },
        { "column": "C", "source": { "type": "group", "index": 3 },
          "transform": [{ "op": "number", "decimal": "de" }], "type": "number" }
      ] }
  ]
}`;

function table(rows, keyName) {
  return rows.map((row) => `- \`${row[keyName]}\` (${row.args}) — ${row.description}`).join('\n');
}

/** Compact markdown reference, embedded in the prompt for Claude. */
export function schemaMarkdown() {
  return [
    '## Aufbau einer Regeldatei',
    '',
    '```json',
    SCHEMA_SKELETON,
    '```',
    '',
    '### Quellen (`source.type`)',
    table(SOURCE_REFERENCE, 'type'),
    '',
    '### Zeilenquellen für `tables[].rows.type`',
    table(ROW_SOURCE_REFERENCE, 'type'),
    '',
    '### Transformationen (`transform[].op`)',
    table(TRANSFORM_REFERENCE, 'op'),
    '',
    `### Zieltypen (\`type\`)\n${CELL_TYPES.map((type) => `\`${type}\``).join(', ')} — ` +
      '"auto" erkennt Zahlen, Datumswerte und Texte selbst; "formula" schreibt eine Excel-Formel.',
  ].join('\n');
}
