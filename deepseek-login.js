'use strict';

// Launch a normal Chrome window directly for manual Google OAuth.
// Playwright is used only after the user closes Chrome, to verify and back up the session.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { chromium } = require('playwright');
const { openManualChrome, assertProfileAvailable } = require('./src/manual-chrome');
const { saveStorageState } = require('./src/session-auth');

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
    console.log('DeepSeek manual Google login (regular Chrome; no Incognito)');
    console.log('Project profile:', PROFILE_DIR);
    fs.mkdirSync(PROFILE_DIR, { recursive: true });

    const chromePath = await openManualChrome(PROFILE_DIR, DEEPSEEK_URL);
    console.log('Opened Chrome directly (not through Playwright):', chromePath);
    console.log('');
    console.log('Complete these steps in the Chrome window:');
    console.log('  1. Click Log in / Sign in on DeepSeek.');
    console.log('  2. Choose Sign in with Google.');
    console.log('  3. Complete Google sign-in, consent, CAPTCHA, or 2FA yourself.');
    console.log('  4. Confirm that the DeepSeek chat composer is visible and usable.');
    console.log('  5. CLOSE every Chrome window using this project profile.');
    console.log('');
    console.log('Only after Chrome is fully closed, return here and press Enter.');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await rl.question('Press Enter after closing the project Chrome window...');
    } finally {
      rl.close();
    }

    // Do not attempt to launch a second browser on a profile still held by Chrome.
    assertProfileAvailable(PROFILE_DIR);

    // Google OAuth is already complete. Playwright now only verifies the saved
    // regular Chrome session and exports a local backup for recovery.
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: 'chrome',
      viewport: { width: 1280, height: 900 },
    });

    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(DEEPSEEK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

      const chatInput = page.locator('textarea[placeholder="Message DeepSeek"]');
      await chatInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
      await page.waitForTimeout(1000);
      await saveStorageState(context, STORAGE_STATE_PATH, 'deepseek');

      const authFileExists = fs.existsSync(STORAGE_STATE_PATH) &&
        fs.statSync(STORAGE_STATE_PATH).isFile() &&
        fs.statSync(STORAGE_STATE_PATH).size > 0;
      if (!authFileExists) {
        throw new Error('The DeepSeek session backup was not created: ' + STORAGE_STATE_PATH);
      }

      console.log('');
      console.log('DeepSeek login verified.');
      console.log('Project Chrome profile:', PROFILE_DIR);
      console.log('Session backup:', STORAGE_STATE_PATH);
      console.log('Close this verification window when done. The gateway uses the same regular Chrome profile.');
    } catch (error) {
      throw new Error(
        'The saved Chrome profile did not open an authenticated DeepSeek chat. ' +
        'Check that manual Google login completed successfully. ' +
        (error.message || String(error))
      );
    }
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error('');
  console.error('DeepSeek login setup failed:', error.message || error);
  console.error('Make sure all manual Chrome windows using deepseek-profile are closed before verification.');
  console.error('You can increase the timeout with DEEPSEEK_LOGIN_TIMEOUT_MS.');
  process.exitCode = 1;
});
