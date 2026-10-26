'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldResumeSession, isConversationTooLong, detectToolLoop } = require('../src/handler');

test('resumes the cached DeepSeek chat when the latest message is a tool_result', () => {
  const cached = { url: 'https://chat.deepseek.com/a/chat/s/test-session' };
  const messages = [
    { role: 'user', content: 'Run pwd using Bash.' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_test', name: 'Bash', input: { command: 'pwd' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_test', content: '/project' }],
    },
  ];

  assert.equal(shouldResumeSession(cached, messages), true);
});

test('does not resume if there is no cached conversation', () => {
  assert.equal(shouldResumeSession(null, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]), false);
});

test('starts a new conversation for the first request with no history', () => {
  assert.equal(shouldResumeSession(
    { url: 'https://chat.deepseek.com/a/chat/s/test-session' },
    [{ role: 'user', content: 'hello' }]
  ), false);
});

test('allows multi-step tool chains but still caps very long conversations', () => {
  const makeMessages = (length) =>
    Array.from({ length }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'fixture' }));

  assert.equal(isConversationTooLong(makeMessages(13)), false);
  assert.equal(isConversationTooLong(makeMessages(40)), false);
  assert.equal(isConversationTooLong(makeMessages(41)), true);
});


test('long conversation starts a fresh bounded replay instead of resuming the old browser thread', () => {
  const cached = { url: 'https://chat.deepseek.com/a/chat/s/test-session' };
  const messages = Array.from({ length: 41 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: 'fixture',
  }));

  assert.equal(isConversationTooLong(messages), true);
  assert.equal(shouldResumeSession(cached, messages, true), false);
  assert.equal(shouldResumeSession(cached, messages, false), true);
});

test('tool-loop detection matches repeated names and arguments, not merely repeated names', () => {
  const call = (input) => ({
    role: 'assistant',
    content: [{ type: 'tool_use', name: 'Bash', input }],
  });

  assert.equal(detectToolLoop([call({ command: 'pwd' }), call({ command: 'pwd' }), call({ command: 'pwd' })]), true);
  assert.equal(detectToolLoop([call({ command: 'pwd' }), call({ command: 'ls' }), call({ command: 'pwd' })]), false);
});
