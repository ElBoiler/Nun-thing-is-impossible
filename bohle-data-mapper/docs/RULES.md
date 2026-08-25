# Regeldatei — Referenz

Eine Regeldatei ist eine JSON-Datei. Sie beschreibt, **welcher Wert aus der Eingangsdatei in welche Zelle der
Ausgabevorlage** geschrieben wird. Die Erweiterung führt nur aus, was hier steht — es gibt keine Automatik,
die „passende“ Felder errät.

Der schnellste Weg zu einer Regeldatei: Eingangsdatei und Vorlage laden, **„Prompt für Claude kopieren“**
klicken, den Prompt in Claude einfügen und die Antwort in den Reiter „Regeln“ übernehmen. Der Prompt enthält
diese Referenz in Kurzform plus die tatsächliche Struktur beider Dateien.

## Grundgerüst

```json
{
  "version": 1,
  "name": "Auftragsbestätigung → Kalkulation",
  "description": "optional",
  "input":  { "type": "pdf" },
  "output": { "sheet": "Kalkulation", "fileName": "optional-fester-Dateiname.xlsx" },
  "options": { "failOnMissingField": false },

  "fields": [ … ],
  "cells":  [ … ],
  "tables": [ … ]
}
```

| Feld | Bedeutung |
| --- | --- |
| `input.type` | `pdf`, `xlsx` oder `any`. Passt der Typ nicht zur geladenen Datei, bricht der Lauf mit einer klaren Meldung ab. |
| `output.sheet` | Standard-Zielblatt. Einzelne Ziele können es mit `"Blatt!B4"` überschreiben. |
| `options.failOnMissingField` | `true` bricht beim ersten fehlenden Pflichtfeld ab, statt den Lauf mit Fehlermeldung im Bericht fortzusetzen. |

Es müssen nicht alle drei Abschnitte vorkommen — aber mindestens einer.

## `fields` — benannte Werte

`fields` sind Zwischenergebnisse. Sie werden in Reihenfolge ausgewertet, sind danach über
`{"type": "field", "name": "…"}` und in `expr`-Formeln unter ihrem Namen verfügbar, und tauchen im Bericht
mit ihrem Wert auf — dadurch ist sofort sichtbar, ob eine Erkennung gegriffen hat.

```json
{
  "name": "auftragsnummer",
  "description": "erscheint im Bericht",
  "source": { "type": "regex", "pattern": "Auftragsnummer:?\\s*([A-Z0-9-]+)" },
  "transform": [{ "op": "trim" }],
  "required": true
}
```

`required: true` erzeugt einen Fehlereintrag im Bericht, wenn der Wert leer bleibt.

## `cells` — einzelne Zellen

```json
{ "target": "B4",              "source": { "type": "field", "name": "auftragsnummer" } }
{ "target": "Kalkulation!B6",  "source": { "type": "field", "name": "datum" }, "type": "date" }
{ "target": "B8",              "source": { "type": "literal", "value": "=SUM(F12:F31)" }, "type": "formula" }
```

