# deepseek-super

A local gateway that exposes an **Anthropic Messages API-compatible** interface on top of the DeepSeek web app at `chat.deepseek.com` using Playwright. The codebase is split into CommonJS modules for prompt construction, tool parsing, browser automation, SSE streaming, and HTTP request handling.

> **Important:** This project automates the DeepSeek website; it is not an official DeepSeek API integration. Website UI changes may require updates to selectors in `src/browser.js`. Use this project in accordance with DeepSeek's terms of service and your account requirements.

## Requirements

- Node.js 18 or later
- Google Chrome installed
- A DeepSeek account that can sign in through a browser

## Installation, Google login, and startup

Install the dependencies first:

```bash
npm install
```

### 1. Sign in to DeepSeek with Google

Run the login helper before starting the gateway server:

```bash
node deepseek-login.js
```

The script opens Chrome with the persistent profile in `deepseek-profile/`. Authentication is **manual**:

1. On the DeepSeek page, click **Log in / Sign in**.
2. Choose **Sign in with Google**.
3. Complete Google's sign-in, consent, CAPTCHA, or two-factor authentication in the browser yourself.
4. Once the DeepSeek chat composer is visible and ready, return to the terminal and press **Enter**. The script verifies the composer, ensures the `deepseek-profile/` directory exists, writes `deepseek-auth.json`, verifies that both artifacts were created, and closes Chrome so the profile is not left locked.

After successful login verification, two local artifacts should be present in the repository root:

- `deepseek-profile/` — Chrome's persistent user profile, including the login session. The script creates this directory before launching Chrome.
- `deepseek-auth.json` — a storage-state backup written after the DeepSeek chat composer is verified.

Both are listed in `.gitignore` because they contain authentication data. **Never commit or share these files.** If saving `deepseek-auth.json` fails, the login helper reports an error rather than reporting the setup as successful.

If the profile is already signed in, you do not need to authenticate again: make sure the chat page is ready and press Enter in the terminal. If the session has expired, rerun `node deepseek-login.js` and sign in manually. After you press Enter, the chat-composer check has a default timeout of 10 minutes; change it with the `DEEPSEEK_LOGIN_TIMEOUT_MS` environment variable if needed.

### 2. Start the gateway

After the login helper exits and Chrome has closed, start the server:

```bash
npm start
```

The server uses the same `deepseek-profile/` directory. Do not run `node deepseek-login.js` and `npm start` at the same time: both use the same Chrome profile and may conflict.

Default endpoint: `http://127.0.0.1:8787`

## Configuration

Configuration is read from environment variables:

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `8787` | Local HTTP server port |
| `MODEL_NAME` | `deepseek-super` | Virtual model name reported by the API |
| `PROFILE_DIR` | `./deepseek-profile` | Persistent Chrome profile directory |
| `DEEPSEEK_SUPER_TOKEN` | Empty | Optional API authentication token |
| `POLL_MS` | `200` | UI polling interval in milliseconds |
| `STABLE_MS` | `4000` | Required no-change period before a turn is considered complete |
| `MAX_TURN_MS` | `300000` | Maximum duration of one turn |
| `MAX_REPLAY` | `60000` | Maximum number of characters replayed from conversation history |

When `DEEPSEEK_SUPER_TOKEN` is set, send it using the `x-api-key` header or `Authorization: Bearer <token>`. Without a token, the server binds only to `127.0.0.1`.

Example client environment:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_AUTH_TOKEN=any
ANTHROPIC_MODEL=deepseek-super
```

If server authentication is enabled, set `ANTHROPIC_AUTH_TOKEN` to the same value as `DEEPSEEK_SUPER_TOKEN`.

## Using the Anthropic SDK

You can call the gateway with the official Anthropic SDK by pointing its `baseURL` at the local server:

```bash
npm install @anthropic-ai/sdk
```

Example non-streaming request:

```js
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN || 'any',
  baseURL: 'http://127.0.0.1:8787',
});

async function main() {
  const message = await client.messages.create({
    model: 'deepseek-super',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Explain the purpose of the src/ directory.' }],
  });

  for (const block of message.content) {
    if (block.type === 'text') process.stdout.write(block.text);
  }
}

