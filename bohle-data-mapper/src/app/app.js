/**
 * Bohle Datenmapper — UI controller.
 *
 * Holds the three inputs (source file, template, rules), renders what the
 * engine sees, runs a mapping and reports every write. All file handling stays
 * in the tab: nothing is uploaded, and only named rule presets are persisted.
 */

import { loadSourceDocument } from '../core/document.js';
import { readXlsx } from '../core/xlsx-read.js';
import { runMapping, suggestFileName } from '../core/engine.js';
import { parseRules } from '../core/rules.js';
import { numberToColumn } from '../core/a1.js';
import { buildClaudePrompt } from './prompt.js';
import { renderHelp } from './help.js';
import { deletePreset, getPreset, listPresets, loadDraft, savePreset, saveDraft } from './storage.js';

const $ = (id) => document.getElementById(id);

const state = {
  input: { file: null, doc: null },
  template: { file: null, bytes: null, workbook: null },
  rules: null,
  output: null,
  previewSource: 'input',
  previewSheet: null,
};

/* ------------------------------------------------------------------ helpers */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} kB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function displayValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return String(value);
  const text = String(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function setStatus(text, kind = '') {
  const node = $('run-status');
  node.textContent = text;
  node.className = `run-status${kind ? ` is-${kind}` : ''}`;
}

function fileSummary(target, { title, meta, error = false }) {
  const node = $(target);
  node.hidden = false;
  node.className = `file-summary${error ? ' is-error' : ''}`;
  node.replaceChildren(el('strong', { text: title }), el('span', { class: 'meta', text: meta }));
}

/* ---------------------------------------------------------------- dropzones */

function wireDropzone(zoneId, inputId, onFile) {
  const zone = $(zoneId);
  const input = $(inputId);

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    if (input.files[0]) onFile(input.files[0]);
    input.value = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add('is-dragging');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.remove('is-dragging');
    });
  }
  zone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
}

/* -------------------------------------------------------------- file intake */

async function handleInputFile(file) {
  fileSummary('input-summary', { title: file.name, meta: 'wird gelesen …' });
  setStatus('');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await loadSourceDocument(bytes, file.name);
    state.input = { file, doc };
    fileSummary('input-summary', {
      title: file.name,
      meta: `${doc.kind.toUpperCase()} · ${formatBytes(file.size)} · ${doc.describe()}`,
    });
    state.previewSource = 'input';
    state.previewSheet = doc.sheets[0] ?? null;
    syncPreviewButtons();
    renderPreview();
  } catch (error) {
    state.input = { file: null, doc: null };
    fileSummary('input-summary', { title: file.name, meta: error.message, error: true });
  }
  updateRunButton();
}

async function handleTemplateFile(file) {
  fileSummary('template-summary', { title: file.name, meta: 'wird gelesen …' });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const workbook = await readXlsx(bytes);
    state.template = { file, bytes, workbook };
    fileSummary('template-summary', {
      title: file.name,
      meta: `${formatBytes(file.size)} · Blätter: ${workbook.sheetNames.join(', ')}`,
    });
  } catch (error) {
    state.template = { file: null, bytes: null, workbook: null };
    fileSummary('template-summary', { title: file.name, meta: error.message, error: true });
  }
  updateRunButton();
}

/* ------------------------------------------------------------------ preview */

function syncPreviewButtons() {
  for (const button of document.querySelectorAll('#preview-source .segmented__item')) {
    button.classList.toggle('is-active', button.dataset.source === state.previewSource);
  }
}

function highlight(text, needle) {
  if (!needle) return [document.createTextNode(text)];
  const nodes = [];
  const lowered = text.toLowerCase();
  const target = needle.toLowerCase();
  let index = 0;
  for (;;) {
    const found = lowered.indexOf(target, index);
    if (found === -1) break;
    if (found > index) nodes.push(document.createTextNode(text.slice(index, found)));
    nodes.push(el('mark', { text: text.slice(found, found + needle.length) }));
    index = found + needle.length;
  }
  nodes.push(document.createTextNode(text.slice(index)));
  return nodes;
}

function renderPdfPreview(doc, needle) {
  const table = el('table', { class: 'line-list' });
  const body = el('tbody');
  let page = 0;
  let shown = 0;
  for (const line of doc.lines) {
    if (needle && !line.text.toLowerCase().includes(needle.toLowerCase())) continue;
    if (line.page !== page && !needle) {
      page = line.page;
      body.append(el('tr', { class: 'page-break' }, el('td', { colspan: '2', text: `Seite ${page}` })));
    }
    const row = el('tr');
    row.append(el('td', { class: 'line-no', text: String(line.index + 1) }));
    const cell = el('td', { class: 'line-text' });
    cell.append(...highlight(line.text, needle));
    row.append(cell);
    body.append(row);
    shown++;
  }
  table.append(body);
  const wrapper = el('div');
  wrapper.append(
    el('p', {
      class: 'empty-state',
      text: needle
        ? `${shown} von ${doc.lines.length} Zeilen enthalten „${needle}“.`
        : `${doc.pageCount} Seite(n), ${doc.lines.length} Textzeilen — genau diese Zeilen sehen die Regeln.`,
    }),
    table,
  );
  return wrapper;
}

