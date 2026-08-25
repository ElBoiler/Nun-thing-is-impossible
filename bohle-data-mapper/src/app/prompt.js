/**
 * Builds the prompt that turns Claude into the rule author.
 *
 * The hard part of writing a mapping is not the JSON, it is knowing what the
 * two files actually contain — which line the order number sits on, which cell
 * the template expects it in. So the prompt ships the structure of both files
 * along with the schema, and asks for nothing but the rules file back.
 */

import { schemaMarkdown } from './schema-reference.js';

const MAX_PDF_LINES = 140;
const MAX_SHEET_CELLS = 160;

function describePdf(doc) {
  const out = [];
  let page = 0;
  let shown = 0;
  for (const line of doc.lines) {
    if (shown >= MAX_PDF_LINES) break;
    if (line.page !== page) {
      page = line.page;
      out.push(`--- Seite ${page} ---`);
    }
    out.push(line.text);
    shown++;
  }
  if (doc.lines.length > shown) out.push(`… (${doc.lines.length - shown} weitere Zeilen)`);
  return out.join('\n');
}

function describeSheet(sheet, limit = MAX_SHEET_CELLS) {
  const cells = [...sheet.cells.values()]
    .filter((cell) => cell.value !== null && cell.value !== '')
    .sort((a, b) => a.row - b.row || a.col - b.col);
  const lines = cells.slice(0, limit).map((cell) => {
    const value = cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : String(cell.value);
    const formula = cell.formula ? `  [Formel: =${cell.formula}]` : '';
    return `${cell.ref}: ${value.length > 90 ? `${value.slice(0, 90)}…` : value}${formula}`;
  });
  if (cells.length > limit) lines.push(`… (${cells.length - limit} weitere gefüllte Zellen)`);
  if (!cells.length) lines.push('(leer)');
  return lines.join('\n');
}

function describeWorkbook(workbook) {
  return workbook.sheets
    .map((sheet) => `### Blatt "${sheet.name}" (bis Zeile ${sheet.maxRow}, bis Spalte ${sheet.maxCol})\n${describeSheet(sheet)}`)
    .join('\n\n');
}

/**
 * @param {object} params
 * @param {import('../core/document.js').SourceDocument|null} params.inputDoc
 * @param {object|null} params.templateWorkbook a workbook from readXlsx()
 * @param {string} params.templateName
 */
export function buildClaudePrompt({ inputDoc, templateWorkbook, templateName = 'Vorlage.xlsx' }) {
  const parts = [];

  parts.push(
    'Du schreibst eine Mapping-Regeldatei für den "Bohle Datenmapper" — eine Chrome-Erweiterung, '
    + 'die Daten aus einer Eingangsdatei in eine Excel-Vorlage überträgt.',
    '',
    'Aufgabe: Erstelle die Regeldatei als JSON, die die unten gezeigten Daten aus der Eingangsdatei '
    + 'an die passenden Stellen der Vorlage schreibt.',
    '',
    schemaMarkdown(),
    '',
    '---',
    '',
  );

  if (inputDoc) {
    parts.push(`## Eingangsdatei: ${inputDoc.fileName} (${inputDoc.kind.toUpperCase()})`, '');
    if (inputDoc.kind === 'pdf') {
      parts.push(
        `${inputDoc.pageCount} Seite(n), ${inputDoc.lines.length} Textzeilen. So liest die Erweiterung die Datei — `
        + 'genau auf diesen Zeilen arbeiten `regex`, `label` und `lineRegex`:',
        '',
        '```text',
        describePdf(inputDoc),
        '```',
        '',
      );
    } else {
      parts.push('Gefüllte Zellen je Blatt:', '', '```text', describeWorkbook(inputDoc.workbook), '```', '');
    }
  } else {
    parts.push('## Eingangsdatei', '', '(noch keine geladen — bitte Struktur erfragen)', '');
  }

  if (templateWorkbook) {
    parts.push(
      `## Ausgabevorlage: ${templateName}`,
      '',
      'Diese Zellen sind bereits gefüllt (meist Beschriftungen und Überschriften). Die Werte gehören '
      + 'in der Regel in die Zellen **daneben** bzw. **darunter** — leere Zellen tauchen hier nicht auf:',
      '',
      '```text',
      describeWorkbook(templateWorkbook),
      '```',
      '',
    );
  } else {
    parts.push('## Ausgabevorlage', '', '(noch keine geladen — bitte Struktur erfragen)', '');
  }

  parts.push(
    '---',
    '',
    '## Hinweise',
    '',
    '- Antworte ausschließlich mit dem JSON der Regeldatei, ohne Erklärungen davor oder danach.',
    '- Prüfe jede Zielzelle gegen die Beschriftungen der Vorlage oben.',
    '- Deutsche Zahlen ("1.234,56") brauchen `{"op": "number", "decimal": "de"}`, deutsche Datumswerte `{"op": "date"}`.',
    '- Reguläre Ausdrücke stehen im JSON, Backslashes also doppelt schreiben: `"\\\\d+"`.',
    '- Für wiederkehrende Positionen `tables` verwenden und `clearRows` auf die Anzahl der '
    + 'Platzhalterzeilen der Vorlage setzen, damit ein zweiter Lauf keine Altdaten stehen lässt.',
    '- Felder, die fehlen dürfen, nicht auf `"required": true` setzen.',
  );

  return parts.join('\n');
}
