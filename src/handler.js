'use strict';

const { MODEL_NAME, MAX_REPLAY, sha, uuid } = require('./config');
const { getStateStore } = require('./state-store');
const { blocksOf, sessionKey, renderMessage, truncateReplay } = require('./content');
const { buildFullPrompt, buildResumePrompt, parseToolChoice, applyForcedTool } = require('./prompts');
const {
  DEEPSEEK_WEB_TOOLS,
  MAX_INTERNAL_WEB_TOOL_ROUNDS,
  isDeepSeekWebTool,
  executeDeepSeekWebTool,
  buildDeepSeekWebToolContinuationPrompt,
} = require('./deepseek-web-tools');
const { createToolCallRecoveryError } = require('./tool-recovery');
const { effortPrompt } = require('./effort');
const { modelProfilePrompt } = require('./model-profiles');
const { validateToolCalls } = require('./tool-validation');

function validateToolCallsForChoice(toolCalls, tools, force) {
  const validation = validateToolCalls(toolCalls, tools);
  if (!validation.valid) return validation;
  if (force && force.mode === 'tool') {
    const mismatch = toolCalls.find((call) => call.name !== force.name);
    if (mismatch) {
      return {
        valid: false,
        error: 'tool_choice requires "' + force.name + '", but DeepSeek returned "' + mismatch.name + '".',
      };
    }
  }
  return validation;
}

const { ensurePage: defaultEnsurePage, ensureTogglesOn: defaultEnsureTogglesOn, resumeUrl: defaultResumeUrl, gotoNewChat: defaultGotoNewChat, runTurn: defaultRunTurn, runIsolatedTurn: defaultRunIsolatedTurn, currentUrl: defaultCurrentUrl, locked: defaultLocked } = require('./browser');
const { getSession: defaultGetSession, ensureSession: defaultEnsureSession, setSession: defaultSetSession } = require('./session-store');
const { StreamSink } = require('./sse-sink');
const { jsonError } = require('./http-utils');

function containsToolMarkup(value) {
  return typeof value === 'string' &&
    /<\s*(?:TOOL_CALL\b|[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls|invoke|parameter)\b)/i.test(value);
}
const { estimateInputTokens, estimateOutputTokens } = require('./anthropic-contract');

let traceStoreWarningLogged = false;

function traceStore(method, ...args) {
  try {
    return getStateStore()[method](...args);
  } catch (error) {
    if (!traceStoreWarningLogged) {
      traceStoreWarningLogged = true;
      console.warn('[trace-store] SQLite tracing unavailable: ' +
        (error && error.message ? error.message : String(error)));
    }
    return null;
  }
}

function traceEvent(type, requestId, session, details = {}, level = 'info') {
  return traceStore('recordEvent', {
    type,
    requestId,
    sessionId: session && session.sessionId,
    threadId: session && session.threadId,
    details,
    level,
  });
}

