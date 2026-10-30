'use strict';

const SUPPORTED_BACKENDS = Object.freeze(['deepseek', 'qwen']);

function parseBackendArgs(args) {
  if (!Array.isArray(args)) {
    throw new TypeError('Backend arguments must be an array.');
  }
  if (args.length === 0) return 'deepseek';
  if (args.length !== 1 || !SUPPORTED_BACKENDS.some((backend) => args[0] === '--' + backend)) {
    throw new Error('Usage: node server.js --deepseek | --qwen');
  }
  return args[0].slice(2);
}

module.exports = { SUPPORTED_BACKENDS, parseBackendArgs };
