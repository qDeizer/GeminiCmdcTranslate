/**
 * @file egress.test.mjs
 * @description Comprehensive Egress Serializer Test Suite for Gemini1.
 * 
 * Covers:
 * - Anthropic SSE Serializer (anthropic.mjs):
 *   * 0x12 thinking signature starting with 'E' emitted before content_block_stop
 *   * Token usage normalization with noCacheTokens
 *   * Stop reason normalization (tool-calls -> tool_use, length -> max_tokens, others -> end_turn)
 *   * Tool name unaliasing (search_tools -> tool_search)
 *   * Block lifecycle state machine (thinking -> text -> tool_use)
 * - Responses SSE Serializer (responses.mjs):
 *   * Strictly monotonic sequence_number starting at 1 across all events
 *   * Unique monotonic output_index per output item
 *   * Interleaved active items Map: concurrent reasoning (rs_...) and tool calling (fc_...)
 *   * Native search_tools -> type: "tool_search_call", execution: "client"
 *   * Finish event closes all active items, outputs response.completed, and terminal [DONE]
 * - Chat SSE Serializer (chat.mjs):
 *   * Role assistant chunk on start
 *   * Streaming text delta chunks
 *   * Tool call chunks with function payload
 *   * Finish reason normalization and terminal [DONE]
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AnthropicSseSerializer,
  makeThinkingSignature,
  normalizeUsageForAnthropic
} from '../src/egress/anthropic.mjs';
import { ResponsesSseSerializer } from '../src/egress/responses.mjs';
import { ChatSseSerializer } from '../src/egress/chat.mjs';

/**
 * Mock HTTP response capturing SSE writes and headers.
 */
class MockSseResponse {
  constructor() {
    this.statusCode = 0;
    this.headers = {};
    this.chunks = [];
    this.ended = false;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(chunk);
    return true;
  }

  end() {
    this.ended = true;
  }

  /**
   * Parses raw emitted SSE data into structured event objects.
   */
  parseSseEvents() {
    const raw = this.chunks.join('');
    const blocks = raw.split('\n\n').filter(b => b.trim().length > 0);
    const events = [];

    for (const block of blocks) {
      const lines = block.split('\n');
      let eventType = null;
      let data = null;

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const content = line.slice(6).trim();
          if (content === '[DONE]') {
            data = '[DONE]';
          } else {
            try {
              data = JSON.parse(content);
            } catch {
              data = content;
            }
          }
        }
      }

      events.push({ eventType, data, raw: block });
    }

    return events;
  }
}

// ---------------------------------------------------------------------------
// 1. Anthropic Messages Egress Serializer
// ---------------------------------------------------------------------------

test('Egress: Anthropic - start() commits HTTP 200 headers and message_start event', () => {
  const res = new MockSseResponse();
  const serializer = new AnthropicSseSerializer(res, {
    messageId: 'msg_test_123',
    model: 'claude-3-7-sonnet'
  });

  serializer.start();

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache, no-transform');

  const events = res.parseSseEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'message_start');
  assert.equal(events[0].data.type, 'message_start');
  assert.equal(events[0].data.message.id, 'msg_test_123');
  assert.equal(events[0].data.message.role, 'assistant');
  assert.equal(events[0].data.message.model, 'claude-3-7-sonnet');
});

test('Egress: Anthropic - 0x12 thinking signature delta emitted before content_block_stop', () => {
  const res = new MockSseResponse();
  const serializer = new AnthropicSseSerializer(res, { messageId: 'msg_thinking' });
  serializer.start();

  // Feed reasoning deltas
  serializer.processEvent({ type: 'reasoning-delta', text: 'Let me think about this problem.' });
  serializer.processEvent({ type: 'reasoning-delta', text: ' Here is the second thought.' });

  // Transition to text block - this closes the thinking block!
  serializer.processEvent({ type: 'text-delta', text: 'Here is the answer.' });

  const events = res.parseSseEvents();
  // 0: message_start
  // 1: content_block_start (thinking)
  // 2: content_block_delta (thinking_delta)
  // 3: content_block_delta (thinking_delta)
  // 4: content_block_delta (signature_delta with 0x12)
  // 5: content_block_stop
  // 6: content_block_start (text)
  // 7: content_block_delta (text_delta)

  assert.equal(events[1].eventType, 'content_block_start');
  assert.equal(events[1].data.content_block.type, 'thinking');

  assert.equal(events[4].eventType, 'content_block_delta');
  assert.equal(events[4].data.delta.type, 'signature_delta');
  const sig = events[4].data.delta.signature;
  assert.ok(sig && typeof sig === 'string', 'Signature must be a string');
  assert.ok(sig.startsWith('E'), 'Signature in Base64 must start with "E"');

  const decodedBytes = Buffer.from(sig, 'base64');
  assert.equal(decodedBytes[0], 0x12, 'First byte of thinking signature must be 0x12');
  assert.equal(decodedBytes[1], 32, 'Second byte is SHA-256 length (32)');

  assert.equal(events[5].eventType, 'content_block_stop');
  assert.equal(events[5].data.index, 0);

  assert.equal(events[6].eventType, 'content_block_start');
  assert.equal(events[6].data.content_block.type, 'text');
  assert.equal(events[6].data.index, 1);
});

