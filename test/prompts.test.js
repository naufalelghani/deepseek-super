'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toolsToPrompt, buildFullPrompt, buildResumePrompt } = require('../src/prompts');

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

test('full prompt requests raw tool output without Markdown wrappers', () => {
  const prompt = buildFullPrompt('', [{
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_test', content: '/c/Users/USER/project' }],
  }], []);
  assert.ok(prompt.includes('keluarkan baris hasil itu saja'));
  assert.ok(prompt.includes('Jangan bungkus output mentah dengan Markdown code fence'));
  assert.ok(prompt.includes('Jangan menulis <TOOL_CALL>') || prompt.includes('JANGAN menulis <TOOL_CALL>'));
});

test('resume prompt requests raw tool output without Markdown wrappers', () => {
  const prompt = buildResumePrompt('', [{
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_test', content: '/c/Users/USER/project' }],
  }], [], true);
  assert.ok(prompt.includes('keluarkan baris hasil itu saja'));
  assert.ok(prompt.includes('Jangan bungkus output mentah dengan Markdown code fence'));
  assert.ok(prompt.includes('JANGAN memanggil tool apa pun.'));
});
