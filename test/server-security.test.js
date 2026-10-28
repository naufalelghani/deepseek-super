'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../src/server');
const { AUTH_TOKEN } = require('../src/config');

function request(port, { method = 'GET', path = '/v1/models', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('server rejects requests without a valid token, including the health route', async (t) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const response = await request(port);
  assert.equal(response.status, 401);
  assert.match(response.body, /Invalid API token/);

  const health = await request(port, { method: 'HEAD', path: '/api/hello' });
  assert.equal(health.status, 401);
});

test('server accepts a valid token for model discovery', async (t) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const response = await request(port, {
    headers: { Authorization: 'Bearer ' + AUTH_TOKEN },
  });
  assert.equal(response.status, 200);
  const catalog = JSON.parse(response.body);
  const models = catalog.data;
  assert.deepEqual(models.map(({ id, display_name, line }) => ({ id, display_name, line })), [
    { id: 'deepseek-super', display_name: 'Deepseek Super', line: 'sonnet' },
    { id: 'claude-mythos-5.1', display_name: 'Mythos 5.1', line: 'opus' },
    { id: 'claude-fable-5.1', display_name: 'Fable 5.1', line: 'sonnet' },
    { id: 'claude-opus-5-5', display_name: 'Opus 5.5', line: 'opus' },
    { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5', line: 'sonnet' },
    { id: 'claude-haiku-5-5', display_name: 'Haiku 5.5', line: 'haiku' },
  ]);
  assert.ok(models.every(({ display_name }) => !/\bClaude\b/i.test(display_name)),
    'display names should not include the Claude prefix');
  assert.equal(catalog.first_id, 'deepseek-super');
  assert.equal(catalog.last_id, 'claude-haiku-5-5');
  for (const model of models) {
    assert.equal(model.capabilities.effort.supported, true);
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.equal(model.capabilities.effort[level].supported, true, model.id + ' should advertise ' + level);
    }
  }
});

test('server rejects unexpected Host headers and cross-origin browser calls', async (t) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const badHost = await request(port, {
    headers: { Host: 'attacker.example:' + port, Authorization: 'Bearer ' + AUTH_TOKEN },
  });
  assert.equal(badHost.status, 421);

  const badOrigin = await request(port, {
    headers: {
      Origin: 'https://attacker.example',
      Authorization: 'Bearer ' + AUTH_TOKEN,
    },
  });
  assert.equal(badOrigin.status, 403);
});

test('preflight advertises only a specific allowed local origin, never a wildcard', async (t) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const origin = 'http://localhost:' + port;

  const response = await request(port, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], origin);
  assert.ok(!String(response.headers['access-control-allow-origin']).includes('*'));

  const rejected = await request(port, {
    method: 'OPTIONS',
    headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(rejected.status, 403);
});