test('Egress: Anthropic - makeThinkingSignature invariants across empty and non-empty text', () => {
  const emptySig = makeThinkingSignature('');
  assert.ok(emptySig.startsWith('E'));
  assert.equal(Buffer.from(emptySig, 'base64')[0], 0x12);

  const nonNullSig = makeThinkingSignature(null);
  assert.ok(nonNullSig.startsWith('E'));
  assert.equal(Buffer.from(nonNullSig, 'base64')[0], 0x12);

  const longSig = makeThinkingSignature('A'.repeat(5000));
  assert.ok(longSig.startsWith('E'));
  assert.equal(Buffer.from(longSig, 'base64')[0], 0x12);
});

test('Egress: Anthropic - tool_call block unaliases search_tools to tool_search', () => {
  const res = new MockSseResponse();
  const serializer = new AnthropicSseSerializer(res);
  serializer.start();

  serializer.processEvent({
    type: 'tool-call',
    toolCallId: 'call_search_1',
    toolName: 'search_tools',
    input: { query: 'file reader' }
  });

  const events = res.parseSseEvents();
  // Filter for tool_use content_block_start
  const toolStart = events.find(e => e.eventType === 'content_block_start' && e.data?.content_block?.type === 'tool_use');
  assert.ok(toolStart, 'Must emit content_block_start with tool_use');
  assert.equal(toolStart.data.content_block.id, 'call_search_1');
  assert.equal(toolStart.data.content_block.name, 'tool_search', 'Must unalias search_tools to tool_search');

  const toolDelta = events.find(e => e.eventType === 'content_block_delta' && e.data?.delta?.type === 'input_json_delta');
  assert.ok(toolDelta);
  assert.equal(JSON.parse(toolDelta.data.delta.partial_json).query, 'file reader');
});

test('Egress: Anthropic - finish event stop_reason normalization and token usage', () => {
  const checkStopReason = (wireReason, expectedAnthropicReason) => {
    const res = new MockSseResponse();
    const serializer = new AnthropicSseSerializer(res);
    serializer.start();
    serializer.processEvent({
      type: 'finish',
      finishReason: wireReason,
      totalUsage: { inputTokens: 1500, cachedInputTokens: 500, outputTokens: 120 }
    });
    const events = res.parseSseEvents();
    const msgDelta = events.find(e => e.eventType === 'message_delta');
    assert.ok(msgDelta);
    assert.equal(msgDelta.data.delta.stop_reason, expectedAnthropicReason);
    assert.equal(msgDelta.data.usage.output_tokens, 120);

    const msgStop = events.find(e => e.eventType === 'message_stop');
    assert.ok(msgStop);
  };

  checkStopReason('tool-calls', 'tool_use');
  checkStopReason('tool_calls', 'tool_use');
  checkStopReason('tool_use', 'tool_use');
  checkStopReason('length', 'max_tokens');
  checkStopReason('stop', 'end_turn');
  checkStopReason(null, 'end_turn');
});

test('Egress: Anthropic - normalizeUsageForAnthropic prevents double counting with noCacheTokens', () => {
  // Case 1: upstream provides inputTokenDetails with noCacheTokens
  const usage1 = normalizeUsageForAnthropic({
    inputTokens: 2000,
    inputTokenDetails: { cacheReadTokens: 1200, cacheWriteTokens: 300, noCacheTokens: 500 },
    outputTokens: 80
  });
  assert.equal(usage1.input_tokens, 500);
  assert.equal(usage1.cache_read_input_tokens, 1200);
  assert.equal(usage1.cache_creation_input_tokens, 300);
  assert.equal(usage1.output_tokens, 80);

  // Case 2: upstream provides raw inputTokens and cachedInputTokens without details object
  const usage2 = normalizeUsageForAnthropic({
    inputTokens: 1000,
    cachedInputTokens: 750,
    outputTokens: 40
  });
  assert.equal(usage2.input_tokens, 250); // 1000 - 750
  assert.equal(usage2.cache_read_input_tokens, 750);
  assert.equal(usage2.cache_creation_input_tokens, 0);
  assert.equal(usage2.output_tokens, 40);

  // Case 3: empty usage object handles defaults safely
  const usage3 = normalizeUsageForAnthropic({});
  assert.equal(usage3.input_tokens, 0);
  assert.equal(usage3.cache_read_input_tokens, 0);
  assert.equal(usage3.cache_creation_input_tokens, 0);
  assert.equal(usage3.output_tokens, 0);
});

