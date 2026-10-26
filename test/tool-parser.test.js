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
  const fenced = '```json\n{"tool":"Bash","arguments":{"command":"pwd"}}\n```';
  assert.deepEqual(tryParseJSON(fenced), { tool: 'Bash', arguments: { command: 'pwd' } });
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

test('StreamParser preserves a closing marker split across chunks', () => {
  const emitted = [];
  const parser = new StreamParser((chunk) => emitted.push(chunk));
  const input = { tool: 'Bash', arguments: { command: 'pwd', note: 'this is extra padding to ensure the payload is longer than the parser holdback suffix' } };
  const payload = JSON.stringify(input);
  parser.feed('<TOOL_CALL>' + payload + '</TOOL_');
  parser.feed('CALL>');
  parser.finish();
  assert.equal(parser.incompleteToolBlock, false);
  assert.deepEqual(parser.toolCalls(), [{ name: 'Bash', input: input.arguments }]);
  assert.equal(emitted.join(''), '');
});

test('StreamParser preserves held payload when the closing marker is missing', () => {
  const parser = new StreamParser(() => {});
  parser.feed('<TOOL_CALL>' + JSON.stringify({ tool: 'Bash', arguments: { command: 'pwd' } }));
  parser.finish();
  assert.equal(parser.incompleteToolBlock, true);
  assert.deepEqual(parser.toolCalls(), [{ name: 'Bash', input: { command: 'pwd' } }]);
});

test('extractToolCallsFromText removes tool-call markup and returns normalized calls', () => {
  const result = extractToolCallsFromText('Before <TOOL_CALL>{"tool":"Grep","arguments":{"pattern":"abc"}}</TOOL_CALL> After');
  assert.equal(result.text, 'Before  After');
  assert.deepEqual(result.calls, [{ name: 'Grep', input: { pattern: 'abc' } }]);
});


test('parser exposes invalid tool-call markup so the handler can retry instead of silently dropping it', () => {
  const parser = new StreamParser(() => {});
  const invalidPayload = '{"tool":"Bash","arguments":{"command":}}';
  parser.feed('Before <TOOL_CALL>' + invalidPayload + '</TOOL_CALL> After');
  parser.finish();
  assert.equal(parser.sawToolMarkup, true);
  assert.equal(parser.incompleteToolBlock, false);
  assert.deepEqual(parser.toolCalls(), []);
  assert.equal(parser.parseErrors.length, 1);
  assert.equal(parser.parseErrors[0].chars, invalidPayload.length);
  assert.ok(parser.parseErrors[0].reason);
});

test('parser can recover a valid JSON tool payload even if the closing marker is missing', () => {
  const parser = new StreamParser(() => {});
  parser.feed('Before <TOOL_CALL>{"tool":"Bash","arguments":{"command":"pwd"}}');
  parser.finish();
  assert.equal(parser.sawToolMarkup, true);
  assert.equal(parser.incompleteToolBlock, true);
  assert.deepEqual(parser.toolCalls(), [{ name: 'Bash', input: { command: 'pwd' } }]);
});


test('parser rejects scalar or array tool arguments instead of coercing them into objects', () => {
  const parser = new StreamParser(() => {});
  parser.feed('<TOOL_CALL>{"tool":"Bash","arguments":"pwd"}</TOOL_CALL>');
  parser.finish();
  assert.deepEqual(parser.toolCalls(), []);
  assert.equal(parser.parseErrors.length, 1);

  const arrayParser = new StreamParser(() => {});
  arrayParser.feed('<TOOL_CALL>{"tool":"Read","arguments":["file.txt"]}</TOOL_CALL>');
  arrayParser.finish();
  assert.deepEqual(arrayParser.toolCalls(), []);
  assert.equal(arrayParser.parseErrors.length, 1);
});


