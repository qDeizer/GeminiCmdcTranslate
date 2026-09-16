/**
 * @file features_2026.test.mjs
 * @description Comprehensive Verification Suite for 2026 Bridge Enhancements:
 * 1. Stream Buffering & Immediate First-Token Delivery
 * 2. Session ID, Thread ID & W3C Traceparent Continuity Across Turns
 * 3. Deterministic System Safeguard & Byte-Exact Cache Hit Invariance
 * 4. Dashboard Web UI, Dynamic Model Discovery & Config Persistence
 * 5. Adaptive Reasoning Effort Level Mapping & Clamping
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBridgeServer } from '../src/server.mjs';
import { createSessionManager } from '../src/session.mjs';
import { buildWireHeaders, buildWireEnvelope } from '../src/commandcode/wire.mjs';
import { PreludeBuffer } from '../src/transport/prelude.mjs';
import { resolveReasoningEffort, KNOWN_MODEL_EFFORTS, getCatalogModels } from '../src/commandcode/effort.mjs';
import { decodeAnthropicRequest } from '../src/ingress/anthropic.mjs';
import { decodeChatRequest } from '../src/ingress/chat.mjs';
import { decodeResponsesRequest } from '../src/ingress/responses.mjs';

// ===========================================================================
// SECTION 1: Stream Buffering & Real-Time Token Delivery (Point 1)
// ===========================================================================

test('Point 1: Prelude Buffer commits immediately on first text-delta token', () => {
  const prelude = new PreludeBuffer();

  // Initial stream setup events are non-decisive
  assert.equal(prelude.ingest({ type: 'start' }), false);
  assert.equal(prelude.ingest({ type: 'start-step' }), false);
  assert.equal(prelude.committed, false);

  // Very first token (text-delta) must trigger immediate commitment
  const committed = prelude.ingest({ type: 'text-delta', text: 'First' });
  assert.equal(committed, true);
  assert.equal(prelude.committed, true);

  // Drained events must contain all buffered events up to and including the first token
  const flushed = prelude.flush();
  assert.equal(flushed.length, 3);
  assert.equal(flushed[2].text, 'First');
});

test('Point 1: Prelude Buffer commits immediately on reasoning-delta and tool-call', () => {
  // Reasoning delta triggers commitment immediately
  const pReason = new PreludeBuffer();
  assert.equal(pReason.ingest({ type: 'reasoning-start', text: '' }), false);
  assert.equal(pReason.ingest({ type: 'reasoning-delta', text: 'Thinking step' }), true);
  assert.equal(pReason.committed, true);

  // Tool call triggers commitment immediately
  const pTool = new PreludeBuffer();
  assert.equal(pTool.ingest({ type: 'tool-call', toolCallId: 'c1', toolName: 'bash', input: {} }), true);
  assert.equal(pTool.committed, true);
});

test('Point 1: Downstream SSE responses include x-accel-buffering: no', async () => {
  let capturedHeaders = null;
  const mockUpstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ type: 'text-delta', text: 'hello' }) + '\n');
    res.end(JSON.stringify({ type: 'finish', finishReason: 'stop' }) + '\n');
  });
  await new Promise(r => mockUpstream.listen(0, '127.0.0.1', r));
  const upPort = mockUpstream.address().port;

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upPort}` },
    apiKey: 'cc_test_key_123'
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true
      })
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    await res.text();
  } finally {
    await bridge.stop();
    await new Promise(r => mockUpstream.close(r));
  }
});

// ===========================================================================
// SECTION 2: Session ID, Thread ID & W3C Traceparent Continuity (Point 2)
// ===========================================================================

test('Point 2: Multi-turn on same conversation retains identical x-session-id, threadId, and trace-id', async () => {
  const upstreamRequests = [];
  const mockUpstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    upstreamRequests.push({ headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ type: 'text-delta', text: 'answer' }) + '\n');
    res.end(JSON.stringify({ type: 'finish', finishReason: 'stop' }) + '\n');
  });
  await new Promise(r => mockUpstream.listen(0, '127.0.0.1', r));
  const upPort = mockUpstream.address().port;

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upPort}` },
    apiKey: 'cc_test_key_123'
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const sessionIdHeader = 'sess_persistent_conv_001';

    // Turn 1 on Session
    const res1 = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-claude-code-session-id': sessionIdHeader
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Turn 1' }]
      })
    });
    assert.equal(res1.status, 200);
    await res1.text();

    // Turn 2 on same Session
    const res2 = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-claude-code-session-id': sessionIdHeader
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'Turn 2' }
        ]
      })
    });
    assert.equal(res2.status, 200);
    await res2.text();

    // Turn 3 on a DIFFERENT Session
    const res3 = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-claude-code-session-id': 'sess_different_conv_999'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'New session' }]
      })
    });
    assert.equal(res3.status, 200);
    await res3.text();

    assert.equal(upstreamRequests.length, 3);

    // 1. Session ID Invariant
    const turn1Session = upstreamRequests[0].headers['x-session-id'];
    const turn2Session = upstreamRequests[1].headers['x-session-id'];
    const turn3Session = upstreamRequests[2].headers['x-session-id'];
    assert.equal(turn1Session, turn2Session, 'Turn 1 and 2 of same conversation must have identical x-session-id');
    assert.notEqual(turn1Session, turn3Session, 'Different conversation must have different x-session-id');

    // 2. Thread ID Invariant
    const turn1Thread = upstreamRequests[0].body.threadId;
    const turn2Thread = upstreamRequests[1].body.threadId;
    const turn3Thread = upstreamRequests[2].body.threadId;
    assert.ok(turn1Thread, 'Turn 1 must have threadId');
    assert.equal(turn1Thread, turn2Thread, 'Turn 1 and 2 of same conversation must have identical threadId');
    assert.notEqual(turn1Thread, turn3Thread, 'Different conversation must have different threadId');

    // 3. W3C Traceparent Invariant (00-<traceId>-<spanId>-01)
    const tp1 = upstreamRequests[0].headers['traceparent'].split('-');
    const tp2 = upstreamRequests[1].headers['traceparent'].split('-');
    const tp3 = upstreamRequests[2].headers['traceparent'].split('-');

    assert.equal(tp1.length, 4);
    assert.equal(tp1[0], '00');
    assert.equal(tp1[3], '01');

    // Trace ID (16 bytes = 32 hex chars)
    assert.match(tp1[1], /^[a-f0-9]{32}$/);
    assert.match(tp2[1], /^[a-f0-9]{32}$/);
    assert.equal(tp1[1], tp2[1], 'Trace ID must be identical across turns of the same session');
    assert.notEqual(tp1[1], tp3[1], 'Trace ID must differ across different sessions');

    // Span ID (8 bytes = 16 hex chars) - updates per turn!
    assert.match(tp1[2], /^[a-f0-9]{16}$/);
    assert.match(tp2[2], /^[a-f0-9]{16}$/);
    assert.notEqual(tp1[2], tp2[2], 'Span ID must be freshly generated on every turn');
  } finally {
    await bridge.stop();
    await new Promise(r => mockUpstream.close(r));
  }
});

// ===========================================================================
// SECTION 3: Cache Miss Prevention & Determinism (Point 3)
// ===========================================================================

test('Point 3: EmptySystem safeguard is deterministic for empty array, whitespace and null', () => {
  const profile = { emptySystem: 'single-space' };
  const modelConfig = { upstream: 'meta/muse-spark-1.3-contributor', maxOutputTokens: 64000 };
  const identity = { sessionId: 'sess-cache-test' };

  const cases = [
    [],
    null,
    undefined,
    [{ text: '' }],
    [{ text: '   ' }]
  ];

  for (const c of cases) {
    const turn = {
      protocol: 'anthropic',
      publicModel: 'claude-3-7-sonnet',
      system: c,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      tools: []
    };
    const envelope = buildWireEnvelope(turn, profile, modelConfig, identity);
    assert.deepEqual(
      envelope.params.system,
      [{ type: 'text', text: ' ' }],
      'Safeguard must inject single space deterministically'
    );
  }
});

test('Point 3: Multi-turn prefix serialization is byte-exact across turns', () => {
  const profile = { emptySystem: 'single-space' };
  const modelConfig = { upstream: 'meta/muse-spark-1.3-contributor', maxOutputTokens: 64000 };
  const identity = { sessionId: 'sess-cache-test', threadId: '11111111-2222-3333-4444-555555555555' };

  const tools = [
    { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'bash', description: 'Run bash command', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } }
  ];

  const turn1 = {
    protocol: 'anthropic',
    publicModel: 'claude-3-7-sonnet',
    system: [{ text: 'You are an expert coder.' }],
    tools,
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'List files' }] }
    ]
  };

  const turn2 = {
    protocol: 'anthropic',
    publicModel: 'claude-3-7-sonnet',
    system: [{ text: 'You are an expert coder.' }],
    tools,
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'List files' }] },
      { role: 'assistant', parts: [{ type: 'tool-call', id: 'call_1', name: 'bash', input: { command: 'ls' } }] },
      { role: 'user', parts: [{ type: 'tool-result', id: 'call_1', name: 'bash', text: 'file1.txt\nfile2.txt' }, { type: 'text', text: 'Now summarize.' }] }
    ]
  };

  const env1 = buildWireEnvelope(turn1, profile, modelConfig, identity);
  const env2 = buildWireEnvelope(turn2, profile, modelConfig, identity);

  // Tools serialization in env1 and env2 must be identical
  assert.equal(JSON.stringify(env1.params.tools), JSON.stringify(env2.params.tools));

  // System prompt serialization in env1 and env2 must be identical
  assert.equal(JSON.stringify(env1.params.system), JSON.stringify(env2.params.system));

  // The first message in env2 must match the first message in env1 byte-for-byte
  assert.equal(JSON.stringify(env1.params.messages[0]), JSON.stringify(env2.params.messages[0]));
});

// ===========================================================================
// SECTION 4: Dashboard UI & Configuration API (Point 4)
// ===========================================================================

test('Point 4: Dashboard UI is served at GET / and GET /ui', async () => {
  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 }
  });
  await bridge.start();
  const port = bridge.server.address().port;

  try {
    // GET /
    const resRoot = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(resRoot.status, 200);
    assert.equal(resRoot.headers.get('content-type'), 'text/html; charset=utf-8');
    const htmlRoot = await resRoot.text();
    assert.ok(htmlRoot.includes('Gemini1'), 'Must include bridge title');
    assert.ok(htmlRoot.includes('Command Code Native Bridge'), 'Must include heading');

    // GET /ui
    const resUi = await fetch(`http://127.0.0.1:${port}/ui`);
    assert.equal(resUi.status, 200);
    const htmlUi = await resUi.text();
    assert.ok(htmlUi.includes('id="apiKey"'), 'Must include API Key field');
    assert.ok(htmlUi.includes('id="discover-btn"'), 'Must include discover button');
  } finally {
    await bridge.stop();
  }
});

test('Point 4: GET /api/config and POST /api/config with persistence', async () => {
  const testConfigPath = resolve(process.cwd(), `test_config_${Date.now()}.json`);

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    configPath: testConfigPath
  });
  await bridge.start();
  const port = bridge.server.address().port;

  try {
    // 1. GET initial config
    const res1 = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.equal(res1.status, 200);
    const config1 = await res1.json();
    assert.ok(config1.models, 'Config must have models');

    // 2. POST update config
    const res2 = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'cc_saved_key_test_12345',
        models: {
          'claude-custom': {
            upstream: 'meta/muse-spark-1.3-contributor',
            defaultEffort: 'high',
            maxOutputTokens: 64000
          }
        }
      })
    });
    assert.equal(res2.status, 200);
    const resJson = await res2.json();
    assert.equal(resJson.success, true);

    // 3. Verify in-memory config updated
    const res3 = await fetch(`http://127.0.0.1:${port}/api/config`);
    const config3 = await res3.json();
    assert.equal(config3.apiKeyConfigured, true);
    assert.ok(config3.models['claude-custom']);

    // 4. Verify disk persistence
    assert.ok(existsSync(testConfigPath), 'config file must exist on disk');
    const diskContent = JSON.parse(readFileSync(testConfigPath, 'utf8'));
    assert.equal(diskContent.apiKey, 'cc_saved_key_test_12345');
    assert.ok(diskContent.models['claude-custom']);
  } finally {
    await bridge.stop();
    if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
  }
});

test('Point 4: GET /api/upstream-models returns available models (fallback catalog)', async () => {
  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 }
  });
  await bridge.start();
  const port = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/upstream-models`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.count > 10, 'Expected at least 10 models in catalog');
    assert.ok(data.models.some(m => m.id === 'meta/muse-spark-1.3-contributor'));
    assert.ok(data.models.some(m => m.id === 'deepseek/deepseek-v4-pro'));
  } finally {
    await bridge.stop();
  }
});

// ===========================================================================
// SECTION 5: Reasoning Effort Level Mapping & Clamping (Point 5)
// ===========================================================================

test('Point 5: Claude budget_tokens maps to appropriate effort levels', () => {
  const cases = [
    { budget: 500, expected: 'low' },
    { budget: 2000, expected: 'low' },
    { budget: 5000, expected: 'medium' },
    { budget: 16000, expected: 'high' },
    { budget: 32000, expected: 'max' }
  ];

  for (const { budget, expected } of cases) {
    const turn = decodeAnthropicRequest({
      model: 'claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'enabled', budget_tokens: budget }
    });
    assert.equal(turn.reasoningEffort, expected, `Budget ${budget} should map to ${expected}`);
  }
});

test('Point 5: Unsupported effort levels clamp to closest supported option', () => {
  // Model 1: Muse Spark 1.3 Contributor supports ['low', 'medium', 'high', 'xhigh'] (no 'max')
  // Client requests 'max' -> Clamps to closest 'xhigh'
  const resolvedMax = resolveReasoningEffort('meta/muse-spark-1.3-contributor', 'max');
  assert.equal(resolvedMax, 'xhigh', 'Max should clamp to xhigh on muse-spark-1.3-contributor');

  // Client requests 'high' -> Supported as-is
  const resolvedHigh = resolveReasoningEffort('meta/muse-spark-1.3-contributor', 'high');
  assert.equal(resolvedHigh, 'high');

  // Model 2: DeepSeek V4 Pro supports only ['high', 'max'] (no 'low')
  // Client requests 'low' -> Clamps to 'high'
  const resolvedDsLow = resolveReasoningEffort('deepseek/deepseek-v4-pro', 'low');
  assert.equal(resolvedDsLow, 'high', 'Low should clamp to high on deepseek-v4-pro');

  // Model 3: Claude Haiku supports [] (no reasoning)
  // Client requests 'high' -> Omitted (returns undefined)
  const resolvedHaiku = resolveReasoningEffort('claude-haiku-4-5-20251001', 'high');
  assert.equal(resolvedHaiku, undefined, 'Effort should be omitted on non-reasoning models');

  // Explicit 'none' or 'disabled' -> Omitted
  assert.equal(resolveReasoningEffort('meta/muse-spark-1.3-contributor', 'none'), undefined);
  assert.equal(resolveReasoningEffort('meta/muse-spark-1.3-contributor', 'disabled'), undefined);
});

test('Point 5: Custom effortMap in modelConfig overrides default mapping', () => {
  const modelConfig = {
    upstream: 'meta/muse-spark-1.3-contributor',
    effortMap: {
      'low': 'medium',
      'medium': 'medium',
      'high': 'xhigh',
      'max': 'xhigh'
    }
  };

  const resolved = resolveReasoningEffort('meta/muse-spark-1.3-contributor', 'low', modelConfig);
  assert.equal(resolved, 'medium', 'Custom effortMap should override default resolution');
});

test('Point 5: Direct numeric budgets, adaptive, auto and minimal resolve accurately', () => {
  // Numeric token budgets
  assert.equal(resolveReasoningEffort('meta/muse-spark-1.3', 1500), 'low');
  assert.equal(resolveReasoningEffort('meta/muse-spark-1.3', '5000'), 'medium');
  assert.equal(resolveReasoningEffort('meta/muse-spark-1.3', 16000), 'high');
  assert.equal(resolveReasoningEffort('meta/muse-spark-1.3', 32000), 'max');

  // Adaptive and auto
  assert.equal(resolveReasoningEffort('meta/muse-spark-1.3', 'adaptive'), 'high');
  assert.equal(resolveReasoningEffort('meta/muse-spark-1.3', 'auto'), 'high');

  // Minimal clamps to low
  assert.equal(resolveReasoningEffort('meta/muse-spark-1.3', 'minimal'), 'low');
});

// ===========================================================================
// SECTION 6: Advanced Adversarial Scenarios
// ===========================================================================

test('Point 2: Multi-turn requests WITHOUT headers retain session and trace continuity via conversation prefix heuristic', async () => {
  const upstreamRequests = [];
  const mockUpstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    upstreamRequests.push({ headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ type: 'text-delta', text: 'turn response' }) + '\n');
    res.end(JSON.stringify({ type: 'finish', finishReason: 'stop' }) + '\n');
  });
  await new Promise(r => mockUpstream.listen(0, '127.0.0.1', r));
  const upPort = mockUpstream.address().port;

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upPort}` },
    apiKey: 'cc_test_key_123'
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    // Turn 1: No session headers at all
    const res1 = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'What is the capital of Turkey?' }]
      })
    });
    assert.equal(res1.status, 200);
    await res1.text();

    // Turn 2: Follow-up in same conversation, still no session headers
    const res2 = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [
          { role: 'user', content: 'What is the capital of Turkey?' },
          { role: 'assistant', content: 'Ankara' },
          { role: 'user', content: 'What is its population?' }
        ]
      })
    });
    assert.equal(res2.status, 200);
    await res2.text();

    assert.equal(upstreamRequests.length, 2);

    // Verify Session ID and Thread ID continuity without headers
    assert.equal(
      upstreamRequests[0].headers['x-session-id'],
      upstreamRequests[1].headers['x-session-id'],
      'Multi-turn without headers must retain identical x-session-id'
    );
    assert.equal(
      upstreamRequests[0].body.threadId,
      upstreamRequests[1].body.threadId,
      'Multi-turn without headers must retain identical threadId'
    );

    // Verify Trace ID continuity in W3C traceparent
    const tp1 = upstreamRequests[0].headers['traceparent'].split('-');
    const tp2 = upstreamRequests[1].headers['traceparent'].split('-');
    assert.equal(tp1[1], tp2[1], 'Trace ID must be identical across turns without headers');
    assert.notEqual(tp1[2], tp2[2], 'Span ID must update per turn');
  } finally {
    await bridge.stop();
    await new Promise(r => mockUpstream.close(r));
  }
});

test('Point 2: Incoming W3C traceparent header is preserved across turns', async () => {
  const upstreamRequests = [];
  const mockUpstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    upstreamRequests.push({ headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ type: 'text-delta', text: 'ok' }) + '\n');
    res.end(JSON.stringify({ type: 'finish', finishReason: 'stop' }) + '\n');
  });
  await new Promise(r => mockUpstream.listen(0, '127.0.0.1', r));
  const upPort = mockUpstream.address().port;

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upPort}` },
    apiKey: 'cc_test_key_123'
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const clientTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const clientTraceparent = `00-${clientTraceId}-00f067aa0ba902b7-01`;

    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'traceparent': clientTraceparent
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Testing traceparent' }]
      })
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(upstreamRequests.length, 1);
    const sentTp = upstreamRequests[0].headers['traceparent'].split('-');
    assert.equal(sentTp[1], clientTraceId, 'Upstream traceparent must preserve incoming client trace ID');
  } finally {
    await bridge.stop();
    await new Promise(r => mockUpstream.close(r));
  }
});

test('Point 4: POST /api/config rejects masked key overwrite and persists model deletion', async () => {
  const testConfigPath = resolve(process.cwd(), `test_config_masked_${Date.now()}.json`);

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    configPath: testConfigPath,
    apiKey: 'cc_original_secret_key_99999'
  });
  await bridge.start();
  const port = bridge.server.address().port;

  try {
    // 1. Submit update with masked key like "cc_orig...9999" (simulating browser save without key change)
    // and delete old models by only providing one new model
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'cc_orig...9999',
        models: {
          'only-model': { upstream: 'meta/muse-spark-1.3-contributor', maxOutputTokens: 32000 }
        }
      })
    });
    assert.equal(res.status, 200);

    // 2. Fetch config and ensure real key was NOT destroyed
    const resGet = await fetch(`http://127.0.0.1:${port}/api/config`);
    const cfg = await resGet.json();
    assert.equal(cfg.apiKey, 'cc_original_secret_key_99999', 'Masked key must NOT overwrite authentic secret');
    assert.deepEqual(Object.keys(cfg.models), ['only-model'], 'Deleted models must be pruned from configuration');
  } finally {
    await bridge.stop();
    if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
  }
});

test('Point 4: Dynamic discovery queries /provider/v1/models endpoint successfully', async () => {
  let endpointHit = null;
  const mockUpstream = http.createServer((req, res) => {
    endpointHit = req.url;
    if (req.url === '/provider/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'meta/muse-spark-1.3-contributor', max_tokens: 64000, efforts: ['low', 'medium', 'high', 'xhigh'] },
          { id: 'deepseek/deepseek-v4-pro', max_tokens: 64000, efforts: ['high', 'max'] }
        ]
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => mockUpstream.listen(0, '127.0.0.1', r));
  const upPort = mockUpstream.address().port;

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upPort}` },
    apiKey: 'cc_test_key'
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/api/upstream-models`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.source, 'upstream');
    assert.equal(data.count, 2);
    assert.equal(endpointHit, '/provider/v1/models');
  } finally {
    await bridge.stop();
    await new Promise(r => mockUpstream.close(r));
  }
});

test('Point 1: Prelude Buffer commits immediately on reasoning-start with text', () => {
  const prelude = new PreludeBuffer();
  // Empty reasoning start does not commit
  assert.equal(prelude.ingest({ type: 'reasoning-start', text: '' }), false);
  assert.equal(prelude.committed, false);

  // Non-empty reasoning start commits immediately
  assert.equal(prelude.ingest({ type: 'reasoning-start', text: 'Initial thinking step' }), true);
  assert.equal(prelude.committed, true);
});
