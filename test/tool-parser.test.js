'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamParser, tryParseJSON, extractToolCallsFromText } = require('../src/tool-parser');

test('tryParseJSON parses valid JSON and repairs common invalid backslashes', () => {
  assert.deepEqual(tryParseJSON('{"tool":"Bash","arguments":{"command":"pwd"}}'), { tool: 'Bash', arguments: { command: 'pwd' } });
  assert.deepEqual(tryParseJSON('{tool:"Bash",arguments:{command:"C:\\work"}}'), { tool: 'Bash', arguments: { command: 'C:\\work' } });
});

test('StreamParser keeps regular text and parses tool call split across chunks', () => {
  const emitted = [];
  const parser = new StreamParser((chunk) => emitted.push(chunk));
  parser.feed('Hello. <TOOL_');
  parser.feed('CALL>{"tool":"Bash","arguments":{"command":"pwd"}}</TOOL_CALL> Done.');
  parser.finish();
  assert.equal(emitted.join(''), 'Hello.  Done.');
  assert.deepEqual(parser.toolCalls(), [{ name: 'Bash', input: { command: 'pwd' } }]);
});

test('extractToolCallsFromText removes tool-call markup and returns normalized calls', () => {
  const result = extractToolCallsFromText('Before <TOOL_CALL>{"tool":"Grep","arguments":{"pattern":"abc"}}</TOOL_CALL> After');
  assert.equal(result.text, 'Before  After');
  assert.deepEqual(result.calls, [{ name: 'Grep', input: { pattern: 'abc' } }]);
});


test('parser exposes invalid tool-call markup so the handler can retry instead of silently dropping it', () => {
  const parser = new StreamParser(() => {});
  parser.feed('Before <TOOL_CALL>{"tool":"Bash","arguments":{"command":}}</TOOL_CALL> After');
  parser.finish();
  assert.equal(parser.sawToolMarkup, true);
  assert.equal(parser.incompleteToolBlock, false);
  assert.deepEqual(parser.toolCalls(), []);
});

test('parser can recover a valid JSON tool payload even if the closing marker is missing', () => {
  const parser = new StreamParser(() => {});
  parser.feed('Before <TOOL_CALL>{"tool":"Bash","arguments":{"command":"pwd"}}');
  parser.finish();
  assert.equal(parser.sawToolMarkup, true);
  assert.equal(parser.incompleteToolBlock, true);
  assert.deepEqual(parser.toolCalls(), [{ name: 'Bash', input: { command: 'pwd' } }]);
});
