# deepseek-super

A local gateway that exposes an **Anthropic Messages API-compatible** interface on top of the DeepSeek web app at `chat.deepseek.com` using Playwright. The codebase is split into CommonJS modules for prompt construction, tool parsing, browser automation, SSE streaming, and HTTP request handling.

> **Important:** This project automates the DeepSeek website; it is not an official DeepSeek API integration. Website UI changes may require updates to selectors in `src/browser.js`. Use this project in accordance with DeepSeek's terms of service and your account requirements.

## Project positioning and policy risks

`deepseek-super` is an experimental compatibility gateway for people who specifically want to use their signed-in DeepSeek web session through Anthropic Messages API-style clients and agent tools. It does not expose DeepSeek's underlying model directly or implement Anthropic's native tool protocol. It translates requests into prompt instructions, automates the website with Playwright, reads the response from the UI, and maps recognized `<TOOL_CALL>` output back to Anthropic-style responses.

**This approach may conflict with DeepSeek's web-service terms.** The [current DeepSeek Terms of Use](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html) (last updated March 27, 2026) include restrictions in Section 3.5 concerning copying/capturing service content and using robots, spiders, or other automated setups. This project uses browser automation, so users should review the terms and obtain any needed permission before use or redistribution. This README is a technical disclosure, not legal advice or a determination that a specific use is permitted. CAPTCHA, rate limits, account restrictions, or UI changes may interrupt operation.

