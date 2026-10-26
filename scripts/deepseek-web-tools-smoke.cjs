'use strict';

// Live smoke test for the DeepSeek-native WebSearch/WebFetch adapter.
// Start the signed-in local gateway first, then run: npm run test:web-tools

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Anthropic = require('@anthropic-ai/sdk');

const baseURL = process.env.DEEPSEEK_SUPER_BASE_URL || 'http://127.0.0.1:8787';

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

const client = new Anthropic({
  apiKey: apiKey || 'missing-local-gateway-token',
  baseURL,
  maxRetries: 0,
  timeout: 600_000,
});

function textFrom(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function assertFinalText(message, label) {
  assert.equal(message.type, 'message', label + ': response type must be message');
  assert.equal(message.role, 'assistant', label + ': role must be assistant');
  assert.equal(message.stop_reason, 'end_turn', label + ': internal web calls should be consumed by the gateway');
  const text = textFrom(message).trim();
  assert.ok(text, label + ': final text is empty');
  assert.match(text, /https?:\/\/\S+/i, label + ': expected at least one explicit URL in the answer');
  return text;
}

async function main() {
  console.log('DeepSeek-native web-tool smoke test');
  console.log('Endpoint:', baseURL);
  if (!apiKey) {
    throw new Error(isDefaultLocalGateway(baseURL)
      ? 'Local gateway token not found. Start npm start first so .deepseek-super-token is created.'
      : 'API token is missing. Set ANTHROPIC_AUTH_TOKEN for the selected endpoint.');
  }

  console.log('\n[1/2] DeepSeekWebSearch via Search mode ...');
  const searched = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'deepseek-super',
    max_tokens: 512,
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: 'Use the internal DeepSeekWebSearch tool to find the official Node.js downloads page. Do not answer from memory. Return a one-sentence summary and the exact public source URL.',
    }],
  });
  const searchText = assertFinalText(searched, 'DeepSeekWebSearch');
  assert.match(searchText, /node(?:js|\.js)|nodejs\.org/i,
    'DeepSeekWebSearch: answer should identify Node.js or its official site');
  console.log('PASS DeepSeekWebSearch:', searchText.slice(0, 500));

  console.log('\n[2/2] DeepSeekWebFetch via Search mode ...');
  const fetched = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'deepseek-super',
    max_tokens: 512,
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: 'Use the internal DeepSeekWebFetch tool to inspect this exact public URL: https://nodejs.org/en/download. Report the page title if available, one fact shown on the page, and the exact URL. Do not pretend you opened it if it was inaccessible.',
    }],
  });
  const fetchText = assertFinalText(fetched, 'DeepSeekWebFetch');
  assert.match(fetchText, /node(?:js|\.js)|nodejs\.org/i,
    'DeepSeekWebFetch: answer should identify the requested Node.js page');
  console.log('PASS DeepSeekWebFetch:', fetchText.slice(0, 500));

  console.log('\nALL DEEPSEEK WEB-TOOL SMOKE TESTS PASSED');
  console.log('For routing confirmation, inspect the gateway terminal for parsed DeepSeekWebSearch / DeepSeekWebFetch calls.');
}

main().catch((error) => {
  console.error('\nDEEPSEEK WEB-TOOL SMOKE TEST FAILED');
  if (error && error.status) console.error('HTTP status:', error.status);
  console.error(error && error.stack ? error.stack : error);
  if (error && (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND')) {
    console.error('\nEnsure the local gateway is running and DEEPSEEK_SUPER_BASE_URL is correct.');
  } else if (error && error.status === 401) {
    console.error('\nInvalid token: use the same secret as DEEPSEEK_SUPER_TOKEN.');
  } else {
    console.error('\nEnsure the signed-in Chrome profile can use DeepSeek Search mode and the gateway is running.');
  }
  process.exitCode = 1;
});
