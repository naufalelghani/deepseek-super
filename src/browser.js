'use strict';

const { chromium } = require('playwright');
const { readStateInPage } = require('./browser-dom');
const { PROFILE_DIR, POLL_MS, STABLE_MS, MAX_TURN_MS, MAX_PENDING_TURNS } = require('./config');
const { StreamParser, extractToolCallsFromText, parseToolCallsFromText } = require('./tool-parser');
const { hasNewAssistantResponse, isResponseComplete, shouldUseStableFallback, isIdleCompletionCandidate, isComposerRestoredCompletionCandidate } = require('./turn-state');

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
                // Keep Chrome's sandbox enabled; Playwright otherwise adds --no-sandbox,
                // which weakens browser isolation and triggers Chrome's warning banner.
                chromiumSandbox: true,
                 viewport: { width: 1280, height: 900 },
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
         const els = document.querySelectorAll('[aria-pressed]');
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

     const desiredSearchOn = !toolsProvided;
     await page.evaluate((wantOn) => {
         const aria = 'aria-pressed';
         const cls = 'ds-toggle-button';
         const els = document.querySelectorAll('[aria-pressed]');
         for (let i = 0; i < els.length; i++) {
             const el = els[i];
             if (el.getAttribute(aria) === null) continue;
             if (!el.classList.contains(cls)) continue;
             const span = el.querySelector('span');
             if (!span || span.textContent.trim() !== 'Search') continue;
             const isOn = el.getAttribute(aria) === 'true';
             if (wantOn && !isOn) el.click();
             if (!wantOn && isOn) el.click();
             return true;
         }
         return false;
     }, desiredSearchOn).catch(() => false);
     await page.waitForTimeout(200);
     const verifiedSearchState = await page.evaluate(() => {
         const els = document.querySelectorAll('.ds-toggle-button[aria-pressed]');
         for (let i = 0; i < els.length; i++) {
             const span = els[i].querySelector('span');
             if (span && span.textContent.trim() === 'Search') {
                 return els[i].getAttribute('aria-pressed') === 'true';
             }
         }
         return null;
     }).catch(() => null);
     if (verifiedSearchState === null) {
         console.warn('[toggle] Could not verify DeepSeek Search toggle state; internal web tools will reject unverified Search turns.');
     } else if (verifiedSearchState !== desiredSearchOn) {
         console.warn('[toggle] DeepSeek Search toggle did not reach requested state=' + desiredSearchOn);
     }
     return verifiedSearchState;
 }

 async function readState(finalSnapshot = false) {
     return page.evaluate(readStateInPage, { final: finalSnapshot });
 }

 async function readLatestAssistantTextViaCopy(expectedText = '') {
     if (!page || page.isClosed()) return null;

     const copySelector = [
         'button[aria-label="copy" i]',
         'button[title="copy" i]',
         '[role="button"][aria-label="copy" i]',
         '[role="button"][title="copy" i]',
         'button[aria-label*="copy message" i]',
         'button[title*="copy message" i]',
         '[role="button"][aria-label*="copy message" i]',
         'button[aria-label*="copy response" i]',
         'button[title*="copy response" i]',
         '[role="button"][aria-label*="copy response" i]',
         'button[aria-label="复制"]',
         'button[title="复制"]',
         '[role="button"][aria-label="复制"]',
         '[role="button"][title="复制"]',
         '[data-testid*="copy-message" i]',
         '[data-testid*="copy-response" i]'
     ].join(',');

     const context = page.context();
     let permissionsGranted = false;
     let previousClipboard = '';
     let previousClipboardCaptured = false;
     let copyAttempted = false;
     try {
         const clipboardSupported = await page.evaluate(() =>
             Boolean(navigator.clipboard && typeof navigator.clipboard.readText === 'function'));
         if (!clipboardSupported) {
             console.warn('[tool-parser] clipboard fallback unavailable: Clipboard API is not supported by this page.');
             return null;
         }

         // Grant clipboard access only for the DeepSeek origin and only while
         // performing this recovery attempt. Never log clipboard contents.
         await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
             origin: 'https://chat.deepseek.com'
         });
         permissionsGranted = true;
         const readClipboard = () => page.evaluate(async () => navigator.clipboard.readText());
         try {
             previousClipboard = await readClipboard();
             previousClipboardCaptured = true;
         } catch (error) {
             console.warn('[tool-parser] clipboard fallback skipped: could not preserve the existing clipboard.');
             return null;
         }

         const assistantItem = page.locator(
             '[data-virtual-list-item-key]:has(.ds-assistant-message-main-content)'
         ).last();
         if (await assistantItem.count() === 0) {
             console.warn('[tool-parser] clipboard fallback unavailable: latest assistant message was not found.');
             return null;
         }

         // DeepSeek may only reveal message actions on hover.
         await assistantItem.hover({ timeout: 1500 }).catch(() => {});
         const buttons = assistantItem.locator(copySelector);
         const count = await buttons.count();
         for (let i = count - 1; i >= 0; i--) {
             const button = buttons.nth(i);
             if (!(await button.isVisible().catch(() => false))) continue;

             copyAttempted = true;
             await button.click({ timeout: 2500 });
             const deadline = Date.now() + 1200;
             let copiedText = '';
             do {
                 copiedText = await readClipboard().catch(() => '');
                 if (copiedText.trim() &&
                     (copiedText !== previousClipboard || copiedText === expectedText)) {
                     return copiedText;
                 }
                 await page.waitForTimeout(75);
             } while (Date.now() < deadline);

             console.warn('[tool-parser] clipboard fallback did not produce new text; ignoring stale clipboard contents.');
             return null;
         }

         console.warn('[tool-parser] clipboard fallback unavailable: no visible assistant Copy button matched known labels.');
         return null;
     } catch (error) {
         console.warn('[tool-parser] clipboard fallback failed: ' + (error.message || String(error)));
         return null;
     } finally {
         if (permissionsGranted && previousClipboardCaptured && copyAttempted) {
             try {
                 await page.evaluate(async (text) => navigator.clipboard.writeText(text), previousClipboard);
             } catch (error) {
                 console.warn('[tool-parser] could not restore the pre-existing clipboard contents.');
             }
         }
         if (permissionsGranted) {
             try { await context.clearPermissions(); } catch (error) {}
         }
     }
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

 async function runTurn(prompt, sink, bufferText, isCancelled = () => false, includeLinks = false) {
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
     let observedAnswer = '';
     let lastState = before;
     let emittedThink = '';
     let uiAnswerLinks = [];
     let lastChange = Date.now();
     const start = Date.now();
     let sawNewMessage = false;
     let sawResponseContent = false;
     let sawGeneratingSignal = false;
     let sawComposerUnavailableSignal = false;
     let completionSignalStreak = 0;
     let usedStableFallback = false;
     let completionSource = 'unknown';
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
         if (st.composerReady === false) sawComposerUnavailableSignal = true;
         lastState = st;

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
                 observedAnswer = st.answer || '';
                 lastState = st;
                 thinkOpened = false; // New thinking starts a new content block.
             }
             lastChange = Date.now();
             if (Date.now() - start > MAX_TURN_MS) {
                 timedOut = true;
                 break;
             }
             continue;
         }

         if (st.answer !== observedAnswer) {
             observedAnswer = st.answer || '';
             lastChange = Date.now();
         }
         if (st.think) sawResponseContent = true;
         if (st.answer) sawResponseContent = true;

         if (st.think && st.think.length > emittedThink.length && st.think.startsWith(emittedThink)) {
             const d = st.think.slice(emittedThink.length);
             emittedThink = st.think;
             emitThinking(d);
             lastChange = Date.now();
         }

         // Preserve rendered Markdown by streaming only complete DOM blocks.
         // Buffered turns are parsed once at completion, preserving tool-call payloads.
         const stableMarkdown = typeof st.answerMarkdownStable === 'string' ? st.answerMarkdownStable : '';
         if (!bufferText && stableMarkdown.startsWith(emittedAnswer) && stableMarkdown.length > emittedAnswer.length) {
             parser.feed(stableMarkdown.slice(emittedAnswer.length));
             emittedAnswer = stableMarkdown;
             lastChange = Date.now();
         }

         if (sawNewMessage && sawResponseContent) {
             const idleMs = Date.now() - lastChange;
             const explicitCompletion = sawGeneratingSignal && isResponseComplete(st, sawGeneratingSignal);
             const inferredCompletion = isIdleCompletionCandidate(st, sawGeneratingSignal, idleMs, STABLE_MS);
             // DeepSeek may temporarily remove the composer while generating. Its
             // restoration plus a stable answer is a useful completion signal even
             // when the empty input keeps the Send button disabled.
             const composerRestoredCompletion = isComposerRestoredCompletionCandidate(
                 st, sawComposerUnavailableSignal, idleMs, STABLE_MS
             );
             if (explicitCompletion || inferredCompletion || composerRestoredCompletion) {
                 completionSignalStreak++;
                 if (completionSignalStreak >= 3) {
                     completionSource = explicitCompletion ? 'ui_explicit' :
                         composerRestoredCompletion ? 'ui_composer_restored' : 'ui_idle_inferred';
                     break;
                 }
             } else {
                 completionSignalStreak = 0;
             }

             // Without usable completion signals, wait twice the configured stable
             // interval before falling back. This reduces false completion during
             // short pauses between DeepSeek output chunks.
             if (shouldUseStableFallback(st, sawGeneratingSignal, idleMs, STABLE_MS)) {
                 console.warn('[turn-completion-debug]', JSON.stringify({
                     sawGeneratingSignal,
                     isGenerating: st.isGenerating,
                     sendButtonEnabled: st.sendButtonEnabled,
                     completionSignalAvailable: st.completionSignalAvailable,
                     uiState: st.completionDebug || null,
                     sawComposerUnavailableSignal,
                     composerReady: st.composerReady === true,
                     idleMs,
                     stableMs: STABLE_MS,
                     answerChars: (st.answer || '').length
                 }));
                 usedStableFallback = true;
                 completionSource = 'stable_fallback';
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
     console.info('[turn-completion-result]', JSON.stringify({
         source: completionSource,
         sawGeneratingSignal,
         sawComposerUnavailableSignal,
         composerReady: Boolean(lastState && lastState.composerReady === true),
         idleMs: Date.now() - lastChange,
         stableMs: STABLE_MS,
         answerChars: (lastState && lastState.answer ? lastState.answer : '').length
     }));

     // Final DOM snapshot closes the trailing Markdown block and captures web sources.
     let fin = lastState;
     try {
         fin = await readState(true);
         if (includeLinks && Array.isArray(fin.answerLinks)) uiAnswerLinks = fin.answerLinks;
     } catch (error) {
         console.warn('[markdown] final DOM snapshot failed; using last observed snapshot: ' + (error.message || String(error)));
     }
     let finalAnswer = fin.answerMarkdown || fin.answer || '';
     if (bufferText && fin.answerIsProtocol && fin.answerHasRichMarkdown) {
         const copiedSource = await readLatestAssistantTextViaCopy(finalAnswer);
         const hasToolProtocol = typeof copiedSource === 'string' &&
             /<\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls|invoke|parameter)\b/i.test(copiedSource);
         if (hasToolProtocol) {
             finalAnswer = copiedSource;
             console.info('[markdown] using assistant Copy source for mixed DSML/Markdown; chars=' + finalAnswer.length);
         } else {
             console.warn('[markdown] Copy source unavailable for mixed DSML/Markdown; using DOM serialization fallback.');
         }
     }
     if (bufferText) {
         // Do not rewrite tool-call protocol output; the parser handles the full payload.
         if (finalAnswer) parser.feed(finalAnswer);
         emittedAnswer = finalAnswer;
     } else if (finalAnswer.startsWith(emittedAnswer)) {
         const remaining = finalAnswer.slice(emittedAnswer.length);
         if (remaining) parser.feed(remaining);
         emittedAnswer = finalAnswer;
     } else if (!emittedAnswer) {
         if (finalAnswer) parser.feed(finalAnswer);
         emittedAnswer = finalAnswer;
     } else {
         console.warn('[markdown] final Markdown differed from the emitted stable prefix.');
     }
     if (fin.think && fin.think.length > emittedThink.length && fin.think.startsWith(emittedThink)) {
         emitThinking(fin.think.slice(emittedThink.length));
         emittedThink = fin.think;
     }

     parser.finish();

     // Post-process: recover tool calls if the parser did not find them but the text contains markup.
     const rawFinalText = parser.textOut;
     const sawDsmlMarkup = /<\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls|invoke|parameter)\b/i.test(rawFinalText);
     let finalTools = parser.toolCalls();
     let finalText = parser.textOut;
     let extractionErrors = [];
     if (finalTools.length === 0 && (finalText || sawDsmlMarkup)) {
         // Use the original text for malformed/naked DSML blocks: toolCalls() scrubs
         // orphan protocol tags from user-facing text after its primary parse pass.
         const extractionSource = sawDsmlMarkup ? rawFinalText : finalText;
         const ex = extractToolCallsFromText(extractionSource);
         if (ex.calls.length > 0) finalTools = ex.calls;
         finalText = ex.text;
         extractionErrors = Array.isArray(ex.errors) ? ex.errors : [];
     }
     // A partially valid batch is still invalid: forwarding only its valid subset
     // would silently omit requested actions and could leave the client out of sync.
     let invalidToolCall = (parser.sawToolMarkup &&
         (finalTools.length === 0 || parser.parseErrors.length > 0)) ||
         (sawDsmlMarkup && (finalTools.length === 0 || parser.parseErrors.length > 0 || extractionErrors.length > 0));

     // DOM remains the primary source. Only when its DSML parse is invalid do
     // we click Copy on the latest assistant message and try parsing that text
     // with a fresh parser, preventing state from the failed parse from leaking.
     if (invalidToolCall) {
         console.warn('[tool-parser] DOM parsing failed; attempting assistant Copy fallback.');
         const copiedText = await readLatestAssistantTextViaCopy(finalAnswer);
         if (copiedText) {
             const copied = parseToolCallsFromText(copiedText);
             if (!copied.invalidToolCall && copied.calls.length > 0) {
                 finalTools = copied.calls;
                 finalText = copied.text;
                 extractionErrors = [];
                 invalidToolCall = false;
                 console.info('[tool-parser] recovered via assistant Copy; tool_calls=' + finalTools.length +
                     ' copied_chars=' + copiedText.length);
             } else {
                 console.warn('[tool-parser] assistant Copy fallback did not produce a complete valid DSML parse; ' +
                     'tool_calls=' + copied.calls.length +
                     ' parse_errors=' + copied.parseErrors.length +
                     ' extraction_errors=' + copied.extractionErrors.length);
             }
         }
     }

     // Close any live thinking/text block, but defer buffered text and every tool
     // block to the handler. It must validate the complete tool batch before emitting
     // or forwarding any part of it, otherwise a failed recovery can leak partial output.
     if (sink && (thinkOpened || textOpened)) sink.stopBlock();

     if (includeLinks && finalTools.length === 0 && uiAnswerLinks.length > 0) {
         const seenLinks = new Set();
         const uniqueLinks = uiAnswerLinks.filter((link) => {
             const url = typeof link.url === 'string' ? link.url.trim() : '';
             if (!/^https?:\/\//i.test(url) || seenLinks.has(url)) return false;
             seenLinks.add(url);
             return true;
         }).slice(0, 20).map((link) => {
             const url = link.url.trim();
             const label = typeof link.text === 'string' && link.text ? link.text : url;
             return '- ' + label + ': ' + url;
         });
         if (uniqueLinks.length > 0) {
             finalText = [finalText, 'Links surfaced by the DeepSeek UI:\n' + uniqueLinks.join('\n')].filter(Boolean).join('\n\n');
         }
     }

     if (finalTools.length > 0) {
         console.log('[tool-parser] parsed tool call(s): ' + finalTools.map((t) => t.name).join(', '));
     } else if (invalidToolCall) {
         const detail = parser.parseErrors[0];
         console.warn('[tool-parser] tool-call markup detected, but no valid tool input parsed' +
             ' disallowed_legacy_payloads=' + parser.disallowedLegacyBlocks.length +
             ' dsml_payloads=' + parser.dsmlToolBlocks.length +
             ' incomplete=' + parser.incompleteToolBlock +
             (detail ? ' chars=' + detail.chars + ' reason=' + detail.reason : '') +
             (extractionErrors.length ? ' extraction_errors=' + extractionErrors.join('; ') : ''));
         const debugPayload = parser.dsmlToolBlocks[0] || parser.disallowedLegacyBlocks[0];
         if (process.env.DEBUG_TOOL_PARSER === '1' && debugPayload) {
             console.warn('[tool-parser] payload preview=' + debugPayload.slice(0, 240).replace(/\s+/g, ' '));
         }
     }

     if (includeLinks) {
         const textURLCount = (finalText.match(/https?:\/\/[^\s<>"'`)\]]+/gi) || []).length;
         console.log('[web-turn] captured_ui_links=' + uiAnswerLinks.length +
             ' visible_text_urls=' + textURLCount +
             ' answer_chars=' + finalText.length);
     }
     return { text: finalText, thinking: emittedThink, toolCalls: finalTools, invalidToolCall, sourceLinks: includeLinks ? uiAnswerLinks : [], completionSource };
 }

/**
 * Run a native DeepSeek Search turn in a clean chat.
 *
 * The main gateway prompt includes the client tool schemas and DSML instructions.
 * Reusing that thread for an internal Search turn can make DeepSeek emit another
 * gateway tool call instead of using the Search mode toggle. Keep internal Search
 * turns isolated, then return to the original conversation before the model resumes.
 */
async function runIsolatedTurn(prompt, sink, bufferText, isCancelled = () => false, includeLinks = false) {
    await ensurePage();
    const originalUrl = await currentUrl();
    if (!originalUrl) {
        throw new Error('Cannot isolate a DeepSeek Search turn because the original conversation URL is unavailable.');
    }

    let operationError = null;
    try {
        await gotoNewChat();
        const newChatUrl = await currentUrl();
        if (newChatUrl && newChatUrl === originalUrl) {
            throw new Error('DeepSeek stayed on the original chat; refusing to send an internal Search prompt into the user conversation.');
        }
        const searchState = await ensureTogglesOn(false);
        if (searchState !== true) {
            throw new Error('Could not verify that DeepSeek Search mode is enabled in the isolated chat.');
        }
        const output = await runTurn(prompt, sink, bufferText, isCancelled, includeLinks);
        // A new DeepSeek chat may not receive its /a/chat/s/<id> URL until the
        // first message is submitted, so check isolation after the turn completes.
        const isolatedUrl = await currentUrl();
        if (!isolatedUrl || isolatedUrl === originalUrl) {
            throw new Error('DeepSeek did not use a distinct temporary chat for the isolated Search turn.');
        }
        console.log('[web-isolation] original_chat_changed=true');
        return output;
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        try {
            const restored = await resumeUrl(originalUrl);
            if (!restored) {
                throw new Error('The original DeepSeek conversation could not be restored after an isolated Search turn.');
            }
            const searchState = await ensureTogglesOn(true);
            if (searchState !== false) {
                throw new Error('Could not verify that DeepSeek Search mode is disabled after restoring the original conversation.');
            }
        } catch (restoreError) {
            if (operationError) {
                console.warn('[web-isolation] failed to fully restore the original DeepSeek chat: ' +
                    (restoreError.message || String(restoreError)));
            } else {
                throw restoreError;
            }
        }
    }
}

async function shutdownBrowser() {
    try { if (ctx) await ctx.close(); } catch (e) {}
    ctx = null;
    page = null;
    textarea = null;
    initPromise = null;
}

module.exports = { ensurePage, ensureTogglesOn, readState, clickSend, currentUrl, gotoNewChat, resumeUrl, runTurn, runIsolatedTurn, locked, shutdownBrowser };
