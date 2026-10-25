'use strict';

const { approxTokens } = require('./config');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validContent(content) {
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return content.every((block) => isPlainObject(block) && typeof block.type === 'string');
}

/**
 * Validate the public shape expected by the Anthropic Messages API.
 * This checks the wire contract, not whether the browser-backed model can
 * faithfully implement every Anthropic feature.
 */
function validateMessagesRequest(body, options = {}) {
  const countTokens = options.countTokens === true;

  if (!isPlainObject(body)) {
    return { type: 'invalid_request_error', message: 'Request body harus berupa object JSON.' };
  }

  if (typeof body.model !== 'string' || !body.model.trim()) {
    return { type: 'invalid_request_error', message: 'Field "model" wajib berupa string yang tidak kosong.' };
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { type: 'invalid_request_error', message: 'Field "messages" wajib berupa array yang tidak kosong.' };
  }

  if (!countTokens && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)) {
    return { type: 'invalid_request_error', message: 'Field "max_tokens" wajib berupa integer positif.' };
  }

  if (body.system !== undefined && !validContent(body.system)) {
    return { type: 'invalid_request_error', message: 'Field "system" harus berupa string atau array content block.' };
  }

  for (let i = 0; i < body.messages.length; i++) {
    const message = body.messages[i];
    if (!isPlainObject(message)) {
      return { type: 'invalid_request_error', message: `messages[${i}] harus berupa object.` };
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      return { type: 'invalid_request_error', message: `messages[${i}].role harus "user" atau "assistant", tetapi menerima ${JSON.stringify(message.role)}.` };
    }
    if (!validContent(message.content)) {
      return { type: 'invalid_request_error', message: `messages[${i}].content harus berupa string atau array content block.` };
    }
  }

  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      return { type: 'invalid_request_error', message: 'Field "tools" harus berupa array.' };
    }
    for (let i = 0; i < body.tools.length; i++) {
      const tool = body.tools[i];
      if (!isPlainObject(tool) || typeof tool.name !== 'string' || !tool.name.trim()) {
        return { type: 'invalid_request_error', message: `tools[${i}] harus memiliki field name berupa string yang tidak kosong.` };
      }
      if (!isPlainObject(tool.input_schema)) {
        return { type: 'invalid_request_error', message: `tools[${i}].input_schema wajib berupa object.` };
      }
    }
  }

  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    const validStringChoice = typeof choice === 'string' && ['auto', 'any', 'none'].includes(choice);
    const validObjectChoice = isPlainObject(choice) && (
      ['auto', 'any', 'none'].includes(choice.type) ||
      (choice.type === 'tool' && typeof choice.name === 'string' && choice.name.trim())
    );
    if (!validStringChoice && !validObjectChoice) {
      return { type: 'invalid_request_error', message: 'Field "tool_choice" tidak valid.' };
    }
    if (isPlainObject(choice) && choice.type === 'tool' &&
        (!Array.isArray(body.tools) || !body.tools.some((tool) => tool.name === choice.name))) {
      return { type: 'invalid_request_error', message: `tool_choice merujuk tool yang tidak tersedia: ${choice.name}` };
    }
  }

  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return { type: 'invalid_request_error', message: 'Field "stream" harus berupa boolean.' };
  }

  return null;
}

/**
 * Normalize Claude Code requests that put a system/developer instruction
 * inside messages[]. Anthropic expects these instructions in top-level system.
 * Returns a copied request and does not mutate the caller's object.
 */
function normalizeAnthropicMessagesRequest(body) {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) {
    return { body, normalizedInstructionMessages: 0 };
  }

  const systemBlocks = [];
  const messages = [];
  let normalizedInstructionMessages = 0;

  if (typeof body.system === 'string') {
    systemBlocks.push({ type: 'text', text: body.system });
  } else if (Array.isArray(body.system)) {
    systemBlocks.push(...body.system);
  }

  for (const message of body.messages) {
    if (isPlainObject(message) &&
        (message.role === 'system' || message.role === 'developer')) {
      normalizedInstructionMessages++;
      if (typeof message.content === 'string') {
        systemBlocks.push({ type: 'text', text: message.content });
      } else if (Array.isArray(message.content)) {
        systemBlocks.push(...message.content);
      }
      continue;
    }
    messages.push(message);
  }

  if (normalizedInstructionMessages === 0) {
    return { body, normalizedInstructionMessages: 0 };
  }

  return {
    body: { ...body, system: systemBlocks, messages },
    normalizedInstructionMessages,
  };
}

/**
 * A local character-based estimate, not a tokenizer or actual upstream usage.
 * Count all major prompt inputs so system instructions and tool schemas aren't
 * omitted from the reported input usage.
 */
function estimateInputTokens(body) {
  const input = {
    system: body.system === undefined ? null : body.system,
    messages: Array.isArray(body.messages) ? body.messages : [],
    tools: Array.isArray(body.tools) ? body.tools : [],
    tool_choice: body.tool_choice === undefined ? null : body.tool_choice,
  };
  return approxTokens(JSON.stringify(input));
}

function estimateOutputTokens(text, thinking, toolCalls) {
  return approxTokens(JSON.stringify({
    text: text || '',
    thinking: thinking || '',
    tool_calls: Array.isArray(toolCalls) ? toolCalls : [],
  }));
}

module.exports = {
  isPlainObject,
  validContent,
  normalizeAnthropicMessagesRequest,
  validateMessagesRequest,
  estimateInputTokens,
  estimateOutputTokens,
};
