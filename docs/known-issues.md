# Deferred fixes and known issues

> **STATUS LABEL: DEFERRED - FIX ONLY IF REQUESTED**
>
> This file records issues for later reference. Do not start work, change implementation, create a fix commit, or open a fix PR for an item below unless the user explicitly asks to fix or resume that specific item. When the user does ask, use the issue ID below to resume the investigation.

Last updated: 2026-10-30

## DEFERRED-001: DeepSeek UI response-completion detection

**Status: DEFERRED - FIX ONLY IF REQUESTED**

### Summary

The gateway can complete requests, including Claude Code tool round-trips, but live runs still fall back to the idle/stable timer instead of observing a reliable UI completion signal. The composer-restoration candidate was added as an additional signal, but it did not activate in the latest live test because the composer was already visible at every observed poll.

### Evidence from the live run

The local test suite and syntax check passed after the diagnostic changes. A Claude Code request using Bash returned CHECK PASSED, and the gateway reported a tool call and a subsequent tool result. This validates the basic tool round-trip, not the completion detector itself.

Representative gateway diagnostics:

```json
{
  "source": "stable_fallback",
  "sawGeneratingSignal": false,
  "sawComposerUnavailableSignal": false,
  "composerReady": true,
  "idleMs": 8092,
  "stableMs": 4000,
  "answerChars": 242
}
```

The accompanying UI diagnostics repeatedly showed:

- composer-ready was true
- stopCandidateCount was 0
- stopButtonVisible was false
- completionSignalAvailable was false
- primaryButtonFound was true
- primaryDisabledClass was true
- textareaFound was true
- textareaVisible was true
- primaryButtonVisible was true

Similar results were observed over several response turns. The fallback therefore still fired after roughly twice STABLE_MS (about eight seconds with the current setting). This is an inactivity heuristic, not proof from DeepSeek that generation has ended.

### Next investigation when explicitly requested

1. Capture the live DOM while DeepSeek is still generating a response. Save it as generating.html. The existing user-supplied ui.html represents a completed response and is not sufficient by itself.
2. Compare the in-progress DOM with the completed DOM. Inspect the textarea, primary button, Stop/cancel controls, accessible labels, class changes, and any generation/progress indicator. Do not assume hashed CSS class names are stable selectors.
3. Update the UI-state detector only after a concrete, repeatable DOM signal is identified.
4. Verify normal text responses, long responses, thinking-enabled responses, tool calls, and tool-result continuation. Ensure a temporary pause or missing DOM element cannot prematurely end a response, and that MAX_TURN_MS still produces an error rather than a false successful completion.
5. Check the [turn-completion-result] diagnostic source across live runs. The goal is to observe an evidence-backed UI completion source in appropriate cases, rather than merely to hide the fallback warning.

Relevant files: src/browser-dom.js, src/browser.js, src/turn-state.js, and test/turn-state.test.js.

## DEFERRED-002: Chrome --no-sandbox warning banner

**Status: DEFERRED - FIX ONLY IF REQUESTED; live verification pending**

### Summary

The automation browser previously displayed Chrome's warning that the --no-sandbox command-line flag was in use. The launch configuration now explicitly sets chromiumSandbox: true in src/browser.js. The latest unit tests and syntax checks pass, but the latest user-provided server logs do not confirm whether the banner disappeared after restarting Chrome.

### Next verification when explicitly requested

1. Stop the gateway and close the automation Chrome process so the next run uses a fresh launch.
2. Run npm start and check whether the warning banner is absent.
3. Verify that the persistent profile, DeepSeek login, and normal automation still work.
4. If the banner remains or Chrome fails to start, inspect the actual executable and launch arguments before changing flags further. Do not disable sandboxing as a quick workaround.

No claim that the banner is resolved should be made until the browser has been checked after a fresh launch.

## DEFERRED-003: Large prompt replay truncation

**Status: PARTIALLY ADDRESSED: model-specific replay caps implemented. Further compaction optimization remains DEFERRED - FIX ONLY IF REQUESTED.**

### Summary

