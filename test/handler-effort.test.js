'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handleMessages, isConversationTooLong, shouldResumeSession } = require('../src/handler');

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.statusCode = null;
    this.headers = {};
    this.output = '';
  }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = headers;
  }
  write(chunk) {
    this.output += String(chunk);
    return true;
  }
  end(chunk) {
    if (chunk) this.output += String(chunk);
    this.writableEnded = true;
  }
}

test('the message rotation threshold remains 41 and fresh threads are not resumed without a URL', () => {
  assert.equal(isConversationTooLong(Array.from({ length: 40 }, () => ({ role: 'user', content: 'x' }))), false);
  assert.equal(isConversationTooLong(Array.from({ length: 41 }, () => ({ role: 'user', content: 'x' }))), true);
  assert.equal(shouldResumeSession({ url: null }, [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }]), false);
  assert.equal(shouldResumeSession({ url: 'https://chat.deepseek.com/chat/id' }, [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }]), true);
});

test('handler turns the selected output_config effort into DeepSeek prompt guidance', async () => {
  const response = new FakeResponse();
  let capturedPrompt = '';
  const dependencies = {
    ensurePage: async () => {},
    ensureTogglesOn: async () => {},
    resumeUrl: async () => false,
    gotoNewChat: async () => {},
    runTurn: async (prompt) => {
      capturedPrompt = prompt;
      return { text: 'Answer ready.', thinking: '', toolCalls: [], invalidToolCall: false };
    },
    currentUrl: async () => null,
    locked: async (fn) => fn(),
    getSession: () => null,
    setSession: () => {},
  };

  await handleMessages({ aborted: false }, response, {
    model: 'deepseek-super',
    max_tokens: 256,
    stream: false,
    tool_choice: 'none',
    output_config: { effort: 'high' },
    messages: [{ role: 'user', content: 'Explain the result.' }],
  }, dependencies);

  assert.match(capturedPrompt, /MODEL RESPONSE PROFILE/);
  assert.match(capturedPrompt, /Work style: efficient, practical, and technically precise/);
  assert.match(capturedPrompt, /client selected effort="high"/);
  assert.match(capturedPrompt, /verify important assumptions/);
  assert.match(capturedPrompt, /does not change DeepSeek model weights/);
  assert.equal(JSON.parse(response.output).content[0].text, 'Answer ready.');
});
