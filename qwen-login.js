'use strict';

// Open Qwen Studio in an Incognito Chrome window with a project-specific user-data directory.
// Auth is explicitly backed up to a separate ignored JSON file for the gateway to restore.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { chromium } = require('playwright');
const { restoreStorageState, saveStorageState } = require('./src/incognito-auth');

const QWEN_URL = 'https://chat.qwen.ai/';
const PROFILE_DIR = process.env.QWEN_PROFILE_DIR || path.join(__dirname, 'qwen-profile');
const STORAGE_STATE_PATH = path.join(__dirname, 'qwen-auth.json');
const LOGIN_TIMEOUT_MS = Number.parseInt(
  process.env.QWEN_LOGIN_TIMEOUT_MS || '600000',
  10
);

function isVisible(element) {
  if (!element || element.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity || 1) !== 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    !element.disabled;
}

async function waitForQwenComposer(page) {
  await page.waitForFunction(() => {
    const selectors = [
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]'
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
    console.log('Qwen Studio login (manual sign-in)');
    console.log('Profile:', PROFILE_DIR);
    console.log('A Chrome window will open. Complete sign-in yourself in that window.');

    fs.mkdirSync(PROFILE_DIR, { recursive: true });

    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: 'chrome',
      args: ['--incognito'],
      viewport: { width: 1280, height: 900 },
    });

    await restoreStorageState(context, STORAGE_STATE_PATH, 'qwen');
    const page = context.pages()[0] || await context.newPage();
    await page.goto(QWEN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    console.log('');
    console.log('Complete these steps manually in the Chrome window:');
    console.log('  1. Open Log in / Sign in if Qwen asks you to authenticate.');
    console.log('  2. Choose one of the sign-in methods displayed by Qwen.');
    console.log('  3. Complete any email verification, CAPTCHA, consent, or 2FA yourself.');
    console.log('  4. Wait until the Qwen chat composer is visible and usable.');
    console.log('');
    console.log('Do not enter account credentials in this terminal; use the browser only.');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await rl.question('When Qwen is ready, press Enter here to verify the page and save the session...');
    } finally {
      rl.close();
    }

    const currentUrl = new URL(page.url());
    if (currentUrl.protocol !== 'https:' ||
        (currentUrl.hostname !== 'chat.qwen.ai' && !currentUrl.hostname.endsWith('.qwen.ai'))) {
      throw new Error('The current page is not on the expected Qwen HTTPS domain: ' + currentUrl.origin);
    }

    // Qwen UI markup can change. Use common composer semantics instead of
    // depending on a single generated class name or a fragile CSS module selector.
    await waitForQwenComposer(page);

    // Allow authentication cookies and browser storage to settle before saving.
    await page.waitForTimeout(1000);

    // Qwen's published cookie notice lists a "token" cookie on .qwen.ai.
    // Treat it only as a diagnostic marker; never print or expose its value.
    const cookies = await context.cookies();
    const tokenCookiePresent = cookies.some((cookie) =>
      cookie.name === 'token' &&
      cookie.value &&
      cookie.domain.toLowerCase().includes('qwen.ai')
    );
    if (!tokenCookiePresent) {
      console.warn('[qwen-login] Qwen token cookie was not detected. The auth snapshot will still be written, but confirm that sign-in completed successfully.');
    }

    fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
    await saveStorageState(context, STORAGE_STATE_PATH, 'qwen');

    const profileExists = fs.existsSync(PROFILE_DIR) && fs.statSync(PROFILE_DIR).isDirectory();
    const authFileExists = fs.existsSync(STORAGE_STATE_PATH) &&
      fs.statSync(STORAGE_STATE_PATH).isFile() &&
      fs.statSync(STORAGE_STATE_PATH).size > 0;

    if (!profileExists) {
      throw new Error('The Qwen project user-data directory was not created: ' + PROFILE_DIR);
    }
    if (!authFileExists) {
      throw new Error('The Qwen session backup was not created: ' + STORAGE_STATE_PATH);
    }

    console.log('Session backup saved locally:', STORAGE_STATE_PATH);
    console.log('Project Incognito user-data directory verified:', PROFILE_DIR);
    console.log('Session backup file verified:', STORAGE_STATE_PATH);
    console.log('Qwen token-cookie marker:', tokenCookiePresent ? 'detected' : 'not detected');

    console.log('');
    console.log('Qwen login setup completed in Incognito mode. The temporary session is backed up to:');
    console.log('  ' + STORAGE_STATE_PATH);
    console.log('The browser will now close so the project user-data directory is not left locked.');
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error('');
  console.error('Qwen login setup failed:', error.message || error);
  console.error('Check that Qwen sign-in completed and the chat composer appeared.');
  console.error('You can increase the timeout with QWEN_LOGIN_TIMEOUT_MS.');
  process.exitCode = 1;
});