Replay limits are now selected by model ID: IDs beginning with `claude-` use 150,000 characters, while `deepseek-super` and non-Claude IDs continue using the existing `MAX_REPLAY` value (60,000 characters by default). The log examples below are from before this change and show why the Claude-specific increase was requested:

| Input characters | Cap characters | Characters omitted |
| ---: | ---: | ---: |
| 120,241 | 60,000 | 60,241 |
| 140,684 | 60,000 | 80,684 |

The gateway inserts an explicit truncation warning and prioritizes current instructions, tool schemas, and the latest request, but character-based compaction can still drop earlier conversation context. These numbers describe characters, not model tokens.

### Next investigation when explicitly requested

1. Use request IDs and the existing trace metadata to identify which prompt sections contribute most to the replay size, without logging or sharing secrets or full private prompts.
2. Check whether system instructions, tool descriptions, older history, and tool results can be compacted more effectively while preserving the latest request and required tool schemas.
3. The model-specific caps are implemented. Do not raise them further or redesign compaction unless the user explicitly requests it. Keep the explicit truncation notice.
4. Add tests for oversized multi-step Claude Code conversations and tool-result continuations; confirm the latest task and necessary tools remain intact.

Relevant areas include src/content.js, src/prompts.js, src/handler.js, and the existing replay/prompt tests.


## DEFERRED-004: DeepSeek UI stopped-response continuation

**Status: DEFERRED - INVESTIGATION ONLY; do not change implementation unless explicitly requested.**

### Observation from the user-provided snapshot

On 2026-10-29, the user supplied an HTML capture of the DeepSeek Chat UI during a FlowDesk coding task. The capture contains all of the following:

- A message reading `Server is temporarily unavailable.`
- An assistant response marked `Stopped`.
- The partial assistant text describes inspection progress and says the expected `scripts/build.mjs` file was not found.
- A visible `Continue` button is associated with the stopped response.

This establishes that the captured page rendered a stopped-response state with a Continue affordance. It does **not** establish the exact backend failure, the reason generation stopped, what request the Continue button submits, whether it reuses the same message/thread, or whether the gateway's replay behavior caused the stop. The snapshot contains no DevTools network trace proving the button's behavior. Do not infer those details from DOM text alone.

The HTML capture also contains identifying metadata unrelated to the bug report. Do not commit the raw capture or copy its IP/session/account metadata into repository documentation.

### Why it matters to the gateway

The UI may offer a native continuation path after an interrupted response. This could be distinct from:
- a user sending a new follow-up prompt,
- a response ending naturally,
- the gateway deciding that generation has completed,
- a transient server error, or
- a client-triggered cancellation.

Those states must not be treated as interchangeable. In particular, a response marked `Stopped` must not be reported as a successful completed answer without additional evidence.

### Investigation when explicitly requested

1. Reproduce a controlled long-running coding turn and capture sanitized DOM snapshots during generation, after it becomes `Stopped`, and after activating `Continue`.
2. Inspect browser Network activity for the Continue action and record only redacted method/path, non-sensitive status/stop metadata, and whether the same UI conversation/message continues. Never save or share cookies, authorization headers, tokens, full private prompts, or unredacted conversation URLs.
3. Compare the native Continue action with sending a new follow-up prompt. Also test transient server-unavailable errors, natural completion, manual cancellation, and long-output interruption separately.
4. Review `src/browser-dom.js`, `src/browser.js`, and `src/turn-state.js` to determine how stopped messages, Continue controls, and completion signals interact. Do not assume hashed CSS classes are stable selectors; prefer repeatable semantic/accessibility signals where available.
5. Add regression tests only after the behavior is reproducible. A partial or stopped answer must not be classified as complete, and continuation must not blindly replay tool actions or duplicate side effects. Preserve the existing `MAX_TURN_MS` failure behavior.

Relevant areas: `src/browser-dom.js`, `src/browser.js`, `src/turn-state.js`, and `test/turn-state.test.js`.


## DEFERRED-005: Unsupported Chrome automation flag warning

**Status: FIX IMPLEMENTED - LIVE VERIFICATION PENDING.**

### Observation

