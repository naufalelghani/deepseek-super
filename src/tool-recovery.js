'use strict';

function createToolCallRecoveryError(message, attempts) {
  const error = new Error(message || 'The selected backend did not return a valid tool call.');
  error.statusCode = 502;
  error.type = 'api_error';
  error.code = 'TOOL_CALL_RECOVERY_FAILED';
  if (Number.isInteger(attempts) && attempts >= 0) error.attempts = attempts;
  return error;
}

module.exports = { createToolCallRecoveryError };
