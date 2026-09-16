/**
 * @file replay.test.mjs
 * @description Real-World Production Recording Replay Test Suite for Gemini1.
 * 
 * Replays realistic recorded Command Code NDJSON streams through the loopback HTTP bridge
 * to verify end-to-end translation fidelity for Claude Code CLI and Codex Responses clients.
 * 
 * Fixtures:
 * - stream_basic_text.ndjson: Standard multi-token completion
 * - stream_reasoning_muse.ndjson: Deep reasoning with Muse Spark 1.3 contributor + cache breakdown
 * - stream_tool_call_search.ndjson: Tool search / function calling with tool name unaliasing
 * - stream_interleaved_reasoning_tool.ndjson: Concurrent reasoning and function execution
 * - stream_delayed_rate_limit.ndjson: Non-decisive prelude start followed by 429 rate limit
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridgeServer } from '../src/server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/**
 * Creates a mock upstream server that replays an NDJSON fixture file.
 */
function createReplayUpstream(fixtureFilename, { chunkSizeBytes = 0, statusCode = 200 } = {}) {
  const fixturePath = path.join(FIXTURES_DIR, fixtureFilename);

  const server = http.createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/alpha/generate');

    if (statusCode !== 200) {
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Simulated HTTP ${statusCode}` }));
      return;
    }

    res.writeHead(200, {
      'content-type': 'application/x-ndjson',
      'x-command-code-session-id': 'sess-replay-123'
    });

    const fileContent = await fs.readFile(fixturePath);

    if (chunkSizeBytes > 0) {
      // Simulate packet fragmentation
      for (let offset = 0; offset < fileContent.length; offset += chunkSizeBytes) {
        const slice = fileContent.subarray(offset, Math.min(offset + chunkSizeBytes, fileContent.length));
        res.write(slice);
        // tiny delay to allow event loop cycle
        await new Promise((r) => setTimeout(r, 2));
      }
    } else {
      res.write(fileContent);
    }
    res.end();
  });

  return {
    server,
    start() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve(server.address().port);
        });
      });
    },
    stop() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

/**
 * Helper to parse SSE stream from HTTP response text.
 */
function parseSseBlocks(rawText) {
  const blocks = rawText.split('\n\n').filter(b => b.trim().length > 0);
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

// ---------------------------------------------------------------------------
// 1. Anthropic Claude Messages Replay Tests
// ---------------------------------------------------------------------------

test('Replay: Anthropic - Basic text stream translates to standard Claude SSE frames', async () => {
  const mockUpstream = createReplayUpstream('stream_basic_text.ndjson');
  const upstreamPort = await mockUpstream.start();

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upstreamPort}` }
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_token'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Say the pangram' }]
      })
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

    const text = await res.text();
    const events = parseSseBlocks(text);

    // Verify event progression
    assert.equal(events[0].eventType, 'message_start');
    assert.equal(events[1].eventType, 'content_block_start');
    assert.equal(events[1].data.content_block.type, 'text');

    // Deltas contain text
    const textDeltas = events.filter(e => e.eventType === 'content_block_delta' && e.data?.delta?.type === 'text_delta');
    assert.equal(textDeltas.length, 3);
    const assembledText = textDeltas.map(d => d.data.delta.text).join('');
    assert.equal(assembledText, 'The quick brown fox jumps over the lazy dog.');

    // Stop reason
    const msgDelta = events.find(e => e.eventType === 'message_delta');
    assert.ok(msgDelta);
    assert.equal(msgDelta.data.delta.stop_reason, 'end_turn');

    const msgStop = events.find(e => e.eventType === 'message_stop');
    assert.ok(msgStop);
  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});

test('Replay: Anthropic - Muse Spark deep reasoning stream with 0x12 signature and token normalization', async () => {
  const mockUpstream = createReplayUpstream('stream_reasoning_muse.ndjson');
  const upstreamPort = await mockUpstream.start();

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upstreamPort}` }
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_token'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'What is the complexity of binary search?' }]
      })
    });

    assert.equal(res.status, 200);
    const text = await res.text();
    const events = parseSseBlocks(text);

    // 1. Verify thinking block
    const thinkingStart = events.find(e => e.eventType === 'content_block_start' && e.data?.content_block?.type === 'thinking');
    assert.ok(thinkingStart, 'Must start thinking content block');

    // 2. Verify 0x12 signature delta before content_block_stop
    const sigDelta = events.find(e => e.eventType === 'content_block_delta' && e.data?.delta?.type === 'signature_delta');
    assert.ok(sigDelta, 'Must emit signature_delta');
    assert.ok(sigDelta.data.delta.signature.startsWith('E'), 'Signature must start with E');
    const rawSig = Buffer.from(sigDelta.data.delta.signature, 'base64');
    assert.equal(rawSig[0], 0x12, 'First byte must be 0x12');

    // 3. Verify text block follows thinking
    const textStart = events.find(e => e.eventType === 'content_block_start' && e.data?.content_block?.type === 'text');
    assert.ok(textStart, 'Text block must follow thinking block');
    assert.ok(textStart.data.index > thinkingStart.data.index);

    // 4. Verify token usage normalization (noCacheTokens prevents double counting)
    const msgDelta = events.find(e => e.eventType === 'message_delta');
    assert.ok(msgDelta);
    assert.equal(msgDelta.data.usage.output_tokens, 45);

  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});

test('Replay: Anthropic - Tool call unaliases search_tools to tool_search with tool_use stop reason', async () => {
  const mockUpstream = createReplayUpstream('stream_tool_call_search.ndjson');
  const upstreamPort = await mockUpstream.start();

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upstreamPort}` }
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_token'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Search tools' }]
      })
    });

    assert.equal(res.status, 200);
    const text = await res.text();
    const events = parseSseBlocks(text);

    // Verify tool_use content block
    const toolBlock = events.find(e => e.eventType === 'content_block_start' && e.data?.content_block?.type === 'tool_use');
    assert.ok(toolBlock);
    assert.equal(toolBlock.data.content_block.name, 'tool_search', 'Must unalias to tool_search');
    assert.equal(toolBlock.data.content_block.id, 'call_search_987123');

    // Stop reason must be tool_use
    const msgDelta = events.find(e => e.eventType === 'message_delta');
    assert.equal(msgDelta.data.delta.stop_reason, 'tool_use');
  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});

