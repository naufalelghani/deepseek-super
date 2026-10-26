'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAgainstSchema, validateToolCalls } = require('../src/tool-validation');

test('validates required fields and primitive types recursively', () => {
  const schema = {
    type: 'object',
    required: ['command', 'flags'],
    properties: {
      command: { type: 'string', minLength: 1 },
      flags: {
        type: 'array',
        items: { type: 'boolean' },
      },
    },
  };

  assert.equal(validateAgainstSchema({ command: 'pwd', flags: [true, false] }, schema), null);
  assert.match(validateAgainstSchema({ command: '', flags: [true, 1] }, schema), /at least 1 character/);
  assert.match(validateAgainstSchema({ flags: [] }, schema), /command is required/);
});

test('supports enum, additionalProperties, and numeric bounds', () => {
  assert.equal(validateAgainstSchema('read', { enum: ['read', 'write'] }), null);
  assert.match(validateAgainstSchema('execute', { enum: ['read', 'write'] }), /enum values/);
  assert.match(validateAgainstSchema({ x: 1, extra: true }, {
    type: 'object',
    properties: { x: { type: 'number', minimum: 0 } },
    additionalProperties: false,
  }), /extra is not allowed/);
  assert.match(validateAgainstSchema(11, { type: 'integer', maximum: 10 }), /less than or equal/);
});

test('rejects undeclared tools and non-object arguments', () => {
  const tools = [{
    name: 'Read',
    input_schema: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' } } },
  }];

  assert.deepEqual(validateToolCalls([{ name: 'Write', input: {} }], tools), {
    valid: false,
    error: 'Tool name "Write" was not declared in this request.',
  });
  assert.match(validateToolCalls([{ name: 'Read', input: 'file.txt' }], tools).error, /must be a JSON object/);
});

test('validates every call before forwarding a multi-tool response', () => {
  const tools = [
    { name: 'Read', input_schema: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' } } } },
    { name: 'Bash', input_schema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } },
  ];

  assert.deepEqual(validateToolCalls([
    { name: 'Read', input: { file_path: 'package.json' } },
    { name: 'Bash', input: { command: 'pwd' } },
  ], tools), { valid: true, error: null });

  assert.match(validateToolCalls([
    { name: 'Read', input: { file_path: 'package.json' } },
    { name: 'Bash', input: {} },
  ], tools).error, /Bash.arguments.command is required/);
});
