/**
 * Test runner for the core modules.
 *
 *   node test/run.mjs            # everything
 *   node test/run.mjs pdf        # only suites whose name contains "pdf"
 *
 * The core is deliberately free of browser-only APIs, so the same modules the
 * extension loads run here unchanged.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { columnToNumber, numberToColumn, parseRange, parseRef } from '../src/core/a1.js';
import { evaluateExpression } from '../src/core/expr.js';
import { loadSourceDocument } from '../src/core/document.js';
import { readXlsx, serialToDate, dateToSerial } from '../src/core/xlsx-read.js';
import { assembleLines, readPdf } from '../src/core/pdf-text.js';
import { readZip, writeZip } from '../src/core/zip.js';
import { runMapping, suggestFileName } from '../src/core/engine.js';
import { parseRules } from '../src/core/rules.js';
import { applyCellWrites, writeIntoTemplate } from '../src/core/xlsx-write.js';
import { parseDate, parseNumber } from '../src/core/values.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const EXAMPLES = join(HERE, '..', 'examples', 'rules');

const filter = process.argv[2] || '';
const results = { passed: 0, failed: 0, failures: [] };
let currentSuite = '';

function suite(name) {
  currentSuite = name;
}

function check(description, condition, detail = '') {
  if (filter && !`${currentSuite} ${description}`.toLowerCase().includes(filter.toLowerCase())) return;
  if (condition) {
    results.passed++;
    console.log(`  [32m✓[0m ${description}`);
  } else {
    results.failed++;
    results.failures.push(`${currentSuite} › ${description}${detail ? `\n      ${detail}` : ''}`);
    console.log(`  [31m✗[0m ${description}${detail ? `\n      ${detail}` : ''}`);
  }
}

function equal(description, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(description, same, same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function close(description, actual, expected, tolerance = 1e-9) {
  const same = typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
  check(description, same, same ? '' : `expected ≈${expected}, got ${actual}`);
}

const fixture = (name) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const example = (name) => readFileSync(join(EXAMPLES, name), 'utf8');

/* ---------------------------------------------------------------- A1 refs */

suite('a1');
console.log('\na1 references');
equal('column letters -> numbers', [columnToNumber('A'), columnToNumber('Z'), columnToNumber('AA'), columnToNumber('BQ')], [1, 26, 27, 69]);
equal('numbers -> column letters', [numberToColumn(1), numberToColumn(26), numberToColumn(27), numberToColumn(69)], [ 'A', 'Z', 'AA', 'BQ']);
equal('parseRef handles $', parseRef('$C$14'), { col: 3, row: 14 });
equal('parseRange normalises corners', parseRange('C3:A1'), { start: { col: 1, row: 1 }, end: { col: 3, row: 3 } });

/* ------------------------------------------------------------- expressions */

suite('expr');
console.log('\nexpressions');
close('arithmetic', evaluateExpression('2 + 3 * 4'), 14);
close('precedence with parentheses', evaluateExpression('(2 + 3) * 4'), 20);
close('field lookup', evaluateExpression('menge * preis', { fields: { menge: 4, preis: 2.5 } }), 10);
close('row lookup wins over case', evaluateExpression('Menge * 2', { row: { menge: 21 } }), 42);
equal('string concat with &', evaluateExpression("'AB-' & nummer", { fields: { nummer: 4711 } }), 'AB-4711');
close('if()', evaluateExpression('if(a > 10, a * 2, 0)', { fields: { a: 12 } }), 24);
equal('nested functions', evaluateExpression("upper(left(kunde, 4))", { fields: { kunde: 'Nordwerft' } }), 'NORD');
close('round to 2 digits', evaluateExpression('round(1.005 * 100, 2)'), 100.5);
close('german decimals coerce', evaluateExpression("number('1.234,56')"), 1234.56);
equal('division by zero is empty, not Infinity', evaluateExpression('5 / 0'), '');
check('syntax errors are reported', (() => {
  try {
    evaluateExpression('2 +');
    return false;
  } catch (error) {
    return /expression/i.test(error.message);
  }
})());
check('no access to globals', (() => {
  try {
    evaluateExpression('constructor');
    return true; // resolves to empty, never to a JS constructor
  } catch {
    return true;
  }
})() && evaluateExpression('constructor') === '');

