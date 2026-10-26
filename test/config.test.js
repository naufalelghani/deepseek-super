'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBoundedInteger } = require('../src/config');

test('numeric configuration parser rejects invalid, fractional, and out-of-range values', () => {
  assert.equal(parseBoundedInteger('8787', 1, 65535), 8787);
  assert.equal(parseBoundedInteger(undefined, 1, 65535), null);
  assert.equal(parseBoundedInteger('', 1, 65535), null);
  assert.equal(parseBoundedInteger('8787junk', 1, 65535), null);
  assert.equal(parseBoundedInteger('8787.5', 1, 65535), null);
  assert.equal(parseBoundedInteger('0', 1, 65535), null);
  assert.equal(parseBoundedInteger('65536', 1, 65535), null);
  assert.equal(parseBoundedInteger('1024', 8192, 1000000), null);
  assert.equal(parseBoundedInteger('NaN', 1, 65535), null);
});