main().catch(console.error);
```

The SDK sends requests to `/v1/messages`; do not append that path to `baseURL`. If `DEEPSEEK_SUPER_TOKEN` is unset, `apiKey` only needs to be a non-empty string. If server authentication is enabled, `apiKey` must match that token.

Example streaming request:

```js
const stream = await client.messages.create({
  model: 'deepseek-super',
  max_tokens: 1024,
  stream: true,
  messages: [{ role: 'user', content: 'Hello!' }],
});

for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    process.stdout.write(event.delta.text);
  }
}
```

### Compatibility limitations

The request contract validates `model`, `messages`, `max_tokens`, message roles and content, tool schemas, `tool_choice`, and `stream`. The `count_tokens` endpoint estimates input based on `system`, `messages`, and tool schemas. This is a character-length-based estimate, not a count from DeepSeek's actual tokenizer.

HTTP compatibility with the Anthropic SDK does not imply full semantic support for Anthropic model features. This gateway automates the DeepSeek website. For example, `max_tokens`, sampling parameters, prompt caching, images/documents, and Anthropic-specific options that are not mapped to the web UI may not behave like the official Anthropic API. Do not rely on undocumented options as supported features.

## Anthropic SDK integration test

The `@anthropic-ai/sdk` test dependency is included as a dev dependency. To test the local gateway with the real SDK, start the server first:

```bash
npm install
npm start
```

Sign in to DeepSeek in the Chrome window opened by Playwright. Then open a second terminal in the repository root and run:

```bash
npm run test:sdk
```

The smoke test checks non-streaming requests, SSE streaming events consumed by the SDK, tool calls, and a follow-up request with `tool_result`. The test requires the server to be running and the DeepSeek browser session to be signed in. If `DEEPSEEK_SUPER_TOKEN` is configured, set `ANTHROPIC_AUTH_TOKEN` to the same value. The endpoint can be changed with `DEEPSEEK_SUPER_BASE_URL`, and the model name with `ANTHROPIC_MODEL`.

The tool-use part of this test checks the payload only; it does not execute the generated command. Tool results in the follow-up request are synthetic. The test sends several requests to DeepSeek and therefore requires access to your signed-in DeepSeek web account.

Run unit tests and syntax checks without a running DeepSeek server:

```bash
npm test
npm run check
```

## Claude Code CLI integration test

This test uses the real Claude Code CLI through a local 9Router instance. The defaults are:

- Base URL: `http://localhost:20128/v1`
- Model: `byv-flash-2410`
- API key: read from `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`

Run the following commands from the repository root. Choose the instructions for your terminal. The API key is not displayed while entering it and should never be committed to the repository.

**Windows PowerShell:**

```powershell
$secure = Read-Host "9Router API key" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:ANTHROPIC_AUTH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
npm run test:claude-code
Remove-Item Env:ANTHROPIC_AUTH_TOKEN
```

**Git Bash:**

```bash
read -rsp "9Router API key: " ANTHROPIC_AUTH_TOKEN; echo
export ANTHROPIC_AUTH_TOKEN
npm run test:claude-code
unset ANTHROPIC_AUTH_TOKEN
```

The test requires six tools to be called sequentially and each to return a result: `Read`, `Glob`, `Grep`, `Edit`, `Write`, and `Bash(pwd)`. It also exercises multi-step tool calling. File edits and writes are restricted to a temporary workspace, not the repository. The only allowed Bash command is `pwd`; other tools are not available to the test. The temporary workspace is deleted when the test finishes.

Override the endpoint with `DEEPSEEK_SUPER_BASE_URL` and the model with `ANTHROPIC_MODEL`. When using the 9Router endpoint above, you do not need to run `npm start` for this repository; only 9Router needs to be running. Keep API keys in local environment variables and never commit them to a public repository.

## Endpoints

- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `HEAD /api/hello`

`POST /v1/messages` supports both SSE streaming responses and non-streaming JSON responses, as well as mapping `tool_use` and `tool_result` blocks to the prompt format used by the gateway.

## DeepSeek / Anthropic compatibility notes

This gateway implements part of the Anthropic Messages API contract so clients such as Claude Code can communicate with the DeepSeek web interface. It does not connect directly to `https://api.deepseek.com/anthropic`: prompts, tool calls, streaming, and token usage are handled by the local adapter and browser automation.