test('parser exposes errors in mixed valid and invalid tool batches', () => {
  const parser = new StreamParser(() => {});
  parser.feed('<TOOL_CALL>[{"tool":"Read","arguments":{"file_path":"a.txt"}},{"tool":"Bash","arguments":"bad"}]</TOOL_CALL>');
  parser.finish();

  assert.deepEqual(parser.toolCalls(), [{ name: 'Read', input: { file_path: 'a.txt' } }]);
  assert.equal(parser.parseErrors.length, 1);
});


test('tool argument normalization does not mutate prototypes from JSON input', () => {
  const parser = new StreamParser(() => {});
  parser.feed('<TOOL_CALL>{"tool":"Bash","arguments":{"__proto__":{"polluted":true},"command":"pwd"}}</TOOL_CALL>');
  parser.finish();

  const calls = parser.toolCalls();
  assert.equal(calls.length, 1);
  assert.equal(Object.getPrototypeOf(calls[0].input), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].input, '__proto__'), true);
});


test('StreamParser parses DeepSeek V4.1 DSML calls and raw string parameters', () => {
  const parser = new StreamParser(() => {});
  const input = [
    '<｜DSML｜ calls>',
    '<｜DSML｜ invoke name="Bash">',
    '<｜DSML｜ parameter name="command" string="true">ls -la "docs" && echo done</｜DSML｜ parameter>',
    '</｜DSML｜ invoke>',
    '<｜DSML｜ invoke name="Read">',
    '<｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter>',
    '<｜DSML｜ parameter name="options" string="false">{"start":1,"enabled":true}</｜DSML｜ parameter>',
    '</｜DSML｜ invoke>',
    '</｜DSML｜ calls>',
  ].join('\n');
  for (let i = 0; i < input.length; i += 11) parser.feed(input.slice(i, i + 11));
  parser.finish();

  assert.deepEqual(parser.toolCalls(), [
    { name: 'Bash', input: { command: 'ls -la "docs" && echo done' } },
    { name: 'Read', input: { file_path: 'README.md', options: { start: 1, enabled: true } } },
  ]);
  assert.equal(parser.parseErrors.length, 0);
  assert.equal(parser.textOut, '');
});

test('StreamParser accepts DeepSeek V4 tool_calls spelling and duplicated DSML bars', () => {
  const parser = new StreamParser(() => {});
  parser.feed('<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="Bash"><｜｜DSML｜｜parameter name="command" string="true">pwd</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>');
  parser.finish();

  assert.deepEqual(parser.toolCalls(), [{ name: 'Bash', input: { command: 'pwd' } }]);
  assert.equal(parser.parseErrors.length, 0);
});

test('StreamParser parses DSML and rejects malformed non-string parameter JSON', () => {
  const parser = new StreamParser(() => {});
  parser.feed('<｜DSML｜ calls><｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command" string="false">not-json</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>');
  parser.finish();

  assert.deepEqual(parser.toolCalls(), []);
  assert.equal(parser.parseErrors.length, 1);
  assert.match(parser.parseErrors[0].reason, /invalid JSON/);
});

test('StreamParser ignores stray DSML closing tags after legacy tool blocks', () => {
  const parser = new StreamParser(() => {});
  parser.feed('<TOOL_CALL>[{"tool":"Bash","arguments":{"command":"echo one"}}]</TOOL_CALL>');
  parser.feed('<TOOL_CALL>[{"tool":"Bash","arguments":{"command":"echo two"}}]</TOOL_CALL>');
  parser.feed('</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>');
  parser.finish();

  assert.deepEqual(parser.toolCalls(), [
    { name: 'Bash', input: { command: 'echo one' } },
    { name: 'Bash', input: { command: 'echo two' } },
  ]);
  assert.equal(parser.textOut.trim(), '');
  assert.equal(parser.parseErrors.length, 0);
});


test('extractToolCallsFromText recovers a complete DSML invoke when the calls wrapper is missing', () => {
  const text = 'Before <｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter></｜DSML｜ invoke> After';
  const result = extractToolCallsFromText(text);

  assert.deepEqual(result.calls, [{ name: 'Bash', input: { command: 'pwd' } }]);
  assert.equal(result.text, 'Before  After');
  assert.deepEqual(result.errors, []);
});
