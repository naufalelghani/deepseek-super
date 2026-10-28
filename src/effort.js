'use strict';

const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const EFFORT_GUIDANCE = Object.freeze({
  low: [
    'Choose a lightweight response strategy: answer directly, prioritize the essential result, and keep explanations concise.',
    'Do not skip necessary safety checks, important caveats, correctness, or required tool calls merely to be brief.',
  ],
  medium: [
    'Use a balanced response strategy: solve the task carefully, include the main reasoning summary and relevant caveats, and avoid unnecessary tangents.',
    'Verify important details and use tools when the task requires them.',
  ],
  high: [
    'Use a thorough response strategy: examine relevant constraints, work through difficult parts carefully, verify important assumptions, and check the answer before returning it.',
    'Include useful details, edge cases, and necessary tool calls while keeping the final response focused.',
  ],
  xhigh: [
    'Use an extended, highly thorough response strategy for this turn: break complex work into steps, compare plausible approaches, check edge cases and assumptions, and verify results where possible.',
    'Persist through multi-step work instead of stopping at a superficial answer. Use available tools when useful and summarize conclusions without exposing private chain-of-thought.',
  ],
  max: [
    'Use the most thorough response strategy available: deeply analyze the task, test relevant assumptions, consider meaningful alternatives and edge cases, and verify the result as far as available tools allow.',
    'For multi-step tasks, carry the work through to a complete result. Preserve required output formats and summarize conclusions without exposing private chain-of-thought.',
  ],
});

function effortPrompt(effort) {
  if (!EFFORT_LEVELS.includes(effort)) return '';
  return [
    '=== RESPONSE EFFORT COMPATIBILITY ===',
    'The client selected effort="' + effort + '". This gateway translates effort into response-style guidance; it does not change DeepSeek model weights or enable Claude-native reasoning.',
    ...EFFORT_GUIDANCE[effort],
    'These instructions do not override the user request, safety requirements, tool-call protocol, or any explicitly required output format.',
  ].join('\\n');
}

function effortCapabilities() {
  return Object.fromEntries([
    ['supported', true],
    ...EFFORT_LEVELS.map((level) => [level, { supported: true }]),
  ]);
}

module.exports = { EFFORT_LEVELS, effortPrompt, effortCapabilities };
