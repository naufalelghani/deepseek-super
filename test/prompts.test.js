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
  assert.ok(prompt.includes('return only that output when it consists of one or more lines'));
  assert.ok(prompt.includes('Do not wrap raw output in Markdown code fences'));
  assert.ok(prompt.includes('If the task still requires an action'));
  assert.ok(!prompt.includes('JANGAN menulis <TOOL_CALL>'));
});

test('resume prompt requests raw tool output without Markdown wrappers', () => {
  const prompt = buildResumePrompt('', [{
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_test', content: '/c/Users/USER/project' }],
  }], [], true);
  assert.ok(prompt.includes('return only that output when it consists of one or more lines'));
  assert.ok(prompt.includes('Do not wrap raw output in Markdown code fences'));
  assert.ok(prompt.includes('If the task is not complete, use the next required tool'));
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
  assert.ok(prompt.includes('you MUST call the most appropriate tool now'));
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
  assert.ok(prompt.includes('If the task is not complete, use the next required tool'));
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
  assert.ok(prompt.includes('If the task still requires an action'));
  assert.ok(prompt.includes('<TOOL_CALL>...</TOOL_CALL>'));
});

test('project identity and first-user-language policy are included in every prompt path', () => {
  const messages = [{ role: 'user', content: 'Halo, bantu saya membaca file.' }];
  const fullPrompt = buildFullPrompt('', messages, []);
  const resumedPrompt = buildResumePrompt('', messages, [], false);
  const toolResultPrompt = buildResumePrompt('', [{
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_test', content: 'OK' }],
  }], [], true);

  for (const prompt of [fullPrompt, resumedPrompt, toolResultPrompt]) {
    assert.ok(prompt.includes('deepseek-super'));
    assert.ok(prompt.includes('BYV Dev Unorganization'));
    assert.ok(prompt.includes('language of the first user message'));
    assert.ok(prompt.includes('https://chat.deepseek.com/'));
  }
});


test('truncated long replay retains tool schemas and the latest user request', () => {
  const { truncateReplay } = require('../src/content');
  const messages = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: 'HISTORY_' + index + '_' + 'x'.repeat(5000),
  }));
  messages.push({ role: 'user', content: 'LATEST_REQUEST_MARKER: continue the task with Bash.' });

  const tools = [{
    name: 'Bash',
    description: 'Run shell commands',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  }];

  const replay = truncateReplay(buildFullPrompt('system instructions', messages, tools));
  assert.match(replay, /Bash\(command\*: string/);
  assert.match(replay, /LATEST_REQUEST_MARKER/);
  assert.match(replay, /WARNING: conversation replay was truncated/);
});


test('bounded resumed prompt preserves tool schemas after an oversized tool result', () => {
  const { truncateReplay } = require('../src/content');
  const prompt = buildResumePrompt('', [{
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_large',
      content: 'RESULT_BEGIN_MARKER_' + 'r'.repeat(70000) + '_RESULT_END_MARKER',
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

  const replay = truncateReplay(prompt);
  assert.ok(replay.length <= require('../src/config').MAX_REPLAY);
  assert.match(replay, /Read\(file_path\*: string/);
  assert.match(replay, /RESULT_BEGIN_MARKER/);
  assert.match(replay, /RESULT_END_MARKER/);
  assert.match(replay, /If the task is not complete, use the next required tool/);
  assert.match(replay, /WARNING: conversation replay was truncated/);
});
