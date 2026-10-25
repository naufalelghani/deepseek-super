'use strict';

// Open DeepSeek in a persistent Chrome profile so the user can complete
// Google OAuth manually. The same profile is used by the gateway server.

const path = require('node:path');
const { chromium } = require('playwright');

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

    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: 'chrome',
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = context.pages()[0] || await context.newPage();
    await page.goto(DEEPSEEK_URL, { waitUntil: 'domcontentloaded' });

    // Match the composer selector used by src/browser.js.
    const chatInput = page.locator('textarea[placeholder="Message DeepSeek"]');
    const alreadyReady = await chatInput.isVisible().catch(() => false);

    if (alreadyReady) {
      console.log('Chat composer detected. The existing profile may already be logged in.');
    } else {
      console.log('');
      console.log('Complete these steps manually in the Chrome window:');
      console.log('  1. Click Log in / Sign in on DeepSeek.');
      console.log('  2. Choose Sign in with Google.');
      console.log('  3. Complete Google sign-in, consent, CAPTCHA, or 2FA yourself.');
      console.log('  4. Wait until the DeepSeek chat composer is visible.');
      console.log('');
      console.log('Waiting for the DeepSeek chat composer. Timeout: ' + Math.round(LOGIN_TIMEOUT_MS / 60000) + ' minutes.');

      await chatInput.waitFor({
        state: 'visible',
        timeout: LOGIN_TIMEOUT_MS,
      });
    }

    // Wait briefly for cookies/local storage to settle before saving the backup.
    await page.waitForTimeout(1000);
    try {
      await context.storageState({ path: STORAGE_STATE_PATH });
      console.log('Session backup saved locally:', STORAGE_STATE_PATH);
    } catch (error) {
      console.warn('Could not write storage-state backup:', error.message);
    }

    console.log('');
    console.log('Login step completed. Persistent session is stored in:');
    console.log('  ' + PROFILE_DIR);
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
