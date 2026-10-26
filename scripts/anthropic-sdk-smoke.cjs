'use strict';

// End-to-end smoke test for the real local gateway.
// Start the gateway and log in to DeepSeek in its Playwright Chrome first,
// then run: npm run test:sdk

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Anthropic = require('@anthropic-ai/sdk');

const baseURL = process.env.DEEPSEEK_SUPER_BASE_URL ||
  'http://127.0.0.1:8787';

function isDefaultLocalGateway(value) {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      Number(url.port || 80) === 8787 &&
      (url.pathname === '/' || url.pathname === '');
  } catch {
    return false;
  }
}

function readLocalGatewayToken() {
  if (!isDefaultLocalGateway(baseURL)) return '';
  try {
    return fs.readFileSync(path.join(__dirname, '..', '.deepseek-super-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const apiKey = isDefaultLocalGateway(baseURL)
  ? (process.env.DEEPSEEK_SUPER_TOKEN ||
      readLocalGatewayToken() ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_API_KEY ||
      '')
  : (process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.DEEPSEEK_SUPER_TOKEN ||
      '');
const model = process.env.ANTHROPIC_MODEL || 'deepseek-super';

const client = new Anthropic({
  apiKey: apiKey || 'missing-local-gateway-token',
  baseURL,
  maxRetries: 0,
  timeout: Number.parseInt(process.env.ANTHROPIC_SDK_TEST_TIMEOUT_MS || '600000', 10),
});

function textFrom(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function assertMessageShape(message, label) {
  assert.equal(message.type, 'message', label + ': response type must be message');
  assert.equal(message.role, 'assistant', label + ': role must be assistant');
  assert.ok(Array.isArray(message.content), label + ': content must be an array');
  assert.ok(
    Number.isInteger(message.usage && message.usage.input_tokens),
    label + ': usage.input_tokens must be an integer'
  );
  assert.ok(
    Number.isInteger(message.usage && message.usage.output_tokens),
    label + ': usage.output_tokens must be an integer'
  );
}

async function main() {
  console.log('Anthropic SDK smoke test');
  console.log('Endpoint:', baseURL);
  console.log('Model:', model);
  if (!apiKey) {
    throw new Error(isDefaultLocalGateway(baseURL)
      ? 'Local gateway token not found. Start npm start first so .deepseek-super-token is created.'
      : 'API token is missing. Set ANTHROPIC_AUTH_TOKEN for the selected external endpoint.');
  }

  // 1. Actual non-streaming Messages API request.
  console.log('\n[1/4] Non-streaming request ...');
  const normal = await client.messages.create({
    model,
    max_tokens: 128,
    messages: [{
      role: 'user',
      content: 'Reply with the exact text SDK_SMOKE_OK and nothing else.',
    }],
  });
  assertMessageShape(normal, 'non-streaming');
  assert.ok(textFrom(normal).trim(), 'non-streaming: response text is empty');
  console.log('PASS non-streaming:', textFrom(normal).trim().slice(0, 160));
  console.log('  stop_reason:', normal.stop_reason);

  // 2. Actual SSE text stream, parsed by the official SDK.
  console.log('\n[2/4] Streaming text request ...');
  const stream = await client.messages.create({
    model,
    max_tokens: 128,
    stream: true,
    messages: [{
      role: 'user',
      content: 'Reply with a short greeting containing STREAM_SMOKE_OK.',
    }],
  });

  let streamedText = '';
  let eventCount = 0;
  let sawMessageStop = false;

  for await (const event of stream) {
    eventCount++;
    if (
      event.type === 'content_block_delta' &&
      event.delta &&
      event.delta.type === 'text_delta'
    ) {
      streamedText += event.delta.text;
    }
    if (event.type === 'message_stop') sawMessageStop = true;
  }

  assert.ok(eventCount > 0, 'streaming: the SDK received no events');
  assert.ok(streamedText.trim(), 'streaming: no text_delta was received');
  assert.ok(sawMessageStop, 'streaming: message_stop was not received');
  console.log('PASS streaming text:', streamedText.trim().slice(0, 160));
  console.log('  events:', eventCount);

  const tools = [{
    name: 'Bash',
    description: 'A compatibility-test tool. The command will not be executed.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command string for this compatibility test' },
      },
      required: ['command'],
    },
  }];

  // 3. Non-streaming tool use, followed by a synthetic tool_result round-trip.
  // The requested shell command is NEVER executed by this test.
  console.log('\n[3/4] Non-streaming tool-use + tool_result round trip ...');
  const toolRequest =
    'Call the Bash tool with command exactly "echo SDK_TOOL_CALL_OK". Do not answer with plain text.';

  const toolMessage = await client.messages.create({
    model,
    max_tokens: 256,
    tools,
    tool_choice: { type: 'tool', name: 'Bash' },
    messages: [{ role: 'user', content: toolRequest }],
  });

  assertMessageShape(toolMessage, 'non-streaming tool-use');
  assert.equal(toolMessage.stop_reason, 'tool_use',
    'non-streaming tool-use: stop_reason must be tool_use');

  const toolUse = toolMessage.content.find((block) => block.type === 'tool_use');
  assert.ok(toolUse, 'non-streaming tool-use: no tool_use block was returned');
  assert.equal(toolUse.name, 'Bash', 'non-streaming tool-use: tool name did not match');
  assert.ok(typeof toolUse.input.command === 'string' && toolUse.input.command.trim(),
    'non-streaming tool-use: command input is empty or invalid');
  assert.equal(toolUse.input.command, 'echo SDK_TOOL_CALL_OK',
    'non-streaming tool-use: command did not match the requested fixture');
  console.log('PASS non-streaming tool_use:', JSON.stringify({
    name: toolUse.name,
    input: toolUse.input,
  }));

  const finalMessage = await client.messages.create({
    model,
    max_tokens: 128,
    tools,
    messages: [
      { role: 'user', content: toolRequest },
      { role: 'assistant', content: toolMessage.content },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: 'SDK_TOOL_RESULT_OK (synthetic result; no command was executed)',
        }],
      },
    ],
  });

  assertMessageShape(finalMessage, 'tool-result round trip');
  assert.ok(textFrom(finalMessage).trim(), 'tool-result round trip: final response is empty');
  console.log('PASS tool_result round trip:', textFrom(finalMessage).trim().slice(0, 160));

  // 4. Actual SSE tool-use stream. Accumulate partial JSON by block index.
  // This validates the streaming example; it does not execute the requested command.
  console.log('\n[4/4] Streaming tool-use request ...');
  const streamingToolMessage = await client.messages.create({
    model,
    max_tokens: 256,
    stream: true,
    tools,
    tool_choice: { type: 'tool', name: 'Bash' },
    messages: [{
      role: 'user',
      content: 'Call the Bash tool with command exactly "echo SDK_STREAM_TOOL_CALL_OK". Do not answer with plain text.',
    }],
  });

  const streamedToolsByIndex = new Map();
  let streamedToolStopReason = null;
  let streamedToolEventCount = 0;
  let sawToolMessageStop = false;

  for await (const event of streamingToolMessage) {
    streamedToolEventCount++;
    if (
      event.type === 'content_block_start' &&
      event.content_block &&
      event.content_block.type === 'tool_use'
    ) {
      streamedToolsByIndex.set(event.index, {
        id: event.content_block.id,
        name: event.content_block.name,
        partialJson: '',
      });
    } else if (
      event.type === 'content_block_delta' &&
      event.delta &&
      event.delta.type === 'input_json_delta'
    ) {
      const tool = streamedToolsByIndex.get(event.index);
      if (tool) tool.partialJson += event.delta.partial_json;
    } else if (event.type === 'message_delta') {
      streamedToolStopReason = event.delta.stop_reason;
    } else if (event.type === 'message_stop') {
      sawToolMessageStop = true;
    }
  }

  const streamedTools = [...streamedToolsByIndex.values()].map((tool) => {
    let input;
    try {
      input = tool.partialJson ? JSON.parse(tool.partialJson) : {};
    } catch (error) {
      throw new Error('streaming tool-use: invalid accumulated input JSON: ' + error.message);
    }
    return { id: tool.id, name: tool.name, input };
  });

  assert.ok(streamedToolEventCount > 0, 'streaming tool-use: the SDK received no events');
  assert.ok(sawToolMessageStop, 'streaming tool-use: message_stop was not received');
  assert.equal(streamedToolStopReason, 'tool_use',
    'streaming tool-use: stop_reason must be tool_use');
  assert.equal(streamedTools.length, 1, 'streaming tool-use: expected exactly one tool block');
  assert.equal(streamedTools[0].name, 'Bash', 'streaming tool-use: tool name did not match');
  assert.equal(typeof streamedTools[0].input.command, 'string',
    'streaming tool-use: command input must be a string');
  assert.equal(streamedTools[0].input.command, 'echo SDK_STREAM_TOOL_CALL_OK',
    'streaming tool-use: command did not match the requested fixture');
  console.log('PASS streaming tool_use:', JSON.stringify({
    stop_reason: streamedToolStopReason,
    name: streamedTools[0].name,
    input: streamedTools[0].input,
    events: streamedToolEventCount,
  }));


  if (isDefaultLocalGateway(baseURL)) {
  // 5. DeepSeek-native web search through the public Anthropic Messages SDK.
  // The gateway handles DeepSeekWebSearch internally; it must not leak as tool_use.
  console.log('\n[5/6] DeepSeekWebSearch batch through the SDK ...');
  const searchMessage = await client.messages.create({
    model,
    max_tokens: 900,
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: 'Run DeepSeekWebSearch only, using one batch. Main query: official Node.js downloads and supported release versions. Additional queries: ["Node.js release notes on GitHub", "official npm package documentation"]. Target sites: ["nodejs.org", "github.com", "docs.npmjs.com"]. Do not call DeepSeekWebFetch or substitute direct page fetches for missing search results. Return a separate section headed SEARCH RESULTS with actual source URLs surfaced by Search, titles, and one supported fact. If search results are empty, say NO_SOURCES_FOUND. Do not answer from memory or invent sources.',
    }],
  });
  assertMessageShape(searchMessage, 'DeepSeekWebSearch SDK');
  assert.equal(searchMessage.stop_reason, 'end_turn',
    'DeepSeekWebSearch SDK: internal calls must be consumed by the gateway');
  const searchText = textFrom(searchMessage);
  assert.match(searchText, /SEARCH RESULTS/i,
    'DeepSeekWebSearch SDK: expected a distinct SEARCH RESULTS section');
  assert.doesNotMatch(searchText, /NO_SOURCES_FOUND/i,
    'DeepSeekWebSearch SDK: actual Search batch returned no verifiable sources');
  assert.doesNotMatch(searchText, /follow-up direct fetch|substitut(?:e|ed|ing) direct fetch|sources came from .*fetch/i,
    'DeepSeekWebSearch SDK: Search must not pass by fetching pages instead');
  const searchSectionMatch = searchText.match(/SEARCH RESULTS([\s\S]*?)(?:FETCH RESULTS|$)/i);
  assert.ok(searchSectionMatch, 'DeepSeekWebSearch SDK: SEARCH RESULTS section could not be isolated');
  const sourceHosts = [...searchSectionMatch[1].matchAll(/https?:\/\/([^/\s?#]+)/gi)]
    .map((match) => match[1].toLowerCase());
  const expectedSearchDomains = ['nodejs.org', 'github.com', 'docs.npmjs.com'];
  const sourceDomainCount = expectedSearchDomains.filter((domain) =>
    sourceHosts.some((host) => host === domain || host.endsWith('.' + domain))
  ).length;
  assert.ok(sourceDomainCount >= 2,
    'DeepSeekWebSearch SDK: expected real source URLs from at least two target domains, got ' + sourceDomainCount);
  console.log('PASS DeepSeekWebSearch SDK:', sourceDomainCount, 'source domains');
  console.log(searchSectionMatch[1].trim().slice(0, 600));

  // 6. DeepSeek-native fetch of three explicit public URLs through the SDK.
  console.log('\n[6/6] DeepSeekWebFetch batch through the SDK ...');
  const fetchMessage = await client.messages.create({
    model,
    max_tokens: 900,
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: 'Use DeepSeekWebFetch to inspect all three exact public URLs in one batch: https://nodejs.org/en/download, https://github.com/nodejs/node/releases, and https://docs.npmjs.com/about-npm. Return a separate section headed FETCH RESULTS and, for each URL, include the exact URL, Title: ..., Fact: ..., and whether it opened. Do not invent content.',
    }],
  });
  assertMessageShape(fetchMessage, 'DeepSeekWebFetch SDK');
  assert.equal(fetchMessage.stop_reason, 'end_turn',
    'DeepSeekWebFetch SDK: internal calls must be consumed by the gateway');
  const fetchText = textFrom(fetchMessage);
  assert.match(fetchText, /FETCH RESULTS/i,
    'DeepSeekWebFetch SDK: expected a distinct FETCH RESULTS section');
  const requestedFetchURLs = [
    'https://nodejs.org/en/download',
    'https://github.com/nodejs/node/releases',
    'https://docs.npmjs.com/about-npm',
  ];
  const fetchedCount = requestedFetchURLs.filter((url) => fetchText.includes(url)).length;
  assert.equal(fetchedCount, 3,
    'DeepSeekWebFetch SDK: expected all three requested URLs, found ' + fetchedCount);
  assert.doesNotMatch(fetchText, /could not be opened|not opened/i,
    'DeepSeekWebFetch SDK: a requested official page could not be opened');
  assert.ok((fetchText.match(/Title\s*:/gi) || []).length >= 3,
    'DeepSeekWebFetch SDK: expected a title for each URL');
  assert.ok((fetchText.match(/Fact\s*:/gi) || []).length >= 3,
    'DeepSeekWebFetch SDK: expected a fact for each URL');
  console.log('PASS DeepSeekWebFetch SDK: 3/3 URLs with titles and facts');

  } else {
    console.log('\nSKIP DeepSeek web-tool tests: the selected endpoint is not this repository's local gateway.');
  }

  console.log('\nALL SDK AND DEEPSEEK WEB-TOOL SMOKE TESTS PASSED');
}

main().catch((error) => {
  console.error('\nSDK SMOKE TEST FAILED');
  if (error && error.status) console.error('HTTP status:', error.status);
  console.error(error && error.stack ? error.stack : error);
  if (error && (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND')) {
    console.error('\nEnsure the server is running and DEEPSEEK_SUPER_BASE_URL is correct.');
  } else if (error && error.status === 401) {
    console.error('\nInvalid token: use the same secret as DEEPSEEK_SUPER_TOKEN when server authentication is enabled.');
  } else {
    console.error('\nEnsure the server is running and the Playwright Chrome profile is signed in to DeepSeek, then retry.');
  }
  process.exitCode = 1;
});