function renderSheetPreview(workbook, needle) {
  const wrapper = el('div');
  const tabs = el('div', { class: 'sheet-tabs' });
  const active = workbook.sheet(state.previewSheet) ? state.previewSheet : workbook.sheetNames[0];
  for (const name of workbook.sheetNames) {
    const button = el('button', {
      class: `sheet-tab${name === active ? ' is-active' : ''}`,
      type: 'button',
      text: name,
    });
    button.addEventListener('click', () => {
      state.previewSheet = name;
      renderPreview();
    });
    tabs.append(button);
  }
  wrapper.append(tabs);

  const sheet = workbook.sheet(active);
  if (!sheet) return wrapper;

  const maxRow = Math.min(sheet.maxRow, 200);
  const maxCol = Math.min(sheet.maxCol, 26);
  const table = el('table', { class: 'grid' });
  const head = el('tr');
  head.append(el('th', { text: '' }));
  for (let col = 1; col <= maxCol; col++) head.append(el('th', { text: numberToColumn(col) }));
  table.append(el('thead', {}, head));

  const body = el('tbody');
  for (let row = 1; row <= maxRow; row++) {
    const tr = el('tr');
    tr.append(el('th', { text: String(row) }));
    for (let col = 1; col <= maxCol; col++) {
      const ref = `${numberToColumn(col)}${row}`;
      const cell = sheet.cell(ref);
      const text = sheet.text(ref);
      const td = el('td', {
        class: [
          cell && cell.kind === 'number' ? 'is-number' : '',
          text ? '' : 'is-empty',
          cell?.formula ? 'has-formula' : '',
        ].filter(Boolean).join(' '),
        title: cell?.formula ? `${ref}  =${cell.formula}` : ref,
      });
      td.append(...highlight(cell?.formula ? `=${cell.formula}` : text, needle));
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);

  wrapper.append(
    el('p', {
      class: 'empty-state',
      text: `Blatt „${sheet.name}“ — ${sheet.maxRow} Zeilen × ${sheet.maxCol} Spalten`
        + `${sheet.maxRow > maxRow || sheet.maxCol > maxCol ? ' (Anzeige gekürzt)' : ''}.`,
    }),
    el('div', { style: 'overflow:auto' }, table),
  );
  return wrapper;
}

function renderPreview() {
  const container = $('preview');
  const needle = $('preview-search').value.trim();
  container.replaceChildren();

  if (state.previewSource === 'template') {
    if (!state.template.workbook) {
      container.append(el('p', { class: 'empty-state', text: 'Noch keine Vorlage geladen.' }));
      return;
    }
    container.append(renderSheetPreview(state.template.workbook, needle));
    return;
  }

  const doc = state.input.doc;
  if (!doc) {
    container.append(el('p', {
      class: 'empty-state',
      text: 'Noch keine Eingangsdatei geladen. Legen Sie links eine Datei ab — hier erscheinen dann die '
        + 'erkannten Textzeilen bzw. Tabellenzellen.',
    }));
    return;
  }
  container.append(doc.kind === 'pdf' ? renderPdfPreview(doc, needle) : renderSheetPreview(doc.workbook, needle));
}

/* -------------------------------------------------------------------- rules */

let validateTimer = null;

function validateRules({ persist = true } = {}) {
  const text = $('rules-editor').value;
  const messages = $('rules-messages');
  const short = $('rules-validation');

  if (persist) saveDraft(text);

  if (!text.trim()) {
    state.rules = null;
    messages.textContent = '';
    messages.className = 'editor-messages';
    short.textContent = 'Keine Regeln geladen.';
    short.className = 'validation';
    updateRunButton();
    return;
  }
  try {
    const { rules, warnings } = parseRules(text);
    state.rules = rules;
    const counts = `${rules.fields.length} Felder · ${rules.cells.length} Zellen · ${rules.tables.length} Tabellen`;
    messages.textContent = `✓ Regeln gültig — ${counts}${warnings.length ? `\n${warnings.join('\n')}` : ''}`;
    messages.className = 'editor-messages is-ok';
    short.textContent = `✓ ${rules.name} (${counts})`;
    short.className = 'validation is-ok';
  } catch (error) {
    state.rules = null;
    messages.textContent = error.message;
    messages.className = 'editor-messages is-error';
    short.textContent = 'Regeln enthalten Fehler — siehe Reiter „Regeln“.';
    short.className = 'validation is-error';
  }
  updateRunButton();
}

function updateRunButton() {
  $('run').disabled = !(state.input.doc && state.template.bytes && state.rules);
}

async function refreshPresets(selected = '') {
  const select = $('preset-select');
  const presets = await listPresets();
  select.replaceChildren(el('option', { value: '', text: '– keine Auswahl –' }));
  for (const preset of presets) {
    select.append(el('option', { value: preset.name, text: preset.name }));
  }
  select.value = selected;
  $('preset-delete').disabled = !select.value;
}

/* --------------------------------------------------------------- run/report */

function reportTile(value, label) {
  return el('div', { class: 'tile' }, [
    el('div', { class: 'tile__value', text: String(value) }),
    el('div', { class: 'tile__label', text: label }),
  ]);
}

function statusBadge(status) {
  const labels = { ok: 'geschrieben', empty: 'leer', missing: 'fehlt', error: 'Fehler' };
  return el('span', { class: `badge badge--${status}`, text: labels[status] ?? status });
}

function dataTable(headers, rows) {
  const table = el('table', { class: 'data-table' });
  table.append(el('thead', {}, el('tr', {}, headers.map((header) => el('th', { text: header })))));
  const body = el('tbody');
  for (const row of rows) body.append(el('tr', {}, row));
  table.append(body);
  return table;
}

function renderReport(report) {
  const container = $('report');
  container.replaceChildren();

  container.append(el('div', { class: 'summary-tiles' }, [
    reportTile(report.writeCount, 'geschriebene Zellen'),
    report.clearedCount ? reportTile(report.clearedCount, 'geleerte Platzhalter') : null,
    reportTile(report.fields.length, 'Felder'),
    reportTile(report.tables.reduce((total, table) => total + table.rowCount, 0), 'Tabellenzeilen'),
    reportTile(`${report.durationMs} ms`, 'Laufzeit'),
  ].filter(Boolean)));

  if (report.errors.length) {
    container.append(el('div', { class: 'notice notice--error' }, [
      el('strong', { text: `${report.errors.length} Problem(e):` }),
      el('ul', {}, report.errors.map((message) => el('li', { text: message }))),
    ]));
  }
  if (report.warnings.length) {
    container.append(el('div', { class: 'notice notice--warn' }, [
      el('strong', { text: 'Hinweise:' }),
      el('ul', {}, report.warnings.map((message) => el('li', { text: message }))),
    ]));
  }

  if (report.fields.length) {
    container.append(el('h3', { text: 'Felder' }));
    container.append(dataTable(['Feld', 'Wert', 'Status'], report.fields.map((field) => [
      el('td', { text: field.name }),
      el('td', { class: 'value', text: displayValue(field.value) }),
      el('td', {}, statusBadge(field.status)),
    ])));
  }

  if (report.cells.length) {
    container.append(el('h3', { text: 'Einzelzellen' }));
    container.append(dataTable(['Zelle', 'Wert', 'Status'], report.cells.map((cell) => [
      el('td', { class: 'ref', text: cell.target }),
      el('td', { class: 'value', text: displayValue(cell.value) }),
      el('td', {}, statusBadge(cell.status)),
    ])));
  }

  for (const table of report.tables) {
    container.append(el('h3', { text: `Tabelle „${table.name}“ — ${table.rowCount} Zeile(n) ab Zeile ${table.startRow}` }));
    if (!table.sample.length) {
      container.append(el('p', { class: 'empty-state', text: table.message || 'Keine Zeilen erkannt.' }));
      continue;
    }
    const columns = [...new Set(table.sample.flatMap((row) => Object.keys(row.values)))].sort();
    container.append(dataTable(['Zielzeile', ...columns], table.sample.map((row) => [
      el('td', { class: 'ref', text: String(row.row) }),
      ...columns.map((column) => el('td', { class: 'value', text: displayValue(row.values[column]) })),
    ])));
    if (table.rowCount > table.sample.length) {
      container.append(el('p', { class: 'empty-state', text: `… und ${table.rowCount - table.sample.length} weitere Zeile(n).` }));
    }
  }
}

async function run() {
  $('run').disabled = true;
  $('download').hidden = true;
  setStatus('Mapping läuft …');
  try {
    const { bytes, report } = await runMapping({
      doc: state.input.doc,
      templateBytes: state.template.bytes,
      rules: $('rules-editor').value,
    });
    state.output = {
      bytes,
      fileName: suggestFileName(state.rules, state.input.file?.name, state.template.file?.name),
    };
    renderReport(report);
    showTab('report');
    $('download').hidden = false;
    const problems = report.errors.length;
    setStatus(
      problems
        ? `Fertig mit ${problems} Problem(en) — ${report.writeCount} Zellen geschrieben. Bericht prüfen.`
        : `Fertig — ${report.writeCount} Zellen geschrieben.`,
      problems ? 'error' : 'ok',
    );
  } catch (error) {
    setStatus(error.message, 'error');
    console.error(error);
  } finally {
    updateRunButton();
  }
}

function download() {
  if (!state.output) return;
  const blob = new Blob([state.output.bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { href: url, download: state.output.fileName });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* --------------------------------------------------------------------- tabs */

function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('is-active', panel.id === `panel-${name}`);
  }
}

/* ------------------------------------------------------------------- wiring */

// Dropping a file next to a dropzone would otherwise navigate the tab to it.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (event) => {
    if (!event.target.closest?.('.dropzone')) event.preventDefault();
  });
}

