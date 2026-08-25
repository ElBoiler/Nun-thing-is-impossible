# Aufbau und Wiederverwendung

Dieses Projekt ist als **Gerüst für weitere Bohle-Werkzeuge** gedacht: eine Chrome-Erweiterung ohne
Build-Schritt, mit genau einer mitgelieferten Bibliothek und ohne Netzwerkzugriff, mit einem klar getrennten
Kern, der sich auch in Node testen lässt.

## Entscheidungen

| Entscheidung | Grund |
| --- | --- |
| **Fast keine Abhängigkeiten** | ZIP, XLSX und XML laufen mit Bordmitteln: `CompressionStream`/`DecompressionStream` und ein eigener XML-Tokenizer; `DOMParser` wird bewusst nicht gebraucht. Kein Build, kein Bundler. |
| **pdf.js für die PDF-Textebene** | Der einzige Fremdcode. PDF ist ein zu großes Format, um es nebenbei selbst zu lesen: kaputte Querverweistabellen, Schrifteinbettungen, Encodings, gedrehte Seiten. pdf.js kennt diese Fälle seit über zehn Jahren. Es liegt fertig gebaut in `vendor/pdfjs/` (Apache-2.0), damit es ohne Build-Schritt und ohne Auflösung aus `node_modules` läuft, und arbeitet in einem eigenen Worker — die Oberfläche bleibt bedienbar. |
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
  pdf-text.js              pdf.js ansteuern und Textfragmente zu Zeilen zusammensetzen
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
vendor/pdfjs/              pdf.js (Apache-2.0), erzeugt mit npm run vendor:pdfjs
tools/vendor-pdfjs.mjs     kopiert den pdf.js-Build aus node_modules nach vendor/
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
* Aus pdf.js sind bewusst **nicht** mitgeliefert: `standard_fonts/`, `cmaps/` und `wasm/`. Sie werden zum
  *Zeichnen* von Glyphen, für vordefinierte CJK-Kodierungen und zum Dekodieren von Bildern gebraucht — hier
  wird nur die Textebene gelesen. Die Extraktion wurde mit und ohne Standardschriften auf identisches
  Ergebnis geprüft. Falls doch einmal nötig: Ordner nach `vendor/pdfjs/` kopieren und in `pdf-text.js`
  `standardFontDataUrl` bzw. `cMapUrl` setzen.
* Zeilen entstehen aus Positionen: Fragmente werden nach Grundlinie gruppiert und über ihren Abstand
  getrennt. Bei mehrspaltigen Kopfbereichen können zwei nebeneinander stehende Felder in einer Zeile landen —
  die Vorschau zeigt das sofort, und `label` lässt sich mit `pattern` nachschärfen.