/* -------------------------------------------------------------- value bits */

suite('values');
console.log('\nvalue parsing');
close('german number', parseNumber('1.234,56 €'), 1234.56);
close('english number', parseNumber('1,234.56'), 1234.56);
close('negative in parentheses', parseNumber('(1.234,56)'), -1234.56);
close('trailing minus', parseNumber('1.234,56-'), -1234.56);
equal('empty stays null', parseNumber('   '), null);
equal('german date', parseDate('12.03.2026').toISOString().slice(0, 10), '2026-03-12');
equal('iso date', parseDate('2026-03-12').toISOString().slice(0, 10), '2026-03-12');
equal('written month', parseDate('4. Mai 2026').toISOString().slice(0, 10), '2026-05-04');
equal('two digit year', parseDate('01.02.99').toISOString().slice(0, 10), '1999-02-01');
equal('explicit format', parseDate('03/12/2026', 'MM/DD/YYYY').toISOString().slice(0, 10), '2026-03-12');
equal('serial round trip', dateToSerial(serialToDate(46000)), 46000);
equal('excel epoch', serialToDate(1).toISOString().slice(0, 10), '1900-01-01');

/* --------------------------------------------------------------------- zip */

suite('zip');
console.log('\nzip');
{
  const archive = readZip(fixture('vorlage-kalkulation.xlsx'));
  check('reads the central directory', archive.names.includes('xl/workbook.xml'));
  const text = await archive.textOf('xl/workbook.xml');
  check('inflates a member', text.includes('<sheet name="Kalkulation"'));
  equal('missing members return null', await archive.textOf('xl/nope.xml'), null);

  const rebuilt = await writeZip(archive.names.map((name) => ({ name, passthrough: archive.entry(name) })));
  const reread = readZip(rebuilt);
  equal('pass-through round trip keeps every member', reread.names, archive.names);
  equal('pass-through keeps content', await reread.textOf('xl/styles.xml'), await archive.textOf('xl/styles.xml'));

  const written = await writeZip([{ name: 'a.txt', data: 'hello '.repeat(200) }, { name: 'b.bin', data: new Uint8Array([1, 2, 3]) }]);
  const small = readZip(written);
  equal('deflates and re-reads text', await small.textOf('a.txt'), 'hello '.repeat(200));
  equal('stores tiny members', [...(await small.bytesOf('b.bin'))], [1, 2, 3]);
}

/* -------------------------------------------------------------- xlsx read */

suite('xlsx read');
console.log('\nxlsx reading');
{
  const workbook = await readXlsx(fixture('auftrag-eingang.xlsx'));
  equal('sheet names', workbook.sheetNames, ['Kopf', 'Positionen']);
  equal('shared strings', workbook.sheet('Kopf').value('B2'), 'AB-2026-04821');
  equal('date cells become Date objects', workbook.sheet('Kopf').value('B4').toISOString().slice(0, 10), '2026-03-12');
  close('numbers stay numbers', workbook.sheet('Positionen').value('C2'), 124.5);
  equal('missing cells are null', workbook.sheet('Positionen').value('Z99'), null);

  const { headers, rows } = workbook.sheet('Positionen').rowObjects({ headerRow: 1 });
  equal('header labels', headers, ['Pos', 'Bezeichnung', 'Menge', 'Einheit', 'Einzelpreis']);
  equal('row count', rows.length, 4);
  equal('row is addressable by header and by letter', [rows[1].Bezeichnung, rows[1].B], ['Kanalisolierung 40 mm', 'Kanalisolierung 40 mm']);
  equal('row keeps its source row number', rows[0]._row, 2);

  const template = await readXlsx(fixture('vorlage-kalkulation.xlsx'));
  equal('template formula is readable', template.sheet('Kalkulation').cell('F32').formula, 'SUM(F12:F31)');
}

/* ------------------------------------------------------------- xlsx write */

