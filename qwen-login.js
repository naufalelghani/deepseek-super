'use strict';

// Launch a normal Chrome window directly for manual Qwen sign-in.
// Playwright is used only after the user closes Chrome, to verify and back up the session.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { chromium } = require('playwright');
const { openManualChrome, assertProfileAvailable } = require('./src/manual-chrome');
const { saveStorageState } = require('./src/session-auth');

const QWEN_URL = 'https://chat.qwen.ai/';
const PROFILE_DIR = process.env.QWEN_PROFILE_DIR || path.join(__dirname, 'qwen-profile');
const STORAGE_STATE_PATH = path.join(__dirname, 'qwen-auth.json');
const LOGIN_TIMEOUT_MS = Number.parseInt(
  process.env.QWEN_LOGIN_TIMEOUT_MS || '600000',
  10
);

async function waitForQwenComposer(page) {
  await page.waitForFunction(() => {
    const selectors = [
      'textarea.message-input-textarea',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ];

    return selectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some((element) => {
        if (element.getAttribute('aria-hidden') === 'true' || element.disabled) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) !== 0 &&
          rect.width > 0 &&
          rect.height > 0;
      })
    );
  }, null, { timeout: LOGIN_TIMEOUT_MS });
}

async function main() {
  let context;

  try {
    console.log('Qwen manual sign-in (regular Chrome; no Incognito)');
    console.log('Project profile:', PROFILE_DIR);
    fs.mkdirSync(PROFILE_DIR, { recursive: true });

    const chromePath = await openManualChrome(PROFILE_DIR, QWEN_URL);
    console.log('Opened Chrome directly (not through Playwright):', chromePath);
    console.log('');
    console.log('Complete these steps in the Chrome window:');
    console.log('  1. Open Log in / Sign in if Qwen asks you to authenticate.');
    console.log('  2. Choose one of the sign-in methods displayed by Qwen.');
    console.log('  3. Complete verification, CAPTCHA, consent, or 2FA yourself.');
    console.log('  4. Wait until the Qwen chat composer is visible and usable.');
    console.log('  5. CLOSE every Chrome window using this project profile.');
    console.log('');
    console.log('Only after Chrome is fully closed, return here and press Enter.');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await rl.question('Press Enter after closing the project Chrome window...');
    } finally {
      rl.close();
    }

    assertProfileAvailable(PROFILE_DIR);

    // Google/provider sign-in has already completed in ordinary Chrome.
    // Playwright only verifies the persisted session and writes a backup.
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: 'chrome',
      viewport: { width: 1280, height: 900 },
    });

    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(QWEN_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      const currentUrl = new URL(page.url());
      if (currentUrl.protocol !== 'https:' ||
          (currentUrl.hostname !== 'chat.qwen.ai' && !currentUrl.hostname.endsWith('.qwen.ai'))) {
        throw new Error('The current page is not on the expected Qwen HTTPS domain: ' + currentUrl.origin);
      }

      await waitForQwenComposer(page);
      await page.waitForTimeout(1000);

      const cookies = await context.cookies();
      const tokenCookiePresent = cookies.some((cookie) =>
        cookie.name === 'token' &&
        cookie.value &&
        cookie.domain.toLowerCase().includes('qwen.ai')
      );
      if (!tokenCookiePresent) {
        console.warn('[qwen-login] Qwen token cookie was not detected. Confirm the page is truly signed in.');
      }

      await saveStorageState(context, STORAGE_STATE_PATH, 'qwen');

      const authFileExists = fs.existsSync(STORAGE_STATE_PATH) &&
        fs.statSync(STORAGE_STATE_PATH).isFile() &&
        fs.statSync(STORAGE_STATE_PATH).size > 0;
      if (!authFileExists) {
        throw new Error('The Qwen session backup was not created: ' + STORAGE_STATE_PATH);
      }

      console.log('');
      console.log('Qwen login verified.');
      console.log('Project Chrome profile:', PROFILE_DIR);
      console.log('Session backup:', STORAGE_STATE_PATH);
      console.log('Qwen token-cookie marker:', tokenCookiePresent ? 'detected' : 'not detected');
      console.log('Close this verification window when done. The gateway uses the same regular Chrome profile.');
    } catch (error) {
      throw new Error(
        'The saved Chrome profile did not open an authenticated Qwen chat. ' +
        'Check that manual sign-in completed successfully. ' +
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
  console.error('Qwen login setup failed:', error.message || error);
  console.error('Make sure all manual Chrome windows using qwen-profile are closed before verification.');
  console.error('You can increase the timeout with QWEN_LOGIN_TIMEOUT_MS.');
  process.exitCode = 1;
});
