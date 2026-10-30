'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBackendArgs } = require('../src/backend-selection');

test('backend selection defaults to DeepSeek for backward compatibility', () => {
  assert.equal(parseBackendArgs([]), 'deepseek');
});

test('backend selection accepts the explicit DeepSeek flag', () => {
  assert.equal(parseBackendArgs(['--deepseek']), 'deepseek');
});

test('backend selection accepts the explicit Qwen flag', () => {
  assert.equal(parseBackendArgs(['--qwen']), 'qwen');
});

test('backend selection rejects conflicting or unknown arguments', () => {
  assert.throws(() => parseBackendArgs(['--qwen', '--deepseek']), /Usage:/);
  assert.throws(() => parseBackendArgs(['--other']), /Usage:/);
  assert.throws(() => parseBackendArgs(['--qwen', 'extra']), /Usage:/);
});