suite('xlsx write');
console.log('\nxlsx writing');
{
  const template = fixture('vorlage-kalkulation.xlsx');
  const { bytes, warnings } = await writeIntoTemplate(template, [
    { sheet: 'Kalkulation', ref: 'B4', value: 'AB-2026-04821' },
    { sheet: 'Kalkulation', ref: 'B5', value: 'Nordwerft Kiel GmbH' },
    { sheet: 'Kalkulation', ref: 'B6', value: new Date(Date.UTC(2026, 2, 12)), type: 'date' },
    { sheet: 'Kalkulation', ref: 'B8', value: 5534.2, type: 'number' },
    { sheet: 'Kalkulation', ref: 'A12', value: 1, type: 'number' },
    { sheet: 'Kalkulation', ref: 'B12', value: 'Rohrisolierung DN 100' },
    { sheet: 'Kalkulation', ref: 'F12', value: '=C12*E12', type: 'formula' },
    { sheet: 'Kalkulation', ref: 'B13', value: 'Zweite Zeile & <Sonderzeichen>' },
    { sheet: 'Stammdaten', ref: 'B2', value: 'Rohrisolierung (neu)' },
  ]);
  equal('no warnings for ordinary writes', warnings, []);

  const written = await readXlsx(bytes);
  const sheet = written.sheet('Kalkulation');
  equal('new cell in an existing row', sheet.value('B4'), 'AB-2026-04821');
  equal('overwrites an existing empty cell', sheet.value('B5'), 'Nordwerft Kiel GmbH');
  equal('date lands as a date', sheet.value('B6').toISOString().slice(0, 10), '2026-03-12');
  close('number lands as a number', sheet.value('B8'), 5534.2);
  equal('creates a row that did not exist', sheet.value('B12'), 'Rohrisolierung DN 100');
  equal('formula is written', sheet.cell('F12').formula, 'C12*E12');
  equal('xml special characters survive', sheet.value('B13'), 'Zweite Zeile & <Sonderzeichen>');
  equal('other sheets are writable too', written.sheet('Stammdaten').value('B2'), 'Rohrisolierung (neu)');

  equal('untouched template cells survive', sheet.value('A11'), 'Pos');
  equal('template formula survives', sheet.cell('F32').formula, 'SUM(F12:F31)');
  equal('date placeholder keeps its style', sheet.cell('B6').style, 2);
  equal('new cells inherit the column style', sheet.cell('F12').style, 3);

  const archive = readZip(bytes);
  check('calcChain is dropped so Excel recalculates', !archive.names.includes('xl/calcChain.xml'));
  check('content types no longer mention calcChain', !(await archive.textOf('[Content_Types].xml')).includes('calcChain'));
  check('workbook rels no longer mention calcChain', !(await archive.textOf('xl/_rels/workbook.xml.rels')).includes('calcChain'));
  check('workbook asks for a full recalculation', (await archive.textOf('xl/workbook.xml')).includes('fullCalcOnLoad="1"'));
  check('unrelated parts are byte-identical', (() => {
    const before = readZip(template);
    const a = before.entry('xl/styles.xml');
    const b = archive.entry('xl/styles.xml');
    return a.crc === b.crc && a.uncompressedSize === b.uncompressedSize;
  })());
  equal('template stays untouched on disk', (await readXlsx(fixture('vorlage-kalkulation.xlsx'))).sheet('Kalkulation').value('B4'), null);

  // Writing twice must be idempotent, not additive.
  const twice = await writeIntoTemplate(bytes, [{ sheet: 'Kalkulation', ref: 'B4', value: 'AB-2026-99999' }]);
  equal('re-writing an already written cell replaces it', (await readXlsx(twice.bytes)).sheet('Kalkulation').value('B4'), 'AB-2026-99999');

  const { xml } = applyCellWrites('<worksheet><sheetData/></worksheet>', [{ ref: 'B2', value: 'x' }]);
  check('empty sheetData is reopened', xml.includes('<row r="2">') && xml.includes('inlineStr'));

  const missing = await writeIntoTemplate(template, [{ sheet: 'Gibtsnicht', ref: 'A1', value: 1 }]).then(
    () => null,
    (error) => error.message,
  );
  check('unknown sheet names fail loudly', /Gibtsnicht/.test(missing || ''), missing || 'no error thrown');
}