// ---------------------------------------------------------------------------
// 2. OpenAI Codex Responses Replay Tests
// ---------------------------------------------------------------------------

test('Replay: Responses - Monotonic sequence numbering and unique output indexing', async () => {
  const mockUpstream = createReplayUpstream('stream_reasoning_muse.ndjson');
  const upstreamPort = await mockUpstream.start();

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upstreamPort}` }
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_token'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        input: [{ type: 'message', role: 'user', content: 'Explain binary search' }]
      })
    });

    assert.equal(res.status, 200);
    const text = await res.text();
    const events = parseSseBlocks(text).filter(e => e.data && typeof e.data === 'object');

    // Invariant 1: sequence_number starts at 1 and increases monotonically
    let currentSeq = 1;
    for (const ev of events) {
      assert.equal(ev.data.sequence_number, currentSeq, `Event ${ev.eventType} must have seq ${currentSeq}`);
      currentSeq++;
    }

    // Invariant 2: reasoning output_index is 0, message output_index is 1
    const itemAdded = events.filter(e => e.eventType === 'response.output_item.added');
    assert.equal(itemAdded.length, 2);
    assert.equal(itemAdded[0].data.output_index, 0);
    assert.equal(itemAdded[0].data.item.type, 'reasoning');
    assert.equal(itemAdded[1].data.output_index, 1);
    assert.equal(itemAdded[1].data.item.type, 'message');

    // Invariant 3: response.completed followed by [DONE]
    const completed = events.find(e => e.eventType === 'response.completed');
    assert.ok(completed);
    assert.equal(completed.data.response.status, 'completed');
    assert.ok(text.endsWith('data: [DONE]\n\n'));
  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});

test('Replay: Responses - Interleaved reasoning and tool calls execute concurrently', async () => {
  const mockUpstream = createReplayUpstream('stream_interleaved_reasoning_tool.ndjson');
  const upstreamPort = await mockUpstream.start();

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upstreamPort}` }
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/backend-api/codex/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_token'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        input: [{ type: 'message', role: 'user', content: 'List files' }]
      })
    });

    assert.equal(res.status, 200);
    const text = await res.text();
    const events = parseSseBlocks(text);

    // Verify function call output item
    const fcDone = events.find(e => e.eventType === 'response.output_item.done' && e.data?.item?.type === 'function_call');
    assert.ok(fcDone, 'Function call must be done');
    assert.equal(fcDone.data.item.name, 'bash');

    // Verify reasoning output item closed at the end with all summary text accumulated
    const reasoningDone = events.find(e => e.eventType === 'response.output_item.done' && e.data?.item?.type === 'reasoning');
    assert.ok(reasoningDone, 'Reasoning must be done on finish');
    const fullReasoning = reasoningDone.data.item.summary[0].text;
    assert.ok(fullReasoning.includes('list directory contents'));
    assert.ok(fullReasoning.includes('formulate the next steps'));
  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});

// ---------------------------------------------------------------------------
// 3. Transport Resiliency: Delayed Rate Limit & Packet Fragmentation
// ---------------------------------------------------------------------------

test('Replay: Prelude - Non-decisive start followed by 429 returns clean JSON 429', async () => {
  const mockUpstream = createReplayUpstream('stream_delayed_rate_limit.ndjson');
  const upstreamPort = await mockUpstream.start();

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upstreamPort}` }
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_token'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Test rate limit' }]
      })
    });

    // MUST return 429 with application/json, NOT 200 text/event-stream!
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const data = await res.json();
    assert.equal(data.error.code, 'upstream_error');
    assert.equal(data.error.message, 'Rate limit exceeded for organization');
  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});

test('Replay: Transport - High packet fragmentation (3-byte slices) parses cleanly without corruption', async () => {
  // Fragment stream_basic_text.ndjson into 3-byte chunks to stress parser boundaries
  const mockUpstream = createReplayUpstream('stream_basic_text.ndjson', { chunkSizeBytes: 3 });
  const upstreamPort = await mockUpstream.start();

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upstreamPort}` }
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_token'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Test fragmentation' }]
      })
    });

    assert.equal(res.status, 200);
    const text = await res.text();
    const events = parseSseBlocks(text);

    const textDeltas = events.filter(e => e.eventType === 'content_block_delta' && e.data?.delta?.type === 'text_delta');
    const assembledText = textDeltas.map(d => d.data.delta.text).join('');
    assert.equal(assembledText, 'The quick brown fox jumps over the lazy dog.');
  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});