wireDropzone('input-drop', 'input-file', handleInputFile);
wireDropzone('template-drop', 'template-file', handleTemplateFile);

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
}

for (const button of document.querySelectorAll('#preview-source .segmented__item')) {
  button.addEventListener('click', () => {
    state.previewSource = button.dataset.source;
    syncPreviewButtons();
    renderPreview();
  });
}

$('preview-search').addEventListener('input', () => renderPreview());

$('rules-editor').addEventListener('input', () => {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validateRules, 250);
});

$('rules-format').addEventListener('click', () => {
  try {
    $('rules-editor').value = JSON.stringify(JSON.parse($('rules-editor').value), null, 2);
    validateRules();
  } catch (error) {
    $('rules-messages').textContent = `JSON konnte nicht formatiert werden: ${error.message}`;
    $('rules-messages').className = 'editor-messages is-error';
  }
});

$('rules-example').addEventListener('click', async () => {
  const kind = state.input.doc?.kind === 'xlsx' ? 'auftrag-excel' : 'auftragsbestaetigung-pdf';
  const url = new URL(`../../examples/rules/${kind}.json`, import.meta.url);
  try {
    const response = await fetch(url);
    $('rules-editor').value = await response.text();
    validateRules();
    showTab('rules');
  } catch (error) {
    setStatus(`Beispiel konnte nicht geladen werden: ${error.message}`, 'error');
  }
});

