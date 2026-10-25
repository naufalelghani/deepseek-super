'use strict';

const config = require('./config');
const { createServer } = require('./server');
const { shutdownBrowser } = require('./browser');

function start() {
  const server = createServer();
  server.listen(config.PORT, '127.0.0.1', () => {
    console.log('=== deepseek-super server ===');
    console.log('Model      : ' + config.MODEL_NAME);
    console.log('Endpoint   : http://127.0.0.1:' + config.PORT);
    console.log('Routes     : POST /v1/messages, POST /v1/messages/count_tokens, GET /v1/models');
    console.log('Auth       : ' + (config.AUTH_TOKEN ? 'token wajib' : 'terbuka (localhost)'));
    console.log('');
    console.log('Set di client (Claude Code / Cline / Roo Code):');
    console.log('  ANTHROPIC_BASE_URL=http://127.0.0.1:' + config.PORT);
    console.log('  ANTHROPIC_AUTH_TOKEN=' + (config.AUTH_TOKEN || 'any'));
    console.log('  ANTHROPIC_MODEL=' + config.MODEL_NAME);
    console.log('');
  });

  const shutdown = async () => {
    console.log('\nShutting down...');
    server.close();
    await shutdownBrowser();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

module.exports = { start, createServer, config };