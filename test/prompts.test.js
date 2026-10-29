'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toolsToPrompt, buildFullPrompt, buildResumePrompt } = require('../src/prompts');

test('tool prompt instructs DeepSeek to use DSML calls and typed parameters', () => {
  const prompt = toolsToPrompt([{
    name: 'Bash',
    description: 'Run shell commands',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  }]);
  assert.ok(prompt.includes('<｜DSML｜ calls>'));
  assert.ok(prompt.includes('<｜DSML｜ invoke name="Bash">'));
  assert.ok(prompt.includes('<｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter>'));
  assert.ok(prompt.includes('</｜DSML｜ calls>'));
  assert.ok(prompt.includes('exactly ONE outer calls block'));
  assert.ok(prompt.includes('string="false"'));
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
  assert.ok(prompt.includes('<｜DSML｜ calls>'));
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

test('tool-result fallback explicitly retains the original user request', () => {
  const original = 'Audit src/handler.js for request routing and cite verified line numbers.';
  const prompt = buildFullPrompt('', [
    { role: 'user', content: original },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'src/\ntest/\nREADME.md' }] },
  ], [{
    name: 'Read',
    description: 'Read a project file',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  }]);

  assert.ok(prompt.includes('=== ORIGINAL USER REQUEST ==='));
  assert.ok(prompt.includes(original));
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
  assert.ok(prompt.includes('<｜DSML｜ calls>'));
  assert.ok(prompt.includes('</｜DSML｜ calls>'));
});

test('BYV attribution and first-user-language policy are included without exposing gateway internals', () => {
  const messages = [{ role: 'user', content: 'Halo, bantu saya membaca file.' }];
  const fullPrompt = buildFullPrompt('', messages, []);
  const resumedPrompt = buildResumePrompt('', messages, [], false);
  const toolResultPrompt = buildResumePrompt('', [{
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_test', content: 'OK' }],
  }], [], true);

  for (const prompt of [fullPrompt, resumedPrompt, toolResultPrompt]) {
    assert.ok(!prompt.includes('deepseek-super'));
    assert.ok(prompt.includes('BYV Dev Unorganization'));
    assert.ok(prompt.includes('Respond in the language the user is currently using'));
    assert.ok(!prompt.includes('https://chat.deepseek.com/'));
    assert.ok(!prompt.includes('browser automation'));
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
  assert.match(replay, /content truncated/);
});


test('base prompt separates global communication, writing quality, typography, and capability accuracy rules', () => {
  const messages = [{ role: 'user', content: 'Halo bro, bantu tulis ulang kalimat ini.' }];
  const prompts = [
    buildFullPrompt('', messages, []),
    buildResumePrompt('', messages, [], false),
    buildResumePrompt('', [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_language', content: 'OK' }],
    }], [], true),
  ];

  for (const prompt of prompts) {
    assert.match(prompt, /WRITING QUALITY AND EDITING/);
    assert.match(prompt, /Remove AI clichés, generic openings, repetitive wording/);
    assert.match(prompt, /Preserve the author’s intent, facts, nuance, and important details/);
    assert.match(prompt, /match the author’s tone, vocabulary, rhythm/);
    assert.match(prompt, /Make minimal edits when the original is already natural/);
    assert.match(prompt, /TYPOGRAPHY AND SOURCE FIDELITY/);
    assert.match(prompt, /Do not use the Unicode character U\+2014 \(EM DASH\) as punctuation/i);
    assert.match(prompt, /Ordinary hyphen-minus U\+002D/);
    assert.match(prompt, /check newly written prose for U\+2014 and remove it/);
    assert.match(prompt, /SKILL AND CAPABILITY ACCURACY/);
    assert.match(prompt, /Never claim a skill is installed or activated unless that has been verified/);
    assert.match(prompt, /Respond in the language the user is currently using/);
    assert.match(prompt, /If the user switches languages, switch with them/);
    assert.match(prompt, /TONE AND RESPONSE FORMATTING/);
    assert.match(prompt, /warm, respectful, conversational tone/i);
    assert.match(prompt, /ask at most one per response/i);
    assert.match(prompt, /Use headings, bold emphasis, bullets, and numbered lists sparingly/i);
    assert.match(prompt, /When declining a request, do not use bullets/i);
    assert.match(prompt, /verify that it is actually available before claiming to inspect it/i);
    assert.doesNotMatch(prompt, /\u2014/);
  }
});


test('Claude-specific resume budget preserves larger tool results before outer replay truncation', () => {
  const { CLAUDE_MAX_REPLAY } = require('../src/content');
  const toolOutput = 'TOOL_RESULT_LARGE_MARKER_' + 'r'.repeat(70000) + '_TOOL_RESULT_END';
  const prompt = buildResumePrompt('', [{
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_large_claude', content: toolOutput }],
  }], [], true, CLAUDE_MAX_REPLAY);
  assert.ok(prompt.includes(toolOutput), 'a 70k result should fit within the Claude-specific 90k tool-result budget');
});

test('shared safety guidance is present in all prompt paths and excludes copyright-specific rules', () => {
  const messages = [{ role: 'user', content: 'Help me with a task.' }];
  const prompts = [
    buildFullPrompt('', messages, []),
    buildResumePrompt('', messages, [], false),
    buildResumePrompt('', [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_safety', content: 'OK' }],
    }], [], true),
  ];

  for (const prompt of prompts) {
    assert.match(prompt, /SAFETY AND WELLBEING/);
    assert.match(prompt, /Protect minors/);
    assert.match(prompt, /age-appropriate and non-romantic/i);
    assert.match(prompt, /Do not assist a minor in sexualizing themselves/i);
    assert.match(prompt, /focused on recognizing patterns/i);
    assert.match(prompt, /weapons or explosives/);
    assert.match(prompt, /authorized defensive analysis/);
    assert.match(prompt, /self-harm or acute distress/);
    assert.match(prompt, /do not provide methods or affirm suicidal intent/i);
    assert.match(prompt, /In an active crisis/i);
    assert.match(prompt, /whole conversation, not one message in isolation/i);
    assert.match(prompt, /ask at most one focused clarification/i);
    assert.match(prompt, /disordered eating is apparent/i);
    assert.match(prompt, /legal or financial decisions/i);
    assert.match(prompt, /imminent intent, a plan, or a farewell/i);
    assert.match(prompt, /suicide notes, posthumous messages/i);
    assert.match(prompt, /cumulative direction across turns/i);
    assert.match(prompt, /restricting food, bingeing, purging, or compensating/i);
    assert.match(prompt, /official label for the exact product and formulation/i);
    assert.match(prompt, /dangerous interactions, overdose signs/i);
    assert.match(prompt, /political, ethical, or other contested positions/i);
    assert.match(prompt, /do not provide the declined content incrementally/i);
    assert.doesNotMatch(prompt, /copyright|intellectual property/i);
  }
});
