'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamParser, tryParseJSON, extractToolCallsFromText } = require('../src/tool-parser');

test('tryParseJSON parses valid JSON and repairs common invalid backslashes', () => {
  assert.deepEqual(tryParseJSON('{"tool":"Bash","arguments":{"command":"pwd"}}'), { tool: 'Bash', arguments: { command: 'pwd' } });
  assert.deepEqual(tryParseJSON('{tool:"Bash",arguments:{command:"C:\\work"}}'), { tool: 'Bash', arguments: { command: 'C:\\work' } });
});

test('tryParseJSON recovers unescaped quotes embedded inside a shell command', () => {
  const malformed = '{"tool":"Bash","arguments":{"command":"cd "C:/path" && ls"}}';
  assert.deepEqual(tryParseJSON(malformed), {
    tool: 'Bash',
    arguments: { command: 'cd "C:/path" && ls' },
  });
});

test('tryParseJSON strips accidental JSON code fences', () => {
  const fenced = '\x60\x60\x60json\n{"tool":"Bash","arguments":{"command":"pwd"}}\n\x60\x60\x60';
  assert.deepEqual(tryParseJSON(fenced), { tool: 'Bash', arguments: { command: 'pwd' } });
});

test('StreamParser keeps regular text and parses DSML calls split across chunks', () => {
  const emitted = [];
  const parser = new StreamParser((chunk) => emitted.push(chunk));
  parser.feed('Hello. <｜DSML｜ ca');
  parser.feed('lls><｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ cal');
  parser.feed('ls> Done.');
  parser.finish();

  assert.equal(emitted.join(''), 'Hello.  Done.');
  assert.deepEqual(parser.toolCalls(), [{ name: 'Bash', input: { command: 'pwd' } }]);
  assert.equal(parser.parseErrors.length, 0);
});

test('StreamParser preserves a DSML closing marker split across chunks', () => {
  const emitted = [];
  const parser = new StreamParser((chunk) => emitted.push(chunk));
  const input = '<｜DSML｜ calls><｜DSML｜ invoke name="Bash">' +
    '<｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter>' +
    '<｜DSML｜ parameter name="note" string="true">padding keeps the close marker beyond the parser holdback suffix</｜DSML｜ parameter>' +
    '</｜DSML｜ invoke></｜DSML｜ cal';
  parser.feed(input);
  parser.feed('ls>');
  parser.finish();

  assert.equal(parser.incompleteToolBlock, false);
  assert.deepEqual(parser.toolCalls(), [{
    name: 'Bash',
    input: {
      command: 'pwd',
      note: 'padding keeps the close marker beyond the parser holdback suffix',
    },
  }]);
  assert.equal(emitted.join(''), '');
});

test('StreamParser parses DeepSeek V4.1 DSML calls with raw strings and typed JSON parameters', () => {
  const parser = new StreamParser(() => {});
  const input = [
    '<｜DSML｜ calls>',
    '<｜DSML｜ invoke name="Bash">',
    '<｜DSML｜ parameter name="command" string="true">ls -la "docs" && echo done</｜DSML｜ parameter>',
    '</｜DSML｜ invoke>',
    '<｜DSML｜ invoke name="Read">',
    '<｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter>',
    '<｜DSML｜ parameter name="options" string="false">{"start":1,"enabled":true}</｜DSML｜ parameter>',
    '<｜DSML｜ parameter name="tags" string="false">["alpha","beta"]</｜DSML｜ parameter>',
    '</｜DSML｜ invoke>',
    '</｜DSML｜ calls>',
  ].join('\n');
  for (let i = 0; i < input.length; i += 11) parser.feed(input.slice(i, i + 11));
  parser.finish();

  assert.deepEqual(parser.toolCalls(), [
    { name: 'Bash', input: { command: 'ls -la "docs" && echo done' } },
    { name: 'Read', input: { file_path: 'README.md', options: { start: 1, enabled: true }, tags: ['alpha', 'beta'] } },
  ]);
  assert.equal(parser.parseErrors.length, 0);
  assert.equal(parser.textOut, '');
});

test('StreamParser accepts DeepSeek V4 tool_calls spelling and alternate DSML bar rendering', () => {
  const parser = new StreamParser(() => {});
  parser.feed('<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="Bash"><｜｜DSML｜｜parameter name="command" string="true">pwd</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>');
  parser.finish();

  assert.deepEqual(parser.toolCalls(), [{ name: 'Bash', input: { command: 'pwd' } }]);
  assert.equal(parser.parseErrors.length, 0);
});