### Tool use and round trips

- Requests containing `tools` include tool names, descriptions, and `input_schema` definitions in local prompt instructions.
- Recognized tool calls are returned as Anthropic `tool_use` blocks; the gateway does not execute client-side tools. Claude Code or the client is responsible for executing them.
- The client must send tool results back as `tool_result` blocks referencing the original `tool_use_id`. The gateway continues the same DeepSeek chat URL and can request another tool if the task is not complete. The model returns a final answer when the available results are sufficient or a safety limit is reached.
- Model-generated tool payloads must still be checked. Validate tool names and input shapes in the parser/client; do not trust generated JSON blindly.
- `tool_choice` is mapped locally. Anthropic-specific semantics such as `disable_parallel_tool_use` are not automatically available, and some compatibility behavior may differ from the official API.

### Context caching

The official DeepSeek API automatically uses disk-based context caching and can reuse identical input prefixes across requests. Cache hits are best-effort, not guaranteed. The official API reports `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` in `usage`.

This Playwright gateway interacts with `chat.deepseek.com`, not the official API endpoint. Its code therefore cannot control or guarantee the official API's cache behavior. Local `usage` values are estimates, not measurements of DeepSeek token or cache usage. Anthropic's `cache_control` field does not configure an active cache in this adapter.

To keep context consistent and avoid unnecessary history truncation, instructions and tool schemas are built from each request. Continued conversations use the tool schema supplied for that turn. Changes in the DeepSeek UI or prompt content may still affect the website's internal behavior and caching efficiency.

### Anthropic fields and compatibility limits

The adapter supports common forms of `system`, `messages`, `tools`, `tool_choice`, and `stream`, along with the `text`, `tool_use`, and `tool_result` blocks required for common client workflows. This is not a full implementation of the Anthropic API. Fields or blocks that are not explicitly mapped may be ignored or normalized by the adapter. In particular, `cache_control` does not enable controlled caching in this gateway.

Official references:

- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache)
- [Using the Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api)
- [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)

## Project structure

```text
deepseek-super/
├── deepseek-login.js          # Manual Google sign-in helper
├── deepseek-super-server.js   # Backward-compatible entry point
├── package.json
├── README.md
├── .gitignore
├── scripts/
│   ├── anthropic-sdk-smoke.cjs # Anthropic SDK integration test
│   └── claude-code-smoke.cjs   # Claude Code CLI integration test
├── src/
│   ├── index.js               # Public API and lifecycle
│   ├── config.js              # Environment variables and defaults
│   ├── content.js             # Message-block normalization and session keys
│   ├── prompts.js             # Prompt building, tool_choice, and tool schemas
│   ├── tool-parser.js         # Streaming and TOOL_CALL parsing
│   ├── session-store.js       # Conversation URL cache
│   ├── browser.js             # Playwright, polling, and browser turn runner
│   ├── turn-state.js          # Turn state detection
│   ├── sse-sink.js            # Anthropic SSE serialization
│   ├── handler.js             # Messages endpoint handler
│   ├── http-utils.js          # HTTP parsing and authentication helpers
│   ├── anthropic-contract.js  # Request validation and token estimates
│   └── server.js              # HTTP routing
└── test/                      # Unit and behavior tests
```

## Using the project as a library

```js
const { createServer, config } = require('deepseek-super');

const server = createServer();
server.listen(config.PORT, '127.0.0.1');
```

For normal shutdown when using `createServer()` directly, close the HTTP server and call `shutdownBrowser()` from `deepseek-super/src/browser` to close the Chrome context as well. For regular CLI usage, run `npm start` so the built-in shutdown handlers are enabled.

## Troubleshooting tool calls

If DeepSeek generates an invalid JSON block inside `<TOOL_CALL>`, the gateway sends up to two correction prompts in the same conversation. The parser processes only the newest assistant response, not the user message that was just added to the UI. Logs record the payload length, whether the block was truncated, and the parsing failure reason.

For one diagnostic session, start the server with `DEBUG_TOOL_PARSER=1` to log an initial excerpt of a malformed payload. This excerpt may contain shell commands or prompt content. Keep these logs private and disable the flag after diagnosis.

## Tests and syntax checks

```bash
npm test
npm run check
```
