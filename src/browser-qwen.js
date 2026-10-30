'use strict';

const { chromium } = require('playwright');
const {
  PROFILE_DIR,
  POLL_MS,
  STABLE_MS,
  MAX_TURN_MS,
  MAX_PENDING_TURNS,
} = require('./config');
const { readQwenStateInPage } = require('./browser-qwen-dom');
const { parseToolCallsFromText } = require('./tool-parser');

const QWEN_URL = 'https://chat.qwen.ai/';
const COMPOSER_SELECTOR = 'textarea.message-input-textarea';
const SEND_SELECTOR = 'button.send-button[aria-label="Send"]';
const DSML_PATTERN = /<\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls|invoke|parameter)\b/i;

let ctx = null;
let page = null;
let textarea = null;
let initPromise = null;
let chain = Promise.resolve();
let pendingTurns = 0;

function locked(fn) {
  if (pendingTurns >= MAX_PENDING_TURNS) {
    const error = new Error('The browser turn queue is full. Retry after another request completes.');
    error.statusCode = 503;
    error.type = 'overloaded_error';
    throw error;
  }
  pendingTurns++;
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run.finally(() => {
    pendingTurns = Math.max(0, pendingTurns - 1);
  });
}

async function waitForComposer(candidate, timeout = 60000) {
  const input = candidate.locator(COMPOSER_SELECTOR).first();
  await input.waitFor({ state: 'visible', timeout });
  return input;
}

async function ensurePage() {
  if (page && !page.isClosed()) return;

  if (!initPromise) {
    initPromise = (async () => {
      if (ctx) {
        try {
          const candidate = ctx.pages().find((item) => !item.isClosed()) || await ctx.newPage();
          if (!candidate.url().startsWith(QWEN_URL)) {
            await candidate.goto(QWEN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
          }
          const candidateTextarea = await waitForComposer(candidate);
          page = candidate;
          textarea = candidateTextarea;
          return;
        } catch (error) {
          try { await ctx.close(); } catch {}
          ctx = null;
          page = null;
          textarea = null;
        }
      }

      const newContext = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        channel: 'chrome',
        viewport: { width: 1280, height: 900 },
      });

      try {
        const newPage = newContext.pages()[0] || await newContext.newPage();
        await newPage.goto(QWEN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const newTextarea = await waitForComposer(newPage);
        ctx = newContext;
        page = newPage;
        textarea = newTextarea;
      } catch (error) {
        try { await newContext.close(); } catch {}
        throw error;
      }
    })();
  }

  const pending = initPromise;
  try {
    await pending;
  } catch (error) {
    if (initPromise === pending) initPromise = null;
    throw error;
  }
  if (!page || page.isClosed()) {
    if (initPromise === pending) initPromise = null;
    return ensurePage();
  }
}

async function ensureTogglesOn() {
  return null;
}

async function readState(finalSnapshot = false) {
  return page.evaluate(readQwenStateInPage, { final: finalSnapshot });
}

function parseQwenChatUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== 'https://chat.qwen.ai') return null;
    const match = /^\\/c\\/([A-Za-z0-9_-]{16,128})\\/?$/.exec(parsed.pathname);
    if (!match) return null;
    return {
      chatId: match[1],
      url: 'https://chat.qwen.ai/c/' + match[1],
    };
  } catch {
    return null;
  }
}

async function currentChatId() {
  return page.evaluate(() => {
    const message = document.querySelector('.chat-user-message-container[data-chat-id]');
    if (message) return message.getAttribute('data-chat-id');
    const match = /^\\/c\\/([A-Za-z0-9_-]{16,128})\\/?$/.exec(window.location.pathname);
    return match ? match[1] : null;
  });
}

async function gotoNewChat() {
  await ensurePage();
  const previousChatId = await currentChatId();
  let newChatButton = page.locator(
    '.sidebar-entry-fixed-list-content[aria-label="New Chat"], [aria-label="New Chat"][role="button"]'
  ).first();

  if (!(await newChatButton.isVisible().catch(() => false))) {
    const expandSidebar = page.locator('button[aria-label="Expand sidebar"]').first();
    if (await expandSidebar.isVisible().catch(() => false)) {
      await expandSidebar.click({ timeout: 3000 }).catch(() => {});
    }
  }
  if (!(await newChatButton.isVisible().catch(() => false))) {
    throw new Error('Qwen New Chat control was not found; refusing to send into an existing conversation.');
  }

  await newChatButton.click({ timeout: 5000 });
  await waitForComposer(page);
  if (previousChatId) {
    await page.waitForFunction((oldChatId) => {
      const message = document.querySelector('.chat-user-message-container[data-chat-id]');
      const currentChatId = message ? message.getAttribute('data-chat-id') : null;
      return currentChatId !== oldChatId;
    }, previousChatId, { timeout: 15000 }).catch(() => {});
  }
  await page.waitForTimeout(350);

  const remainingChatId = await currentChatId();
  if (previousChatId && remainingChatId === previousChatId) {
    throw new Error('Qwen did not switch to a new conversation; refusing to mix API sessions.');
  }
  textarea = page.locator(COMPOSER_SELECTOR).first();
}