$('rules-import').addEventListener('click', () => $('rules-file').click());
$('rules-file').addEventListener('change', async () => {
  const file = $('rules-file').files[0];
  if (!file) return;
  $('rules-editor').value = await file.text();
  $('rules-file').value = '';
  validateRules();
  showTab('rules');
});

$('rules-export').addEventListener('click', () => {
  const text = $('rules-editor').value;
  if (!text.trim()) return;
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const name = `${(state.rules?.name || 'regeln').replace(/[\\/:*?"<>|]+/g, '-')}.json`;
  const anchor = el('a', { href: url, download: name });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

$('preset-select').addEventListener('change', async () => {
  const name = $('preset-select').value;
  $('preset-delete').disabled = !name;
  if (!name) return;
  const rules = await getPreset(name);
  if (rules !== null) {
    $('rules-editor').value = rules;
    validateRules();
  }
});

$('preset-save').addEventListener('click', async () => {
  const suggestion = state.rules?.name || state.input.file?.name || 'Regelsatz';
  const name = window.prompt('Name für diesen Regelsatz:', suggestion);
  if (!name) return;
  await savePreset(name.trim(), $('rules-editor').value);
  await refreshPresets(name.trim());
  setStatus(`Regelsatz „${name.trim()}“ gespeichert.`, 'ok');
});

$('preset-delete').addEventListener('click', async () => {
  const name = $('preset-select').value;
  if (!name || !window.confirm(`Regelsatz „${name}“ löschen?`)) return;
  await deletePreset(name);
  await refreshPresets();
  setStatus(`Regelsatz „${name}“ gelöscht.`);
});

$('copy-prompt').addEventListener('click', async () => {
  const prompt = buildClaudePrompt({
    inputDoc: state.input.doc,
    templateWorkbook: state.template.workbook,
    templateName: state.template.file?.name ?? 'Vorlage.xlsx',
  });
  try {
    await navigator.clipboard.writeText(prompt);
    setStatus('Prompt kopiert — in Claude einfügen und die Antwort in den Reiter „Regeln“ übernehmen.', 'ok');
  } catch {
    $('rules-editor').value = prompt;
    showTab('rules');
    setStatus('Zwischenablage nicht verfügbar — der Prompt steht jetzt im Regeln-Feld.', 'error');
  }
});

$('run').addEventListener('click', run);
$('download').addEventListener('click', download);

renderHelp($('help'));
renderPreview();
refreshPresets();
loadDraft().then((draft) => {
  if (draft) {
    $('rules-editor').value = draft;
    validateRules({ persist: false });
  }
});
