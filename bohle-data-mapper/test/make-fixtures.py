#!/usr/bin/env python3
"""Generate the test fixtures.

Nothing here uses the code under test: the workbooks are written the way Excel
writes them (shared strings, a styles part with real number formats, a stale
calcChain) and the PDFs are assembled from raw PDF syntax. That way the readers
and the writer are exercised against files they did not produce.

Two PDFs on purpose:

  auftragsbestaetigung.pdf  classic xref table, Flate content streams, base-14
                            Helvetica with WinAnsiEncoding, TJ kerning arrays,
                            a Form XObject, two pages.
  auftrag-cid.pdf           objects packed into an object stream behind an xref
                            stream, Type0/Identity-H font with a /ToUnicode
                            CMap -- the modern layout most ERP exporters emit.

    python3 test/make-fixtures.py
"""

from __future__ import annotations

import zlib
from datetime import date
from pathlib import Path

OUT = Path(__file__).resolve().parent / "fixtures"

# --------------------------------------------------------------------- xlsx


def _escape(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _column(index: int) -> str:
    out = ""
    while index > 0:
        index, rem = divmod(index - 1, 26)
        out = chr(65 + rem) + out
    return out


def _serial(value: date) -> int:
    return (value - date(1899, 12, 31)).days + 1  # +1 for the 1900 leap-year bug


CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
{sheets}
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
{calcchain}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""

STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="164" formatCode="DD\\.MM\\.YYYY"/>
<numFmt numFmtId="165" formatCode="#,##0.00\\ &quot;€&quot;"/>
</numFmts>
<fonts count="2">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
</fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
</styleSheet>"""

CORE_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:creator>Bohle Isoliertechnik</dc:creator><cp:lastModifiedBy>Bohle Isoliertechnik</cp:lastModifiedBy>
</cp:coreProperties>"""

APP_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>Microsoft Excel</Application></Properties>"""


class SheetBuilder:
    """Collects cells for one worksheet. `value` may be str/int/float/date/None."""

    def __init__(self, name: str, cols_xml: str = ""):
        self.name = name
        self.cols_xml = cols_xml
        self.rows: dict[int, dict[int, tuple]] = {}

    def set(self, ref: str, value=None, style: int = 0, formula: str | None = None):
        column = "".join(ch for ch in ref if ch.isalpha())
        row = int("".join(ch for ch in ref if ch.isdigit()))
        col = 0
        for ch in column.upper():
            col = col * 26 + (ord(ch) - 64)
        self.rows.setdefault(row, {})[col] = (value, style, formula)
        return self

    def row(self, row: int, start_col: int, values, style: int = 0):
        for offset, value in enumerate(values):
            self.set(f"{_column(start_col + offset)}{row}", value, style)
        return self

    def to_xml(self, shared: list[str]) -> str:
        def index_of(text: str) -> int:
            if text not in shared:
                shared.append(text)
            return shared.index(text)

        body = []
        max_col = 1
        for row_number in sorted(self.rows):
            cells = []
            for col in sorted(self.rows[row_number]):
                value, style, formula = self.rows[row_number][col]
                max_col = max(max_col, col)
                ref = f"{_column(col)}{row_number}"
                attrs = f' r="{ref}"' + (f' s="{style}"' if style else "")
                if formula:
                    cells.append(f"<c{attrs}><f>{_escape(formula)}</f><v>0</v></c>")
                elif value is None:
                    cells.append(f"<c{attrs}/>")
                elif isinstance(value, date):
                    cells.append(f"<c{attrs}><v>{_serial(value)}</v></c>")
                elif isinstance(value, (int, float)):
                    cells.append(f"<c{attrs}><v>{value}</v></c>")
                else:
                    cells.append(f'<c{attrs} t="s"><v>{index_of(str(value))}</v></c>')
            body.append(f'<row r="{row_number}">{"".join(cells)}</row>')

        last_row = max(self.rows) if self.rows else 1
        return (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'<dimension ref="A1:{_column(max_col)}{last_row}"/>'
            '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
            '<sheetFormatPr defaultRowHeight="14.5"/>'
            f"{self.cols_xml}"
            f'<sheetData>{"".join(body)}</sheetData>'
            '<pageMargins left="0.7" right="0.7" top="0.79" bottom="0.79" header="0.3" footer="0.3"/>'
            "</worksheet>"
        )


def write_xlsx(path: Path, sheets: list[SheetBuilder], calc_chain_cells: list[tuple[str, int]] | None = None):
    shared: list[str] = []
    sheet_xml = [sheet.to_xml(shared) for sheet in sheets]

    shared_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(shared)}" uniqueCount="{len(shared)}">'
        + "".join(f'<si><t xml:space="preserve">{_escape(text)}</t></si>' for text in shared)
        + "</sst>"
    )

    sheet_entries = "".join(
        f'<sheet name="{_escape(sheet.name)}" sheetId="{index + 1}" r:id="rId{index + 1}"/>'
        for index, sheet in enumerate(sheets)
    )
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="10000"/>'
        '<workbookPr defaultThemeVersion="166925"/>'
        '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="20000" windowHeight="12000"/></bookViews>'
        f"<sheets>{sheet_entries}</sheets>"
        '<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">Kalkulation!$1:$1</definedName></definedNames>'
        '<calcPr calcId="191029"/>'
        "</workbook>"
    )

    rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
    for index, _ in enumerate(sheets):
        rels.append(
            f'<Relationship Id="rId{index + 1}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{index + 1}.xml"/>'
        )
    next_id = len(sheets) + 1
    rels.append(
        f'<Relationship Id="rId{next_id}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" '
        'Target="sharedStrings.xml"/>'
    )
    rels.append(
        f'<Relationship Id="rId{next_id + 1}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/>'
    )
    if calc_chain_cells:
        rels.append(
            f'<Relationship Id="rId{next_id + 2}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" '
            'Target="calcChain.xml"/>'
        )
    rels.append("</Relationships>")

    parts = {
        "[Content_Types].xml": CONTENT_TYPES.format(
            sheets="\n".join(
                f'<Override PartName="/xl/worksheets/sheet{index + 1}.xml" '
                'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                for index in range(len(sheets))
            ),
            calcchain=(
                '<Override PartName="/xl/calcChain.xml" '
                'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>'
                if calc_chain_cells
                else ""
            ),
        ),
        "_rels/.rels": ROOT_RELS,
        "docProps/core.xml": CORE_XML,
        "docProps/app.xml": APP_XML,
        "xl/workbook.xml": workbook_xml,
        "xl/_rels/workbook.xml.rels": "\n".join(rels),
        "xl/sharedStrings.xml": shared_xml,
        "xl/styles.xml": STYLES,
    }
    for index, xml in enumerate(sheet_xml):
        parts[f"xl/worksheets/sheet{index + 1}.xml"] = xml
    if calc_chain_cells:
        cells = "".join(f'<c r="{ref}" i="{sheet}"/>' for ref, sheet in calc_chain_cells)
        parts["xl/calcChain.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{cells}</calcChain>'
        )

    import zipfile

    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in parts.items():
            archive.writestr(name, text)
    return path


def build_template() -> Path:
    # Columns E and F carry the currency style, so cells created there inherit it.
    cols = '<cols><col min="1" max="1" width="14" customWidth="1"/><col min="2" max="2" width="32" customWidth="1"/>' \
           '<col min="5" max="6" width="14" style="3" customWidth="1"/></cols>'
    sheet = SheetBuilder("Kalkulation", cols)
    sheet.set("A1", "Bohle Isoliertechnik GmbH", style=1)
    sheet.set("A2", "Kalkulationsblatt")
    sheet.set("A4", "Auftragsnummer")           # B4 does not exist -> new cell in an existing row
    sheet.set("A5", "Kunde").set("B5", None)    # B5 exists but is empty -> overwrite
    sheet.set("A6", "Datum").set("B6", None, style=2)   # date-formatted placeholder
    sheet.set("A7", "Baustelle")
    sheet.set("A8", "Nettosumme").set("B8", None, style=3)
    sheet.set("A10", "Positionen", style=1)
    sheet.row(11, 1, ["Pos", "Bezeichnung", "Menge", "Einheit", "Einzelpreis", "Gesamt"], style=1)
    # Rows 12-31 are absent entirely: the engine has to create them.
    sheet.set("A32", "Summe", style=1)
    sheet.set("F32", None, style=3, formula="SUM(F12:F31)")

    stammdaten = SheetBuilder("Stammdaten")
    stammdaten.row(1, 1, ["Kuerzel", "Leistung", "Faktor"], style=1)
    stammdaten.row(2, 1, ["ROH", "Rohrisolierung", 1.15])
    stammdaten.row(3, 1, ["KAN", "Kanalisolierung", 1.3])
    stammdaten.row(4, 1, ["BRA", "Brandschutz", 1.45])

    return write_xlsx(OUT / "vorlage-kalkulation.xlsx", [sheet, stammdaten], calc_chain_cells=[("F32", 1)])


def build_input_workbook() -> Path:
    kopf = SheetBuilder("Kopf")
    kopf.row(1, 1, ["Feld", "Wert"], style=1)
    kopf.row(2, 1, ["Auftragsnummer", "AB-2026-04821"])
    kopf.row(3, 1, ["Kunde", "Nordwerft Kiel GmbH"])
    kopf.set("A4", "Datum").set("B4", date(2026, 3, 12), style=2)
    kopf.row(5, 1, ["Baustelle", "Werft Halle 3"])

    positionen = SheetBuilder("Positionen")
    positionen.row(1, 1, ["Pos", "Bezeichnung", "Menge", "Einheit", "Einzelpreis"], style=1)
    positionen.row(2, 1, [1, "Rohrisolierung DN 100", 124.5, "m", 18.4])
    positionen.row(3, 1, [2, "Kanalisolierung 40 mm", 86, "m2", 24.9])
    positionen.row(4, 1, [3, "Brandschutzmanschette R90", 12, "Stk", 63.5])
    positionen.row(5, 1, [4, "Montage Kleinteile", 1, "psch", 340])

    return write_xlsx(OUT / "auftrag-eingang.xlsx", [kopf, positionen])


# ---------------------------------------------------------------------- pdf


def _pdf_escape(text: str) -> bytes:
    raw = text.encode("cp1252", errors="replace")
    return raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


class PdfBuilder:
    """Assembles a classic PDF with an xref table."""

    def __init__(self):
        self.objects: list[bytes | None] = []

    def add(self, body: bytes) -> int:
        self.objects.append(body)
        return len(self.objects)

    def reserve(self) -> int:
        self.objects.append(None)
        return len(self.objects)

    def put(self, number: int, body: bytes):
        self.objects[number - 1] = body

    def stream(self, dict_extra: bytes, payload: bytes, compress: bool = True) -> bytes:
        data = zlib.compress(payload) if compress else payload
        filt = b"/Filter/FlateDecode" if compress else b""
        return b"<<" + dict_extra + filt + b"/Length " + str(len(data)).encode() + b">>stream\n" + data + b"\nendstream"

    def render(self, root: int) -> bytes:
        out = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0] * (len(self.objects) + 1)
        for index, body in enumerate(self.objects, start=1):
            offsets[index] = len(out)
            out += f"{index} 0 obj\n".encode() + (body or b"null") + b"\nendobj\n"
        xref_start = len(out)
        out += f"xref\n0 {len(self.objects) + 1}\n".encode()
        out += b"0000000000 65535 f \n"
        for index in range(1, len(self.objects) + 1):
            out += f"{offsets[index]:010d} 00000 n \n".encode()
        out += (
            f"trailer\n<</Size {len(self.objects) + 1}/Root {root} 0 R>>\nstartxref\n{xref_start}\n%%EOF\n".encode()
        )
        return bytes(out)


def build_order_pdf() -> Path:
    pdf = PdfBuilder()
    catalog = pdf.reserve()
    pages = pdf.reserve()

    helv = pdf.add(b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>")
    helv_bold = pdf.add(b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>")

    footer_content = b"BT /F1 7 Tf 1 0 0 1 60 60 Tm (Bohle Isoliertechnik GmbH \\267 Werftstra\\337e 12 \\267 24143 Kiel) Tj ET"
    footer = pdf.add(
        pdf.stream(b"/Type/XObject/Subtype/Form/BBox[0 0 595 120]/Resources<</Font<</F1 " + str(helv).encode() + b" 0 R>>>>",
                   footer_content)
    )

    def text(x, y, value, font="F1", size=10):
        return f"BT /{font} {size} Tf 1 0 0 1 {x} {y} Tm (".encode() + _pdf_escape(value) + b") Tj ET\n"

    def columns(y, cells, font="F1", size=9):
        out = b""
        for x, value in cells:
            out += text(x, y, value, font, size)
        return out

    page1 = b""
    page1 += text(60, 780, "Bohle Isoliertechnik GmbH", "F2", 13)
    page1 += text(60, 764, "Werftstraße 12 · 24143 Kiel", "F1", 9)
    page1 += text(60, 726, "Auftragsbestätigung", "F2", 15)
    # A kerned run, the way real generators emit justified text.
    page1 += b"BT /F1 10 Tf 1 0 0 1 60 700 Tm [(Auftragsnummer:) -300 (AB-2026-04821)] TJ ET\n"
    page1 += text(60, 686, "Kunde: Nordwerft Kiel GmbH")
    page1 += text(60, 672, "Datum: 12.03.2026")
    page1 += text(60, 658, "Baustelle: Werft Halle 3")
    page1 += text(60, 644, "Sachbearbeiter: T. Bohle")
    page1 += columns(610, [(60, "Pos"), (95, "Bezeichnung"), (300, "Menge"), (355, "Einheit"),
                           (410, "Einzelpreis"), (490, "Gesamt")], "F2")
    rows = [
        ("1", "Rohrisolierung DN 100", "124,50", "m", "18,40", "2.290,80"),
        ("2", "Kanalisolierung 40 mm", "86,00", "m2", "24,90", "2.141,40"),
        ("3", "Brandschutzmanschette R90", "12,00", "Stk", "63,50", "762,00"),
    ]
    y = 594
    for pos, name, menge, einheit, ep, gp in rows:
        page1 += columns(y, [(60, pos), (95, name), (300, menge), (355, einheit), (410, ep), (490, gp)])
        y -= 16
    page1 += text(60, 520, "Fortsetzung auf Seite 2")
    page1 += b"q 1 0 0 1 0 0 cm /Fx1 Do Q\n"

    page2 = b""
    page2 += text(60, 780, "Auftragsbestätigung AB-2026-04821 – Seite 2", "F2", 11)
    page2 += columns(740, [(60, "Pos"), (95, "Bezeichnung"), (300, "Menge"), (355, "Einheit"),
                           (410, "Einzelpreis"), (490, "Gesamt")], "F2")
    page2 += columns(720, [(60, "4"), (95, "Montage Kleinteile"), (300, "1,00"), (355, "psch"),
                           (410, "340,00"), (490, "340,00")])
    page2 += text(60, 680, "Nettosumme: 5.534,20 EUR", "F2", 11)
    page2 += text(60, 660, "Zahlungsziel: 30 Tage netto. Lieferzeit nach Absprache.")
    page2 += b"q 1 0 0 1 0 0 cm /Fx1 Do Q\n"

    resources = (
        b"/Resources<</Font<</F1 " + str(helv).encode() + b" 0 R/F2 " + str(helv_bold).encode()
        + b" 0 R>>/XObject<</Fx1 " + str(footer).encode() + b" 0 R>>>>"
    )
    content1 = pdf.add(pdf.stream(b"", page1))
    content2 = pdf.add(pdf.stream(b"", page2))
    page1_obj = pdf.add(
        b"<</Type/Page/Parent " + str(pages).encode() + b" 0 R/MediaBox[0 0 595.28 841.89]"
        + resources + b"/Contents " + str(content1).encode() + b" 0 R>>"
    )
    page2_obj = pdf.add(
        b"<</Type/Page/Parent " + str(pages).encode() + b" 0 R/MediaBox[0 0 595.28 841.89]"
        + resources + b"/Contents " + str(content2).encode() + b" 0 R>>"
    )
    pdf.put(pages, b"<</Type/Pages/Kids[" + str(page1_obj).encode() + b" 0 R " + str(page2_obj).encode()
            + b" 0 R]/Count 2>>")
    pdf.put(catalog, b"<</Type/Catalog/Pages " + str(pages).encode() + b" 0 R>>")

    path = OUT / "auftragsbestaetigung.pdf"
    path.write_bytes(pdf.render(catalog))
    return path


def build_cid_pdf() -> Path:
    """Type0/Identity-H text, objects in an ObjStm behind an xref stream."""
    lines = [
        (60, 780, "Bohle Isoliertechnik GmbH", 13),
        (60, 750, "Lieferschein LS-2026-00917", 11),
        (60, 726, "Kunde: Werft Nord GmbH", 10),
        (60, 712, "Datum: 04.05.2026", 10),
        (60, 690, "Position 1 Rohrisolierung 40,00 m", 10),
        (60, 676, "Position 2 Brandschutz 8,00 Stk", 10),
    ]

    # Identity-H: every glyph is a 2-byte code. Codes are assigned per character
    # and mapped back through /ToUnicode, exactly like a subset font.
    charset = sorted({ch for _, _, value, _ in lines for ch in value})
    codes = {ch: index + 1 for index, ch in enumerate(charset)}

    bfchars = "".join(f"<{codes[ch]:04X}> <{ord(ch):04X}>\n" for ch in charset)
    to_unicode = f"""/CIDInit /ProcSet findresource begin
12 dict begin begincmap
/CMapName /Bohle-Identity-H def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
{len(charset)} beginbfchar
{bfchars}endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end"""

    content = b""
    for x, y, value, size in lines:
        hexed = "".join(f"{codes[ch]:04X}" for ch in value)
        content += f"BT /F1 {size} Tf 1 0 0 1 {x} {y} Tm <{hexed}> Tj ET\n".encode()

    # Widths: a plausible 600/1000 em for everything except the space.
    widths = " ".join(
        f"{codes[ch]} [{250 if ch == ' ' else 600}]" for ch in charset
    )

    pdf = PdfBuilder()
    objstm_number = pdf.reserve()
    tounicode_number = pdf.add(pdf.stream(b"", to_unicode.encode("latin-1")))
    content_number = pdf.add(pdf.stream(b"", content))

    # Objects 4..8 live inside the object stream.
    packed = {
        4: b"<</Type/Catalog/Pages 5 0 R>>",
        5: b"<</Type/Pages/Kids[6 0 R]/Count 1>>",
        6: (b"<</Type/Page/Parent 5 0 R/MediaBox[0 0 595.28 841.89]/Resources<</Font<</F1 7 0 R>>>>"
            b"/Contents " + str(content_number).encode() + b" 0 R>>"),
        7: (b"<</Type/Font/Subtype/Type0/BaseFont/BohleSans/Encoding/Identity-H"
            b"/DescendantFonts[8 0 R]/ToUnicode " + str(tounicode_number).encode() + b" 0 R>>"),
        8: (b"<</Type/Font/Subtype/CIDFontType2/BaseFont/BohleSans"
            b"/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>"
            b"/DW 500/W[" + widths.encode() + b"]>>"),
    }
    header = b""
    body = b""
    for number, payload in packed.items():
        header += f"{number} {len(body)} ".encode()
        body += payload + b" "
    objstm_payload = header + body
    pdf.put(
        objstm_number,
        pdf.stream(
            b"/Type/ObjStm/N " + str(len(packed)).encode() + b"/First " + str(len(header)).encode(),
            objstm_payload,
        ),
    )

    # Render manually so the file gets an xref *stream* rather than a table.
    out = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for index, body_bytes in enumerate(pdf.objects, start=1):
        offsets[index] = len(out)
        out += f"{index} 0 obj\n".encode() + body_bytes + b"\nendobj\n"

    xref_number = len(pdf.objects) + 1
    entries = [(0, 0, 65535)]
    for index in range(1, len(pdf.objects) + 1):
        entries.append((1, offsets[index], 0))
    for slot, number in enumerate(packed):
        while len(entries) <= number:
            entries.append((0, 0, 0))
        entries[number] = (2, objstm_number, slot)
    while len(entries) <= xref_number:
        entries.append((0, 0, 0))

    xref_offset = len(out)
    entries[xref_number] = (1, xref_offset, 0)
    packed_xref = b"".join(
        bytes([kind]) + field2.to_bytes(4, "big") + field3.to_bytes(2, "big")
        for kind, field2, field3 in entries
    )
    xref_stream = zlib.compress(packed_xref)
    out += (
        f"{xref_number} 0 obj\n<</Type/XRef/Size {len(entries)}/W[1 4 2]/Root 4 0 R"
        f"/Filter/FlateDecode/Length {len(xref_stream)}>>stream\n".encode()
    )
    out += xref_stream + b"\nendstream\nendobj\n"
    out += f"startxref\n{xref_offset}\n%%EOF\n".encode()

    path = OUT / "auftrag-cid.pdf"
    path.write_bytes(bytes(out))
    return path


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    produced = [build_template(), build_input_workbook(), build_order_pdf(), build_cid_pdf()]
    for path in produced:
        print(f"{path.relative_to(OUT.parent.parent)}  {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
