'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handleMessages } = require('../src/handler');
const { DEEPSEEK_WEB_SEARCH } = require('../src/deepseek-web-tools');

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

function makeDependencies(runTurn, options = {}) {
  return {
    ensurePage: async () => {},
    ensureTogglesOn: options.ensureTogglesOn || (async () => {}),
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
    messages: [{ role: 'user', content: options.content || 'Find information and answer this task.' }],
    tools: options.tools || [],
  };
}

function makeRequest() {
  return { aborted: false };
}

test('handler executes DeepSeekWebSearch internally and resumes the model with the result', async () => {
  const response = new FakeResponse();
  const promptCalls = [];
  const toggleStates = [];
  let turn = 0;
  const runTurn = async (prompt) => {
    promptCalls.push(prompt);
    turn++;
    if (turn === 1) {
      return {
        text: '',
        thinking: 'Need current sources.',
        toolCalls: [{
          name: DEEPSEEK_WEB_SEARCH,
          input: { query: 'DeepSeek release notes', max_results: 2 },
        }],
        invalidToolCall: false,
      };
    }
    if (turn === 2) {
      assert.match(prompt, /INTERNAL TOOL: DeepSeekWebSearch/);
      return {
        text: 'FOUND\nTitle: DeepSeek release notes\nURL: https://example.com/releases\nEvidence: release notes page.',
        thinking: '',
        toolCalls: [],
        invalidToolCall: false,
      };
    }
    assert.match(prompt, /INTERNAL DEEPSEEK WEB TOOL RESULTS/);
    assert.match(prompt, /https:\/\/example\.com\/releases/);
    return {
      text: 'The release notes are available at https://example.com/releases.',
      thinking: 'The source directly answers the request.',
      toolCalls: [],
      invalidToolCall: false,
    };
  };

  await handleMessages(makeRequest(), response, makeBody(), makeDependencies(runTurn, {
    ensureTogglesOn: async (toolsProvided) => toggleStates.push(toolsProvided),
  }));

  const message = JSON.parse(response.output);
  assert.equal(turn, 3);
  assert.deepEqual(toggleStates, [true, false, true, true]);
  assert.equal(message.stop_reason, 'end_turn');
  assert.equal(message.content.some((block) => block.type === 'tool_use'), false);
  assert.match(message.content.find((block) => block.type === 'text').text, /example\.com\/releases/);
  assert.ok(promptCalls[0].includes('DeepSeekWebSearch'), 'the first model prompt includes the internal tool schema');
});

test('handler consumes internal web calls but returns client-owned calls in a mixed batch', async () => {
  const response = new FakeResponse();
  const toggleStates = [];
  let turn = 0;
  const runTurn = async (prompt) => {
    turn++;
    if (turn === 1) {
      return {
        text: '',
        thinking: '',
        toolCalls: [
          { name: DEEPSEEK_WEB_SEARCH, input: { query: 'search before editing' } },
          { name: 'Bash', input: { command: 'pwd' } },
        ],
        invalidToolCall: false,
      };
    }
    assert.match(prompt, /INTERNAL TOOL: DeepSeekWebSearch/);
    return {
      text: 'FOUND\nTitle: Example docs\nURL: https://example.com/docs\nEvidence: reference documentation.',
      thinking: '',
      toolCalls: [],
      invalidToolCall: false,
    };
  };
  const tools = [{
    name: 'Bash',
    description: 'Run a shell command',
    input_schema: {
      type: 'object',
      required: ['command'],
      properties: { command: { type: 'string' } },
    },
  }];

  await handleMessages(makeRequest(), response, makeBody({ tools }), makeDependencies(runTurn, {
    ensureTogglesOn: async (toolsProvided) => toggleStates.push(toolsProvided),
  }));

  const message = JSON.parse(response.output);
  assert.equal(turn, 2, 'the gateway should search internally without a continuation turn when an external tool is also requested');
  assert.deepEqual(toggleStates, [true, false, true]);
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content.filter((block) => block.type === 'tool_use').map((block) => ({
    name: block.name,
    input: block.input,
  })), [{ name: 'Bash', input: { command: 'pwd' } }]);
  assert.equal(message.content.some((block) => block.name === DEEPSEEK_WEB_SEARCH), false);
});


test('tool_choice=none hides internal web tools and keeps Search disabled', async () => {
  const response = new FakeResponse();
  const toggleStates = [];
  let promptText = '';
  const runTurn = async (prompt) => {
    promptText = prompt;
    return {
      text: 'Answering from the available context.',
      thinking: '',
      toolCalls: [],
      invalidToolCall: false,
    };
  };

  await handleMessages(makeRequest(), response, makeBody({ tool_choice: 'none' }), makeDependencies(runTurn, {
    ensureTogglesOn: async (toolsProvided) => toggleStates.push(toolsProvided),
  }));

  const message = JSON.parse(response.output);
  assert.deepEqual(toggleStates, [true]);
  assert.doesNotMatch(promptText, /DeepSeekWebSearch|DeepSeekWebFetch/);
  assert.equal(message.stop_reason, 'end_turn');
  assert.match(message.content.find((block) => block.type === 'text').text, /available context/);
});
