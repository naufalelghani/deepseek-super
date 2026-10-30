'use strict';

// Open DeepSeek in an Incognito Chrome window using a project-specific user-data directory.
// Auth is explicitly backed up to a separate ignored JSON file for the gateway to restore.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { chromium } = require('playwright');
const { restoreStorageState, saveStorageState } = require('./src/incognito-auth');

const DEEPSEEK_URL = 'https://chat.deepseek.com/';
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, 'deepseek-profile');
const STORAGE_STATE_PATH = path.join(__dirname, 'deepseek-auth.json');
const LOGIN_TIMEOUT_MS = Number.parseInt(
  process.env.DEEPSEEK_LOGIN_TIMEOUT_MS || '600000',
  10
);

async function main() {
  let context;

  try {
    console.log('DeepSeek web login (manual Google OAuth)');
    console.log('Profile:', PROFILE_DIR);
    console.log('A Chrome window will open. Complete login yourself in that window.');

    // Create the persistent profile directory explicitly so its presence is
    // predictable before Chrome starts. Playwright will populate it with the
    // browser profile and authentication data.
    fs.mkdirSync(PROFILE_DIR, { recursive: true });

    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: 'chrome',
      args: ['--incognito'],
      viewport: { width: 1280, height: 900 },
    });

    await restoreStorageState(context, STORAGE_STATE_PATH, 'deepseek');
    const page = context.pages()[0] || await context.newPage();
    await page.goto(DEEPSEEK_URL, { waitUntil: 'domcontentloaded' });

    // This helper intentionally leaves OAuth entirely to the human. Ask for
    // explicit confirmation instead of assuming a visible composer means login succeeded.
    console.log('');
    console.log('Complete these steps manually in the Chrome window:');
    console.log('  1. Click Log in / Sign in on DeepSeek (skip if already signed in).');
    console.log('  2. Choose Sign in with Google.');
    console.log('  3. Complete Google sign-in, consent, CAPTCHA, or 2FA yourself.');
    console.log('  4. Confirm the DeepSeek chat composer is visible and usable.');
    console.log('');
    console.log('Do not enter Google credentials in this terminal; use the browser only.');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await rl.question('When DeepSeek is ready, press Enter here to save the session and close Chrome...');
    } finally {
      rl.close();
    }

    // Match the composer selector used by src/browser.js.
    const chatInput = page.locator('textarea[placeholder="Message DeepSeek"]');
    await chatInput.waitFor({
      state: 'visible',
      timeout: LOGIN_TIMEOUT_MS,
    });

    // Wait briefly for cookies/local storage to settle before saving the backup.
    await page.waitForTimeout(1000);
    fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
    await saveStorageState(context, STORAGE_STATE_PATH, 'deepseek');

    const profileExists = fs.existsSync(PROFILE_DIR) && fs.statSync(PROFILE_DIR).isDirectory();
    const authFileExists = fs.existsSync(STORAGE_STATE_PATH) &&
      fs.statSync(STORAGE_STATE_PATH).isFile() &&
      fs.statSync(STORAGE_STATE_PATH).size > 0;

    if (!profileExists) {
      throw new Error('The persistent profile directory was not created: ' + PROFILE_DIR);
    }
    if (!authFileExists) {
      throw new Error('The session backup was not created: ' + STORAGE_STATE_PATH);
    }

    console.log('Session backup saved locally:', STORAGE_STATE_PATH);
    console.log('Persistent profile directory verified:', PROFILE_DIR);
    console.log('Session backup file verified:', STORAGE_STATE_PATH);

    console.log('');
    console.log('Login step completed in Incognito mode. Chrome's temporary session is backed up to:');
    console.log('  ' + STORAGE_STATE_PATH);
    console.log('The gateway uses this same profile. Closing this browser now so');
    console.log('the server can open the profile without a Chrome profile lock.');
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error('');
  console.error('DeepSeek login setup failed:', error.message || error);
  console.error('Check that Google login completed and the chat composer appeared.');
  console.error('You can increase the timeout with DEEPSEEK_LOGIN_TIMEOUT_MS.');
  process.exitCode = 1;
});
