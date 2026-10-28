'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { blocksOf, flattenContent, renderMessage, sessionKey, truncateReplay, truncateTextPreservingEnds } = require('../src/content');
const { approxTokens, MAX_REPLAY } = require('../src/config');

test('blocksOf normalizes strings and handles empty content', () => {
  assert.deepEqual(blocksOf('hello'), [{ type: 'text', text: 'hello' }]);
  assert.deepEqual(blocksOf(null), []);
  assert.deepEqual(blocksOf([{ type: 'text', text: 'x' }]), [{ type: 'text', text: 'x' }]);
});

test('flattenContent and renderMessage preserve supported textual content', () => {
  assert.equal(flattenContent([{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }]), 'hello');
  assert.match(renderMessage({ content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] }), /Tool call Bash/);
  assert.match(renderMessage({ content: [{ type: 'image' }] }), /image unsupported/);
});

test('sessionKey is stable for the same leading system and user messages', () => {
  const messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
  assert.equal(sessionKey('system', messages), sessionKey('system', messages));
  assert.notEqual(sessionKey('system', messages), sessionKey('different', messages));
});

test('truncateReplay caps very long replay prompts and token estimate is positive', () => {
  const long = 'x'.repeat(65000);
  const replay = truncateReplay(long);
  assert.ok(replay.length <= MAX_REPLAY);
  assert.ok(replay.length < long.length);
  assert.match(replay, /WARNING: conversation replay was truncated/);
  assert.equal(approxTokens('hello'), 2);
});

test('sessionKey hashes the full first user message instead of a truncated prefix', () => {
  const prefix = 'x'.repeat(900);
  const a = [{ role: 'user', content: prefix + 'A' }];
  const b = [{ role: 'user', content: prefix + 'B' }];
  assert.notEqual(sessionKey('', a), sessionKey('', b));
});

test('oversized structured prompts preserve project policy, tool schemas, and the latest request', () => {
  const system = '### SYSTEM\\nSYSTEM_HEAD_MARKER\\n' +
    'system context '.repeat(MAX_REPLAY) +
    '\\nSYSTEM_TAIL_MARKER';
  const policy = [
    '### ASSISTANT IDENTITY',
    'IDENTITY_POLICY_MARKER',
    '### CONVERSATION LANGUAGE',
    'Respond in the language the user is currently using.',
    '### WRITING STYLE AND HUMANIZER',
    'EM DASH BAN: Never insert U+2014.',
  ].join('\\n');
  const history = '\\n\\n### CONVERSATION HISTORY\\nHISTORY_HEAD_MARKER\\n' +
    'old conversation '.repeat(MAX_REPLAY) +
    'HISTORY_TAIL_MARKER';
  const tools = '\\n\\n### TOOLS\\nTOOL_SCHEMA_SENTINEL: Bash(command*: string)';
  const latest = '\\n\\n### LATEST USER MESSAGE\\nLATEST_REQUEST_SENTINEL: inspect src/handler.js';
  const replay = truncateReplay(system + '\\n\\n' + policy + history + tools + latest);

  assert.ok(replay.length <= MAX_REPLAY);
  assert.match(replay, /SYSTEM_HEAD_MARKER/);
  assert.match(replay, /SYSTEM_TAIL_MARKER/);
  assert.match(replay, /EM DASH BAN/);
  assert.match(replay, /TOOL_SCHEMA_SENTINEL/);
  assert.match(replay, /LATEST_REQUEST_SENTINEL/);
  assert.match(replay, /WARNING: conversation replay was truncated/);
});

test('oversized latest tool results retain both ends, next-step tool schema, and continuation instructions', () => {
  const system = '### SYSTEM\\n' + 'large-system '.repeat(MAX_REPLAY * 2);
  const policy = [
    '### ASSISTANT IDENTITY',
    'policy',
    '### CONVERSATION LANGUAGE',
    'Respond in the language the user is currently using.',
    '### WRITING STYLE AND HUMANIZER',
    'EM DASH BAN: Never insert U+2014.',
  ].join('\\n');
  const result = 'RESULT_BEGIN_MARKER\\n' +
    'long tool output '.repeat(MAX_REPLAY) +
    '\\nRESULT_END_MARKER';
  const tail = [
    '=== SITUATION ===',
    'Continue the task using the latest result.',
    '=== LATEST TOOL RESULTS ===',
    result,
    '=== TOOLS AVAILABLE FOR THE NEXT STEP ===',
    'NEXT_STEP_TOOL_SCHEMA: Read(file_path*: string)',
    '=== INSTRUCTIONS AFTER TOOL RESULTS ===',
    'If the task is not complete, call the next required tool.',
  ].join('\\n');
  const replay = truncateReplay(system + '\\n\\n' + policy + '\\n\\n' + tail);

  assert.ok(replay.length <= MAX_REPLAY);
  assert.match(replay, /EM DASH BAN/);
  assert.match(replay, /RESULT_BEGIN_MARKER/);
  assert.match(replay, /RESULT_END_MARKER/);
  assert.match(replay, /NEXT_STEP_TOOL_SCHEMA/);
  assert.match(replay, /If the task is not complete, call the next required tool/);
  assert.match(replay, /WARNING: conversation replay was truncated/);
});


test('truncateTextPreservingEnds retains the beginning and ending of oversized content', () => {
  const text = 'BEGIN_MARKER_' + 'x'.repeat(10000) + '_END_MARKER';
  const truncated = truncateTextPreservingEnds(text, 1024);
  assert.equal(truncated.length, 1024);
  assert.match(truncated, /^BEGIN_MARKER/);
  assert.match(truncated, /_END_MARKER$/);
  assert.match(truncated, /content truncated/);
});
