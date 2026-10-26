'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasNewAssistantResponse, isResponseComplete, shouldUseStableFallback, isIdleCompletionCandidate } = require('../src/turn-state');

test('a user-message count increase alone is not a fresh assistant response', () => {
  assert.equal(hasNewAssistantResponse({ answerKey: 'assistant-1', answer: 'bad output', count: 4 }, { answerKey: 'assistant-1', answer: 'bad output', count: 5 }), false);
});

test('a changed assistant message key identifies the new response', () => {
  assert.equal(hasNewAssistantResponse({ answerKey: 'assistant-1', answer: 'bad output' }, { answerKey: 'assistant-2', answer: '' }), true);
});

test('changed answer text identifies an update when the UI reuses a key', () => {
  assert.equal(hasNewAssistantResponse({ answerKey: 'assistant-1', answer: 'old' }, { answerKey: 'assistant-1', answer: 'new' }), true);
});

test('empty or unchanged assistant content is not treated as a fresh response', () => {
  assert.equal(hasNewAssistantResponse({ answerKey: 'assistant-1', answer: 'same' }, { answerKey: 'assistant-1', answer: '' }), false);
  assert.equal(hasNewAssistantResponse({ answerKey: 'assistant-1', answer: 'same' }, { answerKey: 'assistant-1', answer: 'same' }), false);
});

test('explicit UI completion requires a known signal, no active generation, and an enabled send button', () => {
  assert.equal(isResponseComplete({
    isGenerating: false,
    sendButtonEnabled: true,
  }, true), true);

  assert.equal(isResponseComplete({
    isGenerating: false,
    sendButtonEnabled: true,
  }, false), false);

  assert.equal(isResponseComplete({
    isGenerating: true,
    sendButtonEnabled: false,
  }, true), false);

  assert.equal(isResponseComplete({
    isGenerating: false,
    sendButtonEnabled: false,
  }, true), false);
});


test('stable fallback waits longer and defers to available completion controls', () => {
  const unavailable = { completionSignalAvailable: false };
  assert.equal(shouldUseStableFallback(unavailable, false, 3999, 2000), false);
  assert.equal(shouldUseStableFallback(unavailable, false, 4000, 2000), true);
  assert.equal(shouldUseStableFallback({ completionSignalAvailable: true }, false, 9000, 2000), false);
  assert.equal(shouldUseStableFallback(unavailable, true, 9000, 2000), false);
  assert.equal(shouldUseStableFallback({ completionSignalAvailable: false, isGenerating: false }, true, 4000, 2000), true);
  assert.equal(shouldUseStableFallback({ completionSignalAvailable: false, isGenerating: true }, true, 9000, 2000), false);
});


test('idle completion can be inferred from available UI controls after a stable interval', () => {
  const complete = {
    completionSignalAvailable: true,
    isGenerating: false,
    sendButtonEnabled: true,
  };
  assert.equal(isIdleCompletionCandidate(complete, false, 3999, 2000), false);
  assert.equal(isIdleCompletionCandidate(complete, false, 4000, 2000), true);
  assert.equal(isIdleCompletionCandidate({ ...complete, isGenerating: true }, false, 9000, 2000), false);
  assert.equal(isIdleCompletionCandidate({ ...complete, sendButtonEnabled: false }, false, 9000, 2000), false);
  assert.equal(isIdleCompletionCandidate(complete, true, 9000, 2000), false);
});
