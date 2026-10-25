'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateMessagesRequest,
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
