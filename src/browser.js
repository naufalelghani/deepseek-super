'use strict';

const { chromium } = require('playwright');
const { PROFILE_DIR, POLL_MS, STABLE_MS, MAX_TURN_MS, HOLD_CHARS } = require('./config');
const { StreamParser, extractToolCallsFromText } = require('./tool-parser');
const { hasNewAssistantResponse } = require('./turn-state');

 let ctx = null;
 let page = null;
 let textarea = null;
 let initPromise = null;
 let chain = Promise.resolve();

 function locked(fn) {
     const run = chain.then(fn, fn);
     chain = run.then(() => {}, () => {});
     return run;
 }

 async function ensurePage() {
     if (page) return;
     if (!initPromise) {
         initPromise = (async() => {
             ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
                 headless: false,
                 channel: 'chrome',
                 viewport: { width: 1280, height: 900 },
                 args: ['--disable-blink-features=AutomationControlled'],
                 ignoreDefaultArgs: ['--enable-automation'],
             });
             page = ctx.pages()[0] || (await ctx.newPage());
             await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
             textarea = page.locator('textarea[placeholder="Message DeepSeek"]');
             await textarea.waitFor({ state: 'visible', timeout: 60000 });
         })();
     }
     await initPromise;
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
         if (!last) return { count: items.length, answerKey: null, think: '', answer: '' };
         const tEl = last.querySelector('.ds-think-content .ds-markdown');
         const aEl = last.querySelector('.ds-assistant-message-main-content');
         return {
             count: items.length,
             answerKey: last.getAttribute('data-virtual-list-item-key') || null,
             think: tEl ? tEl.innerText : '',
             answer: aEl ? aEl.innerText : '',
         };
     });
 }

 async function clickSend() {
     await page.waitForFunction(() => {
         const b = document.querySelector('.bf38813a .ds-button--primary');
         return b && !b.classList.contains('ds-button--disabled');
     }, null, { timeout: 15000 }).catch(() => {});
     await page.locator('.bf38813a .ds-button--primary').first().click();
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

 async function runTurn(prompt, sink, bufferText) {
     const before = await readState();
     await textarea.click();
     await textarea.fill(prompt);
     await page.waitForTimeout(250);
     await clickSend();

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
         await page.waitForTimeout(POLL_MS);
         let st;
         try { st = await readState(); } catch (e) { break; }

         if (!sawNewMessage) {
             // Ignore user-message row-count changes; wait for a fresh assistant response.
             if (hasNewAssistantResponse(before, st)) {
                 sawNewMessage = true;
                 sawResponseContent = Boolean(st.answer || st.think);
                 // Mulai dari baseline thinking — bukan string kosong
                 // Ini mencegah emit thinking LAMA saat resume thread
                 emittedThink = before.think || '';
                 emittedAnswer = '';
                 thinkOpened = false; // thinking baru = blok baru
             }
             lastChange = Date.now();
             if (Date.now() - start > MAX_TURN_MS) break;
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

         if (sawNewMessage && sawResponseContent && Date.now() - lastChange > STABLE_MS) break;
         if (Date.now() - start > MAX_TURN_MS) break;
     }

     // Flush sisa
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

     // Post-process: kalau parser tidak menemukan tool tapi teks mengandungnya
     let finalTools = parser.toolCalls();
     let finalText = parser.textOut;
     const invalidToolCall = parser.sawToolMarkup && finalTools.length === 0;
     if (finalTools.length === 0 && finalText) {
         const ex = extractToolCallsFromText(finalText);
         if (ex.calls.length > 0) {
             finalTools = ex.calls;
             finalText = ex.text;
         }
     }

     // Emit ke sink
     if (sink) {
         if (thinkOpened || textOpened) sink.stopBlock();
         // Buffer until parsing completes when tools are available. Do not leak malformed
         // tool-call payloads as assistant text while the handler is preparing a retry.
         if (bufferText && finalText && !invalidToolCall) {
             sink.emitText(finalText);
         }
         for (const t of finalTools) sink.toolBlock(t.name, t.input);
     }

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
