/**
 * The Help tab. Content is generated from the same reference tables the prompt
 * uses, so the documentation cannot drift away from what the engine supports.
 */

import {
  ROW_SOURCE_REFERENCE,
  SCHEMA_SKELETON,
  SOURCE_REFERENCE,
  TRANSFORM_REFERENCE,
} from './schema-reference.js';

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

function referenceTable(rows, keyName, keyLabel) {
  const body = rows
    .map((row) => `<tr><td><code>${escapeHtml(row[keyName])}</code></td><td><code>${escapeHtml(row.args)}</code></td><td>${escapeHtml(row.description)}</td></tr>`)
    .join('');
  return `<table><thead><tr><th>${keyLabel}</th><th>Parameter</th><th>Bedeutung</th></tr></thead><tbody>${body}</tbody></table>`;
}

export function renderHelp(container) {
  container.innerHTML = `
    <h3>So läuft ein Mapping</h3>
    <ol>
      <li><strong>Eingangsdatei</strong> ablegen (PDF oder Excel). Im Reiter „Vorschau“ steht danach genau der Text
        bzw. die Zellstruktur, mit der die Regeln arbeiten.</li>
      <li><strong>Vorlage</strong> ablegen — die Excel-Datei, die befüllt werden soll. Sie wird nie verändert;
        das Ergebnis ist immer eine neue Datei.</li>
      <li><strong>Regeln</strong> einfügen. Am schnellsten geht das mit „Prompt für Claude kopieren“: der Prompt
        enthält die Struktur beider Dateien und die vollständige Schema-Beschreibung. Claudes Antwort in den
        Regeln-Reiter einfügen.</li>
      <li><strong>Mapping ausführen</strong>. Der Bericht zeigt jeden geschriebenen Wert samt Quelle;
        danach das Ergebnis herunterladen.</li>
    </ol>

    <h3>Was in der Vorlage erhalten bleibt</h3>
    <p>Die Erweiterung schreibt nur die Zellen, die in den Regeln stehen. Formate, Spaltenbreiten, Logos,
      Druckbereiche, Formeln und alle übrigen Blätter bleiben unverändert — die Vorlage wird nicht neu erzeugt,
      sondern gezielt ergänzt. Neue Zellen übernehmen das Zellformat der Spalte bzw. der Zeile, sodass z. B.
      Währungs- und Datumsformate stimmen.</p>

    <h3>Grundgerüst einer Regeldatei</h3>
    <pre>${escapeHtml(SCHEMA_SKELETON)}</pre>

    <h3>Quellen</h3>
    <p><code>fields</code> sind benannte Einzelwerte, <code>cells</code> schreiben in genau eine Zelle,
      <code>tables</code> wiederholen sich über beliebig viele Zeilen.</p>
    ${referenceTable(SOURCE_REFERENCE, 'type', 'source.type')}

    <h3>Zeilenquellen für Tabellen</h3>
    ${referenceTable(ROW_SOURCE_REFERENCE, 'type', 'rows.type')}

    <h3>Transformationen</h3>
    <p>Werden der Reihe nach auf den Rohwert angewendet. Leere Werte überspringen alle Schritte außer
      <code>default</code>, <code>expr</code>, <code>text</code> und <code>map</code>.</p>
    ${referenceTable(TRANSFORM_REFERENCE, 'op', 'transform.op')}

    <h3>Formeln in <code>expr</code></h3>
    <p>Eine kleine, sichere Formelsprache — kein JavaScript. Verfügbar sind die Grundrechenarten,
      Vergleiche, <code>&amp;</code> zum Verketten sowie
      <code>round, floor, ceil, abs, min, max, sum, len, upper, lower, trim, left, right, mid,
      contains, replace, concat, if, coalesce, isblank, number, text, today</code>.
      Felder und Spalten der aktuellen Zeile werden über ihren Namen angesprochen:
      <code>round(Menge * Einzelpreis, 2)</code>.</p>

    <h3>Grenzen</h3>
    <ul>
      <li>Gescannte PDFs ohne Textebene brauchen vorher eine Texterkennung (OCR).</li>
      <li>Passwortgeschützte PDFs müssen zuerst entsperrt werden.</li>
      <li>Alte <code>.xls</code>-Dateien vorher als <code>.xlsx</code> speichern.</li>
      <li>Beim Überschreiben einer Zelle, die Ausgangspunkt einer geteilten Formel ist, warnt der Bericht.</li>
    </ul>

    <h3>Datenschutz</h3>
    <p>Die Erweiterung hat keine Host-Berechtigungen und sendet nichts ins Netz. Dateien werden im
      Browser-Tab gelesen und geschrieben; gespeichert werden ausschließlich die Regelsätze, die Sie selbst
      unter einem Namen sichern.</p>
  `;
}
