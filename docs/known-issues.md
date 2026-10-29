# Deferred fixes and known issues

> **STATUS LABEL: DEFERRED - FIX ONLY IF REQUESTED**
>
> This file records issues for later reference. Do not start work, change implementation, create a fix commit, or open a fix PR for an item below unless the user explicitly asks to fix or resume that specific item. When the user does ask, use the issue ID below to resume the investigation.

Last updated: 2026-10-29

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

**Status: DEFERRED - FIX ONLY IF REQUESTED**

### Summary

Live logs show replay inputs substantially larger than the configured MAX_REPLAY=60000 character limit. Examples include:

| Input characters | Cap characters | Characters omitted |
| ---: | ---: | ---: |
| 120,241 | 60,000 | 60,241 |
| 140,684 | 60,000 | 80,684 |

The gateway inserts an explicit truncation warning and prioritizes current instructions, tool schemas, and the latest request, but character-based compaction can still drop earlier conversation context. These numbers describe characters, not model tokens.

### Next investigation when explicitly requested

1. Use request IDs and the existing trace metadata to identify which prompt sections contribute most to the replay size, without logging or sharing secrets or full private prompts.
2. Check whether system instructions, tool descriptions, older history, and tool results can be compacted more effectively while preserving the latest request and required tool schemas.
3. Keep the configured bound and explicit truncation notice unless a deliberate, tested design change replaces them.
4. Add tests for oversized multi-step Claude Code conversations and tool-result continuations; confirm the latest task and necessary tools remain intact.

Relevant areas include src/content.js, src/prompts.js, src/handler.js, and the existing replay/prompt tests.

## Verification record

On 2026-10-29, after the currently committed changes:

- npm test: 136 passed, 0 failed.
- npm run check: passed.
- The live Claude Code Bash smoke test returned CHECK PASSED.
- Live completion diagnostics still reported source: stable_fallback.
- The Chrome warning banner's status after a fresh launch was not confirmed in the latest test report.

Passing unit tests does not establish that the live DeepSeek UI selectors or Chrome launch behavior are correct. Keep all entries in this file deferred until the user explicitly requests work on them.
