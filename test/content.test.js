'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { blocksOf, flattenContent, renderMessage, sessionKey, truncateReplay } = require('../src/content');
const { approxTokens, MAX_REPLAY } = require('../src/config');

test('blocksOf normalizes strings and handles empty content', () => {
  assert.deepEqual(blocksOf('hello'), [{ type: 'text', text: 'hello' }]);
  assert.deepEqual(blocksOf(null), []);
  assert.deepEqual(blocksOf([{ type: 'text', text: 'x' }]), [{ type: 'text', text: 'x' }]);
});

test('flattenContent and renderMessage preserve supported textual content', () => {
  assert.equal(flattenContent([{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }]), 'hello');
  assert.match(renderMessage({ content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] }), /Tool call Bash/);
  assert.match(renderMessage({ content: [{ type: 'image' }] }), /image unsupported/);
});

test('sessionKey is stable for the same leading system and user messages', () => {
  const messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
  assert.equal(sessionKey('system', messages), sessionKey('system', messages));
  assert.notEqual(sessionKey('system', messages), sessionKey('different', messages));
});

test('truncateReplay caps very long replay prompts and token estimate is positive', () => {
  const long = 'x'.repeat(65000);
  const replay = truncateReplay(long);
  assert.ok(replay.length <= MAX_REPLAY);
  assert.ok(replay.length < long.length);
  assert.match(replay, /WARNING: conversation replay was truncated/);
  assert.equal(approxTokens('hello'), 2);
});

test('sessionKey hashes the full first user message instead of a truncated prefix', () => {
  const prefix = 'x'.repeat(900);
  const a = [{ role: 'user', content: prefix + 'A' }];
  const b = [{ role: 'user', content: prefix + 'B' }];
  assert.notEqual(sessionKey('', a), sessionKey('', b));
});
