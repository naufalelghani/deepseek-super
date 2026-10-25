'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { locked } = require('../src/browser');
const { MAX_PENDING_TURNS } = require('../src/config');

test('browser queue is serialized and rejects work beyond its configured bound', async () => {
  let releaseFirst;
  let started = 0;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const queued = Array.from({ length: MAX_PENDING_TURNS }, (_, index) =>
    locked(async () => {
      started++;
      if (index === 0) await firstGate;
      return index;
    })
  );

  assert.throws(
    () => locked(async () => 'overloaded'),
    (error) => error.statusCode === 503 && error.type === 'overloaded_error'
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1, 'only one browser turn should be active at a time');

  releaseFirst();
  const results = await Promise.all(queued);
  assert.deepEqual(results, Array.from({ length: MAX_PENDING_TURNS }, (_, index) => index));
});
