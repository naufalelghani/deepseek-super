'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MODEL_PROFILES, modelProfilePrompt } = require('../src/model-profiles');

const MODEL_IDS = [
  'deepseek-super',
  'claude-mythos-5-1',
  'claude-fable-5.1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
];

test('each advertised profile ID has a distinct non-empty response profile', () => {
  assert.deepEqual(Object.keys(MODEL_PROFILES), MODEL_IDS);
  const prompts = MODEL_IDS.map(modelProfilePrompt);
  assert.ok(prompts.every((prompt) => prompt.includes('MODEL RESPONSE PROFILE')));
  assert.equal(new Set(prompts).size, MODEL_IDS.length);
});

test('legacy dotted Mythos ID resolves to the canonical Claude Code profile', () => {
  assert.equal(
    modelProfilePrompt('claude-mythos-5.1'),
    modelProfilePrompt('claude-mythos-5-1')
  );
});

test('unknown model IDs do not add a profile instruction', () => {
  assert.equal(modelProfilePrompt('unlisted-model'), '');
});

test('profile guidance preserves tool protocol, safety, and output-format precedence', () => {
  for (const id of MODEL_IDS) {
    const prompt = modelProfilePrompt(id);
    assert.match(prompt, /guide response style and work habits/);
    assert.match(prompt, /safety requirements/);
    assert.match(prompt, /tool schemas and calling protocol/);
    assert.match(prompt, /do not change the underlying model/i);
  }
});

test('Mythos profile emphasizes authorized defensive security, vulnerabilities, safe fixes, and verification', () => {
  const prompt = modelProfilePrompt('claude-mythos-5-1');
  assert.match(prompt, /defensive cybersecurity and vulnerability analysis/i);
  assert.match(prompt, /trust boundaries/i);
  assert.match(prompt, /authentication or authorization/i);
  assert.match(prompt, /smallest safe fix/i);
  assert.match(prompt, /regression tests/i);
  assert.match(prompt, /authorized to test/i);
  assert.match(prompt, /Never declare a system secure or a vulnerability fixed without supporting evidence/i);
  assert.match(prompt, /do not provide instructions that materially facilitate unauthorized compromise or harm/i);
});

test('Fable profile is adaptive, execution-oriented, concise, and verifies results', () => {
  const prompt = modelProfilePrompt('claude-fable-5.1');
  assert.match(prompt, /flexible, adaptive/i);
  assert.match(prompt, /long-horizon agentic coding/i);
  assert.match(prompt, /multi-step research/i);
  assert.match(prompt, /spreadsheets, and slides/i);
  assert.match(prompt, /acceptance criteria/i);
  assert.match(prompt, /Never claim execution or verification that did not occur/i);
  assert.match(prompt, /Adapt verbosity and tone to the task/i);
  assert.doesNotMatch(prompt, /copyright|intellectual property/i);
});

test('coding-oriented profiles require appropriate scope control and verification', () => {
  const sonnet = modelProfilePrompt('claude-sonnet-5-5');
  const opus = modelProfilePrompt('claude-opus-5-5');
  const haiku = modelProfilePrompt('claude-haiku-5-5');
  for (const prompt of [sonnet, opus, haiku]) {
    assert.match(prompt, /run relevant tests|run the most relevant tests|run relevant checks|run the most targeted available verification/i);
    assert.match(prompt, /without overstating success|without evidence|calling the task complete/i);
  }
  assert.match(sonnet, /Keep changes within the requested scope/);
  assert.match(opus, /long-running workflows/);
  assert.match(haiku, /Brevity is not permission to stop early/);
});

test('Opus profile emphasizes rigorous execution, evidence, verification, and proportional depth', () => {
  const prompt = modelProfilePrompt('claude-opus-5-5');
  assert.match(prompt, /deliberate, rigorous, and outcome-oriented/i);
  assert.match(prompt, /acceptance criteria, constraints, dependencies, and likely failure modes/i);
  assert.match(prompt, /continue until the requested result is verified or a real blocker remains/i);
  assert.match(prompt, /Ask a focused clarifying question only when missing information materially affects the outcome or safety/i);
  assert.match(prompt, /targeted regression tests/i);
  assert.match(prompt, /separate verified facts from inference/i);
  assert.match(prompt, /Never claim execution, validation, or success without evidence/i);
  assert.match(prompt, /direct for routine requests and thorough for complex or high-impact work/i);
  assert.doesNotMatch(prompt, /copyright|intellectual property/i);
});
