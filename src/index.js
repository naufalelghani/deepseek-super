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
    console.log('Auth       : required');
    console.log('Token source: ' + config.AUTH_TOKEN_SOURCE);
    if (config.AUTH_TOKEN_SOURCE !== 'environment') {
      console.log('Local token file: ' + config.AUTH_TOKEN_FILE);
      console.log('PowerShell client setup: $env:ANTHROPIC_AUTH_TOKEN = (Get-Content -Raw .deepseek-super-token).Trim()');
      console.log('Git Bash client setup: export ANTHROPIC_AUTH_TOKEN="$(tr -d \"\\\\r\\\\n\" < .deepseek-super-token)"');
    } else {
      console.log('Set DEEPSEEK_SUPER_TOKEN / ANTHROPIC_AUTH_TOKEN to the same secret in client processes.');
    }
    console.log('Never commit or share the local token file.');
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
