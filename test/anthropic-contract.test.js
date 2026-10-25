'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateMessagesRequest,
  normalizeAnthropicMessagesRequest,
  estimateInputTokens,
  estimateOutputTokens,
} = require('../src/anthropic-contract');

const minimal = {
  model: 'deepseek-super',
  max_tokens: 256,
  messages: [{ role: 'user', content: 'Hello' }],
};

test('accepts a standard Anthropic Messages request', () => {
  assert.equal(validateMessagesRequest(minimal), null);
});

test('requires model, non-empty messages, and positive integer max_tokens', () => {
  assert.match(validateMessagesRequest({ ...minimal, model: '' }).message, /model/);
  assert.match(validateMessagesRequest({ ...minimal, messages: [] }).message, /messages/);
  assert.match(validateMessagesRequest({ ...minimal, max_tokens: 0 }).message, /max_tokens/);
  assert.match(validateMessagesRequest({ ...minimal, max_tokens: 1.5 }).message, /max_tokens/);
});

test('validates message roles and content block container shape', () => {
  assert.match(
    validateMessagesRequest({ ...minimal, messages: [{ role: 'system', content: 'Hello' }] }).message,
    /role/
  );
  assert.match(
    validateMessagesRequest({ ...minimal, messages: [{ role: 'user', content: { text: 'Hello' } }] }).message,
    /content/
  );
  assert.equal(
    validateMessagesRequest({
      ...minimal,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    }),
    null
  );
});

test('validates tool schemas and tool_choice references', () => {
  assert.match(
    validateMessagesRequest({ ...minimal, tools: [{ name: 'Bash' }] }).message,
    /input_schema/
  );

  const tools = [{
    name: 'Bash',
    description: 'Run a shell command',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  }];
  assert.equal(validateMessagesRequest({ ...minimal, tools, tool_choice: { type: 'tool', name: 'Bash' } }), null);
  assert.match(
    validateMessagesRequest({ ...minimal, tools, tool_choice: { type: 'tool', name: 'Read' } }).message,
    /tidak tersedia/
  );
  assert.match(
    validateMessagesRequest({ ...minimal, tool_choice: { type: 'random' } }).message,
    /tool_choice/
  );
});

test('count_tokens validation does not require max_tokens', () => {
  const { max_tokens, ...request } = minimal;
  assert.equal(validateMessagesRequest(request, { countTokens: true }), null);
  assert.match(validateMessagesRequest(request).message, /max_tokens/);
});

test('input token estimate includes system instructions and tool schemas', () => {
  const base = estimateInputTokens(minimal);
  const extended = estimateInputTokens({
    ...minimal,
    system: 'Follow these detailed instructions.',
    tools: [{
      name: 'Read',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
    }],
  });
  assert.ok(extended > base);
  assert.ok(estimateOutputTokens('answer', '', []) > 0);
});

test('normalizes Claude Code system-role messages into the top-level system field', () => {
  const request = {
    ...minimal,
    system: 'Existing system instruction.',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'system', content: 'Extra injected system instruction.' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'continue' },
    ],
  };

  const result = normalizeAnthropicMessagesRequest(request);
  assert.equal(result.normalizedInstructionMessages, 1);
  assert.deepEqual(result.body.messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'continue' },
  ]);
  assert.deepEqual(result.body.system, [
    { type: 'text', text: 'Existing system instruction.' },
    { type: 'text', text: 'Extra injected system instruction.' },
  ]);
  assert.equal(request.messages[1].role, 'system', 'normalizer must not mutate original request');
  assert.equal(validateMessagesRequest(result.body), null);
});

test('normalizes developer-role instructions too and preserves array content blocks', () => {
  const result = normalizeAnthropicMessagesRequest({
    ...minimal,
    messages: [
      { role: 'developer', content: [{ type: 'text', text: 'Developer instruction.' }] },
      { role: 'user', content: 'hello' },
    ],
  });

  assert.equal(result.normalizedInstructionMessages, 1);
  assert.deepEqual(result.body.system, [{ type: 'text', text: 'Developer instruction.' }]);
  assert.deepEqual(result.body.messages, [{ role: 'user', content: 'hello' }]);
  assert.equal(validateMessagesRequest(result.body), null);
});

test('reports the actual unsupported message role in validation errors', () => {
  const error = validateMessagesRequest({
    ...minimal,
    messages: [{ role: 'tool', content: 'unexpected role' }],
  });
  assert.match(error.message, /"tool"/);
});
