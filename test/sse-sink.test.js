'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamSink } = require('../src/sse-sink');

test('StreamSink emits a valid Anthropic-style tool-use SSE sequence', () => {
  const chunks = [];
  const res = { write(chunk) { chunks.push(chunk); return true; } };
  const sink = new StreamSink(res, 'deepseek-super', 12);
  sink.toolBlock('Bash', { command: 'pwd' });
  sink.finish('tool_use');

  const events = chunks.map((chunk) => {
    const match = chunk.match(/^event: ([^\\n]+)\\ndata: ([\\s\\S]*?)\\n\\n$/);
    assert.ok(match, `Malformed SSE chunk: ${chunk}`);
    return { event: match[1], data: JSON.parse(match[2]) };
  });

  assert.deepEqual(events.map((item) => item.event), [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop',
  ]);
  assert.equal(events[1].data.content_block.type, 'tool_use');
  assert.equal(events[1].data.content_block.name, 'Bash');
  assert.match(events[1].data.content_block.id, /^toolu_/);
  assert.equal(events[2].data.delta.type, 'input_json_delta');
  assert.deepEqual(JSON.parse(events[2].data.delta.partial_json), { command: 'pwd' });
  assert.equal(events[4].data.delta.stop_reason, 'tool_use');
});
