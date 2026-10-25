'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  safeEqualToken,
  isAllowedHost,
  isAllowedOrigin
} = require('../src/http-utils');
const { AUTH_TOKEN } = require('../src/config');

test('API token comparisons accept a matching token and reject a mismatch', () => {
  assert.equal(safeEqualToken(AUTH_TOKEN), true);
  assert.equal(safeEqualToken(AUTH_TOKEN + 'x'), false);
  assert.equal(safeEqualToken(undefined), false);
});

test('Host validation only accepts loopback names and the active port', () => {
  assert.equal(isAllowedHost('127.0.0.1:8787', 8787), true);
  assert.equal(isAllowedHost('localhost:8787', 8787), true);
  assert.equal(isAllowedHost('[::1]:8787', 8787), true);
  assert.equal(isAllowedHost('attacker.example:8787', 8787), false);
  assert.equal(isAllowedHost('localhost:9999', 8787), false);
});

test('Origin validation allows same-port loopback and rejects arbitrary websites', () => {
  assert.equal(isAllowedOrigin(undefined, 8787), true);
  assert.equal(isAllowedOrigin('http://localhost:8787', 8787), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:8787', 8787), true);
  assert.equal(isAllowedOrigin('https://attacker.example', 8787), false);
  assert.equal(isAllowedOrigin('null', 8787), false);
});

test('explicit CORS allowlist can add a trusted front-end origin', () => {
  const previous = process.env.CORS_ALLOWED_ORIGINS;
  process.env.CORS_ALLOWED_ORIGINS = 'https://trusted.example, http://localhost:3000';
  try {
    assert.equal(isAllowedOrigin('https://trusted.example', 8787), true);
    assert.equal(isAllowedOrigin('https://other.example', 8787), false);
  } finally {
    if (previous === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previous;
  }
});
