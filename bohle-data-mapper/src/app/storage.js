/**
 * Persistence for rule presets and the editor draft.
 *
 * Uses chrome.storage.local inside the extension and falls back to
 * localStorage when the page is opened directly (handy while developing the UI
 * with a plain static server).
 */

const area = globalThis.chrome?.storage?.local ?? null;
const PREFIX = 'bohle-datenmapper:';

async function readKey(key, fallback) {
  const full = PREFIX + key;
  if (area) {
    const result = await area.get(full);
    return result[full] ?? fallback;
  }
  try {
    const raw = globalThis.localStorage?.getItem(full);
    return raw === null || raw === undefined ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeKey(key, value) {
  const full = PREFIX + key;
  if (area) {
    await area.set({ [full]: value });
    return;
  }
  try {
    globalThis.localStorage?.setItem(full, JSON.stringify(value));
  } catch {
    /* storage disabled — presets simply do not persist */
  }
}

export async function loadDraft() {
  return readKey('draft', '');
}

export async function saveDraft(text) {
  return writeKey('draft', text);
}

export async function listPresets() {
  const presets = await readKey('presets', {});
  return Object.entries(presets)
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export async function savePreset(name, rulesText) {
  const presets = await readKey('presets', {});
  presets[name] = { rules: rulesText, savedAt: new Date().toISOString() };
  await writeKey('presets', presets);
}

export async function deletePreset(name) {
  const presets = await readKey('presets', {});
  delete presets[name];
  await writeKey('presets', presets);
}

export async function getPreset(name) {
  const presets = await readKey('presets', {});
  return presets[name]?.rules ?? null;
}