function detectToolLoop(messages, threshold = 3) {
  if (threshold < 1) return false;
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
function shouldResumeSession(cached, messages, forceFresh = false) {
  return Boolean(!forceFresh && cached && typeof cached.url === 'string' && cached.url &&
    Array.isArray(messages) && messages.length > 1);
}

async function handleMessages(req, res, body, dependencies = {}) {
  const requestId = uuid('req');
  const messageId = uuid('msg');
  req.gatewayRequestId = requestId;
  const ensurePage = dependencies.ensurePage || defaultEnsurePage;
  const ensureTogglesOn = dependencies.ensureTogglesOn || defaultEnsureTogglesOn;
  const resumeUrl = dependencies.resumeUrl || defaultResumeUrl;
  const gotoNewChat = dependencies.gotoNewChat || defaultGotoNewChat;
  const runTurn = dependencies.runTurn || defaultRunTurn;
  // Tests/custom adapters that inject runTurn keep their existing turn behavior unless
  // they explicitly provide an isolated callback. Production uses a clean chat for
  // native DeepSeek Search so client DSML instructions do not leak into that turn.
  const runIsolatedTurn = dependencies.runIsolatedTurn ||
    (dependencies.runTurn ? null : defaultRunIsolatedTurn);
  const currentUrl = dependencies.currentUrl || defaultCurrentUrl;
  const locked = dependencies.locked || defaultLocked;
  const getSession = dependencies.getSession || defaultGetSession;
  const setSession = dependencies.setSession || defaultSetSession;
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

  console.error('[REQ] request_id=' + requestId + ' message_id=' + messageId +
    ' model=' + (body.model || '?') +
    ' tools=' + (Array.isArray(body.tools) ? body.tools.length : 0) +
    ' msgs=' + (Array.isArray(body.messages) ? body.messages.length : 0));

  const system = body.system || '';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const clientTools = Array.isArray(body.tools) ? body.tools : [];
  const wantStream = body.stream === true;
  const model = body.model || MODEL_NAME;

  if (messages.length === 0) {
    return jsonError(res, 400, 'invalid_request_error', 'The messages array must not be empty.');
  }

  traceStore('recordRequestStart', {
    requestId, messageId, model, stream: wantStream,
    messageCount: messages.length, clientToolCount: clientTools.length,
  });

  const last = messages[messages.length - 1];
  const lastHasToolResult = blocksOf(last.content).some((block) => block.type === 'tool_result');
  // Respect the caller's tool_choice after tool results too; the model may need another tool step.
  let force = parseToolChoice(body.tool_choice);
  if (detectToolLoop(messages, 3)) {
    console.warn('[loop-detect] three identical tool calls detected; forcing a text response');
    force = { mode: 'none' };
  }

  // Keep client-enforced tool_choice and loop-recovery semantics intact.
  // DeepSeek-backed web tools are internal orchestration tools for auto selection only.
  const tools = force.mode === 'auto'
    ? clientTools.concat(DEEPSEEK_WEB_TOOLS)
    : clientTools;
  const conversationTooLong = isConversationTooLong(messages);
  if (conversationTooLong) {
    console.warn('[long-conv] message_count=' + messages.length +
      '; starting a fresh DeepSeek thread with a bounded replay so tool use can continue');
  }

  const key = sessionKey(system, messages);
  let sessionInfo = traceStore('ensureSession', key) || defaultEnsureSession(key);
  if (sessionInfo) {
    traceStore('linkRequestToSession', requestId, sessionInfo, { resumed: false });
    if (sessionInfo.created) {
      traceEvent('session.created', requestId, sessionInfo, { message_count: messages.length });
    }
  }
  if (isCancelled()) return;
  await ensurePage();
  if (isCancelled()) return;

  let answer, thinking, toolCalls;
  let activeSession = sessionInfo || null;
  let initialThreadId = sessionInfo && sessionInfo.threadId || null;
  let resumed = false;
  let rotationReason = null;
  let completionSource = 'unknown';
  const sink = wantStream ? new StreamSink(res, model, estimateInputTokens(body), messageId) : null;

  try {
  await locked(async () => {
    abortIfCancelled();
    await ensurePage();
    abortIfCancelled();
    await ensureTogglesOn(tools.length > 0 || force.mode === 'none');
    abortIfCancelled();

    // Resolve the latest cached URL inside the browser lock. A preceding
    // queued request may have created or updated this conversation's URL.
    const cached = getSession(key) || sessionInfo;
    activeSession = cached || activeSession;
    initialThreadId = cached && cached.threadId || null;
    traceStore('linkRequestToSession', requestId, cached, { resumed: false });
    abortIfCancelled();

    resumed = false;
    if (shouldResumeSession(cached, messages, conversationTooLong)) {
      try {
        resumed = await resumeUrl(cached.url);
      } catch (error) {
        console.warn('[session] failed to resume cached conversation:', error.message || String(error));
      }
      if (resumed) {
        console.log('[session] resumed cached conversation; tool_result=' + lastHasToolResult);
        traceEvent('thread.resumed', requestId, cached, {
          message_count: messages.length,
          thread_generation: cached.generation,
          tool_result_turn: lastHasToolResult,
        });
      }
    }

    rotationReason = resumed ? null : conversationTooLong ? 'message_limit'
      : cached && cached.url ? 'resume_failed' : 'initial_thread';

    let untruncatedPrompt;
    if (resumed) {
      untruncatedPrompt = buildResumePrompt(system, messages, tools, lastHasToolResult);
    } else {
      if (cached && cached.url) {
        console.warn(conversationTooLong
          ? '[session] conversation exceeded the replay threshold; creating a fresh thread'
          : '[session] cached conversation unavailable; creating a new conversation');
      }
      traceEvent(cached && cached.url ? 'thread.rotation_requested' : 'thread.creation_requested',
        requestId, cached, { reason: rotationReason, message_count: messages.length },
        cached && cached.url ? 'warn' : 'info');
      await gotoNewChat();
      untruncatedPrompt = buildFullPrompt(system, messages, tools);
    }

    if (untruncatedPrompt.length > MAX_REPLAY) {
      console.warn('[prompt-truncate] input_chars=' + untruncatedPrompt.length +
        ' cap_chars=' + MAX_REPLAY +
        ' omitted_chars=' + (untruncatedPrompt.length - MAX_REPLAY) +
        '; the replay includes an explicit warning marker');
    }
    let prompt = truncateReplay(untruncatedPrompt);
    const replayPromptChars = prompt.length;
    prompt = applyForcedTool(prompt, force);
    const profileInstruction = modelProfilePrompt(model);
    if (profileInstruction) prompt += '\n\n' + profileInstruction;
    const effortInstruction = effortPrompt(body.output_config && body.output_config.effort);
    if (effortInstruction) prompt += '\n\n' + effortInstruction;
    traceStore('recordPromptMetrics', requestId, {
      inputPromptChars: untruncatedPrompt.length,
      replayPromptChars,
      finalPromptChars: prompt.length,
      omittedPromptChars: Math.max(0, untruncatedPrompt.length - replayPromptChars),
      truncated: untruncatedPrompt.length > MAX_REPLAY,
    });
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
    const bufferResponse = useBuffer || force.mode === 'none';
    const out = await runTurn(prompt, sink || dummySink, bufferResponse, isCancelled);
    abortIfCancelled();
    completionSource = out.completionSource || 'unknown';
    answer = out.text;
    thinking = out.thinking;
    toolCalls = out.toolCalls;

    let hasRawToolCall = out.invalidToolCall || containsToolMarkup(answer);
    if (force.mode === 'none' && (hasRawToolCall || toolCalls.length > 0)) {
      console.warn('[tool-recovery] model ignored the no-tool policy; requesting one text-only recovery');
      const textOnlyPrompt = [
        '=== TEXT-ONLY RECOVERY ===',
        'Your previous response attempted to call a tool even though tools are disabled for this turn.',
        'Do not emit DSML calls/invoke/parameter tags, legacy <TOOL_CALL> tags, or tool-call JSON.',
        'Use only the conversation and tool results already available to provide the best possible plain-text answer now.',
        'If the task cannot be completed from available information, state the limitation clearly.',
        'Output only the final user-facing answer.'
      ].join('\n');
      const recovery = await runTurn(textOnlyPrompt, dummySink, true, isCancelled);
      abortIfCancelled();
      completionSource = recovery.completionSource || completionSource;
      const recoveryHasToolMarkup = recovery.invalidToolCall ||
        containsToolMarkup(recovery.text);
      if (recovery.toolCalls.length > 0 || recoveryHasToolMarkup || !(recovery.text || '').trim()) {
        throw createToolCallRecoveryError(
          'DeepSeek continued to emit tool-call output despite a text-only recovery request. No tool was forwarded.',
          1
        );
      }
      answer = recovery.text;
      thinking = recovery.thinking;
      toolCalls = [];
      hasRawToolCall = false;
    }

    let validation = toolCalls.length > 0
      ? validateToolCallsForChoice(toolCalls, tools, force)
      : { valid: !hasRawToolCall, error: null };
    const needsRecovery = (hasRawToolCall && (out.invalidToolCall || toolCalls.length === 0)) ||
      (toolCalls.length > 0 && !validation.valid);

    if (needsRecovery) {
      if (tools.length === 0) {
        throw createToolCallRecoveryError(
          'DeepSeek emitted a tool call that cannot be used because this request did not declare tools.',
          0
        );
      }

      const maxRetries = 2;
      let recovered = false;
      let recoveryIssue = validation.error ||
        'The previous DSML tool-call markup was malformed or incomplete.';
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.warn('[retry] attempt=' + attempt + '/' + maxRetries +
          ' — repairing tool-call output: ' + recoveryIssue);
        const retryPrompt = [
          '=== TOOL CALL RECOVERY ===',
          'The previous response contained a tool call that was malformed or did not match the declared tool schema.',
          'Do not copy its malformed JSON or invalid arguments.',
          'Use the original task, conversation history, available tools, and their schemas.',
          'Correct this issue: ' + recoveryIssue,
          'Rebuild the necessary tool call(s) from scratch. All arguments must be valid JSON objects and satisfy the declared schemas.',
          'Output only one DeepSeek DSML calls block, with no prose or Markdown outside it.',
          'Use one invoke block per tool, and one parameter block per argument. For string values use string="true" and raw text; for non-string values use string="false" and valid JSON.',
          'Valid formatting example only; this is not an instruction to execute pwd:',
          '<｜DSML｜ calls><｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>',
          'Do not use the legacy <TOOL_CALL> wrapper or JSON-encoded arguments for string parameters.',
          attempt === 1
            ? 'Preserve the original task intent and do not invent arguments.'
            : 'This is the final recovery attempt. Rebuild the simplest valid arguments that still satisfy the original task.'
        ].join('\n');

        // Keep retry output private until the whole batch passes validation.
        const retry = await runTurn(retryPrompt, dummySink, useBuffer, isCancelled);
        abortIfCancelled();
        completionSource = retry.completionSource || completionSource;
        answer = retry.text;
        thinking = retry.thinking;
        toolCalls = retry.toolCalls;

        const retryHasRawToolCall = retry.invalidToolCall ||
          containsToolMarkup(answer);
        validation = retry.invalidToolCall
          ? { valid: false, error: 'The retry returned a partially malformed or invalid tool-call batch.' }
          : toolCalls.length > 0
            ? validateToolCallsForChoice(toolCalls, tools, force)
            : { valid: false, error: retryHasRawToolCall
                ? 'The retried DSML tool-call markup is still malformed or incomplete.'
                : 'The retry did not return a tool call.' };

        if (toolCalls.length > 0 && validation.valid && !retry.invalidToolCall) {
          recovered = true;
          console.log('[retry] recovered on attempt ' + attempt +
            ' — schema-valid tool calls=' + toolCalls.length);
          break;
        }

        recoveryIssue = validation.error || 'The retry did not return a valid tool call.';
        console.warn('[retry] attempt ' + attempt + ' did not produce schema-valid tool calls');
      }

      if (!recovered) {
        console.error('[retry] exhausted; returning an explicit gateway error instead of a false end_turn');
        throw createToolCallRecoveryError(
          'DeepSeek could not produce a valid tool call after ' + maxRetries +
          ' recovery attempts. Last validation issue: ' + recoveryIssue,
          maxRetries
        );
      }
    }

    // Resolve DeepSeek-native web tools inside the gateway. Only client-owned tools
    // are returned as Anthropic tool_use blocks; internal results are placed back
    // into the same DeepSeek conversation before it continues.
    let internalWebRounds = 0;
    while (toolCalls.some(isDeepSeekWebTool)) {
      const internalCalls = toolCalls.filter(isDeepSeekWebTool);
      const clientCalls = toolCalls.filter((call) => !isDeepSeekWebTool(call));
      internalWebRounds++;
      if (internalWebRounds > MAX_INTERNAL_WEB_TOOL_ROUNDS) {
        throw createToolCallRecoveryError(
          'DeepSeek exceeded the internal web-tool round limit (' + MAX_INTERNAL_WEB_TOOL_ROUNDS + ').',
          internalWebRounds - 1
        );
      }

      const internalResults = [];
      for (const call of internalCalls) {
        abortIfCancelled();
        try {
          internalResults.push(await executeDeepSeekWebTool(call, {
            ensureTogglesOn,
            runTurn,
            runIsolatedTurn,
            sink: dummySink,
            isCancelled,
          }));
        } catch (error) {
          abortIfCancelled();
          internalResults.push({
            name: call.name,
            input: call.input || {},
            result: 'Internal DeepSeek web tool failed: ' + (error.message || String(error)),
          });
        }
      }

      // A mixed batch is allowed: run internal searches now, then hand the
      // client-owned calls back exactly as requested. Their results will arrive
      // on the client's next Messages request, with web results retained in UI history.
      if (clientCalls.length > 0) {
        toolCalls = clientCalls;
        answer = '';
        break;
      }

      const continuationPrompt = buildDeepSeekWebToolContinuationPrompt(internalResults, tools);
      await ensureTogglesOn(true);
      abortIfCancelled();
      const continued = await runTurn(continuationPrompt, dummySink, true, isCancelled);
      abortIfCancelled();
      completionSource = continued.completionSource || completionSource;
      answer = continued.text;
      thinking = continued.thinking;
      toolCalls = continued.toolCalls;

      const hasInvalidMarkup = continued.invalidToolCall || containsToolMarkup(answer);
      if (hasInvalidMarkup) {
        throw createToolCallRecoveryError(
          'DeepSeek returned malformed tool-call markup after receiving internal web-tool results.',
          0
        );
      }
      if (toolCalls.length > 0) {
        const continuedValidation = validateToolCallsForChoice(toolCalls, tools, force);
        if (!continuedValidation.valid) {
          throw createToolCallRecoveryError(
            'Tool calls after internal web-tool results failed schema validation: ' + continuedValidation.error,
            0
          );
        }
      }
    }

    if (force.mode !== 'auto' && force.mode !== 'none' && toolCalls.length === 0) {
      throw createToolCallRecoveryError(
        'DeepSeek did not return the tool call required by tool_choice=' + force.mode + '.',
        0
      );
    }

    if (toolCalls.length > 0) {
      validation = validateToolCallsForChoice(toolCalls, tools, force);
      if (!validation.valid) {
        throw createToolCallRecoveryError(
          'Tool calls failed schema validation and were not forwarded: ' + validation.error,
          0
        );
      }
    }

    // For tool-enabled requests, emit the response only after parse and schema
    // validation succeeds. This keeps retries atomic and prevents partial/invalid
    // tool batches from reaching the client.
    if (sink && (useBuffer || force.mode === 'none')) {
      if (answer) sink.emitText(answer);
      for (const tool of toolCalls) sink.toolBlock(tool.name, tool.input);
    }

    abortIfCancelled();
    const url = await currentUrl();
    if (url) {
      const updatedSession = setSession(key, url, {
        rotationReason,
        messageCount: messages.length,
      });
      if (updatedSession) {
        activeSession = updatedSession;
        traceStore('linkRequestToSession', requestId, updatedSession, { resumed, rotationReason });
        if (updatedSession.threadId && updatedSession.threadId !== initialThreadId) {
          traceEvent(initialThreadId ? 'thread.rotated' : 'thread.created', requestId, updatedSession, {
            previous_thread_id: initialThreadId,
            thread_generation: updatedSession.generation,
            reason: rotationReason || 'thread_changed',
            message_count: messages.length,
          });
        }
      }
    }
  });
  } catch (error) {
    traceStore('finishRequest', {
      requestId,
      status: error && error.name === 'AbortError' ? 'cancelled' : 'error',
      completionSource,
      errorCode: error && (error.type || error.name) || 'error',
    });
    throw error;
  }

  if (isCancelled()) {
    traceStore('finishRequest', { requestId, status: 'cancelled', completionSource });
    return;
  }

  const stopReason = toolCalls.length ? 'tool_use' : 'end_turn';
  traceStore('finishRequest', {
    requestId,
    status: 'completed',
    stopReason,
    toolCallCount: toolCalls.length,
    completionSource,
  });
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
    id: messageId,
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
