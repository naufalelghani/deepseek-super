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

  console.log('\n[1/2] Multi-site / multi-query DeepSeekWebSearch batch ...');
  const searched = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'deepseek-super',
    max_tokens: 900,
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: 'Use DeepSeekWebSearch in one batch. Main query: official Node.js downloads and supported release versions. Additional queries: ["Node.js release notes on GitHub", "official npm package documentation"]. Target sites: ["nodejs.org", "github.com", "docs.npmjs.com"]. Return a concise report with real source links from at least two of those target domains; state explicitly if a domain has no result. Do not answer from memory.',
    }],
  });
  const searchText = assertFinalText(searched, 'DeepSeekWebSearch');
  assert.match(searchText, /node(?:js|\.js)|nodejs\.org/i,
    'DeepSeekWebSearch: answer should identify Node.js or its official site');
  const searchDomains = ['nodejs\\.org', 'github\\.com', 'docs\\.npmjs\\.com'];
  const foundDomainCount = searchDomains.filter((domain) => new RegExp(domain, 'i').test(searchText)).length;
  assert.ok(foundDomainCount >= 2,
    'DeepSeekWebSearch: expected source URLs from at least two target sites, found ' + foundDomainCount);
  console.log('PASS multi-site DeepSeekWebSearch (' + foundDomainCount + ' domains):', searchText.slice(0, 900));

  console.log('\n[2/2] Multi-URL DeepSeekWebFetch batch ...');
  const fetched = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'deepseek-super',
    max_tokens: 900,
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: 'Use DeepSeekWebFetch to inspect all three exact public URLs in one batch: https://nodejs.org/en/download, https://github.com/nodejs/node/releases, and https://docs.npmjs.com/about-npm. Return a separate subsection per URL with title, one fact, and the URL. State which pages could not be opened rather than inventing content.',
    }],
  });
  const fetchText = assertFinalText(fetched, 'DeepSeekWebFetch');
  assert.match(fetchText, /node(?:js|\.js)|nodejs\.org/i,
    'DeepSeekWebFetch: answer should identify the requested Node.js page');
  const requestedURLs = [
    'https://nodejs.org/en/download',
    'https://github.com/nodejs/node/releases',
    'https://docs.npmjs.com/about-npm',
  ];
  const fetchedURLCount = requestedURLs.filter((url) => fetchText.includes(url)).length;
  assert.ok(fetchedURLCount >= 2,
    'DeepSeekWebFetch: expected results for at least two requested URLs, found ' + fetchedURLCount);
  console.log('PASS multi-URL DeepSeekWebFetch (' + fetchedURLCount + '/3 URLs):', fetchText.slice(0, 900));

  console.log('\nALL DEEPSEEK WEB-TOOL SMOKE TESTS PASSED');
  console.log('For routing confirmation, inspect the gateway terminal for parsed DeepSeekWebSearch / DeepSeekWebFetch calls.');
  console.log('The batch runs in one Search-enabled browser turn per internal tool call; it is not parallel HTTP fetching.');
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
