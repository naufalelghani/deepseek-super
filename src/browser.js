'use strict';

const { chromium } = require('playwright');
const { PROFILE_DIR, POLL_MS, STABLE_MS, MAX_TURN_MS, HOLD_CHARS, MAX_PENDING_TURNS } = require('./config');
const { StreamParser, extractToolCallsFromText } = require('./tool-parser');
const { hasNewAssistantResponse, isResponseComplete, shouldUseStableFallback, isIdleCompletionCandidate } = require('./turn-state');

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

 async function ensurePage() {
     if (page && !page.isClosed()) return;

     if (!initPromise) {
         initPromise = (async() => {
             // A page can close while its persistent context remains healthy.
             // Prefer reviving that context before launching another Chrome instance.
             if (ctx) {
                 try {
                     const candidate = ctx.pages().find((p) => !p.isClosed()) || await ctx.newPage();
                     await candidate.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
                     const candidateTextarea = candidate.locator('textarea[placeholder="Message DeepSeek"]');
                     await candidateTextarea.waitFor({ state: 'visible', timeout: 60000 });
                     page = candidate;
                     textarea = candidateTextarea;
                     return;
                 } catch (error) {
                     try { await ctx.close(); } catch (closeError) {}
                     ctx = null;
                     page = null;
                     textarea = null;
                 }
             }

             const newContext = await chromium.launchPersistentContext(PROFILE_DIR, {
                 headless: false,
                 channel: 'chrome',
                 viewport: { width: 1280, height: 900 },
                 args: ['--disable-blink-features=AutomationControlled'],
                 ignoreDefaultArgs: ['--enable-automation'],
             });

             try {
                 const newPage = newContext.pages()[0] || await newContext.newPage();
                 await newPage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
                 const newTextarea = newPage.locator('textarea[placeholder="Message DeepSeek"]');
                 await newTextarea.waitFor({ state: 'visible', timeout: 60000 });
                 ctx = newContext;
                 page = newPage;
                 textarea = newTextarea;
             } catch (error) {
                 try { await newContext.close(); } catch (closeError) {}
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

     // A close can race with initialization completing. Do not return a stale handle.
     if (!page || page.isClosed()) {
         if (initPromise === pending) initPromise = null;
         return ensurePage();
     }
 }
 async function ensureTogglesOn(toolsProvided) {
     await page.evaluate((n) => {
         const aria = 'aria-pressed';
         const cls = 'ds-toggle-button';
         const els = document.querySelectorAll('div');
         for (let i = 0; i < els.length; i++) {
             const el = els[i];
             if (el.getAttribute(aria) === null) continue;
             if (!el.classList.contains(cls)) continue;
             const span = el.querySelector('span');
             if (!span || span.textContent.trim() !== n) continue;
             if (el.getAttribute(aria) !== 'true') el.click();
             return;
         }
     }, 'DeepThink').catch(() => {});
     await page.waitForTimeout(150);

     await page.evaluate((wantOn) => {
         const aria = 'aria-pressed';
         const cls = 'ds-toggle-button';
         const els = document.querySelectorAll('div');
         for (let i = 0; i < els.length; i++) {
             const el = els[i];
             if (el.getAttribute(aria) === null) continue;
             if (!el.classList.contains(cls)) continue;
             const span = el.querySelector('span');
             if (!span || span.textContent.trim() !== 'Search') continue;
             const isOn = el.getAttribute(aria) === 'true';
             if (wantOn && !isOn) el.click();
             if (!wantOn && isOn) el.click();
             return;
         }
     }, !toolsProvided).catch(() => {});
     await page.waitForTimeout(200);
 }

 async function readState() {
     return page.evaluate(() => {
         const items = document.querySelectorAll('[data-virtual-list-item-key]');
         let last = null;
         for (let i = items.length - 1; i >= 0; i--) {
             if (items[i].querySelector('.ds-assistant-message-main-content')) { last = items[i]; break; }
         }

         // Prefer explicit generation controls over guessing from response inactivity.
         // DeepSeek may change these selectors, so a stable-time fallback remains available.
         const stopSelector = [
             'button[aria-label*="stop" i]',
             'button[title*="stop" i]',
             '[data-testid*="stop" i]',
             '[class*="stop" i]',
             'button[aria-label*="停止"]',
             'button[title*="停止"]',
             '[data-testid*="停止"]'
         ].join(',');
         const isVisible = (element) => {
             if (!element || element.getAttribute('aria-hidden') === 'true') return false;
             const style = window.getComputedStyle(element);
             const rect = element.getBoundingClientRect();
             return style.display !== 'none' && style.visibility !== 'hidden' &&
                 Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
         };
         const stopCandidates = Array.from(document.querySelectorAll(stopSelector));
         const stopButtonVisible = stopCandidates.some(isVisible);
         const primaryButton = document.querySelector('.bf38813a .ds-button--primary');
         const primaryLabel = primaryButton ? [
             primaryButton.getAttribute('aria-label') || '',
             primaryButton.getAttribute('title') || '',
             primaryButton.innerText || '',
             typeof primaryButton.className === 'string' ? primaryButton.className : '',
             Array.from(primaryButton.querySelectorAll('[aria-label],[title],svg,[class]'))
                 .map((el) => [
                     el.getAttribute('aria-label') || '',
                     el.getAttribute('title') || '',
                     typeof el.className === 'string' ? el.className : ''
                 ].join(' '))
                 .join(' ')
         ].join(' ') : '';
         const primaryIsStop = /stop|cancel|停止|取消/i.test(primaryLabel);
         const isGenerating = stopButtonVisible || primaryIsStop;
         const sendButtonEnabled = Boolean(primaryButton && !primaryIsStop &&
             !primaryButton.classList.contains('ds-button--disabled') &&
             !primaryButton.hasAttribute('disabled') &&
             primaryButton.getAttribute('aria-disabled') !== 'true');
         const completionSignalAvailable = Boolean(primaryButton &&
             (stopCandidates.length > 0 || primaryIsStop));

         const tEl = last ? last.querySelector('.ds-think-content .ds-markdown') : null;
         const aEl = last ? last.querySelector('.ds-assistant-message-main-content') : null;
         return {
             count: items.length,
             answerKey: last ? (last.getAttribute('data-virtual-list-item-key') || null) : null,
             think: tEl ? tEl.innerText : '',
             answer: aEl ? aEl.innerText : '',
             isGenerating,
             sendButtonEnabled,
             completionSignalAvailable
         };
     });
 }

 async function clickSend(isCancelled = () => false) {
     const timeoutAt = Date.now() + 15000;
     for (;;) {
         if (isCancelled()) {
             const error = new Error('The client disconnected before the request was sent.');
             error.name = 'AbortError';
             throw error;
         }

         const isEnabled = await page.evaluate(() => {
             const button = document.querySelector('.bf38813a .ds-button--primary');
             return Boolean(button &&
                 !button.classList.contains('ds-button--disabled') &&
                 !button.hasAttribute('disabled') &&
                 button.getAttribute('aria-disabled') !== 'true');
         });
         if (isEnabled) {
             if (isCancelled()) {
                 const error = new Error('The client disconnected before the request was sent.');
                 error.name = 'AbortError';
                 throw error;
             }
             await page.locator('.bf38813a .ds-button--primary').first().click();
             return;
         }

         if (Date.now() >= timeoutAt) {
             throw new Error('The DeepSeek send button did not become available within 15 seconds.');
         }
         await page.waitForTimeout(100);
     }
 }
 async function currentUrl() {
     const u = page.url();
     return u.indexOf('/a/chat/s/') >= 0 ? u : null;
 }

 async function gotoNewChat() {
     await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
     await page.waitForSelector('textarea[placeholder="Message DeepSeek"]', { timeout: 30000 });
     await page.waitForTimeout(800);
 }

 async function resumeUrl(url) {
     await page.goto(url, { waitUntil: 'domcontentloaded' });
     await page.waitForSelector('textarea[placeholder="Message DeepSeek"]', { timeout: 30000 });
     await page.waitForTimeout(1200);
     return !!(await currentUrl());
 }

 async function stopGenerationBestEffort() {
     try {
         const clicked = await page.evaluate(() => {
             const selectors = [
                 'button[aria-label*="stop" i]',
                 'button[title*="stop" i]',
                 'button[data-testid*="stop" i]',
                 '[role="button"][aria-label*="stop" i]',
                 'button[aria-label*="cancel" i]',
                 'button[title*="cancel" i]',
                 'button[aria-label*="停止"]',
                 'button[title*="停止"]',
                 '[role="button"][aria-label*="停止"]',
                 '[role="button"][aria-label*="取消"]'
             ].join(',');
             const visible = (element) => {
                 if (!element || element.getAttribute('aria-hidden') === 'true') return false;
                 const style = window.getComputedStyle(element);
                 const rect = element.getBoundingClientRect();
                 return style.display !== 'none' && style.visibility !== 'hidden' &&
                     Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
             };
             const stopButton = Array.from(document.querySelectorAll(selectors)).find(visible);
             if (stopButton) {
                 stopButton.click();
                 return true;
             }

             const primary = document.querySelector('.bf38813a .ds-button--primary');
             if (!visible(primary)) return false;
             const label = [
                 primary.getAttribute('aria-label') || '',
                 primary.getAttribute('title') || '',
                 primary.innerText || '',
                 typeof primary.className === 'string' ? primary.className : '',
                 Array.from(primary.querySelectorAll('[aria-label],[title],svg,[class]'))
                     .map((element) => [
                         element.getAttribute('aria-label') || '',
                         element.getAttribute('title') || '',
                         typeof element.className === 'string' ? element.className : ''
                     ].join(' '))
                     .join(' ')
             ].join(' ');
             if (!/stop|cancel|停止|取消/i.test(label)) return false;
             primary.click();
             return true;
         });
         if (clicked) await page.waitForTimeout(350);
     } catch (error) {
         console.warn('[turn-cancel] best-effort stop action failed: ' + (error.message || String(error)));
     }
 }

 async function runTurn(prompt, sink, bufferText, isCancelled = () => false) {
     const abortIfCancelled = async () => {
         if (!isCancelled()) return;
         await stopGenerationBestEffort();
         const error = new Error('The client disconnected before the DeepSeek turn completed.');
         error.name = 'AbortError';
         throw error;
     };
     await abortIfCancelled();
     const before = await readState();
     await abortIfCancelled();
     await textarea.click();
     await textarea.fill(prompt);
     await page.waitForTimeout(250);
     await abortIfCancelled();
     await clickSend(isCancelled);
     await abortIfCancelled();

     const parser = new StreamParser((t) => {
         if (bufferText || !sink) return;
         if (!textOpened) {
             if (thinkOpened) sink.stopBlock();
             sink.startText();
             textOpened = true;
         }
         sink.textDelta(t);
     });

     let emittedAnswer = '';
     let emittedThink = '';
     let lastChange = Date.now();
     const start = Date.now();
     let sawNewMessage = false;
     let sawResponseContent = false;
     let sawGeneratingSignal = false;
     let completionSignalStreak = 0;
     let usedStableFallback = false;
     let timedOut = false;
     let thinkOpened = false;
     let textOpened = false;

     const emitThinking = (t) => {
         if (!t || !sink) return;
         if (!thinkOpened) {
             sink.startThinking();
             thinkOpened = true;
         }
         sink.thinkingDelta(t);
     };

     for (;;) {
         await abortIfCancelled();
         await page.waitForTimeout(POLL_MS);
         await abortIfCancelled();
         let st;
         try {
             st = await readState();
         } catch (error) {
             if (isCancelled()) await abortIfCancelled();
             throw new Error('Could not read the DeepSeek UI state: ' + (error.message || String(error)));
         }
         if (st.isGenerating) sawGeneratingSignal = true;

         if (!sawNewMessage) {
             // Ignore user-message row-count changes; wait for a fresh assistant response.
             if (hasNewAssistantResponse(before, st)) {
                 sawNewMessage = true;
                 sawResponseContent = Boolean(st.answer || st.think);
                 // Start from the previous thinking baseline rather than an empty string.
                 // This prevents old thinking content from being emitted when resuming a thread.
                 const changedKey = Boolean(st.answerKey && st.answerKey !== before.answerKey);
                 emittedThink = !changedKey && before.think && st.think.startsWith(before.think) ? before.think : '';
                 emittedAnswer = '';
                 thinkOpened = false; // New thinking starts a new content block.
             }
             lastChange = Date.now();
             if (Date.now() - start > MAX_TURN_MS) {
                 timedOut = true;
                 break;
             }
             continue;
         }

         if (st.think) sawResponseContent = true;
         if (st.answer) sawResponseContent = true;

         if (st.think && st.think.length > emittedThink.length && st.think.startsWith(emittedThink)) {
             const d = st.think.slice(emittedThink.length);
             emittedThink = st.think;
             emitThinking(d);
             lastChange = Date.now();
         }

         if (st.answer && st.answer.startsWith(emittedAnswer)) {
             const stableLen = Math.max(0, st.answer.length - HOLD_CHARS);
             if (stableLen > emittedAnswer.length) {
                 const d = st.answer.slice(emittedAnswer.length, stableLen);
                 emittedAnswer = st.answer.slice(0, stableLen);
                 parser.feed(d);
                 lastChange = Date.now();
             }
         }

         if (sawNewMessage && sawResponseContent) {
             const idleMs = Date.now() - lastChange;
             const explicitCompletion = sawGeneratingSignal && isResponseComplete(st, sawGeneratingSignal);
             const inferredCompletion = isIdleCompletionCandidate(st, sawGeneratingSignal, idleMs, STABLE_MS);
             if (explicitCompletion || inferredCompletion) {
                 completionSignalStreak++;
                 if (completionSignalStreak >= 3) break;
             } else {
                 completionSignalStreak = 0;
             }

             // Without usable completion signals, wait twice the configured stable
             // interval before falling back. This reduces false completion during
             // short pauses between DeepSeek output chunks.
             if (shouldUseStableFallback(st, sawGeneratingSignal, idleMs, STABLE_MS)) {
                 usedStableFallback = true;
                 break;
             }
         }
         if (Date.now() - start > MAX_TURN_MS) {
             timedOut = true;
             break;
         }
     }

     await abortIfCancelled();
     if (timedOut) {
         throw new Error('DeepSeek did not signal completion before MAX_TURN_MS. The turn was not treated as complete.');
     }
     if (usedStableFallback) {
         console.warn('[turn-completion] explicit stop/send completion signal was not observed; used STABLE_MS fallback');
     }

     // Flush the remaining text after the UI has reported completion.
     try {
         const fin = await readState();
         if (fin.answer && fin.answer.startsWith(emittedAnswer) && fin.answer.length > emittedAnswer.length) {
             parser.feed(fin.answer.slice(emittedAnswer.length));
             emittedAnswer = fin.answer;
         }
         if (fin.think && fin.think.length > emittedThink.length && fin.think.startsWith(emittedThink)) {
             emitThinking(fin.think.slice(emittedThink.length));
             emittedThink = fin.think;
         }
     } catch (e) {}

     parser.finish();

     // Post-process: recover tool calls if the parser did not find them but the text contains markup.
     let finalTools = parser.toolCalls();
     let finalText = parser.textOut;
     if (finalTools.length === 0 && finalText) {
         const ex = extractToolCallsFromText(finalText);
         if (ex.calls.length > 0) {
             finalTools = ex.calls;
             finalText = ex.text;
         }
     }
     // A partially valid batch is still invalid: forwarding only its valid subset
     // would silently omit requested actions and could leave the client out of sync.
     const invalidToolCall = parser.sawToolMarkup &&
         (finalTools.length === 0 || parser.parseErrors.length > 0);

     // Close any live thinking/text block, but defer buffered text and every tool
     // block to the handler. It must validate the complete tool batch before emitting
     // or forwarding any part of it, otherwise a failed recovery can leak partial output.
     if (sink && (thinkOpened || textOpened)) sink.stopBlock();

     if (finalTools.length > 0) {
         console.log('[tool-parser] parsed tool call(s): ' + finalTools.map((t) => t.name).join(', '));
     } else if (invalidToolCall) {
         const detail = parser.parseErrors[0];
         console.warn('[tool-parser] TOOL_CALL markup detected, but no valid tool input parsed' +
             ' payloads=' + parser.toolBlocks.length +
             ' incomplete=' + parser.incompleteToolBlock +
             (detail ? ' chars=' + detail.chars + ' reason=' + detail.reason : ''));
         if (process.env.DEBUG_TOOL_PARSER === '1' && parser.toolBlocks[0]) {
             console.warn('[tool-parser] payload preview=' + parser.toolBlocks[0].slice(0, 240).replace(/\s+/g, ' '));
         }
     }

     return { text: finalText, thinking: emittedThink, toolCalls: finalTools, invalidToolCall };
 }

async function shutdownBrowser() {
    try { if (ctx) await ctx.close(); } catch (e) {}
    ctx = null;
    page = null;
    textarea = null;
    initPromise = null;
}

module.exports = { ensurePage, ensureTogglesOn, readState, clickSend, currentUrl, gotoNewChat, resumeUrl, runTurn, locked, shutdownBrowser };
