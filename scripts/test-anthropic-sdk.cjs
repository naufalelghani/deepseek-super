'use strict';

// End-to-end smoke test for the real local gateway.
// Start the gateway and log in to DeepSeek in its Playwright Chrome first,
// then run: npm run test:sdk

const assert = require('node:assert/strict');
const Anthropic = require('@anthropic-ai/sdk');

const baseURL = process.env.DEEPSEEK_SUPER_BASE_URL || 'http://127.0.0.1:8787';
const apiKey = process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.DEEPSEEK_SUPER_TOKEN ||
  'any';
const model = process.env.ANTHROPIC_MODEL || 'deepseek-super';

const client = new Anthropic({
  apiKey,
  baseURL,
  maxRetries: 0,
  timeout: 300_000,
});

function textFrom(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function assertMessageShape(message, label) {
  assert.equal(message.type, 'message', label + ': response type harus message');
  assert.equal(message.role, 'assistant', label + ': role harus assistant');
  assert.ok(Array.isArray(message.content), label + ': content harus array');
  assert.ok(
    Number.isInteger(message.usage && message.usage.input_tokens),
    label + ': usage.input_tokens harus integer'
  );
  assert.ok(
    Number.isInteger(message.usage && message.usage.output_tokens),
    label + ': usage.output_tokens harus integer'
  );
}

async function main() {
  console.log('Anthropic SDK smoke test');
  console.log('Endpoint:', baseURL);
  console.log('Model:', model);

  // 1. Actual non-streaming Messages API request.
  console.log('\n[1/3] Non-streaming request ...');
  const normal = await client.messages.create({
    model,
    max_tokens: 128,
    messages: [{
      role: 'user',
      content: 'Reply with the exact text SDK_SMOKE_OK and nothing else.',
    }],
  });
  assertMessageShape(normal, 'non-streaming');
  assert.ok(textFrom(normal).trim(), 'non-streaming: teks jawaban kosong');
  console.log('PASS non-streaming:', textFrom(normal).trim().slice(0, 160));
  console.log('  stop_reason:', normal.stop_reason);

  // 2. Actual SSE stream, parsed by the official SDK.
  console.log('\n[2/3] Streaming request ...');
  const stream = await client.messages.create({
    model,
    max_tokens: 128,
    stream: true,
    messages: [{
      role: 'user',
      content: 'Reply with a short greeting containing STREAM_SMOKE_OK.',
    }],
  });

  let streamedText = '';
  let eventCount = 0;
  let sawMessageStop = false;

  for await (const event of stream) {
    eventCount++;
    if (
      event.type === 'content_block_delta' &&
      event.delta &&
      event.delta.type === 'text_delta'
    ) {
      streamedText += event.delta.text;
    }
    if (event.type === 'message_stop') sawMessageStop = true;
  }

  assert.ok(eventCount > 0, 'streaming: SDK tidak menerima event');
  assert.ok(streamedText.trim(), 'streaming: tidak ada text_delta');
  assert.ok(sawMessageStop, 'streaming: event message_stop tidak diterima');
  console.log('PASS streaming:', streamedText.trim().slice(0, 160));
  console.log('  events:', eventCount);

  // 3. Force a tool use, then submit a synthetic tool_result round-trip.
  // The command is NEVER executed by this test.
  console.log('\n[3/3] Tool-use + tool-result round trip ...');
  const toolRequest =
    'Call the Bash tool with command exactly "echo SDK_TOOL_CALL_OK". Do not answer with plain text.';
  const tools = [{
    name: 'Bash',
    description: 'A compatibility-test tool. The command will not be executed.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command string for this compatibility test' },
      },
      required: ['command'],
    },
  }];

  const toolMessage = await client.messages.create({
    model,
    max_tokens: 256,
    tools,
    tool_choice: { type: 'tool', name: 'Bash' },
    messages: [{ role: 'user', content: toolRequest }],
  });

  assertMessageShape(toolMessage, 'tool-use');
  assert.equal(toolMessage.stop_reason, 'tool_use', 'tool-use: stop_reason harus tool_use');

  const toolUse = toolMessage.content.find((block) => block.type === 'tool_use');
  assert.ok(toolUse, 'tool-use: tidak ada blok tool_use');
  assert.equal(toolUse.name, 'Bash', 'tool-use: nama tool tidak cocok');
  assert.ok(typeof toolUse.input.command === 'string' && toolUse.input.command.trim(),
    'tool-use: input command kosong atau tidak valid');
  console.log('PASS tool_use:', JSON.stringify({ name: toolUse.name, input: toolUse.input }));

  const finalMessage = await client.messages.create({
    model,
    max_tokens: 128,
    tools,
    messages: [
      { role: 'user', content: toolRequest },
      { role: 'assistant', content: toolMessage.content },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: 'SDK_TOOL_RESULT_OK (synthetic result; no command was executed)',
        }],
      },
    ],
  });

  assertMessageShape(finalMessage, 'tool-result round trip');
  assert.ok(textFrom(finalMessage).trim(), 'tool-result round trip: jawaban akhir kosong');
  console.log('PASS tool_result round trip:', textFrom(finalMessage).trim().slice(0, 160));

  console.log('\nALL SDK SMOKE TESTS PASSED');
}

main().catch((error) => {
  console.error('\nSDK SMOKE TEST FAILED');
  if (error && error.status) console.error('HTTP status:', error.status);
  console.error(error && error.stack ? error.stack : error);
  if (error && (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND')) {
    console.error('\nPastikan server berjalan dan alamat DEEPSEEK_SUPER_BASE_URL benar.');
  } else if (error && error.status === 401) {
    console.error('\nToken salah: samakan ANTHROPIC_AUTH_TOKEN dengan DEEPSEEK_SUPER_TOKEN jika auth server diaktifkan.');
  } else {
    console.error('\nPastikan server berjalan, Chrome Playwright sudah login ke DeepSeek, lalu coba lagi.');
  }
  process.exitCode = 1;
});
