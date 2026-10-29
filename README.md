# deepseek-super

A local gateway that exposes an **Anthropic Messages API-compatible** interface on top of the DeepSeek web app at `chat.deepseek.com` using Playwright. The codebase is split into CommonJS modules for prompt construction, tool parsing, browser automation, SSE streaming, and HTTP request handling.

> **Important:** This project automates the DeepSeek website; it is not an official DeepSeek API integration. Website UI changes may require updates to selectors in `src/browser.js`. Use this project in accordance with DeepSeek's terms of service and your account requirements.

## Project positioning and policy risks

`deepseek-super` is an experimental compatibility gateway for people who specifically want to use their signed-in DeepSeek web session through Anthropic Messages API-style clients and agent tools. It does not expose DeepSeek's underlying model directly or implement Anthropic's native tool protocol. It translates requests into prompt instructions, automates the website with Playwright, reads the response from the UI, asks DeepSeek for DSML tool-call markup, and maps parsed calls to Anthropic-style responses. Legacy `<TOOL_CALL>` JSON wrappers are deliberately rejected and trigger DSML-format recovery instead of being parsed as tool calls.

**This approach may conflict with DeepSeek's web-service terms.** The [current DeepSeek Terms of Use](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html) (last updated March 27, 2026) include restrictions in Section 3.5 concerning copying/capturing service content and using robots, spiders, or other automated setups. This project uses browser automation, so users should review the terms and obtain any needed permission before use or redistribution. This README is a technical disclosure, not legal advice or a determination that a specific use is permitted. CAPTCHA, rate limits, account restrictions, or UI changes may interrupt operation.

