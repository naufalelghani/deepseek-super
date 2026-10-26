'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEEPSEEK_WEB_SEARCH,
  DEEPSEEK_WEB_FETCH,
  DEEPSEEK_WEB_TOOLS,
  isDeepSeekWebTool,
  normalizeWebToolInput,
  buildDeepSeekWebToolPrompt,
  buildDeepSeekWebSearchTurnPrompt,
  buildDeepSeekWebFetchTurnPrompt,
  buildDeepSeekWebToolContinuationPrompt,
  executeDeepSeekWebTool,
} = require('../src/deepseek-web-tools');

test('DeepSeek web tool schemas define search and fetch with required arguments', () => {
  assert.deepEqual(DEEPSEEK_WEB_TOOLS.map((tool) => tool.name), [
    DEEPSEEK_WEB_SEARCH,
    DEEPSEEK_WEB_FETCH,
  ]);
  assert.deepEqual(DEEPSEEK_WEB_TOOLS[0].input_schema.required, ['query']);
  assert.deepEqual(DEEPSEEK_WEB_TOOLS[1].input_schema.required, ['url']);
  assert.equal(isDeepSeekWebTool(DEEPSEEK_WEB_SEARCH), true);
  assert.equal(isDeepSeekWebTool({ name: DEEPSEEK_WEB_FETCH }), true);
  assert.equal(isDeepSeekWebTool('Bash'), false);
});

test('search input is trimmed and batch defaults are applied', () => {
  assert.deepEqual(normalizeWebToolInput({
    name: DEEPSEEK_WEB_SEARCH,
    input: { query: '  DeepSeek web search  ' },
  }), {
    query: 'DeepSeek web search',
    additional_queries: [],
    sites: [],
    max_results: 8,
  });
});

test('search input rejects empty, oversized, and invalid result-count values', () => {
  assert.throws(
    () => normalizeWebToolInput({ name: DEEPSEEK_WEB_SEARCH, input: { query: '   ' } }),
    /non-empty string/
  );
  assert.throws(
    () => normalizeWebToolInput({ name: DEEPSEEK_WEB_SEARCH, input: { query: 'x'.repeat(501) } }),
    /exceeds 500 characters/
  );
  assert.throws(
    () => normalizeWebToolInput({ name: DEEPSEEK_WEB_SEARCH, input: { query: 'news', max_results: 99 } }),
    /between 1 and 12/
  );
});

test('fetch input accepts public HTTP(S) URLs and removes fragments', () => {
  assert.deepEqual(normalizeWebToolInput({
    name: DEEPSEEK_WEB_FETCH,
    input: { url: 'https://example.com/docs#section' },
  }), { url: 'https://example.com/docs', additional_urls: [] });
});

test('fetch input rejects unsupported schemes, credentials, and local/private targets', () => {
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/file',
    'https://user:pass@example.com/private',
    'http://localhost/admin',
    'http://127.0.0.1/',
    'http://192.168.1.1/',
    'http://10.0.0.1/',
    'http://service.internal/',
  ]) {
    assert.throws(
      () => normalizeWebToolInput({ name: DEEPSEEK_WEB_FETCH, input: { url } }),
      undefined,
      url
    );
  }
});

test('tool prompts clearly request DeepSeek Search mode and prohibit fabricated sources', () => {
  const searchPrompt = buildDeepSeekWebToolPrompt({
    name: DEEPSEEK_WEB_SEARCH,
    input: {
      query: 'latest release',
      additional_queries: ['release history'],
      sites: ['nodejs.org', 'github.com'],
      max_results: 3,
    },
  });
  assert.match(searchPrompt, /Search-mode browser turns/i);
  assert.match(searchPrompt, /latest release/);
  assert.match(searchPrompt, /release history/);
  assert.match(searchPrompt, /separate focused Search-mode browser turns/i);
  assert.match(searchPrompt, /Query: latest release \| target domain: nodejs\.org/i);
  assert.match(searchPrompt, /Query: release history \| target domain: github\.com/i);
  assert.doesNotMatch(searchPrompt, /site:nodejs\.org latest release/);
  assert.match(searchPrompt, /Maximum source entries across this batch: 3/);
  assert.match(searchPrompt, /Never fabricate URLs, source titles/);

  const fetchPrompt = buildDeepSeekWebToolPrompt({
    name: DEEPSEEK_WEB_FETCH,
    input: {
      url: 'https://example.com/article',
      additional_urls: ['https://nodejs.org/en/download', 'https://github.com/nodejs/node/releases'],
    },
  });
  assert.match(fetchPrompt, /each URL in its own Search-mode browser turn/i);
  assert.match(fetchPrompt, /https:\/\/example\.com\/article/);
  assert.match(fetchPrompt, /https:\/\/nodejs\.org\/en\/download/);
  assert.match(fetchPrompt, /https:\/\/github\.com\/nodejs\/node\/releases/);
  assert.match(fetchPrompt, /Never substitute an unrelated page/i);
  assert.match(fetchPrompt, /identifying whether it opened/i);

  const oneSearchTurn = buildDeepSeekWebSearchTurnPrompt('official Node.js download', 'nodejs.org', 1, 2);
  assert.match(oneSearchTurn, /exactly ONE focused web search/i);
  assert.match(oneSearchTurn, /Target domain: nodejs.org/);
  assert.doesNotMatch(oneSearchTurn, /site:nodejs\.org/);
  assert.match(oneSearchTurn, /Do not use DeepSeekWebFetch/i);

  const oneFetchTurn = buildDeepSeekWebFetchTurnPrompt('https://nodejs.org/en/download', 1, 3);
  assert.match(oneFetchTurn, /Inspect only this exact public URL/i);
  assert.match(oneFetchTurn, /https:\/\/nodejs\.org\/en\/download/);
});

