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
  assert.ok(prompt.includes('hasilnya saja bila hasilnya satu baris'));
  assert.ok(prompt.includes('Jangan bungkus output mentah dengan Markdown code fence'));
  assert.ok(prompt.includes('Jika tugas masih memerlukan tindakan'));
  assert.ok(!prompt.includes('JANGAN menulis <TOOL_CALL>'));
});

test('resume prompt requests raw tool output without Markdown wrappers', () => {
  const prompt = buildResumePrompt('', [{
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_test', content: '/c/Users/USER/project' }],
  }], [], true);
  assert.ok(prompt.includes('hasilnya saja bila hasilnya satu baris'));
  assert.ok(prompt.includes('Jangan bungkus output mentah dengan Markdown code fence'));
  assert.ok(prompt.includes('Jika tugas belum selesai, gunakan tool berikutnya yang diperlukan'));
  assert.ok(!prompt.includes('JANGAN memanggil tool apa pun.'));
});

test('resumed request includes current tool schemas and requires tool use when relevant', () => {
  const prompt = buildResumePrompt('', [{
    role: 'user',
    content: 'Gunakan tool Read untuk membaca package.json di direktori kerja saat ini.',
  }], [{
    name: 'Read',
    description: 'Read a file from the filesystem',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string', description: 'Absolute path to the file' } },
      required: ['file_path'],
    },
  }], false);
  assert.ok(prompt.includes('TOOLS AVAILABLE FOR THIS REQUEST'));
  assert.ok(prompt.includes('Read(file_path*: string'));
  assert.ok(prompt.includes('NEW USER REQUEST'));
  assert.ok(prompt.includes('WAJIB panggil tool yang paling sesuai sekarang'));
  assert.ok(prompt.includes('<TOOL_CALL>'));
});

test('tool-result resume prompt includes schemas and allows the next tool step', () => {
  const prompt = buildResumePrompt('Keep the project-specific system policy.', [{
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_test',
      content: '/project',
    }],
  }], [{
    name: 'Read',
    description: 'Read a file',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  }], true);

  assert.ok(prompt.includes('### SYSTEM'));
  assert.ok(prompt.includes('Keep the project-specific system policy.'));
  assert.ok(prompt.includes('TOOLS AVAILABLE FOR THE NEXT STEP'));
  assert.ok(prompt.includes('Read(file_path*: string'));
  assert.ok(prompt.includes('Jika tugas belum selesai, gunakan tool berikutnya'));
  assert.ok(!prompt.includes('JANGAN memanggil tool apa pun.'));
});

test('full prompt retains tool schemas on a tool_result fallback turn', () => {
  const prompt = buildFullPrompt('', [
    {
      role: 'user',
      content: 'Read fixture.txt and then edit another fixture.',
    },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'fixture.txt' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'EDIT_BEFORE' }],
    },
  ], [{
    name: 'Edit',
    description: 'Edit a file',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  }]);

  assert.ok(prompt.includes('### TOOLS'));
  assert.ok(prompt.includes('Edit(file_path*: string'));
  assert.ok(prompt.includes('Jika tugas masih memerlukan tindakan'));
  assert.ok(prompt.includes('<TOOL_CALL>...</TOOL_CALL>'));
});
