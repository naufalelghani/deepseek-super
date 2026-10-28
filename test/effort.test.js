'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EFFORT_LEVELS, effortPrompt, effortCapabilities } = require('../src/effort');

test('advertises every supported effort level', () => {
  const capabilities = effortCapabilities();
  assert.equal(capabilities.supported, true);
  assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const level of EFFORT_LEVELS) {
    assert.equal(capabilities[level].supported, true);
  }
});

test('translates selected effort into explicit prompt guidance', () => {
  for (const level of EFFORT_LEVELS) {
    const prompt = effortPrompt(level);
    assert.ok(prompt.includes('effort="' + level + '"'));
    assert.ok(prompt.includes('does not change DeepSeek model weights'));
    assert.ok(prompt.includes('tool-call protocol'));
  }
  assert.equal(effortPrompt(undefined), '');
  assert.equal(effortPrompt('unknown'), '');
});