test('StreamParser reports malformed non-string DSML parameter JSON instead of coercing it to text', () => {
  const parser = new StreamParser(() => {});
  parser.feed('<｜DSML｜ calls><｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command" string="false">not-json</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>');
  parser.finish();

  assert.deepEqual(parser.toolCalls(), []);
  assert.equal(parser.parseErrors.length, 1);
  assert.match(parser.parseErrors[0].reason, /invalid JSON/);
});

test('StreamParser reports a mixed valid and invalid DSML batch for all-or-nothing recovery', () => {
  const parser = new StreamParser(() => {});
  parser.feed('<｜DSML｜ calls>' +
    '<｜DSML｜ invoke name="Read"><｜DSML｜ parameter name="file_path" string="true">a.txt</｜DSML｜ parameter></｜DSML｜ invoke>' +
    '<｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command" string="false">not-json</｜DSML｜ parameter></｜DSML｜ invoke>' +
    '</｜DSML｜ calls>');
  parser.finish();

  assert.deepEqual(parser.toolCalls(), [{ name: 'Read', input: { file_path: 'a.txt' } }]);
  assert.equal(parser.parseErrors.length, 1);
});

test('DSML JSON parameters do not pollute object prototypes', () => {
  const parser = new StreamParser(() => {});
  parser.feed('<｜DSML｜ calls><｜DSML｜ invoke name="Bash">' +
    '<｜DSML｜ parameter name="__proto__" string="false">{"polluted":true}</｜DSML｜ parameter>' +
    '<｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter>' +
    '</｜DSML｜ invoke></｜DSML｜ calls>');
  parser.finish();

  const calls = parser.toolCalls();
  assert.equal(calls.length, 1);
  assert.equal(Object.getPrototypeOf(calls[0].input), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].input, '__proto__'), true);
});

test('extractToolCallsFromText removes DSML markup and returns normalized JSON arguments', () => {
  const result = extractToolCallsFromText('Before <｜DSML｜tool_calls><｜DSML｜invoke name="Grep"><｜DSML｜parameter name="pattern" string="true">abc</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls> After');
  assert.equal(result.text, 'Before  After');
  assert.deepEqual(result.calls, [{ name: 'Grep', input: { pattern: 'abc' } }]);
  assert.deepEqual(result.errors, []);
});

test('extractToolCallsFromText recovers a complete DSML invoke when the calls wrapper is missing', () => {
  const text = 'Before <｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter></｜DSML｜ invoke> After';
  const result = extractToolCallsFromText(text);

  assert.deepEqual(result.calls, [{ name: 'Bash', input: { command: 'pwd' } }]);
  assert.equal(result.text, 'Before  After');
  assert.deepEqual(result.errors, []);
});

test('legacy TOOL_CALL JSON is rejected and never converted into a tool call', () => {
  const parser = new StreamParser(() => {});
  parser.feed('Before <TOOL_CALL>{"tool":"Bash","arguments":{"command":"pwd"}}</TOOL_CALL> After');
  parser.finish();

  assert.deepEqual(parser.toolCalls(), []);
  assert.equal(parser.sawUnsupportedToolMarkup, true);
  assert.equal(parser.parseErrors.length, 1);
  assert.match(parser.parseErrors[0].reason, /Legacy <TOOL_CALL> JSON is disabled/);
  assert.equal(parser.textOut, 'Before  After');

  const result = extractToolCallsFromText('<TOOL_CALL>{"tool":"Bash","arguments":{"command":"pwd"}}</TOOL_CALL>');
  assert.deepEqual(result.calls, []);
  assert.equal(result.text, '');
  assert.equal(result.errors.length, 1);
});

test('incomplete DSML wrappers retain parseable invokes for bounded recovery', () => {
  const parser = new StreamParser(() => {});
  parser.feed('Before <｜DSML｜ calls><｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter></｜DSML｜ invoke>');
  parser.finish();

  assert.equal(parser.incompleteToolBlock, true);
  assert.deepEqual(parser.toolCalls(), [{ name: 'Bash', input: { command: 'pwd' } }]);
});