For supported, more reliable agent integrations, consider the [official DeepSeek API](https://api-docs.deepseek.com/api/responses), which documents an Anthropic-compatible base URL at `https://api.deepseek.com/anthropic` and integrations with coding-agent clients. This project is not a replacement for that official API and is not intended to promise production reliability or real API-token accounting.

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

## Configuration and local security

Configuration is read from environment variables:

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `8787` | Local HTTP server port |
| `MODEL_NAME` | `deepseek-super` | Virtual model name reported by the API |
| `PROFILE_DIR` | `./deepseek-profile` | Persistent Chrome profile directory |
| `DEEPSEEK_SUPER_TOKEN` | Unset | Optional explicit token override; if unset, a random token is created and stored in `.deepseek-super-token` |
| `POLL_MS` | `200` | UI polling interval in milliseconds |
| `STABLE_MS` | `4000` | Completion fallback idle period, used only if a UI completion signal was not observed |
| `MAX_TURN_MS` | `300000` | Hard maximum duration of a single turn; a timeout is reported as a failure rather than success |
| `MAX_REPLAY` | `60000` | Maximum replay prompt length in **characters**, not tokens |
| `MAX_PENDING_TURNS` | `8` | Maximum active-plus-queued browser turns before new requests are rejected as overloaded |
| `CORS_ALLOWED_ORIGINS` | Empty | Optional comma-separated list of exact extra browser origins allowed to access the local gateway |

### Authentication is always required

The server binds to `127.0.0.1` and requires a token for every endpoint, including the health endpoint. On first startup, if `DEEPSEEK_SUPER_TOKEN` is not set, the app generates a random local token and stores it in `.deepseek-super-token`. The file is listed in `.gitignore`; do not commit, publish, or share it. If `DEEPSEEK_SUPER_TOKEN` is set, that environment variable takes precedence over the local token file.

When using the default local token file, load the same value in a **second PowerShell terminal** before running an SDK or client command:

```powershell
$env:ANTHROPIC_AUTH_TOKEN = (Get-Content -Raw .deepseek-super-token).Trim()
```

In Git Bash:

```bash
export ANTHROPIC_AUTH_TOKEN="$(tr -d '\\r\\n' < .deepseek-super-token)"
```

If you explicitly set `DEEPSEEK_SUPER_TOKEN` for the server, set `ANTHROPIC_AUTH_TOKEN` to the same secret in client processes. Never paste secrets into source files or commit them.

### Host and browser-origin protection

Requests with unexpected `Host` headers are rejected to reduce DNS-rebinding exposure. Browser-origin requests are accepted only from the same local loopback origin/port or from an exact origin listed in `CORS_ALLOWED_ORIGINS`; CORS does not use a wildcard. Ordinary Node.js clients normally omit `Origin` and do not need CORS configuration. For example, to allow a trusted local frontend, set `CORS_ALLOWED_ORIGINS=http://localhost:3000` before starting the server. Only allow origins you control.

### Client base URL

For Claude Code CLI, the local base URL is:

```text
http://127.0.0.1:8787/v1
```

The official Anthropic SDK's `baseURL` is the server root without `/v1`, for example `http://127.0.0.1:8787`; the SDK appends the API path itself.

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

The request contract validates `model`, `messages`, `max_tokens`, message roles and content, tool schemas, `tool_choice`, and `stream`. The `/v1/messages/count_tokens` endpoint estimates input length using a local character-based formula; it does not invoke DeepSeek's actual tokenizer.

The gateway's response `usage.input_tokens` and `usage.output_tokens`, and the `/count_tokens` result, are **estimates**, not upstream measurements. Responses include the header `X-Token-Usage-Estimated: true` to make this explicit. The estimate can differ substantially from actual model tokenization, hidden website prompt context, and any provider/router billing counters. Do not rely on these values for billing or precise context-window management.

HTTP compatibility with the Anthropic SDK does not imply full semantic support for Anthropic model features. This gateway automates the DeepSeek website. For example, `max_tokens`, sampling parameters, prompt caching, images/documents, and Anthropic-specific options that are not mapped to the web UI may not behave like the official Anthropic API. Do not rely on undocumented options as supported features.

## Anthropic SDK integration test

The `@anthropic-ai/sdk` test dependency is included as a dev dependency. Sign in to DeepSeek first using the manual login helper documented above, then start the local gateway:

```powershell
node deepseek-login.js
npm start
```

Open a second terminal at the repository root and run:

```powershell
npm run test:sdk
```

For the default local endpoint, the smoke test reads the ignored `.deepseek-super-token` file automatically. If the server was started with an explicit `DEEPSEEK_SUPER_TOKEN`, set `ANTHROPIC_AUTH_TOKEN` to the same value in the second terminal. The endpoint can be changed with `DEEPSEEK_SUPER_BASE_URL`, and the model name with `ANTHROPIC_MODEL`; custom endpoints require a matching token.

The smoke test checks non-streaming requests, SSE streaming events consumed by the SDK, tool calls, and a follow-up request with `tool_result`. The tool-use part checks the payload only; it does not execute the generated command. Tool results in the follow-up request are synthetic. These requests go through the signed-in DeepSeek web session and may be subject to web-app limits.

Run unit tests and syntax checks without a logged-in DeepSeek session or a running gateway:

```bash
npm test
npm run check
```

## Claude Code CLI integration test

By default, `npm run test:claude-code` tests **this repository's local gateway**, not a separate router:

- Base URL: `http://127.0.0.1:8787/v1`
- Model: `deepseek-super`
- Token: read automatically from the ignored `.deepseek-super-token` file when using the default local endpoint

First complete manual Google sign-in and start the gateway in one terminal:

```powershell
node deepseek-login.js
npm start
```

Then, in a second terminal at the repository root:

```powershell
npm run test:claude-code
```

The test requires six tools to be called sequentially and each to return a result: `Read`, `Glob`, `Grep`, `Edit`, `Write`, and `Bash(pwd)`. It also exercises multi-step tool calling. File edits and writes are restricted to a temporary workspace, not the repository. The only allowed Bash command is `pwd`; the workspace is deleted after the test finishes.

### Optional: run the CLI test through 9Router

An external endpoint can be selected explicitly. In PowerShell, enter its API key without displaying it and pass the model alias:

```powershell
$secure = Read-Host "External gateway API key" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:ANTHROPIC_AUTH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
$env:DEEPSEEK_SUPER_BASE_URL = "http://localhost:20128/v1"
$env:ANTHROPIC_MODEL = "byv-flash-2410"
npm run test:claude-code
Remove-Item Env:ANTHROPIC_AUTH_TOKEN
Remove-Item Env:DEEPSEEK_SUPER_BASE_URL
Remove-Item Env:ANTHROPIC_MODEL
```

**Model routing note:** `byv-flash-2410` is a user-configured 9Router combo/alias, not a model implemented by this repository. For the setup described here, configure that combo with exactly one target: `deepseek-super`. Do not add secondary models or fallbacks if the intent is to exercise only this project's DeepSeek-backed gateway. That combo routing is configured in 9Router and cannot be verified by this repository's code. When testing through an external 9Router endpoint, this repo's gateway is exercised only if the combo is actually configured to route to it; the default local test avoids that ambiguity.

The external route is optional and is not the CI test. Keep API keys in local environment variables and never commit them to a public repository.

## Endpoints

- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `HEAD /api/hello`

All endpoints require the API token. `POST /v1/messages` supports SSE streaming and non-streaming JSON responses, plus the local mapping of `tool_use`/`tool_result` blocks.

## End-to-end architecture and trust boundaries

The request path is:

```text
Anthropic-compatible client / AI agent (for example, Claude Code)
        |
        | POST /v1/messages (authenticated HTTP request)
        v
Local deepseek-super gateway
  - validates and normalizes the request
  - renders system instructions, chat history, and tool schemas as prompt text
  - serializes access to a single Playwright Chrome profile
        |
        v
Playwright + your signed-in Chrome profile
        |
        v
https://chat.deepseek.com/ (DeepSeek web UI)
        |
        | assistant text is read back from the page
        v
Parser converts recognized <TOOL_CALL> JSON to Anthropic-style tool_use
        |
        v
Client/agent executes its own tools and sends tool_result back
        |
        +---- the gateway resumes the same DeepSeek chat when possible
```

Tool calling is prompt-based rather than a native tool protocol offered by the website. Tool names, schemas, and the JSON format are described in prompts; the gateway parses the resulting text. Model-generated tool arguments are untrusted input and must be validated by the client before any tool is executed. DeepSeek's web UI does not report the same telemetry as a dedicated API, so local token usage and caching fields cannot be treated as provider billing data.

The browser is a single shared resource. Requests are serialized through a bounded queue; when the queue is full, the server reports overload instead of allowing an unbounded backlog. If a client disconnects while a turn is running, the poll loop stops and releases the queue. Completion detection first uses the UI's observable stop/send controls when detected; `STABLE_MS` is an inactivity fallback only when the explicit signal has not been observed. UI changes can break these selectors, and the `MAX_TURN_MS` deadline is reported as a failure rather than a completed answer.

Initial prompt replay is capped by `MAX_REPLAY` characters. If the cap is exceeded, the gateway preserves the prompt head and tail, inserts a clear truncation warning into the prompt, and logs the lengths. Some middle context is still lost; long agent sessions may therefore need compaction or a fresh session. The cap is character-based, not a token count.

The local API token, Host validation, and CORS allowlist protect the local gateway endpoint. They do not protect or anonymize data submitted to DeepSeek: the browser session and prompts are still processed by the DeepSeek web service under the service's own terms and privacy policy. Do not submit data you are not comfortable sending to that service.

## DeepSeek / Anthropic compatibility notes

This gateway implements part of the Anthropic Messages API contract so clients such as Claude Code can communicate with the DeepSeek web interface. It does not connect directly to `https://api.deepseek.com/anthropic`: prompts, tool calls, streaming, and token usage are handled by the local adapter and browser automation.

For a supported API path, the [official DeepSeek API documentation](https://api-docs.deepseek.com/api/responses) describes an Anthropic-compatible API endpoint and agent integrations. This web-automation project is separate from that official API.

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
