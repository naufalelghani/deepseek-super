'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore, sanitizeDetails } = require('../src/state-store');

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-super-state-'));
  return {
    directory,
    databasePath: path.join(directory, 'state.sqlite3'),
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('SQLite state persists sessions and records thread rotation across process restarts', () => {
  const temporary = temporaryDatabase();
  let store;
  try {
    store = createStateStore({ databasePath: temporary.databasePath, sessionTtlMs: 60000 });
    const first = store.ensureSession('conversation-fingerprint');
    assert.equal(first.created, true);
    assert.ok(first.sessionId);
    assert.equal(first.url, null);

    const firstThread = store.setSession(
      'conversation-fingerprint',
      'https://chat.deepseek.com/chat/first',
      { messageCount: 3 }
    );
    assert.equal(firstThread.generation, 1);
    assert.ok(firstThread.threadId);

    const requestId = 'req_test_001';
    const messageId = 'msg_test_001';
    store.recordRequestStart({
      requestId,
      messageId,
      model: 'claude-mythos-5-1',
      stream: true,
      messageCount: 41,
      clientToolCount: 4,
    });
    store.linkRequestToSession(requestId, firstThread, {
      resumed: false,
      rotationReason: 'message_limit',
    });
    store.recordPromptMetrics(requestId, {
      inputPromptChars: 126574,
      replayPromptChars: 60000,
      finalPromptChars: 61000,
      omittedPromptChars: 66574,
      truncated: true,
    });

    const secondThread = store.setSession(
      'conversation-fingerprint',
      'https://chat.deepseek.com/chat/second',
      { rotationReason: 'message_limit', messageCount: 41 }
    );
    assert.equal(secondThread.sessionId, first.sessionId);
    assert.equal(secondThread.generation, 2);
    assert.notEqual(secondThread.threadId, firstThread.threadId);

    store.linkRequestToSession(requestId, secondThread, {
      resumed: false,
      rotationReason: 'message_limit',
    });
    store.finishRequest({
      requestId,
      status: 'completed',
      stopReason: 'tool_use',
      toolCallCount: 2,
      completionSource: 'ui_explicit',
    });
    store.recordEvent({
      requestId,
      sessionId: first.sessionId,
      threadId: secondThread.threadId,
      type: 'test.sanitization',
      details: {
        prompt_chars: 60000,
        authorization: 'Bearer should-never-be-stored',
        raw_prompt: 'private prompt should never be stored',
      },
    });

    const threads = store.listThreads(first.sessionId);
    assert.equal(threads.length, 2);
    assert.equal(threads[0].status, 'archived');
    assert.equal(threads[0].rotationReason, 'initial');
    assert.equal(threads[1].status, 'active');
    assert.equal(threads[1].rotationReason, 'message_limit');

    const request = store.getRequest(requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.session_id, first.sessionId);
    assert.equal(request.thread_id, secondThread.threadId);
    assert.equal(request.input_prompt_chars, 126574);
    assert.equal(request.omitted_prompt_chars, 66574);
    assert.equal(request.completion_source, 'ui_explicit');

    const events = store.listEvents(requestId);
    const sanitized = events.find((event) => event.type === 'test.sanitization');
    assert.ok(sanitized);
    assert.equal(sanitized.details.prompt_chars, 60000);
    assert.equal(sanitized.details.authorization, '[redacted]');
    assert.equal(sanitized.details.raw_prompt, '[redacted]');
    store.close();
    store = null;

    store = createStateStore({ databasePath: temporary.databasePath, sessionTtlMs: 60000 });
    const restored = store.getSession('conversation-fingerprint');
    assert.equal(restored.sessionId, first.sessionId);
    assert.equal(restored.url, 'https://chat.deepseek.com/chat/second');
    assert.equal(restored.threadId, secondThread.threadId);
    assert.equal(restored.generation, 2);
  } finally {
    if (store) store.close();
    temporary.cleanup();
  }
});

test('expired session keys start a new session while preserving old trace rows', () => {
  const temporary = temporaryDatabase();
  let currentTime = 1000;
  let store;
  try {
    store = createStateStore({
      databasePath: temporary.databasePath,
      sessionTtlMs: 100,
      now: () => currentTime,
    });
    const original = store.ensureSession('repeatable-key');
    store.setSession('repeatable-key', 'https://chat.deepseek.com/chat/old');
    currentTime = 1200;

    const replacement = store.ensureSession('repeatable-key');
    assert.equal(replacement.created, true);
    assert.notEqual(replacement.sessionId, original.sessionId);

    const oldSession = store.db.prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get(original.sessionId);
    const oldThread = store.listThreads(original.sessionId)[0];
    assert.equal(oldSession.status, 'expired');
    assert.equal(oldThread.status, 'expired');
    assert.equal(store.getSession('repeatable-key').sessionId, replacement.sessionId);
  } finally {
    if (store) store.close();
    temporary.cleanup();
  }
});

test('trace details redact secret-bearing keys without dropping safe metrics', () => {
  const details = sanitizeDetails({
    prompt_chars: 50000,
    authorization: 'Bearer secret',
    api_token: 'private',
    raw_prompt: 'full prompt text',
    content: 'private content',
    model: 'claude-mythos-5-1',
  });
  assert.equal(details.prompt_chars, 50000);
  assert.equal(details.authorization, '[redacted]');
  assert.equal(details.api_token, '[redacted]');
  assert.equal(details.raw_prompt, '[redacted]');
  assert.equal(details.content, '[redacted]');
  assert.equal(details.model, 'claude-mythos-5-1');
});
