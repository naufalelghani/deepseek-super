'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldResumeSession } = require('../src/handler');

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
