'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_GATEWAY_URL,
  normalizeClaudeCodeBaseUrl,
  isDefaultLocalGateway,
} = require('../scripts/claude-code-base-url');

test('Claude Code default base URL is the gateway root without /v1', () => {
  assert.equal(DEFAULT_GATEWAY_URL, 'http://127.0.0.1:8787');
  assert.equal(normalizeClaudeCodeBaseUrl(DEFAULT_GATEWAY_URL), DEFAULT_GATEWAY_URL);
});

test('normalizes SDK-style URLs ending in /v1 for Claude Code', () => {
  assert.equal(
    normalizeClaudeCodeBaseUrl('http://127.0.0.1:8787/v1'),
    'http://127.0.0.1:8787'
  );
  assert.equal(
    normalizeClaudeCodeBaseUrl('http://127.0.0.1:8787/v1/'),
    'http://127.0.0.1:8787'
  );
  assert.equal(
    normalizeClaudeCodeBaseUrl('http://localhost:20128/router/v1'),
    'http://localhost:20128/router'
  );
});

test('keeps non-versioned proxy base paths intact', () => {
  assert.equal(
    normalizeClaudeCodeBaseUrl('https://gateway.example/anthropic'),
    'https://gateway.example/anthropic'
  );
});

test('rejects invalid schemes and embedded credentials', () => {
  assert.throws(() => normalizeClaudeCodeBaseUrl('file:///tmp/gateway'), /http:\/\//);
  assert.throws(
    () => normalizeClaudeCodeBaseUrl('http://user:secret@localhost:8787'),
    /credentials/
  );
});

test('recognizes the default local gateway with or without trailing /v1', () => {
  assert.equal(isDefaultLocalGateway('http://127.0.0.1:8787'), true);
  assert.equal(isDefaultLocalGateway('http://localhost:8787/v1'), true);
  assert.equal(isDefaultLocalGateway('http://127.0.0.1:8788'), false);
  assert.equal(isDefaultLocalGateway('https://gateway.example:8787'), false);
});
