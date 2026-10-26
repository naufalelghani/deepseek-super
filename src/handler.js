'use strict';

const { MODEL_NAME, MAX_REPLAY, sha, uuid } = require('./config');
const { blocksOf, sessionKey, renderMessage, truncateReplay } = require('./content');
const { buildFullPrompt, buildResumePrompt, parseToolChoice, applyForcedTool } = require('./prompts');
const { createToolCallRecoveryError } = require('./tool-recovery');
const { ensurePage, ensureTogglesOn, resumeUrl, gotoNewChat, runTurn, currentUrl, locked } = require('./browser');
const { getSession, setSession } = require('./session-store');
const { StreamSink } = require('./sse-sink');
const { jsonError } = require('./http-utils');
const { estimateInputTokens, estimateOutputTokens } = require('./anthropic-contract');

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

const MAX_CONVERSATION_MESSAGES = 41;

function isConversationTooLong(messages) {
  return messages.length >= MAX_CONVERSATION_MESSAGES;
}

// Reuse the saved DeepSeek thread for every continuation, including tool_result
// turns. A tool result is a continuation of the same assistant turn, not a new chat.
function shouldResumeSession(cached, messages) {
  return Boolean(cached && Array.isArray(messages) && messages.length > 1);
}

async function handleMessages(req, res, body) {
  let clientDisconnected = false;
  const onResponseClose = () => {
    if (!res.writableEnded) clientDisconnected = true;
  };
  res.once('close', onResponseClose);
  const isCancelled = () => clientDisconnected || req.aborted || res.destroyed;
  const abortIfCancelled = () => {
    if (!isCancelled()) return;
    const error = new Error('The client disconnected before the DeepSeek turn completed.');
    error.name = 'AbortError';
    throw error;
  };

  console.error('[REQ] model=' + (body.model || '?') +
    ' tools=' + (Array.isArray(body.tools) ? body.tools.length : 0) +
    ' msgs=' + (Array.isArray(body.messages) ? body.messages.length : 0));

  const system = body.system || '';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const wantStream = body.stream === true;
  const model = body.model || MODEL_NAME;

  if (messages.length === 0) {
    return jsonError(res, 400, 'invalid_request_error', 'The messages array must not be empty.');
  }

  const last = messages[messages.length - 1];
  const lastHasToolResult = blocksOf(last.content).some((block) => block.type === 'tool_result');
  // Respect the caller's tool_choice after tool results too; the model may need another tool step.
  let force = parseToolChoice(body.tool_choice);

  if (detectToolLoop(messages, 3)) {
    console.warn('[loop-detect] three identical tool calls detected; forcing a text response');
    force = { mode: 'none' };
  }
  if (isConversationTooLong(messages)) {
    console.warn('[long-conv] message_count=' + messages.length + '; forcing a text response');
    force = { mode: 'none' };
  }

  const key = sessionKey(system, messages);
  if (isCancelled()) return;
  await ensurePage();
  if (isCancelled()) return;

  let answer, thinking, toolCalls;
  const sink = wantStream ? new StreamSink(res, model, estimateInputTokens(body)) : null;

  await locked(async () => {
    abortIfCancelled();
    await ensurePage();
    abortIfCancelled();
    await ensureTogglesOn(tools.length > 0);
    abortIfCancelled();

    // Resolve the latest cached URL inside the browser lock. A preceding
    // queued request may have created or updated this conversation's URL.
    const cached = getSession(key);
    abortIfCancelled();

    let resumed = false;
    if (shouldResumeSession(cached, messages)) {
      try {
        resumed = await resumeUrl(cached.url);
      } catch (error) {
        console.warn('[session] failed to resume cached conversation:', error.message || String(error));
      }
      if (resumed) {
        console.log('[session] resumed cached conversation; tool_result=' + lastHasToolResult);
      }
    }

    let prompt;
    if (resumed) {
      prompt = buildResumePrompt(system, messages, tools, lastHasToolResult);
    } else {
      if (cached) {
        console.warn('[session] cached conversation unavailable; creating a new conversation');
      }
      await gotoNewChat();
      const untruncatedPrompt = buildFullPrompt(system, messages, tools);
      if (untruncatedPrompt.length > MAX_REPLAY) {
        console.warn('[prompt-truncate] input_chars=' + untruncatedPrompt.length +
          ' cap_chars=' + MAX_REPLAY +
          ' omitted_chars=' + (untruncatedPrompt.length - MAX_REPLAY) +
          '; the replay includes an explicit warning marker');
      }
      prompt = truncateReplay(untruncatedPrompt);
    }
    prompt = applyForcedTool(prompt, force);
    abortIfCancelled();

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
    const out = await runTurn(prompt, sink || dummySink, useBuffer, isCancelled);
    abortIfCancelled();
    answer = out.text;
    thinking = out.thinking;
    toolCalls = out.toolCalls;

    const hasRawToolCall = out.invalidToolCall || (answer || '').toLowerCase().includes('<tool_call>');
    if (hasRawToolCall && toolCalls.length === 0) {
      if (tools.length === 0) {
        throw createToolCallRecoveryError(
          'DeepSeek emitted malformed tool-call markup, but this request did not provide any tools.',
          0
        );
      }

      const maxRetries = 2;
      let recoveredByRetry = false;
      for (let attempt = 1; attempt <= maxRetries && toolCalls.length === 0; attempt++) {
        console.warn('[retry] attempt=' + attempt + '/' + maxRetries + ' — correcting malformed tool-call output');
        const retryPrompt = [
          '=== RETRY FORMAT CORRECTION ===',
          'The previous response contained a malformed tool-call JSON payload. Do not copy the malformed payload.',
          'Use the original task, conversation history, available tool list, and schemas already present in the conversation.',
          'Rebuild the tool call from scratch using the tool name and arguments required by the original task.',
          'Output exactly one tool-call block with valid JSON and no text or Markdown outside it.',
          'Valid format example only; this is not an instruction to execute pwd:',
          '<TOOL_CALL>{"tool":"Bash","arguments":{"command":"pwd"}}</TOOL_CALL>',
          'Use double-quoted JSON keys and strings, with no trailing commas or comments. Escape quotes inside strings using standard JSON rules.',
          attempt === 1
            ? 'Correct the format only; preserve the intent and arguments of the original task.'
            : 'Final recovery attempt: do not copy the previous output. Rebuild the simplest arguments that still complete the original task.'
        ].join('\\n');
        // Use a dummy sink so failed retry output is not leaked or duplicated in the SSE stream.
        const retry = await runTurn(retryPrompt, dummySink, useBuffer, isCancelled);
        abortIfCancelled();
        answer = retry.text;
        thinking = retry.thinking;
        toolCalls = retry.toolCalls;
        if (toolCalls.length > 0) {
          recoveredByRetry = true;
          console.log('[retry] recovered on attempt ' + attempt + ' — valid tool calls=' + toolCalls.length);
        } else {
          console.warn('[retry] attempt ' + attempt + ' did not produce a valid tool call');
        }
      }
      if (recoveredByRetry && sink) {
        for (const tool of toolCalls) sink.toolBlock(tool.name, tool.input);
      } else if (!recoveredByRetry) {
        console.error('[retry] exhausted; returning an explicit gateway error instead of a false end_turn');
        throw createToolCallRecoveryError(
          'DeepSeek could not produce valid tool-call JSON after ' + maxRetries + ' recovery attempts. Retry the request or simplify the tool arguments.',
          maxRetries
        );
      }
    }

    if (force.mode !== 'auto' && force.mode !== 'none' && toolCalls.length === 0) {
      throw createToolCallRecoveryError(
        'DeepSeek did not return the tool call required by tool_choice=' + force.mode + '.',
        0
      );
    }

    const declaredToolNames = new Set(tools.map((tool) => tool.name));
    const undeclaredTool = toolCalls.find((tool) => !declaredToolNames.has(tool.name));
    if (undeclaredTool) {
      throw createToolCallRecoveryError(
        'DeepSeek returned an undeclared tool name: ' + undeclaredTool.name + '. The call was not forwarded to the client.',
        0
      );
    }

    abortIfCancelled();
    const url = await currentUrl();
    if (url) setSession(key, url);
  });

  if (isCancelled()) return;

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
      input_tokens: estimateInputTokens(body),
      output_tokens: estimateOutputTokens(answer, thinking, toolCalls),
    },
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

module.exports = { handleMessages, detectToolLoop, isConversationTooLong, shouldResumeSession };