test('continuation prompt feeds internal results back as tool results and retains tool schemas', () => {
  const prompt = buildDeepSeekWebToolContinuationPrompt([{
    name: DEEPSEEK_WEB_SEARCH,
    input: { query: 'DeepSeek' },
    result: 'Source: https://example.com; summary: released feature',
  }], [{
    name: 'Bash',
    description: 'Run a command',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  }]);

  assert.match(prompt, /INTERNAL DEEPSEEK WEB TOOL RESULTS/);
  assert.match(prompt, /Source: https:\/\/example\.com/);
  assert.match(prompt, /Bash\(command\*?: string\)/);
  assert.match(prompt, /CONTINUE THE ORIGINAL USER TASK/i);
  assert.match(prompt, /do not call DeepSeekWebFetch merely to replace the missing search evidence/i);
});

test('execution enables Search for the internal turn and restores it afterwards', async () => {
  const toggleStates = [];
  let promptSent = '';
  const result = await executeDeepSeekWebTool({
    name: DEEPSEEK_WEB_SEARCH,
    input: { query: 'DeepSeek docs' },
  }, {
    ensureTogglesOn: async (toolsProvided) => toggleStates.push(toolsProvided),
    runTurn: async (prompt, sink, buffer, isCancelled, includeLinks) => {
      promptSent = prompt;
      assert.equal(buffer, true);
      assert.equal(typeof isCancelled, 'function');
      assert.equal(includeLinks, true);
      return { text: 'Sources: https://example.com/docs', toolCalls: [], invalidToolCall: false };
    },
  });

  assert.deepEqual(toggleStates, [false, true]);
  assert.match(promptSent, /DeepSeek docs/);
  assert.equal(result.name, DEEPSEEK_WEB_SEARCH);
  assert.ok(result.result.includes('https://example.com/docs'));
  assert.match(result.result, /Target domain: any relevant public domain/);
});

test('execution rejects tool markup from a Search-mode result but still restores Search OFF', async () => {
  const toggleStates = [];
  await assert.rejects(
    executeDeepSeekWebTool({
      name: DEEPSEEK_WEB_FETCH,
      input: { url: 'https://example.com' },
    }, {
      ensureTogglesOn: async (toolsProvided) => toggleStates.push(toolsProvided),
      runTurn: async () => ({
        text: '',
        toolCalls: [{ name: 'Bash', input: { command: 'pwd' } }],
        invalidToolCall: false,
      }),
    }),
    /instead of a plain-text web result/
  );
  assert.deepEqual(toggleStates, [false, true]);
});


test('search batch normalizes several queries and public target domains', () => {
  assert.deepEqual(normalizeWebToolInput({
    name: DEEPSEEK_WEB_SEARCH,
    input: {
      query: ' official docs ',
      additional_queries: [' release notes ', ' security advisory '],
      sites: ['NodeJS.org', 'github.com', 'NodeJS.org'],
      max_results: 6,
    },
  }), {
    query: 'official docs',
    additional_queries: ['release notes', 'security advisory'],
    sites: ['nodejs.org', 'github.com'],
    max_results: 6,
  });
});

test('search batch rejects invalid domains and excessive query/site combinations', () => {
  for (const site of ['https://example.com', 'example.com/path', 'example.com:8080', '*.example.com', 'localhost', 'service.internal']) {
    assert.throws(
      () => normalizeWebToolInput({ name: DEEPSEEK_WEB_SEARCH, input: { query: 'release', sites: [site] } }),
      undefined,
      site
    );
  }
  assert.throws(
    () => normalizeWebToolInput({
      name: DEEPSEEK_WEB_SEARCH,
      input: {
        query: 'primary',
        additional_queries: ['q2', 'q3', 'q4'],
        sites: ['one.example', 'two.example', 'three.example', 'four.example'],
      },
    }),
    /query\/site combinations/
  );
});

