/**
 * @file adversarial_tier5.test.mjs
 * @description Tier 5 Integration Tests for Core Engine Remediation.
 * 
 * Verifies the 5 remediations identified by Challenger 1:
 * 1. Session hint extraction from raw body (body.metadata.session_id and body.prompt_cache_key)
 * 2. Mid-stream upstream error handling after HTTP 200 committed (SSE error frame)
 * 3. Token estimation defense (system array, null/malformed content blocks)
 * 4. Chat serializer tool name unaliasing (search_tools -> tool_search)
 * 5. Responses serializer output array ordering (response.completed sorted by outputIndex)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridgeServer } from '../src/server.mjs';
import { estimateAnthropicTokens } from '../src/ingress/anthropic.mjs';
import { ChatSseSerializer } from '../src/egress/chat.mjs';
import { ResponsesSseSerializer } from '../src/egress/responses.mjs';

function createMockUpstream(handler) {
  const server = http.createServer(handler);
  return {
    server,
    start() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    stop() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

// ---------------------------------------------------------------------------
// 1. Session Hint Extraction from Raw Request Body
// ---------------------------------------------------------------------------

test('Remediation 1.1: Session lock respected via body.metadata.session_id (Anthropic)', async () => {
  let activeUpstreamConnections = 0;
  let maxConcurrentUpstream = 0;
  let releaseUpstream;
  const gate = new Promise((resolve) => { releaseUpstream = resolve; });

  const mockUpstream = createMockUpstream(async (req, res) => {
    activeUpstreamConnections++;
    if (activeUpstreamConnections > maxConcurrentUpstream) {
      maxConcurrentUpstream = activeUpstreamConnections;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"type":"start"}\n');
    await gate;
    res.write('{"type":"text-delta","text":"ok"}\n{"type":"finish"}\n');
    res.end();
    activeUpstreamConnections--;
  });

  const upstreamPort = await mockUpstream.start();
  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upstreamPort}` }
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const turn1Promise = fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_key_shared'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        metadata: { session_id: 'shared_session_in_body_123' },
        messages: [{ role: 'user', content: 'Turn 1' }]
      })
    });

    await new Promise((r) => setTimeout(r, 60));

    const res2Promise = fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_key_shared'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        metadata: { session_id: 'shared_session_in_body_123' },
        messages: [{ role: 'user', content: 'Turn 2' }]
      })
    });

    await new Promise((r) => setTimeout(r, 60));

    releaseUpstream();
    const [res1, res2] = await Promise.all([turn1Promise, res2Promise]);

    assert.equal(res1.status, 200, 'Turn 1 should succeed with 200');
    assert.equal(res2.status, 409, 'Turn 2 with same body.metadata.session_id should receive 409');
    assert.equal(maxConcurrentUpstream, 1, 'Only 1 request should reach upstream');
  } finally {
    releaseUpstream?.();
    await bridge.stop();
    await mockUpstream.stop();
  }
});

test('Remediation 1.2: Session lock respected via body.prompt_cache_key (Responses)', async () => {
  let activeUpstreamConnections = 0;
  let maxConcurrentUpstream = 0;
  let releaseUpstream;
  const gate = new Promise((resolve) => { releaseUpstream = resolve; });

  const mockUpstream = createMockUpstream(async (req, res) => {
    activeUpstreamConnections++;
    if (activeUpstreamConnections > maxConcurrentUpstream) {
      maxConcurrentUpstream = activeUpstreamConnections;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"type":"start"}\n');
    await gate;
    res.write('{"type":"text-delta","text":"ok"}\n{"type":"finish"}\n');
    res.end();
    activeUpstreamConnections--;
  });

  const upstreamPort = await mockUpstream.start();
  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upstreamPort}` }
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const turn1Promise = fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_key_responses'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        prompt_cache_key: 'shared_cache_key_999',
        input: [{ type: 'message', role: 'user', content: 'Turn 1' }]
      })
    });

    await new Promise((r) => setTimeout(r, 60));

    const res2Promise = fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_key_responses'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        prompt_cache_key: 'shared_cache_key_999',
        input: [{ type: 'message', role: 'user', content: 'Turn 2' }]
      })
    });

    await new Promise((r) => setTimeout(r, 60));

    releaseUpstream();
    const [res1, res2] = await Promise.all([turn1Promise, res2Promise]);

    assert.equal(res1.status, 200, 'Turn 1 should succeed with 200');
    assert.equal(res2.status, 409, 'Turn 2 with same body.prompt_cache_key should receive 409');
    assert.equal(maxConcurrentUpstream, 1, 'Only 1 request should reach upstream');
  } finally {
    releaseUpstream?.();
    await bridge.stop();
    await mockUpstream.stop();
  }
});

// ---------------------------------------------------------------------------
// 2. Mid-Stream Upstream Error Handling After HTTP 200 Committed
// ---------------------------------------------------------------------------

test('Remediation 2: Mid-stream upstream error emits SSE error frame post-prelude', async () => {
  const mockUpstream = createMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    // Decisive event commits 200
    res.write('{"type":"text-delta","text":"hello initial"}\n');
    // Upstream failure mid-stream
    res.write('{"type":"error","statusCode":500,"message":"Upstream internal explosion midway"}\n');
    res.end();
  });

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
        'authorization': 'Bearer test_key'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Test midstream error' }]
      })
    });

    assert.equal(res.status, 200, 'HTTP headers already committed as 200');
    const text = await res.text();

    assert.ok(text.includes('event: error'), 'Response stream must contain "event: error" frame');
    assert.ok(text.includes('Upstream internal explosion midway'), 'Response error must include upstream error message');
  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});

// ---------------------------------------------------------------------------
// 3. Defensive Token Estimation in estimateAnthropicTokens
// ---------------------------------------------------------------------------

test('Remediation 3: Defensive token estimation with system array and null content blocks', () => {
  // 1. Array of system blocks (strings and objects)
  const estArray = estimateAnthropicTokens({
    system: [
      { type: 'text', text: 'You are an adversarial tester.' },
      'Secondary plain text system instruction.'
    ],
    messages: [{ role: 'user', content: 'test' }]
  });
  // System: 30 + 41 = 71 chars. User: 4 chars. Total: 75 chars / 3.8 = ~20 tokens.
  assert.ok(estArray >= 18, `Token estimation for system array should count system content, got: ${estArray}`);

  // 2. Malformed content array with null and non-object blocks
  const estMalformed = estimateAnthropicTokens({
    messages: [
      { role: 'user', content: [null, undefined, 42, 'string-block', { text: 'valid block' }] }
    ]
  });
  assert.ok(typeof estMalformed === 'number' && estMalformed > 0, 'Must safely calculate without throwing');

  // 3. Null and undefined body
  assert.equal(estimateAnthropicTokens(null), 1, 'Null body returns fallback 1 token');
  assert.equal(estimateAnthropicTokens(undefined), 1, 'Undefined body returns fallback 1 token');
  assert.equal(estimateAnthropicTokens({}), 1, 'Empty object returns fallback 1 token');
});

// ---------------------------------------------------------------------------
// 4. Tool Name Unaliasing in Chat Serializer
// ---------------------------------------------------------------------------

test('Remediation 4: ChatSseSerializer unaliases search_tools -> tool_search', () => {
  const writtenChunks = [];
  const mockRes = {
    writeHead() {},
    write(chunk) { writtenChunks.push(chunk); return true; },
    end() {}
  };

  const serializer = new ChatSseSerializer(mockRes, { model: 'gpt-4o' });
  serializer.start();
  serializer.processEvent({
    type: 'tool-call',
    toolCallId: 'call_search_1',
    toolName: 'search_tools',
    input: { query: 'test query' }
  });

  const toolCallChunk = writtenChunks.find((c) => c.includes('tool_calls'));
  assert.ok(toolCallChunk, 'Expected tool_calls chunk');

  const parsed = JSON.parse(toolCallChunk.replace(/^data: /, '').trim());
  const funcName = parsed.choices[0].delta.tool_calls[0].function.name;
  assert.equal(funcName, 'tool_search', 'ChatSseSerializer must unalias search_tools to tool_search');
});

// ---------------------------------------------------------------------------
// 5. Output Array Ordering in Responses Serializer
// ---------------------------------------------------------------------------

test('Remediation 5: ResponsesSseSerializer response.completed strictly sorted by outputIndex', () => {
  const writtenChunks = [];
  const mockRes = {
    writeHead() {},
    write(chunk) { writtenChunks.push(chunk); return true; },
    end() {}
  };

  const serializer = new ResponsesSseSerializer(mockRes, { model: 'gpt-4o' });
  serializer.start();

  // 1. Reasoning starts at output_index: 0
  serializer.processEvent({ type: 'reasoning-delta', text: 'Reasoning part 1' });

  // 2. Interleaved tool-call arrives at output_index: 1 and finishes first
  serializer.processEvent({
    type: 'tool-call',
    toolCallId: 'call_bash_1',
    toolName: 'bash',
    input: { command: 'pwd' }
  });

  // 3. Reasoning continues
  serializer.processEvent({ type: 'reasoning-delta', text: 'Reasoning part 2' });

  // 4. Finish closes reasoning (completed second)
  serializer.processEvent({
    type: 'finish',
    finishReason: 'tool-calls',
    totalUsage: { inputTokens: 100, outputTokens: 50 }
  });

  const completedChunk = writtenChunks.find((c) => c.includes('response.completed'));
  assert.ok(completedChunk, 'Expected response.completed frame');

  const lines = completedChunk.split('\n');
  const dataLine = lines.find((l) => l.startsWith('data: '));
  const eventObj = JSON.parse(dataLine.slice(6));
  const outputArray = eventObj.response.output;

  assert.equal(outputArray.length, 2, 'Must have 2 completed output items');
  assert.equal(outputArray[0].type, 'reasoning', 'output[0] must be reasoning (outputIndex: 0)');
  assert.equal(outputArray[1].type, 'function_call', 'output[1] must be function_call (outputIndex: 1)');
});
