'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamParser } = require('../src/tool-parser');
const { validateToolCalls } = require('../src/tool-validation');

const tools = [
  {
    name: 'Bash',
    description: 'Test fixture only; this test never executes the command.',
    input_schema: {
      type: 'object',
      required: ['command', 'timeout'],
      properties: {
        command: { type: 'string', minLength: 1 },
        timeout: { type: 'integer', minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
  },
];

test('DSML output becomes JSON tool arguments that pass the client schema', () => {
  const parser = new StreamParser(() => {});
  const dsml = [
    '<｜DSML｜ calls>',
    '<｜DSML｜ invoke name="Bash">',
    '<｜DSML｜ parameter name="command" string="true">echo DSML_TEST_NO_EXECUTION</｜DSML｜ parameter>',
    '<｜DSML｜ parameter name="timeout" string="false">10</｜DSML｜ parameter>',
    '</｜DSML｜ invoke>',
    '</｜DSML｜ calls>',
  ].join('');
  parser.feed(dsml);
  parser.finish();

  const toolCalls = parser.toolCalls();
  assert.deepEqual(toolCalls, [{
    name: 'Bash',
    input: {
      command: 'echo DSML_TEST_NO_EXECUTION',
      timeout: 10,
    },
  }]);
  assert.deepEqual(validateToolCalls(toolCalls, tools), { valid: true, error: null });
  assert.equal(parser.parseErrors.length, 0);
  assert.equal(parser.textOut, '');
});

test('DSML-to-JSON pipeline rejects malformed typed values before schema validation', () => {
  const parser = new StreamParser(() => {});
  parser.feed(
    '<｜DSML｜ calls><｜DSML｜ invoke name="Bash">' +
    '<｜DSML｜ parameter name="command" string="true">echo fixture</｜DSML｜ parameter>' +
    '<｜DSML｜ parameter name="timeout" string="false">ten</｜DSML｜ parameter>' +
    '</｜DSML｜ invoke></｜DSML｜ calls>'
  );
  parser.finish();

  assert.deepEqual(parser.toolCalls(), []);
  assert.equal(parser.parseErrors.length, 1);
  assert.match(parser.parseErrors[0].reason, /invalid JSON/);
});

test('DSML-to-JSON pipeline rejects legacy JSON wrapper without forwarding a call', () => {
  const parser = new StreamParser(() => {});
  parser.feed('<TOOL_CALL>{"tool":"Bash","arguments":{"command":"echo fixture","timeout":10}}</TOOL_CALL>');
  parser.finish();

  const toolCalls = parser.toolCalls();
  assert.deepEqual(toolCalls, []);
  assert.equal(parser.sawUnsupportedToolMarkup, true);
  assert.equal(parser.parseErrors.length, 1);
  assert.deepEqual(validateToolCalls(toolCalls, tools), { valid: true, error: null });
});
