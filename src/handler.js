'use strict';

const { approxTokens, MODEL_NAME, sha, uuid } = require('./config');
const { blocksOf, flattenContent, sessionKey, renderMessage, truncateReplay } = require('./content');
const { buildFullPrompt, buildResumePrompt, parseToolChoice, applyForcedTool, synthesizeToolCall } = require('./prompts');
const { ensurePage, ensureTogglesOn, resumeUrl, gotoNewChat, runTurn, currentUrl, locked } = require('./browser');
const { getSession, setSession } = require('./session-store');
const { StreamSink } = require('./sse-sink');
const { jsonError } = require('./http-utils');

 function detectToolLoop(messages, threshold) {
     threshold = threshold || 3;
     if (messages.length < threshold * 2 + 1) return false;
     const toolSigs = [];
     for (const m of messages) {
         for (const b of blocksOf(m.content)) {
             if (b.type === 'tool_use') {
                 toolSigs.push(b.name + '|' + JSON.stringify(b.input || {}));
             }
         }
     }
     if (toolSigs.length < threshold) return false;
     const tail = toolSigs.slice(-threshold);
     return tail.every((s) => s === tail[0]);
 }

 // Deteksi: conversation terlalu panjang untuk chat web
 function isConversationTooLong(messages) {
     // Web UI DeepSeek mulai tidak akurat setelah ~15 messages
     return messages.length >= 13;
 }
 async function handleMessages(req, res, body) {
     console.error('[REQ] model=' + (body.model || '?') +
         ' tools=' + (body.tools ? body.tools.length : 0) +
         ' msgs=' + (body.messages ? body.messages.length : 0));
     const system = body.system || '';
     const messages = Array.isArray(body.messages) ? body.messages : [];
     const tools = Array.isArray(body.tools) ? body.tools : [];
     const wantStream = body.stream === true;
     const model = body.model || MODEL_NAME;

     if (!messages.length) {
         return jsonError(res, 400, 'invalid_request_error', 'messages kosong');
     }

     const last = messages[messages.length - 1];
     const lastHasToolResult = blocksOf(last.content).some((b) => b.type === 'tool_result');
     // Kalau turn ini adalah tool_result, paksa model TIDAK boleh panggil tool
     let force = lastHasToolResult ? { mode: 'none' } :
         parseToolChoice(body.tool_choice);

     // === LOOP DETECTION ===
     if (detectToolLoop(messages, 3)) {
         console.warn('[loop-detect] 3 tool_use identik — paksa text, stop tool');
         force = { mode: 'none' };
     }

     // === HARD LIMIT: conversation terlalu panjang ===
     if (isConversationTooLong(messages)) {
         console.warn('[long-conv] messages=' + messages.length + ' — paksa text');
         force = { mode: 'none' };
     }

     const key = sessionKey(system, messages);
     const cached = getSession(key);

     await ensurePage();

     let answer, thinking, toolCalls;
     const sink = wantStream ?
         new StreamSink(res, model, approxTokens(JSON.stringify(messages))) :
         null;

     await locked(async() => {
         await ensurePage();
         await ensureTogglesOn(tools.length > 0);

         let resumed = false;
         // Resume hanya jika:
         //   - bukan turn pertama (messages > 1)
         //   - bukan tool_result turn (DeepSeek bingung kalau resume, malah repeat tool call)
         // Tool_result turn SELALU start fresh chat dengan history replay penuh.
         if (cached && messages.length > 1 && !lastHasToolResult) {
             try { resumed = await resumeUrl(cached.url); } catch (e) { resumed = false; }
         }

         let prompt;
         if (resumed) {
             prompt = buildResumePrompt(system, messages, tools, lastHasToolResult);
         } else {
             await gotoNewChat();
             prompt = truncateReplay(buildFullPrompt(system, messages, tools));
         }
         prompt = applyForcedTool(prompt, force);

         const dummySink = {
             startThinking() {},
             thinkingDelta() {},
             startText() {},
             textDelta() {},
             emitText() {},
             stopBlock() {},
             toolBlock() {},
         };
         const useBuffer = tools.length > 0;
         const out = await runTurn(prompt, sink || dummySink, useBuffer);

         answer = out.text;
         thinking = out.thinking;
         toolCalls = out.toolCalls;

         // Detect: model coba panggil tool tapi JSON invalid → retry sekali
         const hasRawToolCall = /<\s*TOOL_CALL\s*>/i.test(answer || '');
         if (hasRawToolCall && toolCalls.length === 0 && tools.length > 0) {
             console.warn('[retry] tool call invalid JSON — retry sekali dengan instruksi lebih tegas');
             const retryPrompt = [
                 '=== PERINGATAN KRITIS ===',
                 'Percobaan sebelumnya GAGAL karena JSON tidak valid:',
                 '  Ada tanda kutip ganda (") di dalam nilai string yang TIDAK di-escape.',
                 '',
                 'ATURAN RETRY:',
                 '- Setiap " di dalam nilai string HARUS di-escape sebagai \\"',
                 '- Contoh BENAR: {"tool":"Bash","arguments":{"command":"cd \\"C:/path\\" && ls"}}',
                 '- Contoh SALAH: {"tool":"Bash","arguments":{"command":"cd "C:/path" && ls"}}',
                 '',
                 'Emit ulang tool call untuk task yang SAMA dengan JSON yang valid.',
                 '',
                 prompt,
             ].join('\n');

             const retry = await runTurn(retryPrompt, sink || dummySink, useBuffer);
             if (retry.toolCalls.length > 0) {
                 console.log('[retry] berhasil — ' + retry.toolCalls.length + ' tool call valid');
                 answer = retry.text;
                 thinking = retry.thinking;
                 toolCalls = retry.toolCalls;
             } else {
                 console.warn('[retry] gagal juga — fallback ke teks');
             }
         }

         // Fallback synthesize kalau tool_choice memaksa tapi DeepSeek tidak panggil tool
         if (force.mode !== 'auto' && force.mode !== 'none' && toolCalls.length === 0) {
             const synth = synthesizeToolCall(force, tools);
             if (synth) {
                 console.warn('[force-tool] synthesize:', synth.name, JSON.stringify(synth.input));
                 toolCalls = [synth];
                 if (sink) sink.toolBlock(synth.name, synth.input);
             }
         }

         const url = await currentUrl();
         if (url) setSession(key, url);
     });

     const stopReason = toolCalls.length ? 'tool_use' : 'end_turn';

     if (wantStream) {
         sink.finish(stopReason);
         return res.end();
     }

     // ---- Non-streaming ----
     const content = [];
     if (thinking) content.push({ type: 'thinking', thinking, signature: 'sig_' + sha(thinking).slice(0, 16) });
     if (answer) content.push({ type: 'text', text: answer });
     for (const t of toolCalls) {
         content.push({ type: 'tool_use', id: uuid('toolu'), name: t.name, input: t.input || {} });
     }
     if (!content.length) content.push({ type: 'text', text: '' });

     const payload = {
         id: uuid('msg'),
         type: 'message',
         role: 'assistant',
         model,
         content,
         stop_reason: stopReasom,
         stop_sequence: null,
         usage: {
             input_tokens: approxTokens(JSON.stringify(messages)),
             output_tokens: approxTokens(answer || JSON.stringify(toolCalls)),
         },
     };
     res.writeHead(200, { 'Content-Type': 'application/json' });
     res.end(JSON.stringify(payload));
 }

module.exports = { handleMessages, detectToolLoop, isConversationTooLong };