test('Egress: Anthropic - end() closes active block and finishes stream', () => {
  const res = new MockSseResponse();
  const serializer = new AnthropicSseSerializer(res);
  serializer.start();
  serializer.processEvent({ type: 'text-delta', text: 'Unfinished thought...' });
  serializer.end();

  assert.equal(res.ended, true);
  const events = res.parseSseEvents();
  const lastEvent = events[events.length - 1];
  assert.equal(lastEvent.eventType, 'content_block_stop');
});

// ---------------------------------------------------------------------------
// 2. OpenAI Responses Egress Serializer (Codex Mode)
// ---------------------------------------------------------------------------

test('Egress: Responses - Monotonic sequence_number starts strictly at 1 and increases monotonically', () => {
  const res = new MockSseResponse();
  const serializer = new ResponsesSseSerializer(res, {
    responseId: 'resp_seq_test',
    model: 'gpt-4o'
  });

  serializer.start();
  serializer.processEvent({ type: 'reasoning-delta', text: 'Step 1' });
  serializer.processEvent({ type: 'text-delta', text: 'Step 2' });
  serializer.processEvent({ type: 'finish', totalUsage: { totalTokens: 100 } });

  const events = res.parseSseEvents().filter(e => e.data && typeof e.data === 'object');
  assert.ok(events.length >= 6);

  let expectedSeq = 1;
  for (const ev of events) {
    assert.equal(ev.data.sequence_number, expectedSeq, `Event ${ev.eventType} must have sequence_number ${expectedSeq}`);
    expectedSeq++;
  }
});

test('Egress: Responses - Unique output_index per item', () => {
  const res = new MockSseResponse();
  const serializer = new ResponsesSseSerializer(res);
  serializer.start();

  // Item 0: Reasoning
  serializer.processEvent({ type: 'reasoning-delta', text: 'Planning action' });
  // Item 1: Function Call
  serializer.processEvent({ type: 'tool-call', toolCallId: 'call_cmd', toolName: 'bash', input: { cmd: 'ls' } });
  // Item 2: Message Text
  serializer.processEvent({ type: 'text-delta', text: 'Directory contents listed.' });

  const events = res.parseSseEvents();
  const itemAddedEvents = events.filter(e => e.eventType === 'response.output_item.added');

  assert.equal(itemAddedEvents.length, 3);
  assert.equal(itemAddedEvents[0].data.output_index, 0);
  assert.equal(itemAddedEvents[0].data.item.type, 'reasoning');

  assert.equal(itemAddedEvents[1].data.output_index, 1);
  assert.equal(itemAddedEvents[1].data.item.type, 'function_call');

  assert.equal(itemAddedEvents[2].data.output_index, 2);
  assert.equal(itemAddedEvents[2].data.item.type, 'message');
});

test('Egress: Responses - Concurrent interleaved reasoning (rs_...) and tool calling (fc_...)', () => {
  const res = new MockSseResponse();
  const serializer = new ResponsesSseSerializer(res);
  serializer.start();

  // 1. Reasoning starts
  serializer.processEvent({ type: 'reasoning-delta', text: 'Reasoning before tool call.' });

  // 2. Tool call arrives - MUST NOT close active reasoning!
  serializer.processEvent({
    type: 'tool-call',
    toolCallId: 'call_fc_1',
    toolName: 'read_code',
    input: { path: 'server.mjs' }
  });

  // Verify reasoning is still active in serializer's activeItems Map
  assert.ok(serializer.activeItems.has('reasoning'), 'Reasoning item must remain open in activeItems Map');

  // 3. More reasoning arrives concurrently!
  serializer.processEvent({ type: 'reasoning-delta', text: ' Continuing reasoning after tool call.' });

  // 4. Finish stream
  serializer.processEvent({ type: 'finish' });

  const events = res.parseSseEvents();

  // Function call should have emitted added -> args delta -> args done -> output_item.done
  const fcDone = events.find(e => e.eventType === 'response.output_item.done' && e.data?.item?.type === 'function_call');
  assert.ok(fcDone, 'Function call item should be marked done');

  // Reasoning should only be closed on finish
  const reasoningDone = events.find(e => e.eventType === 'response.output_item.done' && e.data?.item?.type === 'reasoning');
  assert.ok(reasoningDone, 'Reasoning item should be marked done on finish');
  assert.ok(reasoningDone.data.item.summary[0].text.includes('Continuing reasoning after tool call.'));
});

