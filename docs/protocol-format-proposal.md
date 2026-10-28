# Proposal: Simple Structured Output Protocol

> **Status: DRAFT — DISCUSSION ONLY**
>
> This document records a design proposal, not an implementation authorization. Do not modify the gateway parser, prompt construction, execution flow, tests, or existing protocol behavior based on this proposal until the repository owner explicitly verifies and approves implementation.

## 1. Context and problem statement

The gateway asks an existing model to produce structured output through prompts, then parses that output into messages or tool calls. The model is not guaranteed to follow the requested syntax perfectly. Formats that represent a large body as an escaped JSON string can be fragile when the body contains many quotes, braces, brackets, backslashes, newlines, or nested languages.

For example, HTML may contain CSS, JavaScript, JSON snippets, template literals, quotes, braces, and bracketed expressions. If all of that content must be escaped inside a single JSON string, one formatting mistake can invalidate the whole envelope even when the intended payload is otherwise usable.

The idea to explore is a small, text-based protocol inspired by explicit structural markers such as those used by DSML. Its purpose would be to separate message structure from payload content and reduce avoidable format/parsing errors when working with an existing model through prompts and a parser.

This proposal does **not** claim a custom textual format can guarantee correct model output. It cannot create dedicated tokenizer-level special tokens in a model that does not support them.

## 2. Goals

- Make the outer message structure small, explicit, and deterministic to parse.
- Keep large bodies—HTML, CSS, JavaScript, Markdown, source code, or ordinary prose—as raw payload where possible, rather than requiring the entire body to be escaped as a JSON string.
- Reduce ambiguity between protocol control markers and ordinary payload text.
- Support streaming and detect incomplete, truncated, malformed, or unexpected output.
- Keep control parsing separate from content-specific validation.
- Permit future message types such as text, artifact, tool call, tool result, and end-of-turn without coupling the body to one data format.
- Make error handling measurable so the proposal can be evaluated against the current approach.

## 3. Non-goals

- Replacing or modifying the current DSML parser as part of this planning document.
- Changing current gateway behavior, prompts, tests, model profiles, or API compatibility.
- Guaranteeing that the model always follows the format.
- Treating a textual marker as a security boundary or proof that an action is authorized.
- Creating new tokenizer tokens or changing the underlying model.
- Implementing a general-purpose HTML, JavaScript, JSON, or programming-language parser inside the protocol parser.

## 4. Proposed design principle: envelope plus payload

Explore a two-layer design:

1. **Envelope / control layer**: identifies the message kind and required metadata, and defines the payload boundary.
2. **Payload layer**: carries the body in its original textual form where practical. The protocol parser should not interpret ordinary payload characters such as quotes, braces, or brackets as envelope syntax.

Illustrative syntax only (not a finalized grammar):

```text
⟪BEGIN type=artifact format=html⟫
<!doctype html>
<html>
  <body>
    <h1>Quotes: "hello"; braces: {x}; brackets: [y]</h1>
    <script>const data = { items: ["a", "b"] };</script>
  </body>
</html>
⟪END ...⟫
```

The example demonstrates the desired separation only. The exact delimiters, metadata syntax, and termination rules remain undecided.

Potential message categories to discuss:

- `text`: ordinary assistant text.
- `artifact`: a raw content body with a declared format, such as HTML or Markdown.
- `call`: a structured request for a tool, with validated metadata and arguments.
- `result`: tool output handed back to the model.
- `end`: explicit end-of-turn marker, if needed by the eventual protocol.

These categories are candidates, not requirements for the first version.

## 5. Boundary and escaping problem

A marker-based format still has a critical edge case: the closing marker might appear naturally inside the payload. If the parser terminates on the first matching sequence, a body may be truncated or misinterpreted.

Possible approaches to evaluate:

### A. Fixed start/end markers plus escaping

Simple to explain, but payloads containing the closing marker need a well-defined escaping rule. The model must apply that rule consistently.

### B. Unique per-response boundary identifier

The gateway could generate a boundary identifier and include it in the requested syntax. This reduces accidental collisions, but does not eliminate malformed output, copying of the marker into the payload, or model mistakes. The parser still needs exact matching and clear failure behavior.

### C. Length-delimited payload