async function currentUrl() {
  if (!page || page.isClosed()) return null;
  const active = parseQwenChatUrl(page.url());
  if (!active) return null;
  const domChatId = await currentChatId().catch(() => null);
  if (domChatId && domChatId !== active.chatId) return null;
  return active.url;
}

async function resumeUrl(value) {
  await ensurePage();
  const target = parseQwenChatUrl(value);
  if (!target) return false;

  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForComposer(page, 30000);
    await page.waitForFunction((chatId) => {
      const message = document.querySelector('.chat-user-message-container[data-chat-id]');
      return window.location.pathname === '/c/' + chatId &&
        Boolean(message && message.getAttribute('data-chat-id') === chatId);
    }, target.chatId, { timeout: 30000 });
    await page.waitForTimeout(300);

    const activeChatId = await currentChatId();
    const activeUrl = await currentUrl();
    if (activeChatId !== target.chatId || activeUrl !== target.url) {
      console.warn('[qwen-session] requested chat did not match the active Qwen conversation.');
      return false;
    }

    textarea = page.locator(COMPOSER_SELECTOR).first();
    return true;
  } catch (error) {
    console.warn('[qwen-session] failed to resume cached Qwen chat: ' +
      (error.message || String(error)));
    return false;
  }
}

async function stopGenerationBestEffort() {
  try {
    const stopButton = page.locator([
      'button[aria-label*="stop" i]',
      'button[title*="stop" i]',
      '[role="button"][aria-label*="stop" i]',
      'button[aria-label*="cancel" i]',
      'button[title*="cancel" i]',
    ].join(',')).first();
    if (await stopButton.isVisible().catch(() => false)) {
      await stopButton.click({ timeout: 1500 });
      await page.waitForTimeout(250);
      return true;
    }
  } catch (error) {
    console.warn('[qwen-cancel] best-effort stop action failed: ' + (error.message || String(error)));
  }
  return false;
}

async function readLatestAssistantTextViaCopy(expectedText = '') {
  if (!page || page.isClosed()) return null;
  const context = page.context();
  let permissionsGranted = false;
  let previousClipboard = '';
  let previousClipboardCaptured = false;
  let copyAttempted = false;

  try {
    const supported = await page.evaluate(() =>
      Boolean(navigator.clipboard && typeof navigator.clipboard.readText === 'function')
    );
    if (!supported) return null;

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'https://chat.qwen.ai',
    });
    permissionsGranted = true;

    const readClipboard = () => page.evaluate(async () => navigator.clipboard.readText());
    try {
      previousClipboard = await readClipboard();
      previousClipboardCaptured = true;
    } catch {
      console.warn('[qwen-parser] Copy fallback skipped because the existing clipboard could not be preserved.');
      return null;
    }

    const assistantItem = page.locator('.qwen-chat-message.qwen-chat-message-assistant').last();
    if (await assistantItem.count() === 0) return null;
    await assistantItem.hover({ timeout: 1500 }).catch(() => {});
    const copyButton = assistantItem.locator(
      '.response-message-footer-actions button[aria-label="Copy"]'
    ).first();
    if (!(await copyButton.isVisible().catch(() => false))) {
      console.warn('[qwen-parser] Qwen assistant Copy button was not visible.');
      return null;
    }

    copyAttempted = true;
    await copyButton.click({ timeout: 3000 });
    const deadline = Date.now() + 1800;
    let copiedText = '';
    do {
      copiedText = await readClipboard().catch(() => '');
      if (copiedText.trim() &&
          (copiedText !== previousClipboard || copiedText === expectedText)) {
        return copiedText;
      }
      await page.waitForTimeout(75);
    } while (Date.now() < deadline);
    console.warn('[qwen-parser] Qwen Copy action did not produce new clipboard text.');
    return null;
  } catch (error) {
    console.warn('[qwen-parser] Qwen Copy fallback failed: ' + (error.message || String(error)));
    return null;
  } finally {
    if (permissionsGranted && previousClipboardCaptured && copyAttempted) {
      try {
        await page.evaluate(async (value) => navigator.clipboard.writeText(value), previousClipboard);
      } catch {
        console.warn('[qwen-parser] Could not restore the pre-existing clipboard contents.');
      }
    }
    if (permissionsGranted) {
      try { await context.clearPermissions(); } catch {}
    }
  }
}

async function clickSend(isCancelled = () => false) {
  const button = page.locator(SEND_SELECTOR).first();
  const deadline = Date.now() + 15000;
  for (;;) {
    if (isCancelled()) {
      const error = new Error('The client disconnected before the Qwen request was sent.');
      error.name = 'AbortError';
      throw error;
    }
    if (await button.isEnabled().catch(() => false)) {
      await button.click({ timeout: 5000 });
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error('The Qwen Send button did not become enabled within 15 seconds.');
    }
    await page.waitForTimeout(100);
  }
}

