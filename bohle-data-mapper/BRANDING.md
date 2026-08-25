# Branding

Die Oberfläche folgt dem Auftritt von **Bohle Isoliertechnik**: kräftiges Dunkelblau als Primärfarbe,
Hellblau als unterstützender Akzent, ruhige Flächen, keine Verläufe.

## Was hier Platzhalter ist

Zum Zeitpunkt der Erstellung lagen **keine offiziellen Markendateien** vor (die Webseite war aus der
Entwicklungsumgebung nicht erreichbar). Folgendes ist daher bewusst als Platzhalter angelegt und sollte vor
einem Rollout durch die echten Vorgaben ersetzt werden:

| Platzhalter | Datei | Ersetzen durch |
| --- | --- | --- |
| Farbwerte | `src/branding/brand.css` | Hex-Werte aus dem Corporate Design |
| Bildmarke | `src/branding/logo.svg`, Inline-SVG in `src/app/app.html` | offizielles Logo |
| Icons | `assets/icon-*.png` (erzeugt aus `assets/make-icons.py`) | aus dem offiziellen Logo gerenderte PNGs |
| Schrift | `--font-sans` in `brand.css` | Hausschrift, falls vorhanden |

Die Bildmarke ist absichtlich **abstrakt** (offene Schalen um einen Kern — Dämmung um ein Rohr) und **kein
Nachbau des Firmenlogos**. Ein nachgezeichnetes Logo wäre schlechter als ein ehrlicher Platzhalter.

## Austauschen

Alle Farben, Radien, Schatten und Schriften stehen als CSS-Variablen in `src/branding/brand.css` — sonst
nirgends. Für ein Re-Branding genügt es, dort die Werte zu ändern:

```css
:root {
  --bohle-navy-800: #0b2a4a;   /* Primär (Kopfzeile, Hauptbutton) */
  --bohle-blue-500: #1c76c4;   /* Akzent (Links, aktive Reiter)   */
  --bohle-blue-300: #7fc4ea;   /* Akzent hell (Kopfzeile, Marke)  */
}
```

Ein dunkles Farbschema ist mitdefiniert und folgt der Systemeinstellung.

## Icons neu erzeugen

```bash
npm run icons     # python3 assets/make-icons.py
```

Liegt das offizielle Logo als PNG vor, kann `assets/make-icons.py` ersatzlos entfallen — die Erweiterung
braucht nur `assets/icon-16.png`, `-32`, `-48` und `-128`.