A declared length can make boundaries deterministic when the length is reliably generated and measured, but asking a language model to count an exact number of characters or bytes is error-prone. This may be more appropriate for a deterministic wrapper than for direct model-authored output.

### D. Streaming state machine with explicit states

The parser can distinguish waiting for an envelope, reading header metadata, reading payload, and reading a terminator. This makes parsing behavior easier to reason about, but it cannot by itself resolve an ambiguous boundary emitted by the model.

No approach should be selected without comparing its reliability, complexity, streaming behavior, and compatibility with existing prompts.

## 6. Tool calls and trust boundaries

Tool calls require stricter treatment than ordinary artifacts. A protocol marker should describe a requested action; it must not itself execute that action or grant authority.

Any future implementation must preserve these boundaries:

- Parse control syntax separately from payload data.
- Validate message type, tool name, required metadata, and argument shape.
- Treat model output and retrieved/tool-provided text as untrusted input.
- Authorize tool use outside the model, using the active request's allowlist and permissions.
- Apply least privilege and validate sensitive arguments immediately before execution.
- Require additional approval for consequential actions when appropriate.
- Fail closed on ambiguous, malformed, truncated, or schema-invalid control messages.
- Ensure payload content cannot impersonate a control message merely by containing similar-looking text.

Prompt wording is a reliability aid, not an authorization mechanism. The parser and executor must enforce the actual policy.

## 7. Streaming and failure behavior to specify

Before any implementation, define expected behavior for:

- Partial headers or markers split across streaming chunks.
- Missing or mismatched terminators.
- Truncated output and maximum payload size.
- Unexpected control markers inside a payload.
- Multiple messages in one response.
- Multiple tool calls and their identifiers.
- Duplicate, unknown, or out-of-order message IDs.
- Invalid metadata or unsupported message types.
- Recovery prompts and maximum retry count.
- Distinguishing a user-visible text answer from a tool call or an artifact.
- Logging enough diagnostic information for debugging without unnecessarily recording secrets or private payloads.

The parser should never turn ambiguous output into a successful action by guessing.

## 8. Evaluation plan (proposed, not executed)

If implementation is later authorized, compare the protocol against the current format using a fixed test corpus. Include:

- Long HTML documents with embedded CSS and JavaScript.
- Payloads containing quotes, braces, brackets, backslashes, Unicode, Markdown fences, and multiple newlines.
- Payloads containing strings that resemble the chosen start and end markers.
- Marker-like strings split across streaming chunk boundaries.
- Truncated outputs and malformed headers.
- Tool arguments with nested data and invalid schemas.
- Prompt-injection-like instructions inside untrusted payloads, verifying they are treated as data rather than protocol authority.
- Multiple calls, empty payloads, large payloads, and normal plain-text responses.

Measure at least:

- First-pass parse success rate.
- Success rate after bounded recovery, reported separately.
- Incorrect early termination and payload truncation rate.
- False recognition of payload text as control syntax.
- Latency and token overhead.
- Parser complexity and maintainability.
- Compatibility regressions in current message and tool-call flows.

Do not claim improvement without recorded test results. Keep the current implementation as the baseline until the new approach has evidence of being more reliable.

## 9. Open design questions

1. Is the primary target raw artifacts, tool-call control, or both?
2. Should the envelope be a line-oriented grammar or use dedicated-looking marker strings?
3. How should payload boundaries be protected when the marker appears inside the body?
4. Should structured tool arguments remain JSON while only large text/artifact bodies become raw payload?
5. How should the format express streaming, multiple messages, and end-of-turn?
6. What are the size limits, failure semantics, and bounded recovery behavior?
7. Which requirements justify a new format instead of hardening the existing DSML parsing and recovery?

## 10. Approval gate

This document is only a record of the current discussion. The following steps require explicit approval from the repository owner:

1. Review and revise this proposal.
2. Agree on the goals, scope, grammar, boundary strategy, and failure behavior.
3. Authorize a separate implementation task or pull request.
4. Implement the smallest prototype behind tests without silently replacing existing behavior.
5. Compare it with the baseline and review the results before deciding whether to adopt it.

**Until that approval is given, do not implement the protocol or modify the existing parser and execution path.**

## Notes

- Working name: **Simple Structured Output Protocol** (placeholder only; naming is not decided).
- This is an exploratory proposal, not a claim that a design has been validated.
- No source code or runtime behavior is changed by this document.