/* --------------------------------------------------------------------- pdf */

suite('pdf');
console.log('\npdf text extraction');
{
  const pdf = await readPdf(fixture('auftragsbestaetigung.pdf'));
  equal('page count', pdf.pageCount, 2);
  check('winansi umlauts decode', pdf.text.includes('Auftragsbestätigung'), pdf.text.slice(0, 200));
  check('eszett decodes', pdf.text.includes('Werftstraße 12'));
  check('kerned TJ runs join up', pdf.lines.some((line) => /Auftragsnummer:\s*AB-2026-04821/.test(line.text)),
    JSON.stringify(pdf.lines.slice(0, 6).map((l) => l.text)));
  check('table columns stay separated', pdf.lines.some((line) => /^1\s+Rohrisolierung DN 100\s+124,50\s+m\s+18,40\s+2\.290,80$/.test(line.text)),
    JSON.stringify(pdf.lines.filter((l) => l.text.startsWith('1 ')).map((l) => l.text)));
  check('lines are ordered top to bottom', pdf.pages[0].lines[0].text.includes('Bohle Isoliertechnik'));
  check('page 2 content is present', pdf.pages[1].text.includes('Montage Kleinteile'));
  check('text inside form xobjects is found', pdf.text.includes('24143 Kiel'));
  equal('lines carry their page number', pdf.pages[1].lines[0].page, 2);

  const cid = await readPdf(fixture('auftrag-cid.pdf'));
  equal('objects in an object stream are found', cid.pageCount, 1);
  check('identity-h text decodes through ToUnicode', cid.text.includes('Lieferschein LS-2026-00917'), cid.text.slice(0, 200));
  check('cid columns stay apart', /Position 1 Rohrisolierung 40,00 m/.test(cid.text), cid.text);

  // Line assembly is the part this project owns; pdf.js only supplies the
  // positioned fragments.
  const item = (text, x, y, width, height = 10) => ({ text, x, y, width, height });
  const assembled = assembleLines([
    item('18,40', 410, 100, 24),
    item('Pos', 60, 100, 18),
    item('Rohrisolierung', 95, 100, 62),
    item('DN 100', 161, 100, 30),
    item('Summe', 60, 130, 30),
  ]);
  equal('fragments group into lines by baseline', assembled.length, 2);
  equal('reading order is left to right', assembled[0].text, 'Pos Rohrisolierung DN 100 18,40');
  equal('lines are ordered top to bottom on the page', assembled[1].text, 'Summe');
  equal('a gap narrower than a space does not become one',
    assembleLines([item('12', 60, 10, 8), item(',50', 68, 10, 12)])[0].text, '12,50');

  const rotated = await readPdf(fixture('auftrag-gedreht.pdf'));
  check('a /Rotate 90 page still reads in order',
    /Lieferschein LS-2026-00042/.test(rotated.pages[0].lines[0].text), JSON.stringify(rotated.pages[0].lines.map((l) => l.text)));
  check('rotation swaps the reported page size', rotated.pages[0].width > rotated.pages[0].height,
    `${rotated.pages[0].width} x ${rotated.pages[0].height}`);

  const notPdf = await readPdf(fixture('vorlage-kalkulation.xlsx')).then(() => null, (error) => error.message);
  check('non-PDF input fails clearly', /not a readable PDF/i.test(notPdf || ''), notPdf || 'no error');
}

/* ---------------------------------------------------------------- document */

suite('document');
console.log('\ndocument loading');
{
  const pdfDoc = await loadSourceDocument(fixture('auftragsbestaetigung.pdf'), 'auftragsbestaetigung.pdf');
  equal('detects pdf', pdfDoc.kind, 'pdf');
  check('describes itself', /2 pages/.test(pdfDoc.describe()));
  const xlsxDoc = await loadSourceDocument(fixture('auftrag-eingang.xlsx'), 'auftrag-eingang.xlsx');
  equal('detects xlsx', xlsxDoc.kind, 'xlsx');
  equal('exposes sheet names', xlsxDoc.sheets, ['Kopf', 'Positionen']);
  check('spreadsheets also expose text lines', xlsxDoc.text.includes('AB-2026-04821'));
}

