# Bohle Datenmapper

Chrome-Erweiterung, die Daten aus **PDF- oder Excel-Dateien** regelbasiert in eine **Excel-Vorlage**
überträgt. Die Regeln sind eine JSON-Datei und lassen sich von Claude schreiben — dafür bringt die
Erweiterung einen fertigen Prompt mit, der die Struktur beider Dateien enthält.

Alles läuft lokal im Browser: keine Server, keine Uploads, keine Host-Berechtigungen.

> Dieses Projekt ist zugleich das **Gerüst für weitere Bohle-Werkzeuge**: kein Build-Schritt, keine
> Fremdbibliotheken, austauschbares Branding an einer Stelle, Kern in Node testbar.
> Siehe [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Installation

1. Repository klonen oder den Ordner `bohle-data-mapper/` herunterladen.
2. In Chrome `chrome://extensions` öffnen und **Entwicklermodus** einschalten.
3. **Entpackte Erweiterung laden** klicken und den Ordner `bohle-data-mapper/` auswählen.
4. Auf das Symbol in der Symbolleiste klicken — die Anwendung öffnet sich **in einem eigenen Tab**.

Es gibt bewusst kein Popup: Ein Mapping bedeutet, lange PDF-Zeilen und breite Tabellen nebeneinander zu
lesen.

## Ablauf

| Schritt | |
| --- | --- |
| **1 · Eingangsdatei** | PDF oder `.xlsx` ablegen. Der Reiter „Vorschau“ zeigt danach exakt den Text bzw. die Zellen, mit denen die Regeln arbeiten — inklusive Zeilennummern und Zellbezügen. |
| **2 · Ausgabevorlage** | Die `.xlsx`-Vorlage ablegen. Sie wird nie verändert; das Ergebnis ist immer eine neue Datei. |
| **3 · Regeln** | JSON einfügen, aus einer Datei laden oder einen gespeicherten Regelsatz wählen. Die Prüfung läuft beim Tippen mit. |
| **4 · Ausführen** | Der Bericht zeigt jeden geschriebenen Wert samt Herkunft und Status; danach herunterladen. |

### Regeln von Claude schreiben lassen

Nach dem Laden beider Dateien **„Prompt für Claude kopieren“** klicken. Der Prompt enthält

* die vollständige Beschreibung des Regelformats,
* den erkannten Text bzw. die gefüllten Zellen der Eingangsdatei,
* die Beschriftungen und Zellbezüge der Vorlage.

Claudes Antwort in den Reiter „Regeln“ einfügen, prüfen lassen, ausführen. Bewährte Regelsätze lassen sich
unter einem Namen speichern und beim nächsten Dokument derselben Art auswählen.

## Beispiel

```json
{
  "version": 1,
  "name": "Auftragsbestätigung → Kalkulation",
  "input": { "type": "pdf" },
  "output": { "sheet": "Kalkulation" },
  "fields": [
    { "name": "auftragsnummer",
      "source": { "type": "regex", "pattern": "Auftragsnummer:?\\s*([A-Z0-9-]+)" },
      "required": true },
    { "name": "datum",
      "source": { "type": "label", "label": "Datum" },
      "transform": [{ "op": "date" }] }
  ],
  "cells": [
    { "target": "B4", "source": { "type": "field", "name": "auftragsnummer" } },
    { "target": "B6", "source": { "type": "field", "name": "datum" }, "type": "date" }
  ],
  "tables": [
    { "name": "positionen",
      "rows": { "type": "lineRegex", "pattern": "^(\\d+)\\s+(.+?)\\s+([\\d.,]+)\\s+(m|Stk)$" },
      "target": { "sheet": "Kalkulation", "startRow": 12, "clearRows": 20 },
      "columns": [
        { "column": "A", "source": { "type": "group", "index": 1 }, "type": "number" },
        { "column": "B", "source": { "type": "group", "index": 2 } },
        { "column": "C", "source": { "type": "group", "index": 3 },
          "transform": [{ "op": "number", "decimal": "de" }], "type": "number" }
      ] }
  ]
}
```

Vollständige Referenz: [`docs/RULES.md`](docs/RULES.md). Lauffähige Beispiele: [`examples/rules/`](examples/rules).

## Was die Vorlage überlebt

Geschrieben werden nur die Zellen aus den Regeln. Formate, Formeln, Spaltenbreiten, Diagramme, Logos,
Druckbereiche und alle übrigen Blätter bleiben unverändert — die Erweiterung erzeugt die Datei nicht neu,
sondern ergänzt sie gezielt. Neue Zellen übernehmen das Format ihrer Spalte bzw. Zeile, und Excel wird nach
dem Öffnen zur Neuberechnung aufgefordert, damit Vorlagenformeln die neuen Werte einbeziehen.

## Datenschutz

Die Erweiterung besitzt genau eine Berechtigung: `storage`, für die gespeicherten Regelsätze. Es gibt keine
`host_permissions` und keinen Netzwerkcode. Dateien werden im Tab gelesen und geschrieben.

## Entwicklung

```bash
npm test          # Kern-Tests, ohne Abhängigkeiten  (test/run.mjs)
npm run test:e2e  # lädt die Erweiterung in Chromium (test/e2e.mjs, braucht playwright-core)
npm run fixtures  # Testdateien neu erzeugen         (test/make-fixtures.py)
npm run icons     # Icons neu erzeugen               (assets/make-icons.py)
```

`npm test` deckt ZIP, XLSX lesen/schreiben, PDF-Textextraktion, Regelprüfung, Formeln und zwei komplette
Durchläufe ab. `npm run test:e2e` fährt die echte Erweiterung in Chromium hoch, legt Dateien ab, führt ein
Mapping aus und prüft die heruntergeladene Arbeitsmappe.

Die Testdateien in `test/fixtures/` stammen bewusst **nicht** aus dem eigenen Code, sondern werden von
`test/make-fixtures.py` aus rohem XLSX- bzw. PDF-Syntax erzeugt — so werden Leser und Writer gegen fremd
erzeugte Dateien geprüft.

## Grenzen

* Gescannte PDFs ohne Textebene brauchen vorher eine Texterkennung (OCR).
* Passwortgeschützte PDFs müssen zuerst entsperrt werden.
* Alte `.xls`-Dateien vorher als `.xlsx` speichern.

## Branding

Farben, Logo und Icons sind **Platzhalter** im Geist des Auftritts (Dunkelblau/Hellblau) — die offiziellen
Markendateien lagen bei der Erstellung nicht vor. Austausch an genau einer Stelle:
[`BRANDING.md`](BRANDING.md).
