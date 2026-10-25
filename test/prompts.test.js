'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toolsToPrompt } = require('../src/prompts');

test('tool prompt contains an unambiguous valid JSON example', () => {
  const prompt = toolsToPrompt([{
    name: 'Bash',
    description: 'Run shell commands',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  }]);
  const marker = '<TOOL_CALL>{"tool":"Bash","arguments":{"command":"pwd"}}</TOOL_CALL>';
  assert.ok(prompt.includes(marker));
  const start = marker.indexOf('<TOOL_CALL>') + '<TOOL_CALL>'.length;
  const end = marker.indexOf('</TOOL_CALL>');
  assert.deepEqual(JSON.parse(marker.slice(start, end)), {
    tool: 'Bash',
    arguments: { command: 'pwd' },
  });
  assert.ok(!prompt.includes('C:/path'));
});