/* ------------------------------------------------------------------- rules */

suite('rules');
console.log('\nrule validation');
{
  const bad = () => parseRules({ cells: [{ target: 'nope', source: { type: 'nosuch' } }] });
  let message = '';
  try {
    bad();
  } catch (error) {
    message = error.message;
  }
  check('reports the offending path', /cells\[0\]/.test(message), message);
  check('reports unknown source types', /nosuch/.test(message), message);

  let regexMessage = '';
  try {
    parseRules({ cells: [{ target: 'B2', source: { type: 'regex', pattern: '([a-z' } }] });
  } catch (error) {
    regexMessage = error.message;
  }
  check('reports broken regular expressions', /regular expression/i.test(regexMessage), regexMessage);

  const { rules } = parseRules({
    output: { sheet: 'Kalkulation' },
    cells: { B4: { source: { type: 'literal', value: 'x' } } },
  });
  equal('object shorthand for cells works', rules.cells[0].target, { sheet: 'Kalkulation', ref: 'B4' });
}

/* ------------------------------------------------------------------ engine */

suite('engine pdf');
console.log('\nengine: pdf -> xlsx');
{
  const doc = await loadSourceDocument(fixture('auftragsbestaetigung.pdf'), 'auftragsbestaetigung.pdf');
  const { bytes, report } = await runMapping({
    doc,
    templateBytes: fixture('vorlage-kalkulation.xlsx'),
    rules: example('auftragsbestaetigung-pdf.json'),
  });
  equal('no errors', report.errors, []);
  const sheet = (await readXlsx(bytes)).sheet('Kalkulation');
  equal('order number', sheet.value('B4'), 'AB-2026-04821');
  equal('customer', sheet.value('B5'), 'Nordwerft Kiel GmbH');
  equal('date is a real date', sheet.value('B6').toISOString().slice(0, 10), '2026-03-12');
  close('net total parsed from german formatting', sheet.value('B8'), 5534.2);
  equal('four positions written', report.tables[0].rowCount, 4);
  equal('first position description', sheet.value('B12'), 'Rohrisolierung DN 100');
  close('quantity is numeric', sheet.value('C12'), 124.5);
  close('last position lands on row 15', sheet.value('E15'), 340);
  equal('unit is carried over', sheet.value('D13'), 'm2');
  close('line total is computed by the rule', sheet.value('F13'), 2141.4);
  check('report keeps a sample of the rows', report.tables[0].sample.length > 0);
}

suite('engine xlsx');
console.log('\nengine: xlsx -> xlsx');
{
  const doc = await loadSourceDocument(fixture('auftrag-eingang.xlsx'), 'auftrag-eingang.xlsx');
  const { bytes, report } = await runMapping({
    doc,
    templateBytes: fixture('vorlage-kalkulation.xlsx'),
    rules: example('auftrag-excel.json'),
  });
  equal('no errors', report.errors, []);
  const sheet = (await readXlsx(bytes)).sheet('Kalkulation');
  equal('cell source', sheet.value('B4'), 'AB-2026-04821');
  equal('date passes through unchanged', sheet.value('B6').toISOString().slice(0, 10), '2026-03-12');
  equal('sheetRows table', report.tables[0].rowCount, 4);
  equal('mapped description', sheet.value('B14'), 'Brandschutzmanschette R90');
  close('expression column', sheet.value('F14'), 762);
  check('suggested file name is sensible', /\.xlsx$/.test(suggestFileName(null, 'auftrag-eingang.xlsx', 'vorlage-kalkulation.xlsx')));
}

/* ------------------------------------------------------------------- done */

console.log('');
if (results.failures.length) {
  console.log('[31mFailures:[0m');
  for (const failure of results.failures) console.log(`  • ${failure}`);
}
console.log(`\n${results.passed} passed, ${results.failed} failed\n`);
process.exit(results.failed ? 1 : 0);