| Schlüssel | Bedeutung |
| --- | --- |
| `target` | Pflicht. `"B4"` oder `"Blatt!B4"`. |
| `source` | Pflicht. Siehe [Quellen](#quellen). |
| `transform` | Optional, Liste von Schritten. |
| `type` | `auto` (Standard), `text`, `number`, `date`, `boolean`, `formula`, `blank`. |
| `required` | Leerer Wert wird als Fehler gemeldet. |
| `skipIfEmpty` | Standard `true`: leere Werte lassen die Zelle unangetastet. Auf `false` setzen, um zu leeren. |

`type: "auto"` erkennt Zahlen, Datumswerte und Wahrheitswerte selbst; Texte, die mit `=` beginnen, werden als
Formel geschrieben.

## `tables` — wiederkehrende Zeilen

```json
{
  "name": "positionen",
  "rows": {
    "type": "lineRegex",
    "pattern": "^(\\d{1,3})\\s+(.+?)\\s+([\\d.,]+)\\s+(m|m2|Stk)\\s+([\\d.,]+)\\s+([\\d.,]+)$",
    "startAfter": "Pos\\s+Bezeichnung",
    "stopAt": "^(Zwischensumme|Nettosumme)"
  },
  "filter": "Menge > 0",
  "skip": 0,
  "limit": null,
  "target": { "sheet": "Kalkulation", "startRow": 12, "rowStep": 1, "maxRows": 200, "clearRows": 20 },
  "columns": [
    { "column": "A", "source": { "type": "group", "index": 1 }, "type": "number" },
    { "column": "B", "source": { "type": "group", "index": 2 } }
  ]
}
```

| Schlüssel | Bedeutung |
| --- | --- |
| `rows` | Woher die Zeilen kommen, siehe [Zeilenquellen](#zeilenquellen). |
| `filter` | Formel; nur Zeilen, für die sie wahr ist, werden geschrieben. |
| `skip` / `limit` | Erste *n* Zeilen überspringen bzw. höchstens *n* Zeilen schreiben. |
| `target.startRow` | Zeile der ersten Position. Alternativ `startCell: "A12"`. |
| `target.rowStep` | Zeilenabstand, z. B. `2` bei Vorlagen mit Leerzeile zwischen den Positionen. |
| `target.maxRows` | Sicherheitsgrenze; mehr Zeilen werden mit Hinweis abgeschnitten. |
| `target.clearRows` | So viele Vorlagenzeilen vorher leeren. Verhindert Altdaten, wenn der zweite Lauf weniger Positionen hat. |
| `columns[].column` | Zielspalte als Buchstabe (`"C"`) oder Nummer. Ohne Angabe wird ab `startCell` weitergezählt. |

### Zeilenquellen

| `rows.type` | Parameter | Beschreibung |
| --- | --- | --- |
| `lineRegex` | `pattern`, `flags?`, `startAfter?`, `startAt?`, `stopAt?`, `include?`, `exclude?`, `page?` | Eine Zeile je passender Textzeile. Klammergruppen über `{"type":"group","index":n}`, benannte Gruppen `(?<menge>…)` zusätzlich über `{"type":"column","name":"menge"}`. |
| `lines` | `startAfter?`, `stopAt?`, `include?`, `exclude?` | Rohe Textzeilen ohne Muster, nutzbar über `{"type":"lineText"}`. |
| `textRegex` | `pattern`, `flags?` | Datensätze, die über mehrere Zeilen gehen — das Muster läuft über den Gesamttext. |
| `sheetRows` | `sheet`, `headerRow?`, `startRow?`, `endRow?`, `stopOnEmpty?` | Zeilen einer Excel-Tabelle. Spalten über `{"type":"column","name":"Menge"}` (Überschrift) oder `letter`. |
| `range` | `sheet`, `ref` | Zeilen eines festen Bereichs; Spalten über `letter`. |

`startAfter` beginnt **nach** der Trefferzeile, `startAt` **mit** ihr; `stopAt` beendet die Tabelle vor der
Trefferzeile.

## Quellen

| `type` | Parameter | Beschreibung |
| --- | --- | --- |
| `literal` | `value` | Fester Wert. |
| `field` | `name` | Vorher definiertes Feld. |
| `regex` | `pattern`, `flags?`, `group?`, `occurrence?`, `page?`, `sheet?` | Treffer im Gesamttext. `group` ist standardmäßig die erste Klammergruppe, `occurrence` wählt den n-ten Treffer. |
| `matchAll` | `pattern`, `group?`, `join?` | Alle Treffer als Liste oder verbundener Text. |
| `label` | `label`, `mode?`, `regex?`, `pattern?`, `occurrence?` | Wert hinter einer Beschriftung. `mode`: `sameLine` (Standard, Rest der Zeile), `nextLine`, `wholeLine`. |
| `line` | `index` **oder** `match` + `offset?` | Ganze Zeile über Position (negativ = von hinten) oder Suchmuster. |
| `cell` | `ref`, `sheet?` | Zelle der Eingangs-Excel, z. B. `"Kopf!B2"`. |
| `range` | `ref`, `sheet?`, `join?`, `aggregate?` | Bereich; `aggregate`: `sum`, `count`, `first`, `last`. |
| `group` | `index` | Nur in Tabellen: Klammergruppe der Zeile (`0` = ganze Zeile). |
| `column` | `name` **oder** `letter` | Nur in Tabellen: Spalte der Quellzeile. |
| `rowIndex` / `rowNumber` | `offset?` | Nur in Tabellen: laufende Nummer bzw. Quellzeilennummer. |
| `lineText` | — | Nur in Tabellen: die vollständige Quellzeile. |
| `meta` | `key` | `fileName`, `pageCount`, `sheetNames`, `today`, `now`, `ruleName`. |
| `concat` | `parts[]`, `separator?` | Mehrere Quellen verbinden. |
| `coalesce` | `sources[]` | Erste nicht leere Quelle. |
| `expr` | `expression` | Formel, siehe unten. |

## Transformationen

Werden der Reihe nach angewendet. Ein leerer Wert überspringt alle Schritte außer `default`, `expr`, `text`
und `map`.

| `op` | Parameter | Beschreibung |
| --- | --- | --- |
| `trim` / `collapse` | — | Leerzeichen entfernen bzw. zusammenfassen. |
| `upper` / `lower` / `title` | — | Groß-/Kleinschreibung. |
| `text` | — | In Text umwandeln. |
| `replace` | `find`, `with`, `regex?`, `flags?` | Ersetzen. |
| `extract` | `pattern`, `group?` | Teil herausziehen. |
| `number` | `decimal?` | `"de"`, `"en"` oder `"auto"`. Entfernt Währungszeichen, erkennt `(1.234,56)` und `1.234,56-` als negativ. |
| `round` | `digits?` | Runden. |
| `multiply` / `add` | `by` | Rechnen. |
| `abs` | — | Betrag. |
| `date` | `from?`, `to?` | Erkennt `12.03.2026`, `2026-03-12`, `4. Mai 2026`, `01.02.99`. Ohne `to` entsteht ein echtes Datum, mit `to: "DD.MM.YYYY"` ein Text. |
| `split` | `separator`, `index` | Trennen, ein Stück übernehmen (negativer Index zählt von hinten). |
| `slice` | `start`, `end?` | Zeichen ausschneiden. |
| `pad` | `length`, `char?`, `side?` | Auffüllen. |
| `prefix` / `suffix` | `text` | Text ergänzen. |
| `map` | `values`, `default?`, `keepUnmapped?` | Werte übersetzen. |
| `default` | `value` | Ersatzwert für leere Werte. |
| `boolean` | `true?` | Ja/Nein-Erkennung. |
| `expr` | `expression` | Formel; der bisherige Wert steht als `value` bereit. |

## Formeln (`expr`)

Eine kleine eigene Sprache — **kein JavaScript**, kein Zugriff auf die Seite oder das Netz.

* Operatoren: `+ - * / %`, Vergleiche `< > <= >= = <>`, `&&`, `||`, Verkettung `&`, Bedingung `a ? b : c`
* Funktionen: `round, floor, ceil, abs, min, max, sum, len, upper, lower, trim, left, right, mid, contains,
  replace, concat, if, coalesce, isblank, number, text, today`
* Namen: Felder und — in Tabellen — die Spalten der aktuellen Zeile, Groß-/Kleinschreibung egal.

```json
{ "type": "expr", "expression": "round(Menge * Einzelpreis, 2)" }
{ "type": "expr", "expression": "if(contains(Bezeichnung, 'Brandschutz'), 'BRA', 'STD')" }
```

Division durch Null ergibt einen leeren Wert (keine Fehlermeldung, kein `#DIV/0!`).

## Was mit der Vorlage passiert

* Geschrieben werden **nur** die Zellen aus den Regeln. Alles andere — Formate, Formeln, Spaltenbreiten,
  Diagramme, weitere Blätter, Druckeinstellungen — bleibt unverändert erhalten.
* Neue Zellen erben das Zellformat der Spalte bzw. der Zeile, damit Währungs- und Datumsformate stimmen.
* Texte werden als *Inline Strings* geschrieben; die `sharedStrings`-Tabelle der Vorlage bleibt gültig.
* Nach einem Lauf wird Excel zur Neuberechnung aufgefordert (`fullCalcOnLoad`), damit Formeln der Vorlage die
  neuen Werte berücksichtigen.
* Wird eine Zelle überschrieben, die Ausgangspunkt einer *geteilten Formel* ist, warnt der Bericht.

## Fehlersuche

| Symptom | Ursache und Abhilfe |
| --- | --- |
| „Tabelle … matched no rows“ | Das Muster passt nicht auf die tatsächlichen Zeilen. Im Reiter „Vorschau“ steht der Text so, wie die Regeln ihn sehen — Muster daran ausrichten. |
| Feld bleibt leer | Beschriftung anders geschrieben (`Auftrags-Nr.` statt `Auftragsnummer`) oder Wert steht in der nächsten Zeile → `mode: "nextLine"` oder `coalesce` mit mehreren Varianten. |
| Zahl landet als Text | `{"op": "number", "decimal": "de"}` ergänzen und `"type": "number"` setzen. |
| Datum landet als Zahl | Zielzelle der Vorlage hat kein Datumsformat. Entweder Vorlage anpassen oder mit `{"op":"date","to":"DD.MM.YYYY"}` als Text schreiben. |
| Spalten kleben aneinander | Zwei Werte standen im PDF so dicht nebeneinander, dass kein Leerzeichen erkannt wurde. `\s+` im Muster durch `\s*` ersetzen oder die Werte einzeln über `label` holen. |
| Zwei Felder in einer Zeile | Mehrspaltige Kopfbereiche landen in einer Textzeile („Kunde: … Datum: …“). `label` zusätzlich mit `pattern` einschränken, damit nur der eigene Wert übrig bleibt. |
| „No text layer found“ | Gescanntes PDF ohne Textebene — vorher OCR laufen lassen. |