async function runTurn(prompt, sink, bufferText, isCancelled = () => false, includeLinks = false) {
  const abortIfCancelled = async () => {
    if (!isCancelled()) return;
    await stopGenerationBestEffort();
    const error = new Error('The client disconnected before the Qwen turn completed.');
    error.name = 'AbortError';
    throw error;
  };

  await abortIfCancelled();
  const before = await readState();
  await textarea.click();
  await textarea.fill(prompt);
  await page.waitForTimeout(150);
  await clickSend(isCancelled);
  await abortIfCancelled();

  const startedAt = Date.now();
  let sawNewAssistant = false;
  let observedAnswer = '';
  let observedStatus = '';
  let lastChange = Date.now();
  let completionStreak = 0;
  let completionSource = 'unknown';
  let lastState = before;

  for (;;) {
    await abortIfCancelled();
    await page.waitForTimeout(POLL_MS);
    const state = await readState();
    lastState = state;

    if (!sawNewAssistant) {
      sawNewAssistant = state.count > before.count ||
        Boolean(state.answerKey && state.answerKey !== before.answerKey);
      if (!sawNewAssistant) {
        if (Date.now() - startedAt > MAX_TURN_MS) {
          throw new Error('Qwen did not create a new assistant response before MAX_TURN_MS.');
        }
        continue;
      }
      observedAnswer = state.answer || '';
      observedStatus = state.statusTitle || '';
      lastChange = Date.now();
    }

    if (state.answer !== observedAnswer || state.statusTitle !== observedStatus) {
      observedAnswer = state.answer || '';
      observedStatus = state.statusTitle || '';
      lastChange = Date.now();
    }

    const idleMs = Date.now() - lastChange;
    const explicitCompletion = Boolean(state.answer && !state.isGenerating &&
      (state.statusComplete || state.copyAvailable));
    if (explicitCompletion) {
      completionStreak++;
      if (completionStreak >= 3) {
        completionSource = state.statusComplete ? 'qwen_status_complete' : 'qwen_copy_action';
        break;
      }
    } else {
      completionStreak = 0;
    }

    if (state.answer && !state.isGenerating && idleMs >= STABLE_MS * 2) {
      completionSource = 'stable_fallback';
      break;
    }
    if (Date.now() - startedAt > MAX_TURN_MS) {
      throw new Error('Qwen did not signal completion before MAX_TURN_MS. The turn was not treated as complete.');
    }
  }

  await abortIfCancelled();
  console.info('[qwen-turn-completion]', JSON.stringify({
    source: completionSource,
    assistantMessages: lastState.count,
    answerChars: (lastState.answer || '').length,
    status: lastState.statusTitle || '',
  }));

  let finalState = lastState;
  try {
    finalState = await readState(true);
  } catch (error) {
    console.warn('[qwen-markdown] final DOM snapshot failed; using last observed state: ' +
      (error.message || String(error)));
  }

  let finalAnswer = finalState.answerMarkdown || finalState.answer || '';
  if (bufferText && DSML_PATTERN.test(finalAnswer)) {
    const copiedSource = await readLatestAssistantTextViaCopy(finalAnswer);
    if (typeof copiedSource === 'string' && DSML_PATTERN.test(copiedSource)) {
      finalAnswer = copiedSource;
      console.info('[qwen-markdown] using assistant Copy source for DSML tool-call response; chars=' +
        finalAnswer.length);
    } else {
      throw new Error(
        'Could not obtain the original Qwen response through its Copy control. ' +
        'The tool call was not forwarded because its arguments may have lost formatting.'
      );
    }
  }

  const parsed = parseToolCallsFromText(finalAnswer);
  const finalText = parsed.text || '';
  const finalTools = Array.isArray(parsed.calls) ? parsed.calls : [];
  const invalidToolCall = Boolean(parsed.invalidToolCall);

  if (sink && !bufferText && finalText) {
    sink.startText();
    sink.textDelta(finalText);
    sink.stopBlock();
  }

  const sourceLinks = includeLinks && Array.isArray(finalState.answerLinks)
    ? finalState.answerLinks
    : [];

  if (finalTools.length > 0) {
    console.log('[qwen-parser] parsed tool call(s): ' + finalTools.map((tool) => tool.name).join(', '));
  } else if (invalidToolCall) {
    console.warn('[qwen-parser] tool-call markup was detected but could not be parsed completely.');
  }

  return {
    text: finalText,
    thinking: '',
    toolCalls: finalTools,
    invalidToolCall,
    sourceLinks,
    completionSource,
  };
}

async function runIsolatedTurn() {
  throw new Error('Qwen backend does not provide the DeepSeek-native isolated Search adapter.');
}

async function shutdownBrowser() {
  try { if (ctx) await ctx.close(); } catch {}
  ctx = null;
  page = null;
  textarea = null;
  initPromise = null;
}

module.exports = {
  ensurePage,
  ensureTogglesOn,
  readState,
  clickSend,
  currentUrl,
  currentChatId,
  gotoNewChat,
  resumeUrl,
  runTurn,
  runIsolatedTurn,
  locked,
  shutdownBrowser,
};
