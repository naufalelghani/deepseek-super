'use strict';

const http = require('node:http');
const { uuid } = require('./config');
const { effortCapabilities } = require('./effort');
// Virtual catalog IDs are client-facing profiles; requests are handled by this gateway.
const AVAILABLE_MODELS = [
  { id: 'deepseek-super', display_name: 'Deepseek Super', line: 'sonnet' },
  { id: 'claude-mythos-5-1', display_name: 'Mythos 5.1', line: 'opus' },
  { id: 'claude-fable-5.1', display_name: 'Fable 5.1', line: 'sonnet' },
  { id: 'claude-opus-5-5', display_name: 'Opus 5.5', line: 'opus' },
  { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5', line: 'sonnet' },
  { id: 'claude-haiku-5-5', display_name: 'Haiku 5.5', line: 'haiku' },
];
const { handleMessages } = require('./handler');
const {
  jsonError,
  readBody,
  checkAuth,
  isAllowedHost,
  isAllowedOrigin
} = require('./http-utils');
const {
  validateMessagesRequest,
  estimateInputTokens,
  normalizeAnthropicMessagesRequest
} = require('./anthropic-contract');

// Compatibility shim for Claude Code versions that put system instructions
// inside messages[]. Log counts only; never log prompt content.
function normalizeRequest(body) {
  const result = normalizeAnthropicMessagesRequest(body);
  if (result.normalizedInstructionMessages > 0) {
    console.warn('[compat] moved ' + result.normalizedInstructionMessages +
      ' system/developer message(s) from messages[] to top-level system');
  }
  return result.body;
}

function createServer() {
  return http.createServer(async (req, res) => {
    const urlPath = (req.url || '').split('?')[0];
    const localPort = req.socket.localPort;
    const origin = req.headers.origin;

    // Reject unexpected Host headers to reduce DNS-rebinding exposure.
    if (!isAllowedHost(req.headers.host, localPort)) {
      return jsonError(res, 421, 'invalid_request_error', 'Host header is not allowed. Use localhost or 127.0.0.1.');
    }

    // Cross-origin browser use is denied unless it is same-origin local or explicitly allowlisted.
    if (!isAllowedOrigin(origin, localPort)) {
      return jsonError(res, 403, 'authentication_error', 'Origin is not allowed. Configure CORS_ALLOWED_ORIGINS to allow a trusted origin.');
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      const headers = {
        'Access-Control-Allow-Methods': 'GET,POST,HEAD,OPTIONS',
        'Access-Control-Allow-Headers': 'authorization,content-type,x-api-key,anthropic-version,anthropic-beta,anthropic-dangerous-direct-browser-access',
        'Cache-Control': 'no-store'
      };
      if (origin) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers.Vary = 'Origin';
      }
      res.writeHead(204, headers);
      return res.end();
    }

    // All routes, including the health endpoint, are authenticated.
    if (!checkAuth(req)) {
      return jsonError(res, 401, 'authentication_error', 'Invalid API token.');
    }

    if (req.method === 'HEAD' && urlPath === '/api/hello') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end();
    }

    if (req.method === 'GET' && urlPath === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const createdAt = new Date().toISOString();
      const data = AVAILABLE_MODELS.map(({ id, display_name, line }) => ({
        id,
        type: 'model',
        display_name,
        line,
        created_at: createdAt,
        allowed_fallback_models: [],
        capabilities: {
          effort: effortCapabilities(),
        },
        max_input_tokens: null,
        max_tokens: null,
      }));
      return res.end(JSON.stringify({
        data,
        first_id: data[0].id,
        last_id: data[data.length - 1].id,
        has_more: false,
      }));
    }

    if (req.method === 'POST' && urlPath === '/v1/messages/count_tokens') {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        return jsonError(res, 400, 'invalid_request_error', 'Invalid JSON: ' + error.message);
      }

      body = normalizeRequest(body);
      const validationError = validateMessagesRequest(body, { countTokens: true });
      if (validationError) {
        return jsonError(res, 400, validationError.type, validationError.message);
      }

      res.setHeader('X-Token-Usage-Estimated', 'true');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: estimateInputTokens(body) }));
    }

    if (req.method === 'POST' && (urlPath === '/v1/messages' || urlPath === '/v1/messages/')) {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        return jsonError(res, 400, 'invalid_request_error', 'Invalid JSON: ' + error.message);
      }

      body = normalizeRequest(body);
      const validationError = validateMessagesRequest(body);
      if (validationError) {
        return jsonError(res, 400, validationError.type, validationError.message);
      }

      const wantStream = body.stream === true;
      const requestId = uuid('req');
      req.gatewayRequestId = requestId;
      res.setHeader('X-Gateway-Request-ID', requestId);
      res.setHeader('X-Token-Usage-Estimated', 'true');
      if (wantStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
      }

      try {
        await handleMessages(req, res, body);
      } catch (error) {
        // A disconnected client should release the browser queue without attempting
        // to write another response to a closed socket.
        if (res.destroyed || res.writableEnded || error.name === 'AbortError') return;
        console.error('[error]', error);
        if (wantStream) {
          res.write('event: error\ndata: ' + JSON.stringify({
            type: 'error',
            error: { type: error.type || 'api_error', message: error.message || String(error) },
          }) + '\n\n');
          return res.end();
        }
        if (!res.headersSent) {
          return jsonError(res, error.statusCode || 500, error.type || 'api_error', error.message || String(error));
        }
        res.end();
      }
      return;
    }

    return jsonError(res, 404, 'not_found_error', 'Unknown endpoint: ' + urlPath);
  });
}

module.exports = { createServer, normalizeRequest };
