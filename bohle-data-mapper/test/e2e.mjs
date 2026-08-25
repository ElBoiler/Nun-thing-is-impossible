/**
 * End-to-end test: loads the unpacked extension into Chromium, drives the UI
 * the way a user would, and checks the workbook that comes back out.
 *
 *   npm run test:e2e
 *
 * Needs `playwright-core` and a Chromium build; skips with a message when
 * either is missing, so `npm test` stays dependency-free.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const GREEN = '[32m';
const RED = '[31m';
const RESET = '[0m';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.log('skipped: playwright-core is not installed (npm i -D playwright-core)');
  process.exit(0);
}

const executablePath = process.env.CHROMIUM_PATH
  || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']
    .find((candidate) => existsSync(candidate));

if (!executablePath) {
  console.log('skipped: no Chromium binary found (set CHROMIUM_PATH)');
  process.exit(0);
}

const results = { passed: 0, failed: 0 };
function check(description, condition, detail = '') {
  if (condition) {
    results.passed++;
    console.log(`  ${GREEN}✓${RESET} ${description}`);
  } else {
    results.failed++;
    console.log(`  ${RED}✗${RESET} ${description}${detail ? `\n      ${detail}` : ''}`);
  }
}

const profile = mkdtempSync(join(tmpdir(), 'bohle-e2e-'));
const downloads = mkdtempSync(join(tmpdir(), 'bohle-dl-'));

const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: false,
  downloadsPath: downloads,
  acceptDownloads: true,
  args: [
    '--headless=new',
    '--no-sandbox',
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
  ],
});

const errors = [];

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  check('service worker starts', Boolean(extensionId), worker.url());

  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto(`chrome-extension://${extensionId}/src/app/app.html`);
  check('app page loads', (await page.title()) === 'Bohle Datenmapper');
  // innerText comes back upper-cased by the brand styling.
  check('branding is rendered', /bohle isoliertechnik/i.test(await page.locator('.brand__company').innerText()));

  await page.setInputFiles('#input-file', join(HERE, 'fixtures', 'auftragsbestaetigung.pdf'));
  await page.waitForFunction(() => document.querySelector('#input-summary')?.textContent?.includes('PDF'), null, { timeout: 20000 });
  const inputSummary = await page.locator('#input-summary').innerText();
  check('pdf is parsed inside the page', /text lines/i.test(inputSummary), inputSummary);
  check('preview shows extracted lines', (await page.locator('.line-list').innerText()).includes('AB-2026-04821'));

  const allLines = await page.locator('.line-list tr').count();
  await page.fill('#preview-search', 'Nettosumme');
  check('preview search filters', (await page.locator('.line-list tr').count()) < allLines);
  await page.fill('#preview-search', '');

  await page.setInputFiles('#template-file', join(HERE, 'fixtures', 'vorlage-kalkulation.xlsx'));
  await page.waitForFunction(() => document.querySelector('#template-summary')?.textContent?.includes('Kalkulation'), null, { timeout: 20000 });
  check('template sheets are listed', (await page.locator('#template-summary').innerText()).includes('Stammdaten'));

  await page.click('.tab[data-tab="rules"]');
  await page.fill('#rules-editor', readFileSync(join(ROOT, 'examples', 'rules', 'auftragsbestaetigung-pdf.json'), 'utf8'));
  await page.waitForFunction(() => document.querySelector('#rules-messages')?.classList.contains('is-ok'), null, { timeout: 10000 });
  check('rules validate in the page', (await page.locator('#rules-messages').innerText()).includes('gültig'));
  check('run button becomes available', !(await page.locator('#run').isDisabled()));

  await page.click('#run');
  await page.waitForSelector('.summary-tiles', { timeout: 30000 });
  const status = await page.locator('#run-status').innerText();
  check('run reports success', /Fertig/.test(status) && !/Problem/.test(status), status);
  const report = await page.locator('#report').innerText();
  check('report lists the order number', report.includes('AB-2026-04821'), report.slice(0, 400));
  check('report shows the positions table', /positionen/i.test(report));

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#download'),
  ]);
  const target = join(downloads, download.suggestedFilename());
  await download.saveAs(target);
  const { readXlsx } = await import('../src/core/xlsx-read.js');
  const workbook = await readXlsx(new Uint8Array(readFileSync(target)));
  check('downloaded workbook is valid', workbook.sheetNames.includes('Kalkulation'));
  check(
    'downloaded workbook carries the mapped values',
    workbook.sheet('Kalkulation').value('B4') === 'AB-2026-04821'
      && workbook.sheet('Kalkulation').value('B12') === 'Rohrisolierung DN 100',
  );

  // Presets round-trip through chrome.storage.local.
  await page.evaluate(() => {
    window.prompt = () => 'E2E-Regelsatz';
  });
  await page.click('#preset-save');
  await page.waitForFunction(
    () => [...document.querySelectorAll('#preset-select option')].some((option) => option.value === 'E2E-Regelsatz'),
    null,
    { timeout: 10000 },
  );
  check('presets are stored via chrome.storage', true);

  check('no page errors', errors.length === 0, errors.join('\n      '));
} finally {
  await context.close();
}

console.log(`\n${results.passed} passed, ${results.failed} failed\n`);
process.exit(results.failed ? 1 : 0);
