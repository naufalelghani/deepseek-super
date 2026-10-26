'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handleMessages } = require('../src/handler');

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.statusCode = null;
    this.headers = {};
    this.output = '';
  }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = headers;
  }
  write(chunk) {
    this.output += String(chunk);
    return true;
  }
  end(chunk) {
    if (chunk) this.output += String(chunk);
    this.writableEnded = true;
  }
}

function makeDependencies(runTurn) {
  return {
    ensurePage: async () => {},
    ensureTogglesOn: async () => {},
    resumeUrl: async () => false,
    gotoNewChat: async () => {},
    runTurn,
    currentUrl: async () => null,
    locked: async (fn) => fn(),
    getSession: () => null,
    setSession: () => {},
  };
}

function makeBody(options = {}) {
  return {
    model: 'deepseek-super',
    max_tokens: 256,
    stream: options.stream === true,
    tool_choice: options.tool_choice || 'auto',
    messages: [{ role: 'user', content: 'Use the requested tool to complete this task.' }],
    tools: options.tools || [{
      name: 'Bash',
      description: 'Run a shell command',
      input_schema: {
        type: 'object',
        required: ['command'],
        properties: { command: { type: 'string' } },
      },
    }],
  };
}

function makeRequest() {
  return { aborted: false };
}

test('handler never reports end_turn when malformed tool-call recovery is exhausted', async () => {
  let calls = 0;
  const response = new FakeResponse();
  const runTurn = async () => {
    calls++;
    return { text: '', thinking: '', toolCalls: [], invalidToolCall: true };
  };

  await assert.rejects(
    handleMessages(makeRequest(), response, makeBody(), makeDependencies(runTurn)),
    (error) => error.statusCode === 502 &&
      error.type === 'api_error' &&
      error.code === 'TOOL_CALL_RECOVERY_FAILED' &&
      error.attempts === 2
  );

  assert.equal(calls, 3, 'one original turn plus exactly two bounded recovery attempts');
  assert.equal(response.writableEnded, false, 'no successful message response was written');
});

test('handler heals schema-invalid arguments and only returns the corrected tool call', async () => {
  let calls = 0;
  const response = new FakeResponse();
  const runTurn = async () => {
    calls++;
    if (calls === 1) {
      return {
        text: '',
        thinking: '',
        toolCalls: [{ name: 'Bash', input: {} }],
        invalidToolCall: false,
      };
    }
    return {
      text: '',
      thinking: '',
      toolCalls: [{ name: 'Bash', input: { command: 'pwd' } }],
      invalidToolCall: false,
    };
  };

  await handleMessages(makeRequest(), response, makeBody(), makeDependencies(runTurn));
  const message = JSON.parse(response.output);

  assert.equal(calls, 2);
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content.filter((block) => block.type === 'tool_use').map((block) => block.input), [
    { command: 'pwd' },
  ]);
});

test('streaming emits a tool batch only after every call passes schema validation', async () => {
  let calls = 0;
  const response = new FakeResponse();
  const tools = [
    {
      name: 'Bash',
      input_schema: {
        type: 'object',
        required: ['command'],
        properties: { command: { type: 'string' } },
      },
    },
    {
      name: 'Read',
      input_schema: {
        type: 'object',
        required: ['file_path'],
        properties: { file_path: { type: 'string' } },
      },
    },
  ];
  const runTurn = async () => {
    calls++;
    if (calls === 1) {
      return {
        text: '',
        thinking: '',
        toolCalls: [
          { name: 'Bash', input: { command: 'pwd' } },
          { name: 'Read', input: { file_path: 42 } },
        ],
        invalidToolCall: false,
      };
    }
    return {
      text: '',
      thinking: '',
      toolCalls: [
        { name: 'Bash', input: { command: 'pwd' } },
        { name: 'Read', input: { file_path: 'package.json' } },
      ],
      invalidToolCall: false,
    };
  };

  await handleMessages(makeRequest(), response, makeBody({ stream: true, tools }), makeDependencies(runTurn));
  const events = response.output.split(/\r?\n/).filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
  const toolStarts = events
    .filter((event) => event.type === 'content_block_start' && event.content_block.type === 'tool_use')
    .map((event) => event.content_block.name);

  assert.equal(calls, 2);
  assert.deepEqual(toolStarts, ['Bash', 'Read']);
  assert.equal(response.writableEnded, true);
});


test('handler heals a tool_choice mismatch and only forwards the selected tool', async () => {
  let calls = 0;
  const response = new FakeResponse();
  const tools = [
    { name: 'Bash', input_schema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } },
    { name: 'Read', input_schema: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' } } } },
  ];
  const runTurn = async () => {
    calls++;
    return {
      text: '',
      thinking: '',
      toolCalls: [calls === 1
        ? { name: 'Bash', input: { command: 'pwd' } }
        : { name: 'Read', input: { file_path: 'package.json' } }],
      invalidToolCall: false,
    };
  };

  await handleMessages(makeRequest(), response, makeBody({
    tools,
    tool_choice: { type: 'tool', name: 'Read' },
  }), makeDependencies(runTurn));

  const message = JSON.parse(response.output);
  assert.equal(calls, 2);
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content.filter((block) => block.type === 'tool_use').map((block) => block.name), ['Read']);
});
