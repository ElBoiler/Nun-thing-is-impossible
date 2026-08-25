/**
 * Background service worker.
 *
 * The extension has no popup on purpose: mapping a document means reading long
 * PDF lines and wide spreadsheets side by side, which needs a full tab. The
 * toolbar button therefore opens (or focuses) the app tab.
 */

const APP_URL = chrome.runtime.getURL('src/app/app.html');

async function openApp() {
  // Reuse an open tab instead of piling up duplicates.
  const existing = await chrome.tabs.query({ url: APP_URL });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: APP_URL });
}

chrome.action.onClicked.addListener(() => {
  openApp();
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') openApp();
});
