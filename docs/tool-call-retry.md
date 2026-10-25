# Tool-call retry diagnostics

## What the gateway does

The gateway buffers tool-capable responses until it can parse a `<TOOL_CALL>` payload. If parsing fails, it submits a correction request in the same DeepSeek conversation, with the correction instructions placed after the original request. It tries up to two correction turns before returning a readable fallback message.

`src/browser.js` waits for a fresh assistant response key or changed assistant answer before parsing. A new user-message row alone is not treated as an assistant reply, which prevents a retry from parsing the previous malformed response again.

## Troubleshooting

1. Pull the latest `main` branch and restart the Node server.
2. Check the server log for `[retry]`, `[tool-parser]`, and `[response]` messages.
3. For one diagnostic run, set `DEBUG_TOOL_PARSER=1` before starting the server. This prints a short prefix of the first rejected payload to help identify its malformed JSON.

The diagnostic preview can contain shell commands, file paths, or other prompt content. Keep logs private and turn the flag off after troubleshooting.

## Local checks

```bash
npm install
npm test
npm run check
```
