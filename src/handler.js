'use strict';

const { approxTokens, MODEL_NAME, sha, uuid } = require('./config');
const { blocksOf, sessionKey, renderMessage, truncateReplay } = require('./content');
const { buildFullPrompt, buildResumePrompt, parseToolChoice, applyForcedTool, synthesizeToolCall } = require('./prompts');
const { ensurePage, ensureTogglesOn, resumeUrl, gotoNewChat, runTurn, currentUrl, locked } = require('./browser');
const { getSession, setSession } = require('./session-store');
const { StreamSink } = require('./sse-sink');
const { jsonError } = require('./http-utils');

function detectToolLoop(messages, threshold = 3) {
  if (messages.length < threshold * 2 + 1) return false;
  const signatures = [];
  for (const message of messages) {
    for (const block of blocksOf(message.content)) {
      if (block.type === 'tool_use') {
        signatures.push(block.name + '|' + JSON.stringify(block.input || {}));
      }
    }
  }
  const tail = signatures.slice(-threshold);
  return tail.length >= threshold && tail.every((signature) => signature === tail[0]);
}

function isConversationTooLong(messages) {
  return messages.length >= 13;
}

async function handleMessages(req, res, body) {
  console.error('[REQ] model=' + (body.model || '?') +
    ' tools=' + (Array.isArray(body.tools) ? body.tools.length : 0) +
    ' msgs=' + (Array.isArray(body.messages) ? body.messages.length : 0));

  const system = body.system || '';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const wantStream = body.stream === true;
  const model = body.model || MODEL_NAME;

  if (messages.length === 0) {
    return jsonError(res, 400, 'invalid_request_error', 'messages kosong');
  }

  const last = messages[messages.length - 1];
  const lastHasToolResult = blocksOf(last.content).some((block) => block.type === 'tool_result');
  let force = lastHasToolResult ? { mode: 'none' } : parseToolChoice(body.tool_choice);

  if (detectToolLoop(messages, 3)) {
    console.warn('[loop-detect] 3 tool_use identik — paksa text, stop tool');
    force = { mode: 'none' };
  }
  if (isConversationTooLong(messages)) {
    console.warn('[long-conv] messages=' + messages.length + ' — paksa text');
    force = { mode: 'none' };
  }

  const key = sessionKey(system, messages);
  const cached = getSession(key);
  await ensurePage();

  let answer, thinking, toolCalls;
  const sink = wantStream ? new StreamSink(res, model, approxTokens(JSON.stringify(messages))) : null;

  await locked(async () => {
    await ensurePage();
    await ensureTogglesOn(tools.length > 0);

    let resumed = false;
    if (cached && messages.length > 1 && !lastHasToolResult) {
      try {
        resumed = await resumeUrl(cached.url);
      } catch {
        resumed = false;
      }
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

    const hasRawToolCall = out.invalidToolCall || (answer || '').toLowerCase().includes('<tool_call>');
    if (hasRawToolCall && toolCalls.length === 0 && tools.length > 0) {
      console.warn('[retry] JSON tool-call tidak valid; kirim instruksi koreksi setelah prompt asli');
      const retryPrompt = [
        '=== RETRY FORMAT CORRECTION ===',
        'Jawaban sebelumnya berisi tool call yang JSON-nya tidak valid. Jangan salin payload yang rusak.',
        'Gunakan tugas asli, riwayat, daftar tool, dan schema dari konteks percakapan yang sudah ada.',
        'Susun ulang pemanggilan tool dari nol dengan nama dan argumen yang sesuai tugas asli.',
        'Keluarkan tepat satu blok tool-call dengan JSON valid dan tanpa teks atau Markdown di luarnya.',
        'Contoh format valid (hanya contoh format, bukan instruksi untuk menjalankan pwd):',
        '<TOOL_CALL>{"tool":"Bash","arguments":{"command":"pwd"}}</TOOL_CALL>',
        'Gunakan key dan string bertanda kutip ganda, tanpa trailing comma atau komentar. Escape tanda kutip di dalam nilai string sesuai aturan JSON.',
        'Penting: instruksi koreksi ini menggantikan instruksi format sebelumnya.'
      ].join('\\n');
      // Gunakan dummy sink agar output percobaan retry tidak terduplikasi di SSE.
      const retry = await runTurn(retryPrompt, dummySink, useBuffer);
      answer = retry.text;
      thinking = retry.thinking;
      toolCalls = retry.toolCalls;
      if (toolCalls.length > 0) {
        console.log('[retry] berhasil — ' + toolCalls.length + ' tool call valid');
        if (sink) {
          for (const tool of toolCalls) sink.toolBlock(tool.name, tool.input);
        }
      } else {
        console.warn('[retry] gagal; fallback ke teks');
        answer = answer || 'DeepSeek gagal menghasilkan tool call dengan JSON valid setelah percobaan koreksi. Silakan ulangi permintaan.';
        if (sink) sink.emitText(answer);
      }
    }

    if (force.mode !== 'auto' && force.mode !== 'none' && toolCalls.length === 0) {
      const synthesized = synthesizeToolCall(force, tools);
      if (synthesized) {
        console.warn('[force-tool] synthesize:', synthesized.name, JSON.stringify(synthesized.input));
        toolCalls = [synthesized];
        if (sink) sink.toolBlock(synthesized.name, synthesized.input);
      }
    }

    const url = await currentUrl();
    if (url) setSession(key, url);
  });

  const stopReason = toolCalls.length ? 'tool_use' : 'end_turn';
  console.log('[response] stop_reason=' + stopReason + ' tool_calls=' + toolCalls.length + ' stream=' + wantStream);
  if (wantStream) {
    sink.finish(stopReason);
    return res.end();
  }

  const content = [];
  if (thinking) {
    content.push({ type: 'thinking', thinking, signature: 'sig_' + sha(thinking).slice(0, 16) });
  }
  if (answer) content.push({ type: 'text', text: answer });
  for (const tool of toolCalls) {
    content.push({ type: 'tool_use', id: uuid('toolu'), name: tool.name, input: tool.input || {} });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });

  const payload = {
    id: uuid('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
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
