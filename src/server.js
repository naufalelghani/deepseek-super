'use strict';

const http = require('node:http');
const { MODEL_NAME } = require('./config');
const { handleMessages } = require('./handler');
const { jsonError, readBody, checkAuth } = require('./http-utils');
const { validateMessagesRequest, estimateInputTokens } = require('./anthropic-contract');

function createServer() {
  return http.createServer(async (req, res) => {
    const urlPath = (req.url || '').split('?')[0];

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,HEAD,OPTIONS',
      });
      return res.end();
    }

    if (req.method === 'HEAD' && urlPath === '/api/hello') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end();
    }

    if (!checkAuth(req)) {
      return jsonError(res, 401, 'authentication_error', 'invalid token');
    }

    if (req.method === 'GET' && urlPath === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        data: [{
          id: MODEL_NAME,
          type: 'model',
          display_name: MODEL_NAME,
          created_at: new Date().toISOString(),
        }],
        has_more: false,
      }));
    }

    if (req.method === 'POST' && urlPath === '/v1/messages/count_tokens') {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return jsonError(res, 400, 'invalid_request_error', 'JSON tidak valid: ' + e.message);
      }

      const validationError = validateMessagesRequest(body, { countTokens: true });
      if (validationError) {
        return jsonError(res, 400, validationError.type, validationError.message);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: estimateInputTokens(body) }));
    }

    if (req.method === 'POST' && (urlPath === '/v1/messages' || urlPath === '/v1/messages/')) {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return jsonError(res, 400, 'invalid_request_error', 'JSON tidak valid: ' + e.message);
      }

      const validationError = validateMessagesRequest(body);
      if (validationError) {
        return jsonError(res, 400, validationError.type, validationError.message);
      }

      const wantStream = body.stream === true;
      if (wantStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*',
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
      }

      try {
        await handleMessages(req, res, body);
      } catch (e) {
        console.error('[error]', e);
        if (wantStream) {
          res.write('event: error\ndata: ' + JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: e.message || String(e) },
          }) + '\n\n');
          return res.end();
        }
        if (!res.headersSent) {
          return jsonError(res, 500, 'api_error', e.message || String(e));
        }
        res.end();
      }
      return;
    }

    jsonError(res, 404, 'not_found_error', 'endpoint tidak dikenal: ' + urlPath);
  });
}

module.exports = { createServer };
