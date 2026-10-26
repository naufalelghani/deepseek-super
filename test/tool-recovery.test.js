'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolCallRecoveryError } = require('../src/tool-recovery');

test('tool-call recovery exhaustion is surfaced as an upstream API error, not a successful end_turn', () => {
  const error = createToolCallRecoveryError(
    'DeepSeek could not produce valid tool-call JSON after 2 recovery attempts.',
    2
  );

  assert.equal(error.message, 'DeepSeek could not produce valid tool-call JSON after 2 recovery attempts.');
  assert.equal(error.statusCode, 502);
  assert.equal(error.type, 'api_error');
  assert.equal(error.code, 'TOOL_CALL_RECOVERY_FAILED');
  assert.equal(error.attempts, 2);
});