test('Egress: Responses - Native search_tools maps to type tool_search_call with execution client', () => {
  const res = new MockSseResponse();
  const serializer = new ResponsesSseSerializer(res);
  serializer.start();

  serializer.processEvent({
    type: 'tool-call',
    toolCallId: 'call_tsc_1',
    toolName: 'search_tools',
    input: { query: 'test' }
  });

  const events = res.parseSseEvents();
  const tscItem = events.find(e => e.eventType === 'response.output_item.added');
  assert.ok(tscItem);
  assert.equal(tscItem.data.item.type, 'tool_search_call');
  assert.equal(tscItem.data.item.execution, 'client');
  assert.equal(tscItem.data.item.name, 'tool_search');
  assert.ok(tscItem.data.item.id.startsWith('tsc_'));
});

test('Egress: Responses - Finish event emits response.completed and terminal [DONE]', () => {
  const res = new MockSseResponse();
  const serializer = new ResponsesSseSerializer(res);
  serializer.start();

  serializer.processEvent({ type: 'text-delta', text: 'Finished response.' });
  serializer.processEvent({
    type: 'finish',
    totalUsage: { inputTokens: 50, outputTokens: 20 }
  });

  const events = res.parseSseEvents();
  const completed = events.find(e => e.eventType === 'response.completed');
  assert.ok(completed);
  assert.equal(completed.data.response.status, 'completed');
  assert.equal(completed.data.response.output.length, 1);
  assert.equal(completed.data.response.usage.outputTokens, 20);

  // Check terminal [DONE]
  const lastEvent = events[events.length - 1];
  assert.equal(lastEvent.data, '[DONE]');
});

// ---------------------------------------------------------------------------
// 3. OpenAI Chat Completions Egress Serializer
// ---------------------------------------------------------------------------

test('Egress: Chat - start() emits initial chunk with assistant role and empty content', () => {
  const res = new MockSseResponse();
  const serializer = new ChatSseSerializer(res, {
    completionId: 'chatcmpl_test',
    model: 'gpt-4o'
  });

  serializer.start();

  assert.equal(res.statusCode, 200);
  const events = res.parseSseEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].data.id, 'chatcmpl_test');
  assert.equal(events[0].data.object, 'chat.completion.chunk');
  assert.equal(events[0].data.choices[0].delta.role, 'assistant');
  assert.equal(events[0].data.choices[0].delta.content, '');
  assert.equal(events[0].data.choices[0].finish_reason, null);
});

test('Egress: Chat - text-delta emits streaming chunks', () => {
  const res = new MockSseResponse();
  const serializer = new ChatSseSerializer(res);
  serializer.start();

  serializer.processEvent({ type: 'text-delta', text: 'Hello, world!' });

  const events = res.parseSseEvents();
  assert.equal(events.length, 2);
  assert.equal(events[1].data.choices[0].delta.content, 'Hello, world!');
  assert.equal(events[1].data.choices[0].finish_reason, null);
});

test('Egress: Chat - tool-call emits function call delta with incremental index', () => {
  const res = new MockSseResponse();
  const serializer = new ChatSseSerializer(res);
  serializer.start();

  serializer.processEvent({
    type: 'tool-call',
    toolCallId: 'call_1',
    toolName: 'calculator',
    input: { expr: '2+2' }
  });

  const events = res.parseSseEvents();
  const toolChunk = events[1].data;
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].index, 0);
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].id, 'call_1');
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].type, 'function');
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, 'calculator');
  assert.equal(JSON.parse(toolChunk.choices[0].delta.tool_calls[0].function.arguments).expr, '2+2');
});

test('Egress: Chat - finish event normalizes finish_reason and emits [DONE]', () => {
  const testReason = (rawReason, expectedReason) => {
    const res = new MockSseResponse();
    const serializer = new ChatSseSerializer(res);
    serializer.start();
    serializer.processEvent({ type: 'finish', finishReason: rawReason });

    const events = res.parseSseEvents();
    const finishChunk = events[1].data;
    assert.equal(finishChunk.choices[0].finish_reason, expectedReason);

    const doneChunk = events[2].data;
    assert.equal(doneChunk, '[DONE]');
  };

  testReason('tool-calls', 'tool_calls');
  testReason('tool_calls', 'tool_calls');
  testReason('tool_use', 'tool_calls');
  testReason('length', 'length');
  testReason('stop', 'stop');
  testReason('other', 'stop');
});

test('Egress: Chat - end() terminates response stream', () => {
  const res = new MockSseResponse();
  const serializer = new ChatSseSerializer(res);
  serializer.start();
  serializer.end();
  assert.equal(res.ended, true);
});