A screenshot supplied on 2026-10-29 shows Chrome's banner:

`You are using an unsupported command-line flag: --disable-blink-features=AutomationControlled. Stability and security will suffer.`

The flag was configured in both `src/browser.js` (gateway startup) and `deepseek-login.js` (manual login startup). Both launch paths also removed Playwright's default `--enable-automation` argument.

### Change made

On the PR branch, removed `args: ['--disable-blink-features=AutomationControlled']` and `ignoreDefaultArgs: ['--enable-automation']` from both launch configurations. Chrome now uses Playwright's standard automation arguments; `chromiumSandbox: true` remains configured for the gateway.

This intentionally avoids suppressing automation indicators. Chrome may display its normal automation infobar, but the unsupported-flag warning should no longer be triggered by this flag.

### Verification still required

1. Stop both the gateway and any Chrome process using the persistent profile.
2. Launch `node deepseek-login.js` and then, after closing it, `npm start`.
3. Confirm the unsupported-flag banner is gone and verify login, persistent-profile reuse, and a normal gateway turn.
4. Run `npm test` and `npm run check`; review the GitHub Actions run for the resulting PR head.

Do not claim the banner is fixed in a live browser until Chrome has been relaunched and checked. The user-provided screenshot is evidence of the warning; no screenshot or local profile/authentication data is committed.

Relevant files: `src/browser.js`, `deepseek-login.js`.



## DSML-001: Malformed DSML parsing and Copy fallback

**Status: FIX IMPLEMENTED - LIVE UI VERIFICATION PENDING.**

### Changes

- The DSML `invoke` closing-tag regex now tolerates a missing `invoke` name in a malformed closing tag such as `</｜DSML｜>`, while keeping the opening `invoke` requirement unchanged.
- Orphan-tag cleanup now removes empty-name DSML tags as well, preventing a leftover `</｜DSML｜>` tag from leaking into user-facing text.
- DOM remains the primary source. Only when the DOM-derived tool-call parse is invalid does the gateway try one best-effort recovery by hovering the latest assistant message, clicking a recognizable Copy control, and parsing the copied text with a fresh parser.
- Clipboard permissions are temporarily granted for the `https://chat.deepseek.com` origin and cleared afterward. The Copy action can replace the operating-system clipboard; no clipboard contents are written to logs.
- The copied result must still contain at least one structurally valid tool call and pass the existing client-schema and `tool_choice` validation. Failure to find/read Copy or parse its output falls back to the existing bounded correction/error path. The fallback never executes a tool itself or blindly replays the request.

### Verification required

1. Run `npm test` and `npm run check`; the added parser tests cover the missing-name closing tag, orphan-tag cleanup, successful copied DSML parsing, and malformed copied DSML rejection.
2. On a freshly launched signed-in DeepSeek browser, capture a controlled parser-failure case and verify that the latest assistant Copy button is found and the clipboard text retains parseable DSML.
3. Verify normal tool calls do not click Copy, invalid copied output does not forward partial tool batches, and the fallback does not cause a duplicate tool execution.
4. Confirm current GitHub Actions for the PR head passes before treating CI verification as complete.

The Copy-button selectors are best-effort accessibility/attribute selectors and can become stale if DeepSeek changes its UI. The live DOM/clipboard behavior is not proven by unit tests alone.

Relevant files: `src/tool-parser.js`, `src/browser.js`, `test/tool-parser.test.js`.



## Verification record

On 2026-10-29, after the currently committed changes:

- npm test: 136 passed, 0 failed.
- npm run check: passed.
- The live Claude Code Bash smoke test returned CHECK PASSED.
- Live completion diagnostics still reported source: stable_fallback.
- The Chrome warning banner's status after a fresh launch was not confirmed in the latest test report.

Passing unit tests does not establish that the live DeepSeek UI selectors or Chrome launch behavior are correct. Keep the remaining issues deferred until the user explicitly requests work on them.

On 2026-10-29, the replay cap was changed at the user's request: Claude-prefixed model IDs use 150,000 characters; DeepSeek retains its existing 60,000-character default. Live confirmation for this change is pending.