test('search batch executes each query/domain pair in a focused turn and accepts only matching rendered source links', async () => {
  const toggleStates = [];
  const prompts = [];
  const result = await executeDeepSeekWebTool({
    name: DEEPSEEK_WEB_SEARCH,
    input: {
      query: 'official docs',
      additional_queries: ['release notes'],
      sites: ['nodejs.org', 'github.com'],
      max_results: 8,
    },
  }, {
    ensureTogglesOn: async (toolsProvided) => toggleStates.push(toolsProvided),
    runTurn: async (prompt, sink, buffer, isCancelled, includeLinks) => {
      prompts.push(prompt);
      assert.equal(buffer, true);
      assert.equal(typeof isCancelled, 'function');
      assert.equal(includeLinks, true);
      if (/Target domain: nodejs\.org/.test(prompt) && /official docs/.test(prompt)) {
        return { text: 'FOUND\nTitle: Node.js download\nURL: https://nodejs.org/en/download', sourceLinks: [{ text: 'Node.js download', url: 'https://nodejs.org/en/download' }], toolCalls: [], invalidToolCall: false };
      }
      if (/Target domain: nodejs\.org/.test(prompt)) {
        // A link from the wrong domain must not be accepted for a site-scoped search.
        return { text: 'FOUND\nURL: https://github.com/nodejs/node/releases', sourceLinks: [{ text: 'Node.js releases', url: 'https://github.com/nodejs/node/releases' }], toolCalls: [], invalidToolCall: false };
      }
      if (/Target domain: github\.com/.test(prompt) && /official docs/.test(prompt)) {
        return { text: 'FOUND\nTitle: Node.js releases\nURL: https://github.com/nodejs/node/releases', sourceLinks: [{ text: 'Node.js releases', url: 'https://github.com/nodejs/node/releases' }], toolCalls: [], invalidToolCall: false };
      }
      return { text: 'NO_RESULT', sourceLinks: [], toolCalls: [], invalidToolCall: false };
    },
  });

  assert.equal(prompts.length, 4, 'each query/domain pair must be its own Search-mode turn');
  assert.deepEqual(toggleStates, [false, false, false, false, true]);
  assert.ok(prompts.every((prompt) => !/site:/.test(prompt)), 'do not rely on site: query syntax');
  assert.match(result.result, /https:\/\/nodejs\.org\/en\/download/);
  assert.match(result.result, /https:\/\/github\.com\/nodejs\/node\/releases/);
  assert.match(result.result, /NO_RESULT: Search did not surface a matching source URL/);
  assert.doesNotMatch(result.result, /Target domain: nodejs\.org\n  Source: Node\.js releases/);
});

test('search batch reports explicit NO_SOURCES_FOUND when Search exposes no rendered URLs', async () => {
  const result = await executeDeepSeekWebTool({
    name: DEEPSEEK_WEB_SEARCH,
    input: { query: 'test query', sites: ['example.com'] },
  }, {
    ensureTogglesOn: async () => {},
    runTurn: async () => ({ text: 'NO_RESULT', sourceLinks: [], toolCalls: [], invalidToolCall: false }),
  });
  assert.match(result.result, /^NO_SOURCES_FOUND:/);
});

test('fetch batch inspects each exact URL in a separate turn', async () => {
  const urls = [
    'https://nodejs.org/en/download',
    'https://github.com/nodejs/node/releases',
    'https://docs.npmjs.com/about-npm',
  ];
  const prompts = [];
  const toggleStates = [];
  const result = await executeDeepSeekWebTool({
    name: DEEPSEEK_WEB_FETCH,
    input: { url: urls[0], additional_urls: urls.slice(1) },
  }, {
    ensureTogglesOn: async (toolsProvided) => toggleStates.push(toolsProvided),
    runTurn: async (prompt, sink, buffer, isCancelled, includeLinks) => {
      prompts.push(prompt);
      assert.equal(buffer, true);
      assert.equal(includeLinks, true);
      return {
        text: 'STATUS: OPENED\nTitle: official documentation\nFact: page content was inspected.',
        sourceLinks: [],
        toolCalls: [],
        invalidToolCall: false,
      };
    },
  });

  assert.equal(prompts.length, 3);
  assert.deepEqual(toggleStates, [false, false, false, true]);
  for (let index = 0; index < urls.length; index++) {
    assert.ok(prompts[index].includes(urls[index]));
    assert.equal((prompts[index].match(/https?:\/\//g) || []).length, 1,
      'each fetch turn should contain only one requested URL');
    assert.ok(result.result.includes(urls[index]));
  }
});


test('fetch batch normalizes multiple public URLs and rejects an oversized batch', () => {
  assert.deepEqual(normalizeWebToolInput({
    name: DEEPSEEK_WEB_FETCH,
    input: {
      url: 'https://example.com/article#top',
      additional_urls: ['https://nodejs.org/en/download', 'https://github.com/nodejs/node/releases#latest'],
    },
  }), {
    url: 'https://example.com/article',
    additional_urls: ['https://nodejs.org/en/download', 'https://github.com/nodejs/node/releases'],
  });

  assert.throws(
    () => normalizeWebToolInput({
      name: DEEPSEEK_WEB_FETCH,
      input: {
        url: 'https://example.com',
        additional_urls: [
          'https://a.example',
          'https://b.example',
          'https://c.example',
          'https://d.example',
          'https://e.example',
        ],
      },
    }),
    /at most 5 URLs/
  );
});
