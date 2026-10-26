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

function assertFinalText(message, label, options = {}) {
  assert.equal(message.type, 'message', label + ': response type must be message');
  assert.equal(message.role, 'assistant', label + ': role must be assistant');
  assert.equal(message.stop_reason, 'end_turn', label + ': internal web calls should be consumed by the gateway');
  const text = textFrom(message).trim();
  assert.ok(text, label + ': final text is empty');
  if (options.requireURL !== false) {
    assert.match(text, /https?:\/\/\S+/i, label + ': expected at least one explicit URL in the answer');
  }
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
      content: 'Use DeepSeekWebSearch only, in one batch. Main query: official Node.js downloads and supported release versions. Additional queries: ["Node.js release notes on GitHub", "official npm package documentation"]. Target sites: ["nodejs.org", "github.com", "docs.npmjs.com"]. Do not call DeepSeekWebFetch or replace missing search results by opening URLs. Return a section headed SEARCH RESULTS containing source links actually surfaced by Search, with title, exact URL, and one supported fact. If Search yields no sources, say NO_SOURCES_FOUND. Do not answer from memory or invent links.',
    }],
  });
  const searchText = assertFinalText(searched, 'DeepSeekWebSearch', { requireURL: false });
  const searchSectionMatch = searchText.match(/SEARCH RESULTS([\s\S]*?)(?:FETCH RESULTS|$)/i);
  assert.ok(searchSectionMatch, 'DeepSeekWebSearch: a separate SEARCH RESULTS section is required');
  const searchSection = searchSectionMatch[1];
  assert.doesNotMatch(searchSection, /NO_SOURCES_FOUND/i,
    'DeepSeekWebSearch: the actual search batch reported no sources. Search response: ' + searchSection.slice(0, 1800));
  assert.doesNotMatch(searchText, /follow-up direct fetch|substitut(?:e|ed|ing) direct fetch|sources came from .*fetch/i,
    'DeepSeekWebSearch: direct fetch must not be used as a fallback for empty search results');
  const searchURLs = [...searchSection.matchAll(/https?:\/\/([^/\s?#]+)/gi)]
    .map((match) => match[1].toLowerCase());
  const targetDomains = ['nodejs.org', 'github.com', 'docs.npmjs.com'];
  const foundDomainCount = targetDomains.filter((domain) =>
    searchURLs.some((host) => host === domain || host.endsWith('.' + domain))
  ).length;
  assert.ok(foundDomainCount >= 2,
    'DeepSeekWebSearch: expected actual source URLs from at least two target domains, found ' + foundDomainCount);
  console.log('PASS multi-site DeepSeekWebSearch (' + foundDomainCount + ' source domains):', searchSection.slice(0, 900));

  console.log('\n[2/2] Multi-URL DeepSeekWebFetch batch ...');
  const fetched = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'deepseek-super',
    max_tokens: 900,
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: 'Use DeepSeekWebFetch to inspect all three exact public URLs in one batch: https://nodejs.org/en/download, https://github.com/nodejs/node/releases, and https://docs.npmjs.com/about-npm. Return a separate subsection per URL with the exact requested URL, page title, one fact supported by the page, and whether it opened. Do not invent content. Keep the results under a FETCH RESULTS heading.',
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
  assert.equal(fetchedURLCount, 3,
    'DeepSeekWebFetch: expected results for all three requested URLs, found ' + fetchedURLCount);
  assert.match(fetchText, /FETCH RESULTS/i, 'DeepSeekWebFetch: separate FETCH RESULTS section is required');
  assert.doesNotMatch(fetchText, /could not be opened|not opened/i,
    'DeepSeekWebFetch: at least one requested official page could not be opened');
  const titleCount = (fetchText.match(/Title\s*:/gi) || []).length;
  const factCount = (fetchText.match(/Fact\s*:/gi) || []).length;
  assert.ok(titleCount >= 3, 'DeepSeekWebFetch: expected a title for each URL, found ' + titleCount);
  assert.ok(factCount >= 3, 'DeepSeekWebFetch: expected a fact for each URL, found ' + factCount);
  console.log('PASS multi-URL DeepSeekWebFetch (' + fetchedURLCount + '/3 URLs):', fetchText.slice(0, 900));

  console.log('\nALL DEEPSEEK WEB-TOOL SMOKE TESTS PASSED');
  console.log('For routing confirmation, inspect the gateway terminal for parsed DeepSeekWebSearch / DeepSeekWebFetch calls.');
  console.log('Each query/domain pair and each URL is inspected in its own sequential Search-enabled browser turn; the batch is not parallel HTTP fetching.');
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
