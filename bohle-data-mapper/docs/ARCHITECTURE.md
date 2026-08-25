# Aufbau und Wiederverwendung

Dieses Projekt ist als **Gerüst für weitere Bohle-Werkzeuge** gedacht: eine Chrome-Erweiterung ohne
Build-Schritt, ohne Fremdbibliotheken und ohne Netzwerkzugriff, mit einem klar getrennten Kern, der sich auch
in Node testen lässt.

## Entscheidungen

| Entscheidung | Grund |
| --- | --- |
| **Keine Abhängigkeiten** | Alles läuft mit Bordmitteln des Browsers: `CompressionStream` für ZIP/XLSX, `DecompressionStream` für die Streams im PDF, `DOMParser` wird bewusst nicht gebraucht. Kein Build, kein Bundler, kein Lieferkettenrisiko, und `npm install` ist nur für den Browser-Test nötig. |
| **Kein Netzwerkzugriff** | Die Erweiterung hat keine `host_permissions`. Auftragsdaten verlassen den Rechner nicht — das ist bei Kundendokumenten die einzig vertretbare Voreinstellung. |
| **Eigener Tab statt Popup** | Ein Mapping bedeutet, lange PDF-Zeilen und breite Tabellen nebeneinander zu lesen. Ein 400-px-Popup taugt dafür nicht. |
| **Vorlage wird ergänzt, nicht neu erzeugt** | Die Vorlage ist das Dokument des Kunden. Der Writer schneidet `<c>`-Elemente an Byte-Offsets in die Blatt-XML und kopiert alle übrigen ZIP-Einträge unverändert durch. |
| **Regeln als Daten** | Eine Regeldatei ist JSON ohne ausführbaren Code. Sie lässt sich versionieren, weitergeben, prüfen — und von Claude schreiben. Die Formelsprache in `expr.js` ist bewusst klein und hat keinen Zugriff auf die Laufzeit. |

## Module

```
manifest.json              MV3-Manifest (Berechtigung: nur "storage")
src/service-worker.js      Toolbar-Klick öffnet/fokussiert den App-Tab

src/core/                  … kennt weder DOM noch chrome.* — in Node testbar
  bytes.js                 Byte-Helfer, CRC32, Deflate/Inflate
  zip.js                   ZIP lesen/schreiben, Einträge unverändert durchreichen
  xml.js                   XML-Tokenizer mit Byte-Offsets
  a1.js                    A1-Referenzen (B4, Blatt!B4, A1:C10)
  xlsx-read.js             Arbeitsmappe lesen (Shared Strings, Formate, Datumswerte)
  xlsx-write.js            Werte in eine Vorlage schreiben, Rest unverändert lassen
  pdf-text.js              PDF-Objektgraph, Filter, Schriften, Textoperatoren → Zeilen
  standard-widths.js       Zeichenbreiten der Base-14-Schriften (Spaltentrennung)
  document.js              Vereinheitlichtes Eingabemodell (PDF und XLSX)
  values.js                Quellen und Transformationen
  expr.js                  Kleine, sichere Formelsprache
  rules.js                 Regeln prüfen und normalisieren
  engine.js                Lauf ausführen, Bericht erzeugen

src/app/                   … UI, nur hier stehen DOM und chrome.*
  app.html/app.css/app.js  Oberfläche
  schema-reference.js      Eine Beschreibung des Regelvokabulars für Hilfe + Prompt
  prompt.js                Prompt für Claude aus Dateistruktur + Schema
  help.js                  Hilfe-Reiter
  storage.js               Regelsätze in chrome.storage.local

src/branding/              brand.css (Tokens) und logo.svg
test/                      run.mjs (Kern), e2e.mjs (echter Chromium), Fixtures
```

Datenfluss eines Laufs:

```
Datei → document.loadSourceDocument() ─┐
                                        ├→ engine.runMapping() → xlsx-write → Download
Vorlage (.xlsx, unverändert) ──────────┤        │
Regeln (JSON) → rules.parseRules() ────┘        └→ Bericht (jede Zelle mit Herkunft)
```

## Ein neues Werkzeug daraus bauen

1. Ordner kopieren, `manifest.json` (Name, Beschreibung) und `package.json` anpassen.
2. `src/branding/brand.css` austauschen — Farben, Radien, Schriften stecken vollständig dort.
3. Icons neu erzeugen (`npm run icons`) oder ersetzen.
4. Kern behalten und nur ergänzen, was fehlt:
   * neue Quelle → Eintrag in `SOURCES` in `values.js` + Zeile in `schema-reference.js`
   * neue Transformation → Eintrag in `TRANSFORMS` in `values.js` + Zeile in `schema-reference.js`
   * neues Eingabeformat → Leser schreiben und in `document.js` einhängen; alles Weitere bleibt gleich
5. Tests erweitern: für jede neue Funktion eine Zusicherung in `test/run.mjs`, für jeden neuen UI-Weg eine in
   `test/e2e.mjs`.

Die Einträge in `schema-reference.js` sind kein Beiwerk: aus ihnen entstehen sowohl der Hilfe-Reiter als auch
der Prompt für Claude. Was dort fehlt, wird Claude nie in eine Regeldatei schreiben.

## Grenzen (bewusst)

* **Gescannte PDFs** ohne Textebene brauchen vorher OCR. Ein OCR-Modul mitzuliefern würde die Erweiterung um
  Größenordnungen aufblähen.
* **Verschlüsselte PDFs** werden abgelehnt statt halb geraten.
* **`.xls`** (das alte Binärformat) wird nicht gelesen — vorher als `.xlsx` speichern.
* **ZIP64** wird nicht unterstützt; für Office-Dateien praktisch irrelevant.
* Der PDF-Textextraktor zielt auf maschinell erzeugte Dokumente. Bei exotischen Schrifteinbettungen ohne
  `/ToUnicode` kann die Zuordnung von Zeichen ungenau werden; die Vorschau zeigt das sofort.
