'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Restore the reusable cookie and localStorage subset of a Playwright
 * storage-state snapshot into a fresh Incognito context.
 *
 * The browser's Incognito profile itself remains temporary. The auth snapshot
 * is a separate, sensitive local file and must never be committed or shared.
 */
async function restoreStorageState(context, storageStatePath, label = 'browser') {
  if (!fs.existsSync(storageStatePath)) return false;

  try {
    const state = JSON.parse(fs.readFileSync(storageStatePath, 'utf8'));
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    const origins = Array.isArray(state.origins) ? state.origins
      .filter((entry) => entry && typeof entry.origin === 'string')
      .map((entry) => ({
        origin: entry.origin,
        localStorage: Array.isArray(entry.localStorage) ? entry.localStorage : [],
      }))
      .filter((entry) => entry.localStorage.length > 0)
      : [];

    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }

    if (origins.length > 0) {
      await context.addInitScript((savedOrigins) => {
        const saved = savedOrigins.find((entry) => entry.origin === window.location.origin);
        if (!saved) return;

        try {
          for (const item of saved.localStorage) {
            if (!item || typeof item.name !== 'string') continue;
            window.localStorage.setItem(item.name, String(item.value ?? ''));
          }
        } catch {
          // Some origins/frames do not expose localStorage; skip those entries.
        }
      }, origins);
    }

    console.info('[' + label + '-auth] restored Incognito session state: cookies=' +
      cookies.length + ' origins=' + origins.length);
    return true;
  } catch (error) {
    console.warn('[' + label + '-auth] could not restore the saved session state: ' +
      (error.message || String(error)));
    return false;
  }
}

async function saveStorageState(context, storageStatePath, label = 'browser') {
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
  console.info('[' + label + '-auth] refreshed local Incognito session backup.');
}

module.exports = { restoreStorageState, saveStorageState };