For supported, more reliable agent integrations, consider the [official DeepSeek API](https://api-docs.deepseek.com/api/responses), which documents an Anthropic-compatible base URL at `https://api.deepseek.com/anthropic` and integrations with coding-agent clients. This project is not a replacement for that official API and is not intended to promise production reliability or real API-token accounting.

## Requirements

- Node.js 22 or later
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
| `MODEL_NAME` | `deepseek-super` | Fallback response model label when a request omits `model`; `/v1/models` lists the six configured model IDs |
| `PROFILE_DIR` | `./deepseek-profile` | Persistent Chrome profile directory |
| `DEEPSEEK_SUPER_TOKEN` | Unset | Optional explicit token override; if unset, a random token is created and stored in `.deepseek-super-token` |
| `POLL_MS` | `200` | UI polling interval in milliseconds |
| `STABLE_MS` | `4000` | Completion fallback idle period, used only if a UI completion signal was not observed |
| `MAX_TURN_MS` | `300000` | Hard maximum duration of a single turn; a timeout is reported as a failure rather than success |
| `MAX_REPLAY` | `60000` | Maximum replay prompt length in **characters**, not tokens |
| `MAX_PENDING_TURNS` | `8` | Maximum active-plus-queued browser turns before new requests are rejected as overloaded |
| `DEEPSEEK_SUPER_DB_PATH` | `./data/deepseek-super.sqlite3` | Path to the local SQLite database used for persistent sessions and request traces |
| `CORS_ALLOWED_ORIGINS` | Empty | Optional comma-separated list of exact extra browser origins allowed to access the local gateway |

### SQLite state and request tracing

The gateway stores its session-to-DeepSeek-thread mapping and privacy-conscious request traces in a local SQLite database. The default location is `data/deepseek-super.sqlite3`; override it with `DEEPSEEK_SUPER_DB_PATH`. The database uses WAL mode, a bounded busy timeout, foreign-key checks, a schema version, and retention limits for trace data. Gateway session fingerprints use the original top-level system content, the first original system/developer instruction when compatibility normalization moves those messages, and the complete first user message. Later system/developer messages appended to the request do not change the fingerprint. If a client rewrites the original user message or the stable base instructions during compaction and provides no stable conversation ID, the gateway starts a separately tracked session rather than guessing and potentially merging unrelated tasks.

Every Messages request gets a `request_id`, returned in the `X-Gateway-Request-ID` response header and printed in the `[REQ]` / `[response]` terminal logs. The database records prompt lengths before and after compaction, message/tool counts, session and thread generations, thread rotation reasons, stop reason, tool-call count, and how the browser completion was detected. It does not store raw prompts, tool inputs, tool results, or API tokens in trace events. The database does contain DeepSeek conversation URLs required for session resumption, so treat it as private local state.

Inspect the latest requests:

```bash
npm run trace
```

Inspect one request and its ordered events:

```bash
npm run trace -- req_...
```

Stop the gateway before moving or deleting the database. The `data/` directory and SQLite database/WAL files are ignored by Git. For a fresh local trace history, stop the server and delete `data/deepseek-super.sqlite3` along with its `-wal` and `-shm` companions if present.

### Available model names

The authenticated `GET /v1/models` endpoint advertises six request IDs: `deepseek-super`, `claude-mythos-5-1`, `claude-fable-5.1`, `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5`. The Claude-prefixed IDs are compatibility aliases and select gateway-defined response profiles; **all six entries still send requests to the signed-in DeepSeek web session. None connects to or provides the actual Anthropic Claude model its ID names.** For backward compatibility, direct API requests using the former dotted Mythos ID `claude-mythos-5.1` still resolve to the canonical `claude-mythos-5-1` response profile.

### Effort selector compatibility

All six catalog entries advertise `output_config.effort` levels (`low`, `medium`, `high`, `xhigh`, and `max`) so compatible clients can expose the effort selector. The gateway translates the chosen level into response-depth instructions for the DeepSeek web session; it does not provide Claude's native internal reasoning or change DeepSeek's model weights. Requests with an unsupported effort value are rejected as invalid.

### Authentication is always required

The server binds to `127.0.0.1` and requires a token for every API route, including the health endpoint. CORS `OPTIONS` preflight requests are handled before token authentication, but only for an accepted local or explicitly allowlisted Origin and they do not execute API operations. On first startup, if `DEEPSEEK_SUPER_TOKEN` is not set, the app generates a random local token and stores it in `.deepseek-super-token`. The file is listed in `.gitignore`; do not commit, publish, or share it. If `DEEPSEEK_SUPER_TOKEN` is set, that environment variable takes precedence over the local token file.

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

For Claude Code CLI, set the base URL to the gateway root **without `/v1`**:

```text
http://127.0.0.1:8787
```

Claude Code appends `/v1/messages` itself. Giving it a base URL that already ends in `/v1` can create a duplicated `/v1/v1/messages` path and return HTTP 404. The Claude Code smoke test accepts a trailing `/v1` in `DEEPSEEK_SUPER_BASE_URL` for convenience and strips it before starting the CLI. The Anthropic SDK also uses the server root, for example `http://127.0.0.1:8787`.

## Using the Anthropic SDK

You can call the gateway with the official Anthropic SDK by pointing its `baseURL` at the local server:

```bash
npm install @anthropic-ai/sdk
```

Example non-streaming request:

```js
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('node:fs');

const apiKey = process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.DEEPSEEK_SUPER_TOKEN ||
  fs.readFileSync('.deepseek-super-token', 'utf8').trim();

const client = new Anthropic({
  apiKey,
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

The SDK sends requests to `/v1/messages`; do not append that path to `baseURL`. Authentication is always enabled, so `apiKey` must match the server's `DEEPSEEK_SUPER_TOKEN` value or the value in `.deepseek-super-token`. Keep the token file local and ignored by Git.

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


### Tool calls with the Anthropic SDK

The gateway can return Anthropic-style **tool_use** blocks in both non-streaming JSON responses and SSE streams. These examples reuse the **client** initialized above. The tool schema is sent with each request, and **tool_choice** asks for the named tool so the example is easy to recognize.

**Important:** receiving a **tool_use** block does not execute the tool. Your application or agent is responsible for validating the requested action, executing it safely, and sending its result back as a **tool_result** block. The shell command below is only a demonstration payload; this example prints it and never runs it.

#### Non-streaming tool call

~~~js
(async () => {
  const toolsForNonStream = [{
    name: 'Bash',
    description: 'Demonstration tool only; this example does not execute commands.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The requested shell command' },
      },
      required: ['command'],
    },
  }];

  const toolMessage = await client.messages.create({
    model: 'deepseek-super',
    max_tokens: 256,
    tools: toolsForNonStream,
    tool_choice: { type: 'tool', name: 'Bash' },
    messages: [{
      role: 'user',
      content: 'Call Bash with command exactly "echo SDK_TOOL_CALL_OK". Do not answer in plain text.',
    }],
  });

  const toolUse = toolMessage.content.find((block) => block.type === 'tool_use');
  if (!toolUse) {
    throw new Error('Expected a tool_use block; stop_reason=' + toolMessage.stop_reason);
  }

  // Inspect the requested tool call. Do not execute untrusted model output blindly.
  console.log(JSON.stringify({
    stop_reason: toolMessage.stop_reason,
    id: toolUse.id,
    name: toolUse.name,
    input: toolUse.input,
  }, null, 2));
})().catch(console.error);
~~~

When the client has actually run a tool, send the result in the next Messages request using the same conversation history, the assistant's **tool_use** block, and a user **tool_result** block whose **tool_use_id** matches **toolUse.id**. The local **npm run test:sdk** smoke test demonstrates that round trip with a **synthetic** result; it does not execute the command.

#### Streaming tool call

With SSE streaming, tool-use information arrives in **content_block_start** and **content_block_delta** events. The SDK exposes the **input_json_delta.partial_json** fragments; accumulate them by content-block index before parsing the JSON.

~~~js
(async () => {
  const toolsForStream = [{
    name: 'Bash',
    description: 'Demonstration tool only; this example does not execute commands.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The requested shell command' },
      },
      required: ['command'],
    },
  }];

  const stream = await client.messages.create({
    model: 'deepseek-super',
    max_tokens: 256,
    stream: true,
    tools: toolsForStream,
    tool_choice: { type: 'tool', name: 'Bash' },
    messages: [{
      role: 'user',
      content: 'Call Bash with command exactly "echo SDK_STREAM_TOOL_CALL_OK". Do not answer in plain text.',
    }],
  });

  const toolBlocks = new Map();
  let stopReason = null;

  for await (const event of stream) {
    if (
      event.type === 'content_block_start' &&
      event.content_block &&
      event.content_block.type === 'tool_use'
    ) {
      toolBlocks.set(event.index, {
        id: event.content_block.id,
        name: event.content_block.name,
        partialJson: '',
      });
    } else if (
      event.type === 'content_block_delta' &&
      event.delta &&
      event.delta.type === 'input_json_delta'
    ) {
      const tool = toolBlocks.get(event.index);
      if (tool) tool.partialJson += event.delta.partial_json;
    } else if (event.type === 'message_delta') {
      stopReason = event.delta.stop_reason;
    }
  }

  const toolCalls = [...toolBlocks.values()].map((tool) => ({
    id: tool.id,
    name: tool.name,
    input: tool.partialJson ? JSON.parse(tool.partialJson) : {},
  }));

  if (stopReason !== 'tool_use' || toolCalls.length === 0) {
    throw new Error('Expected streamed tool_use output; stop_reason=' + stopReason);
  }

  // The streamed input is a request for your app to consider, not an executed action.
  console.log(JSON.stringify({ stop_reason: stopReason, toolCalls }, null, 2));
})().catch(console.error);
~~~

### Compatibility limitations

The request contract validates `model`, `messages`, `max_tokens`, message roles and content, tool schemas, `tool_choice`, and `stream`. The `/v1/messages/count_tokens` endpoint estimates input length using a local character-based formula; it does not invoke DeepSeek's actual tokenizer.

The gateway's response `usage.input_tokens` and `usage.output_tokens`, and the `/count_tokens` result, are **estimates**, not upstream measurements. Responses include the header `X-Token-Usage-Estimated: true` to make this explicit. The estimate can differ substantially from actual model tokenization, hidden website prompt context, and any provider/router billing counters. Do not rely on these values for billing or precise context-window management.

HTTP compatibility with the Anthropic SDK does not imply full semantic support for Anthropic model features. This gateway automates the DeepSeek website. For example, `max_tokens`, sampling parameters, prompt caching, images/documents, and Anthropic-specific options that are not mapped to the web UI may not behave like the official Anthropic API. Do not rely on undocumented options as supported features.

### DeepSeek-native WebSearch / WebFetch adapter

When `tool_choice` is `auto`, the gateway offers two internal tools to DeepSeek:

- `DeepSeekWebSearch({ query, additional_queries?, sites?, max_results? })` — executes one internal batch as separate, focused Search-mode turns for each query/domain combination (up to 12 combinations). Each Search turn runs in a clean temporary chat so the original prompt's DSML tool schemas cannot trigger recursive gateway tool calls. It prefers rendered source links and falls back to explicit URLs in visible response text only if the UI exposes no link anchors. Site-scoped results are credited only when the hostname matches the requested domain.
- `DeepSeekWebFetch({ url, additional_urls? })` — inspects up to 5 public HTTP(S) URLs in separate turns within one internal batch, returning a best-effort per-page summary and visible evidence for each requested URL.

These are **gateway-internal tools**. Their calls are parsed from DSML, executed in isolated temporary DeepSeek chats, and their results are fed back to the restored original conversation as tool-result context. The gateway preserves the original chat URL and returns to it before the model continues. Internal calls are not returned as client-facing `tool_use` blocks. Any client-owned calls in the same batch (for example, `Read` or `Bash`) are returned normally after the internal web call finishes. Internal web-tool loops are bounded to three rounds per request.

DeepThink is still enabled through the UI toggle. Search is turned off for normal tool planning, enabled in each isolated temporary chat, then turned off again after restoring the original conversation. Toggle control depends on the DeepSeek website DOM and is verified before a native Search turn is attempted.

Safety and limitations:

- Each search query is capped at 500 characters; a batch supports at most 6 queries, 8 bare target domains, and 12 query/domain combinations. Target-site domains must be public hostnames without a scheme, path, port, or wildcard. `max_results` defaults to 8 and accepts integers from 1 to 12 across the entire batch.
- Fetch accepts up to 5 public `http://` or `https://` URLs per batch, rejects embedded credentials and common local/private targets, and strips URL fragments. It is not a raw HTTP fetch API and does not guarantee full-page extraction.
- A batch is one internal tool call, but its query/domain combinations or URLs are processed in separate sequential Search-enabled UI turns; they are not parallel HTTP requests. Search attempts avoid relying on a literal `site:` query operator and do not count a URL from another domain as a match for a site-scoped search. Results may still be unavailable if the signed-in UI does not surface source links.
- Source links, summaries, and citations depend on what the signed-in DeepSeek Search UI actually returns. If the Search toggle cannot be located or its state cannot be verified, the internal web tool fails instead of pretending a search took place. If Search returns no source URLs, the result explicitly reports that limitation. The model may provide incomplete results; textual URLs are not proof that every source is authentic or accessible, so verify important sources independently.
- If the DeepSeek UI changes, the Search toggle selectors or result rendering may need maintenance.

Unit tests cover argument validation, URL safety, focused search/fetch turns, source-domain matching, toggle restoration, internal tool-result handoff, and mixed internal/client tool batches. Run `npm test` and `npm run check` without a live session. For live checks, sign in with `node deepseek-login.js`, start `npm start`, then run `npm run test:web-tools`, `npm run test:sdk`, and `npm run test:claude-code` in another terminal. The SDK and Claude Code scripts now also test Search and Fetch through the local gateway. The tests deliberately fail when Search has no source URLs from at least two target domains, when direct fetch is used as a fallback for empty search results, or when one of the three requested fetch URLs does not return a title and fact. The Search smoke test includes the actual returned response in its failure message to help diagnose toggle or UI issues. These tests require the signed-in DeepSeek Search UI and may fail if its search service, selectors, or source links are unavailable. SDK/Claude Code web-tool checks are skipped for external endpoints because they do not necessarily implement this repository's internal tools.

### Tool-call and browser recovery

The gateway prompts DeepSeek to emit DSML calls using `<｜DSML｜ calls>`, `<｜DSML｜ invoke>`, and `<｜DSML｜ parameter>` blocks. String parameters are read as raw text with `string="true"`; non-string values are parsed as JSON with `string="false"`. The parser accepts DeepSeek V4 `tool_calls` and V4.1 `calls` spellings, and rejects legacy `<TOOL_CALL>` JSON wrappers rather than treating them as tool calls. Parsed tool names and arguments are then validated against the schemas supplied by the client using common JSON Schema constraints (types, required/properties, additional properties, enum/const, arrays, and common string/number bounds). This is a deliberately limited validator, not a complete implementation of every JSON Schema keyword. Multi-tool responses are validated as a whole before tool blocks are emitted, so a partially invalid batch is not forwarded. Malformed or schema-invalid output receives a bounded correction attempt; if recovery fails, the gateway returns an upstream API error rather than disguising the failure as a successful \`end_turn\`.

At 41 or more conversation messages, the gateway starts a fresh DeepSeek browser thread and builds a bounded replay instead of continuing to grow the existing browser thread. The replay truncation limit is character-based, not a model-token limit; the latest request and tool schemas are placed near the replay tail to improve their chance of being retained. Oversized individual tool results retain both their beginning and ending, with an explicit truncation marker.

If a Playwright page closes, the gateway attempts to revive the persistent browser context or create a new one on a subsequent initialization. An active turn is not blindly replayed after a browser failure, because repeating a tool request could duplicate side effects. When no generation-completion signal is available, the idle fallback waits twice the configured \`STABLE_MS\` interval; a turn that reaches \`MAX_TURN_MS\` without completion is reported as an error, not as a successful final response.

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

The smoke test covers four Anthropic SDK compatibility flows plus two local-gateway web-tool flows: focused multi-query/multi-domain `DeepSeekWebSearch` with strict source-domain validation, and `DeepSeekWebFetch` over three exact public URLs with per-page title/fact checks. The tool-use checks assert the returned tool name and fixture command. **No command is executed**; the follow-up tool result is synthetic. The web-tool checks require the local gateway and are skipped for external endpoints. All live requests use the signed-in DeepSeek web session and may be subject to web-app limits.

Run unit tests and syntax checks without a logged-in DeepSeek session or a running gateway:

```bash
npm test
npm run check
```

## Claude Code CLI integration test

By default, `npm run test:claude-code` tests **this repository's local gateway**, not a separate router:

- Base URL: `http://127.0.0.1:8787` (provider root; no `/v1`)
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

The test requires six tools to be called sequentially and each to return a result: `Read`, `Glob`, `Grep`, `Edit`, `Write`, and `Bash(pwd)`. It also exercises multi-step tool calling. File edits and writes are restricted to a temporary workspace, not the repository. The only allowed Bash command is `pwd`; the workspace is deleted after the test finishes. When using this repository's local gateway, it then performs a second Claude Code run that exercises `DeepSeekWebSearch` across three domains and `DeepSeekWebFetch` on three exact URLs, validating separate Search/Fetch sections, actual source URLs, and per-page titles/facts. These web checks are skipped for external gateways.

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
$env:DEEPSEEK_SUPER_BASE_URL = "http://localhost:20128"
$env:ANTHROPIC_MODEL = "byv-flash-2410"
npm run test:claude-code
Remove-Item Env:ANTHROPIC_AUTH_TOKEN
Remove-Item Env:DEEPSEEK_SUPER_BASE_URL
Remove-Item Env:ANTHROPIC_MODEL
```

**Model routing note:** `byv-flash-2410` is a user-configured 9Router combo/alias, not a model implemented by this repository. For the setup described here, configure that combo with exactly one target: `deepseek-super`. Do not add secondary models or fallbacks if the intent is to exercise only this project's DeepSeek-backed gateway. That combo routing is configured in 9Router and cannot be verified by this repository's code. When testing through an external 9Router endpoint, this repo's gateway is exercised only if the combo is actually configured to route to it; the default local test avoids that ambiguity.

The external route is optional and is not the CI test. Keep API keys in local environment variables and never commit them to a public repository.

## Model catalog and response profiles

The `/v1/models` catalog exposes six request IDs: `deepseek-super`, `claude-mythos-5-1`, `claude-fable-5.1`, `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5`. Each ID selects a separate response-style profile in `src/model-profiles.js`; profiles guide behavior and working style but do not change the underlying model or grant provider-native capabilities. Effort settings remain an independent layer. The Mythos preset prioritizes authorized defensive security analysis and careful remediation; the Fable preset is flexible across demanding reasoning, long-horizon agent work, research, data, documents, and creative tasks when appropriate. These are gateway-defined presets inspired by public model guidance, not a representation that the gateway invokes native Claude models. The prompt retains BYV attribution but does not disclose internal project or browser-automation details to the model.

## Endpoints

- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `HEAD /api/hello`

All listed API routes require the API token. Browser `OPTIONS` preflight is the exception: it is allowed only for a validated Origin and returns no API data. `POST /v1/messages` supports SSE streaming and non-streaming JSON responses, plus the local mapping of `tool_use`/`tool_result` blocks.

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
Parser converts DeepSeek DSML calls to JSON argument objects and Anthropic-style tool_use
        |
        v
Client/agent executes its own tools and sends tool_result back
        |
        +---- the gateway resumes the same DeepSeek chat when possible
```

Tool calling is prompt-based rather than a native tool protocol offered by the website. Tool names, schemas, and the JSON format are described in prompts; the gateway parses the resulting text. Model-generated tool arguments are untrusted input and must be validated by the client before any tool is executed. DeepSeek's web UI does not report the same telemetry as a dedicated API, so local token usage and caching fields cannot be treated as provider billing data.

The session cache key is a SHA-256 fingerprint of the complete top-level system instructions and the first user message. Hashing the complete values avoids avoidable collisions caused by truncating the fingerprint inputs, but the Anthropic Messages request format does not provide a standard, stable conversation ID. As a result, two independent conversations with the same system instructions and identical first user message can still resolve to the same cached DeepSeek chat. This adapter is safest for one active agent conversation per local gateway; do not assume separate clients receive hard session isolation.

The browser is a single shared resource. Requests are serialized through a bounded queue; when the queue is full, the server reports overload instead of allowing an unbounded backlog. If a client disconnects while a turn is running, the gateway best-effort clicks a visible stop/cancel control, stops polling, and releases the queue. This cancellation is best-effort because the website does not expose a documented API for cancelling a generation. Completion detection first uses the UI's observable stop/send controls when detected; `STABLE_MS` is an inactivity fallback only when the explicit signal has not been observed. UI changes can break these selectors, and the `MAX_TURN_MS` deadline is reported as a failure rather than a completed answer.

Initial prompt replay is capped by `MAX_REPLAY` characters. If the cap is exceeded, the gateway compacts oversized external system instructions, older conversation history, and tool results while prioritizing the project policy, available tool schemas, and latest request. It inserts a truncation warning into the prompt and logs the lengths. Some earlier context can still be lost; long agent sessions may therefore need compaction or a fresh session. The cap is character-based, not a token count.

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
│   ├── tool-parser.js         # Streaming DSML parsing and normalization
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

## Deferred fixes and known issues

Items recorded in [docs/known-issues.md](docs/known-issues.md) are intentionally deferred and labeled **DEFERRED - FIX ONLY IF REQUESTED**. Do not resume or implement those fixes unless the user explicitly requests a specific item.

## Troubleshooting tool calls

If DeepSeek generates invalid DSML markup or attempts the disallowed legacy `<TOOL_CALL>` JSON wrapper, the gateway sends up to two correction prompts in the same conversation. Recovery prompts require DSML and never parse or forward legacy-format calls. The parser processes only the newest assistant response, not the user message that was just added to the UI. Logs record the payload length, whether the block was truncated, and the parsing failure reason.

For one diagnostic session, start the server with `DEBUG_TOOL_PARSER=1` to log an initial excerpt of a malformed payload. This excerpt may contain shell commands or prompt content. Keep these logs private and disable the flag after diagnosis.

## Tests and syntax checks

```bash
npm test
npm run check
```
