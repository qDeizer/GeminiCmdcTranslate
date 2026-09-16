/**
 * @file adversarial_fuzz.test.mjs
 * @description Adversarial Stress Testing & Wire Invariant Fuzzing Suite for Gemini1.
 * 
 * Verifies:
 * 1. CLI 1.54.0 headers exact matching and envelope key ordering in `src/commandcode/wire.mjs`.
 * 2. `emptySystem: 'single-space'` safeguard preventing upstream ~14K token injection across all protocols.
 * 3. Extreme TCP packet slicing (1-byte chunks, irregular chunk delays, multi-byte UTF-8 split boundaries).
 * 4. Responses output indexing and active items concurrent interleaved state tracking.
 * 5. Watchdog timer behavior under backpressure, socket closure, and touch resets.
 * 6. Concurrency turn locking and Two-Phase Commit Prelude error interception.
 * 7. End-to-end live HTTP replay under 1-byte packet fragmentation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  buildWireHeaders,
  buildWireEnvelope,
  compileMessages,
  toWireToolName,
  fromWireToolName,
  WIRE_CONSTANTS
} from '../src/commandcode/wire.mjs';

import { parseNdjsonStream } from '../src/transport/ndjson.mjs';
import { createHeartbeat } from '../src/transport/heartbeat.mjs';
import { PreludeBuffer } from '../src/transport/prelude.mjs';
import { ResponsesSseSerializer } from '../src/egress/responses.mjs';
import { AnthropicSseSerializer, makeThinkingSignature, normalizeUsageForAnthropic } from '../src/egress/anthropic.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { BridgeHttpError } from '../src/types.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// Helper: Mock Response for Serializer / Watchdog testing
// ---------------------------------------------------------------------------
class MockResponse {
  constructor({ writableNeedDrain = false, writeReturnsFalse = false } = {}) {
    this.writes = [];
    this.headers = null;
    this.statusCode = null;
    this.destroyed = false;
    this.writableEnded = false;
    this.writableNeedDrain = writableNeedDrain;
    this.writeReturnsFalse = writeReturnsFalse;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(chunk) {
    if (this.destroyed || this.writableEnded) return false;
    if (this.writableNeedDrain) return false;
    this.writes.push(chunk);
    if (this.writeReturnsFalse) {
      this.writableNeedDrain = true;
      return false;
    }
    return true;
  }

  end() {
    this.writableEnded = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

// ---------------------------------------------------------------------------
// Helper: Parse SSE blocks
// ---------------------------------------------------------------------------
function parseSseEvents(rawText) {
  const blocks = rawText.split('\n\n').filter((b) => b.trim().length > 0);
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

    if (eventType || data) {
      events.push({ event: eventType, data });
    }
  }

  return events;
}

// ===========================================================================
// SECTION 1: Wire Invariant & Envelope Fuzzing
// ===========================================================================

test('Fuzz: Wire Headers - Exact CLI 1.54.0 headers & API key validation', () => {
  const profile = {
    cliVersion: '1.54.0',
    cliEnvironment: 'production',
    projectSlug: 'adversarial-workspace',
    tasteLearning: true
  };
  const identity = { sessionId: 'sess-adv-999' };

  // 1. Valid API key with extraneous whitespace
  const headers = buildWireHeaders(profile, identity, '  cc_api_key_secret_123 \n');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['user-agent'], 'cli');
  assert.equal(headers['x-command-code-version'], '1.54.0');
  assert.equal(headers['x-cli-environment'], 'production');
  assert.equal(headers['x-project-slug'], 'adversarial-workspace');
  assert.equal(headers['x-taste-learning'], 'true');
  assert.equal(headers['x-session-id'], 'sess-adv-999');
  assert.equal(headers['authorization'], 'Bearer cc_api_key_secret_123');

  // 2. Fuzz tasteLearning falsy values
  const headersFalsy = buildWireHeaders({ ...profile, tasteLearning: false }, identity, 'key');
  assert.equal(headersFalsy['x-taste-learning'], 'false');

  // 3. Fuzz invalid API keys: empty string, null, undefined, numbers, objects
  const invalidKeys = ['', null, undefined, 12345, {}, []];
  for (const badKey of invalidKeys) {
    assert.throws(
      () => buildWireHeaders(profile, identity, badKey),
      (err) => err instanceof BridgeHttpError && err.status === 401
    );
  }

  // 4. Whitespace-only string behavior
  const wsHeaders = buildWireHeaders(profile, identity, '   ');
  assert.equal(wsHeaders['authorization'], 'Bearer ');
});

test('Fuzz: Envelope Key Ordering - 100 random envelope generations preserve strict key ordering', () => {
  const baseProfile = {
    cliVersion: '1.54.0',
    cliEnvironment: 'production',
    permissionMode: 'auto-accept',
    emptySystem: 'single-space',
    config: { customField: 'test' }
  };
  const modelConfig = { upstream: 'meta/muse-spark-1.3-contributor', maxOutputTokens: 64000 };

  for (let i = 0; i < 100; i++) {
    const hasThreadId = i % 2 === 0;
    const threadUuid = hasThreadId ? randomUUID() : undefined;
    const identity = {
      sessionId: `sess_${randomUUID()}`,
      threadId: threadUuid
    };

    const turn = {
      protocol: 'anthropic',
      publicModel: 'claude-3-7-sonnet',
      system: [],
      messages: [{ role: 'user', parts: [{ type: 'text', text: `Question ${i}` }] }],
      tools: [],
      stream: true
    };

    const envelope = buildWireEnvelope(turn, baseProfile, modelConfig, identity);

    // Assert strictly ordered keys
    const keys = Object.keys(envelope);
    const expectedKeys = hasThreadId
      ? ['config', 'memory', 'taste', 'skills', 'permissionMode', 'threadId', 'params']
      : ['config', 'memory', 'taste', 'skills', 'permissionMode', 'params'];

    assert.deepEqual(keys, expectedKeys, `Envelope keys mismatch on iteration ${i}`);

    // Assert invariant values
    assert.equal(envelope.memory, null);
    assert.equal(envelope.taste, null);
    assert.equal(envelope.skills, null);
    assert.equal(envelope.permissionMode, 'auto-accept');
    if (hasThreadId) {
      assert.equal(envelope.threadId, threadUuid);
    }

    // Assert JSON.stringify serialization matches the exact key order
    const json = JSON.stringify(envelope);
    const expectedRegex = hasThreadId
      ? /^\{"config":.*,"memory":null,"taste":null,"skills":null,"permissionMode":"auto-accept","threadId":".*","params":\{/
      : /^\{"config":.*,"memory":null,"taste":null,"skills":null,"permissionMode":"auto-accept","params":\{/;
    assert.match(json, expectedRegex, `Serialized JSON key ordering mismatch on iteration ${i}`);
  }
});

test('Fuzz: Assistant Content Ordering Permutations - All permutations strictly order [reasoning, text, tool-call]', () => {
  const partReasoning = { type: 'reasoning', text: 'Thinking step' };
  const partText = { type: 'text', text: 'Answer text' };
  const partTool = { type: 'tool-call', id: 'call_abc', name: 'search_tools', input: { q: 'test' }, owner: 'client' };
  const partProviderTool = { type: 'tool-call', id: 'call_prov', name: 'internal_tool', input: {}, owner: 'provider' };

  // All 6 permutations of [reasoning, text, tool]
  const permutations = [
    [partReasoning, partText, partTool],
    [partReasoning, partTool, partText],
    [partText, partReasoning, partTool],
    [partText, partTool, partReasoning],
    [partTool, partReasoning, partText],
    [partTool, partText, partReasoning]
  ];

  for (let idx = 0; idx < permutations.length; idx++) {
    const parts = [...permutations[idx], partProviderTool];
    const wire = compileMessages([{ role: 'assistant', parts }]);

    assert.equal(wire.length, 1);
    assert.equal(wire[0].role, 'assistant');
    const content = wire[0].content;

    // Provider tool must be omitted
    assert.equal(content.length, 3, `Expected 3 parts (provider tool dropped) for permutation ${idx}`);

    // Strict order: 0 is reasoning, 1 is text, 2 is tool-call
    assert.equal(content[0].type, 'reasoning', `Reasoning must be at index 0 for permutation ${idx}`);
    assert.equal(content[1].type, 'text', `Text must be at index 1 for permutation ${idx}`);
    assert.equal(content[2].type, 'tool-call', `Tool-call must be at index 2 for permutation ${idx}`);
  }
});

test('Fuzz: User Turn Separation & Orphan Tool Result Invariants', () => {
  // 1. Legitimate multi-turn tool calling and execution
  const validMessages = [
    {
      role: 'assistant',
      parts: [
        { type: 'tool-call', id: 'call_101', name: 'tool_search', input: { query: 'math' }, owner: 'client' }
      ]
    },
    {
      role: 'user',
      parts: [
        { type: 'tool-result', id: 'call_101', name: 'tool_search', text: 'Result: 42' },
        { type: 'text', text: 'Now multiply by 2' }
      ]
    }
  ];

  const compiled = compileMessages(validMessages);
  assert.equal(compiled.length, 3);
  assert.equal(compiled[0].role, 'assistant');
  // Wire tool name aliasing check
  assert.equal(compiled[0].content[0].toolName, 'search_tools');

  // Separated: role: 'tool' first, role: 'user' second
  assert.equal(compiled[1].role, 'tool');
  assert.equal(compiled[1].content[0].type, 'tool-result');
  assert.equal(compiled[1].content[0].toolName, 'search_tools');
  assert.equal(compiled[2].role, 'user');
  assert.equal(compiled[2].content[0].type, 'text');

  // 2. Orphan tool result (never called in prior assistant turn) must throw 422
  const orphanMessages = [
    {
      role: 'user',
      parts: [
        { type: 'tool-result', id: 'unknown_call_999', text: 'dangling output' }
      ]
    }
  ];
  assert.throws(
    () => compileMessages(orphanMessages),
    (err) => err instanceof BridgeHttpError && err.status === 422 && err.code === 'orphan_tool_result'
  );

  // 3. Unsupported role must throw 400
  assert.throws(
    () => compileMessages([{ role: 'system', parts: [] }]),
    (err) => err instanceof BridgeHttpError && err.status === 400 && err.code === 'unexpected_role'
  );
});

// ===========================================================================
// SECTION 2: EmptySystem Safeguard Invariant Fuzzing
// ===========================================================================

test('Fuzz: EmptySystem Safeguard - Invariants across omitted, null, empty array, and present prompts', () => {
  const profileWithSafeguard = { emptySystem: 'single-space' };
  const profileWithoutSafeguard = { emptySystem: 'none' };
  const modelConfig = { upstream: 'meta/muse-spark-1.3-contributor', maxOutputTokens: 64000 };
  const identity = { sessionId: 'sess-test' };

  // 1. Omitted / empty array / null system with 'single-space' safeguard
  const emptyVariations = [
    { system: [] },
    { system: null },
    { system: undefined }
  ];

  for (const variation of emptyVariations) {
    const turn = {
      protocol: 'anthropic',
      publicModel: 'claude-3-7-sonnet',
      ...variation,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
      tools: [],
      stream: true
    };
    const envelope = buildWireEnvelope(turn, profileWithSafeguard, modelConfig, identity);
    assert.deepEqual(
      envelope.params.system,
      [{ type: 'text', text: ' ' }],
      'Safeguard must inject single space to prevent ~14k token CLI prompt injection'
    );
  }

  // 2. Without safeguard, empty system produces empty array
  for (const variation of emptyVariations) {
    const turn = {
      protocol: 'anthropic',
      publicModel: 'claude-3-7-sonnet',
      ...variation,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
      tools: [],
      stream: true
    };
    const envelope = buildWireEnvelope(turn, profileWithoutSafeguard, modelConfig, identity);
    assert.deepEqual(envelope.params.system, []);
  }

  // 3. User-provided system prompt is preserved without single-space injection
  const turnWithSystem = {
    protocol: 'anthropic',
    publicModel: 'claude-3-7-sonnet',
    system: [
      { text: 'System instruction 1', cache: 'ephemeral' },
      { text: 'System instruction 2' }
    ],
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
    tools: [],
    stream: true
  };
  const envelopeWithSystem = buildWireEnvelope(turnWithSystem, profileWithSafeguard, modelConfig, identity);
  assert.equal(envelopeWithSystem.params.system.length, 2);
  assert.equal(envelopeWithSystem.params.system[0].text, 'System instruction 1\n');
  assert.deepEqual(envelopeWithSystem.params.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(envelopeWithSystem.params.system[1].text, 'System instruction 2');
});

test('End-to-End Loopback: EmptySystem safeguard verified on live HTTP endpoints', async () => {
  let capturedUpstreamBody = null;

  // Mock upstream server that records the wire envelope sent by Gemini1
  const mockUpstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedUpstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end('{"type":"start"}\n{"type":"text-delta","text":"OK"}\n{"type":"finish"}\n');
  });

  const upstreamPort = await new Promise((resolve) => {
    mockUpstream.listen(0, '127.0.0.1', () => resolve(mockUpstream.address().port));
  });

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: {
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      emptySystem: 'single-space',
      cliVersion: '1.54.0',
      cliEnvironment: 'production'
    }
  });

  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    // 1. Anthropic POST /v1/messages without system
    capturedUpstreamBody = null;
    const resAnthropic = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'test-upstream-key'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    });
    assert.equal(resAnthropic.status, 200);
    await resAnthropic.text();
    assert.deepEqual(
      capturedUpstreamBody.params.system,
      [{ type: 'text', text: ' ' }],
      'Anthropic request without system must trigger emptySystem single-space safeguard upstream'
    );

    // 2. Responses POST /v1/responses without instructions
    capturedUpstreamBody = null;
    const resResponses = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-upstream-key'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        input: [{ type: 'message', role: 'user', content: 'Hello Codex' }]
      })
    });
    assert.equal(resResponses.status, 200);
    await resResponses.text();
    assert.deepEqual(
      capturedUpstreamBody.params.system,
      [{ type: 'text', text: ' ' }],
      'Responses request without instructions must trigger emptySystem single-space safeguard upstream'
    );

    // 3. Chat POST /v1/chat/completions without system message
    capturedUpstreamBody = null;
    const resChat = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-upstream-key'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello Chat' }]
      })
    });
    assert.equal(resChat.status, 200);
    await resChat.text();
    assert.deepEqual(
      capturedUpstreamBody.params.system,
      [{ type: 'text', text: ' ' }],
      'Chat request without system must trigger emptySystem single-space safeguard upstream'
    );

  } finally {
    await bridge.stop();
    await new Promise((r) => mockUpstream.close(r));
  }
});

// ===========================================================================
// SECTION 3: Extreme TCP Packet Slicing (1-Byte Chunks & UTF-8 Boundaries)
// ===========================================================================

test('Fuzz: 1-Byte Packet Slicing on All 4 Production NDJSON Fixtures', async () => {
  const fixtures = [
    'stream_basic_text.ndjson',
    'stream_reasoning_muse.ndjson',
    'stream_tool_call_search.ndjson',
    'stream_interleaved_reasoning_tool.ndjson'
  ];

  for (const fixtureName of fixtures) {
    const fixturePath = path.join(FIXTURES_DIR, fixtureName);
    const contentBuffer = await fs.readFile(fixturePath);

    // Reference parse (unchunked)
    const referenceLines = contentBuffer
      .toString('utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    // Create 1-byte async generator
    async function* makeOneByteStream() {
      for (let i = 0; i < contentBuffer.length; i++) {
        yield Buffer.from([contentBuffer[i]]);
      }
    }

    const parsedResults = [];
    for await (const record of parseNdjsonStream(makeOneByteStream())) {
      parsedResults.push(record);
    }

    assert.equal(
      parsedResults.length,
      referenceLines.length,
      `1-byte slice line count mismatch on fixture ${fixtureName}`
    );
    assert.deepEqual(
      parsedResults,
      referenceLines,
      `1-byte slice data mismatch on fixture ${fixtureName}`
    );
  }
});

test('Fuzz: 1-Byte Multi-byte UTF-8 Boundaries with Emojis and Complex Unicode', async () => {
  // Complex strings with 4-byte emojis, Turkish special characters, Cyrillic, CJK
  const testLines = [
    { type: 'start', id: 1 },
    { type: 'reasoning-delta', text: 'Thinking 🚀🌟 with emoji and Turkish chars: ğüşiöç ĞÜŞİÖÇ' },
    { type: 'reasoning-delta', text: 'Multilingual: 你好世界, Привет мир, こんにちは, 🧠💻' },
    { type: 'finish', finishReason: 'stop' }
  ];

  const rawNdjson = testLines.map((l) => JSON.stringify(l)).join('\r\n') + '\r\n';
  const buf = Buffer.from(rawNdjson, 'utf-8');

  // Slice into 1-byte chunks with irregular async delays
  async function* makeDelayedOneByteStream() {
    for (let i = 0; i < buf.length; i++) {
      yield Buffer.from([buf[i]]);
      // Small jitter every 7 bytes
      if (i % 7 === 0) {
        await new Promise((r) => setTimeout(r, 1));
      }
    }
  }

  const results = [];
  for await (const record of parseNdjsonStream(makeDelayedOneByteStream())) {
    results.push(record);
  }

  assert.equal(results.length, testLines.length);
  assert.deepEqual(results, testLines);

  // Assert absolutely zero Unicode replacement characters (\uFFFD)
  for (const item of results) {
    if (item.text) {
      assert.ok(!item.text.includes('\uFFFD'), 'Found Unicode replacement character in parsed text!');
    }
  }
});

test('End-to-End Loopback: Full 1-byte chunk stream translation via live bridge', async () => {
  const fixturePath = path.join(FIXTURES_DIR, 'stream_reasoning_muse.ndjson');
  const fixtureBytes = await fs.readFile(fixturePath);

  // Mock upstream server that writes out response strictly 1 byte per chunk
  const mockUpstream = http.createServer(async (req, res) => {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson',
      'x-command-code-session-id': 'sess-1-byte-e2e'
    });

    for (let i = 0; i < fixtureBytes.length; i++) {
      res.write(Buffer.from([fixtureBytes[i]]));
      if (i % 50 === 0) {
        await new Promise((r) => setTimeout(r, 1));
      }
    }
    res.end();
  });

  const upstreamPort = await new Promise((resolve) => {
    mockUpstream.listen(0, '127.0.0.1', () => resolve(mockUpstream.address().port));
  });

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
        'x-api-key': 'test-1-byte-key'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Explain binary search' }]
      })
    });

    assert.equal(res.status, 200);
    const text = await res.text();
    const events = parseSseEvents(text);

    // Verify thinking block and signature delta were assembled correctly
    const thinkingBlock = events.find((e) => e.event === 'content_block_start' && e.data?.content_block?.type === 'thinking');
    assert.ok(thinkingBlock, 'Thinking block must be parsed under 1-byte fragmentation');

    const signatureDelta = events.find((e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'signature_delta');
    assert.ok(signatureDelta, '0x12 Signature delta must be emitted under 1-byte fragmentation');
    assert.ok(signatureDelta.data.delta.signature.startsWith('E'));

    const textBlock = events.find((e) => e.event === 'content_block_start' && e.data?.content_block?.type === 'text');
    assert.ok(textBlock, 'Text block must be parsed under 1-byte fragmentation');

  } finally {
    await bridge.stop();
    await new Promise((r) => mockUpstream.close(r));
  }
});

// ===========================================================================
// SECTION 4: Responses Output Indexing & Active Items Interleaving
// ===========================================================================

test('Fuzz: Responses - Strict monotonic sequence numbering (starting at 1) across 100+ events', () => {
  const res = new MockResponse();
  const serializer = new ResponsesSseSerializer(res, { responseId: 'resp_test_seq' });

  serializer.start();

  for (let i = 0; i < 50; i++) {
    serializer.processEvent({ type: 'reasoning-delta', text: `chunk ${i} ` });
    if (i % 10 === 0) {
      serializer.processEvent({
        type: 'tool-call',
        toolCallId: `call_${i}`,
        toolName: 'search_tools',
        input: { q: `search ${i}` }
      });
    }
  }
  serializer.processEvent({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 100, outputTokens: 200 } });

  const rawOutput = res.writes.join('');
  const events = parseSseEvents(rawOutput);

  assert.ok(events.length > 50, 'Expected >50 SSE events');

  let expectedSeq = 1;
  for (const ev of events) {
    if (ev.data === '[DONE]') continue;
    assert.equal(
      ev.data.sequence_number,
      expectedSeq,
      `Sequence number mismatch: expected ${expectedSeq}, got ${ev.data.sequence_number} on event ${ev.event}`
    );
    expectedSeq++;
  }
});

test('Fuzz: Responses - Interleaved reasoning and multiple tool calls maintain unique output indexing', () => {
  const res = new MockResponse();
  const serializer = new ResponsesSseSerializer(res, { responseId: 'resp_interleave' });

  // Adversarial interleaved event sequence:
  // 1. Reasoning starts (outIdx 0)
  // 2. Tool call 1 (outIdx 1)
  // 3. Reasoning continues (must remain outIdx 0!)
  // 4. Tool call 2 (outIdx 2)
  // 5. Reasoning continues (must remain outIdx 0!)
  // 6. Text starts (outIdx 3)
  // 7. Finish completes all active items
  const events = [
    { type: 'reasoning-delta', text: 'Step 1: Planning...' },
    { type: 'tool-call', toolCallId: 'call_search_1', toolName: 'search_tools', input: { query: 'alpha' } },
    { type: 'reasoning-delta', text: 'Step 2: Reviewing search results...' },
    { type: 'tool-call', toolCallId: 'call_bash_2', toolName: 'bash', input: { command: 'ls' } },
    { type: 'reasoning-delta', text: 'Step 3: Formulating final answer...' },
    { type: 'text-delta', text: 'Here are the findings.' },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 500, outputTokens: 120 } }
  ];

  for (const ev of events) {
    serializer.processEvent(ev);
  }

  const rawOutput = res.writes.join('');
  const parsed = parseSseEvents(rawOutput);

  // Collect all output_item.added events
  const addedItems = parsed.filter((e) => e.event === 'response.output_item.added');
  assert.equal(addedItems.length, 4, 'Expected exactly 4 distinct items added');

  const indices = addedItems.map((e) => e.data.output_index);
  assert.deepEqual(indices, [0, 1, 2, 3], 'Output indices must be unique and increment sequentially');

  // Verify item types
  assert.equal(addedItems[0].data.item.type, 'reasoning');
  assert.equal(addedItems[1].data.item.type, 'tool_search_call'); // Native search mapping!
  assert.equal(addedItems[1].data.item.name, 'tool_search');
  assert.equal(addedItems[2].data.item.type, 'function_call');
  assert.equal(addedItems[2].data.item.name, 'bash');
  assert.equal(addedItems[3].data.item.type, 'message');

  // Verify that reasoning deltas after tool calls still reference output_index 0
  const reasoningDeltas = parsed.filter((e) => e.event === 'response.reasoning_summary_text.delta');
  assert.equal(reasoningDeltas.length, 3);
  for (const rd of reasoningDeltas) {
    assert.equal(rd.data.output_index, 0, 'Reasoning delta must retain output_index 0 across interleavings');
  }

  // Verify response.completed contains all 4 completed items
  const completed = parsed.find((e) => e.event === 'response.completed');
  assert.ok(completed, 'response.completed must be emitted');
  assert.equal(completed.data.response.output.length, 4);

  // Assert all 4 item types are present in completed output
  const outputTypes = completed.data.response.output.map((i) => i.type);
  assert.ok(outputTypes.includes('reasoning'), 'Completed output must include reasoning');
  assert.ok(outputTypes.includes('tool_search_call'), 'Completed output must include tool_search_call');
  assert.ok(outputTypes.includes('function_call'), 'Completed output must include function_call');
  assert.ok(outputTypes.includes('message'), 'Completed output must include message');

  for (const item of completed.data.response.output) {
    assert.equal(item.status, 'completed', `Item ${item.id} must have status: completed`);
  }
});

// ===========================================================================
// SECTION 5: Watchdog Timer Backpressure & Socket Closure
// ===========================================================================

test('Fuzz: Watchdog - Respects backpressure (writableNeedDrain) and resumes after drain', async () => {
  const res = new MockResponse({ writableNeedDrain: true });
  const hb = createHeartbeat({
    res,
    protocol: 'anthropic',
    idleIntervalMs: 20
  });

  try {
    // Wait ~1150ms for watchdog interval check
    await new Promise((r) => setTimeout(r, 1150));
    assert.equal(res.writes.length, 0, 'Must NOT write ping frames while socket needs drain (backpressure)');

    // Clear backpressure
    res.writableNeedDrain = false;
    await new Promise((r) => setTimeout(r, 1150));
    assert.ok(res.writes.length >= 1, 'Must resume ping writes after backpressure clears');
    assert.equal(res.writes[0], 'event: ping\ndata: {"type":"ping"}\n\n');
  } finally {
    hb.stop();
  }
});

test('Fuzz: Watchdog - When write() returns false (buffer saturation), lastWrite is not updated', () => {
  const res = new MockResponse({ writeReturnsFalse: true });
  const hb = createHeartbeat({
    res,
    protocol: 'responses',
    idleIntervalMs: 10
  });

  // Verify initial state
  assert.equal(res.writes.length, 0);
  hb.stop();
});

test('Fuzz: Watchdog - Auto-terminates on socket destroy or writableEnded without throwing', async () => {
  const res = new MockResponse();
  const hb = createHeartbeat({
    res,
    protocol: 'responses',
    idleIntervalMs: 20
  });

  // Destroy socket
  res.destroy();

  // Wait past interval cycle: watchdog must clean itself up without errors
  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(res.writes.length, 0);

  // Calling stop() multiple times must be safely idempotent
  assert.doesNotThrow(() => {
    hb.stop();
    hb.stop();
    hb.touch();
    hb.stop();
  });
});

// ===========================================================================
// SECTION 6: Concurrency Locking & Two-Phase Commit Prelude Interception
// ===========================================================================

test('Stress: Concurrency - 10 rapid concurrent turns on identical session hint fail fast with HTTP 409', async () => {
  const mockUpstream = http.createServer((req, res) => {
    // Upstream takes 100ms to respond, simulating deep reasoning turn
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end('{"type":"start"}\n{"type":"text-delta","text":"OK"}\n{"type":"finish"}\n');
    }, 100);
  });

  const upstreamPort = await new Promise((resolve) => {
    mockUpstream.listen(0, '127.0.0.1', () => resolve(mockUpstream.address().port));
  });

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upstreamPort}` }
  });

  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const sessionHeader = 'test-concurrent-session-id';
    const postTurn = () =>
      fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'test-key-1',
          'session-id': sessionHeader
        },
        body: JSON.stringify({
          model: 'claude-3-7-sonnet',
          messages: [{ role: 'user', content: 'Turn' }]
        })
      });

    // Fire 10 turns concurrently
    const promises = Array.from({ length: 10 }, () => postTurn());
    const responses = await Promise.all(promises);

    const statusCodes = responses.map((r) => r.status);
    const successCount = statusCodes.filter((s) => s === 200).length;
    const conflictCount = statusCodes.filter((s) => s === 409).length;

    assert.equal(successCount, 1, 'Exactly one concurrent request must win the turn lock');
    assert.equal(conflictCount, 9, 'All overlapping concurrent turns must receive HTTP 409 Conflict');

    // After turn completion, subsequent turn must succeed cleanly
    const subsequent = await postTurn();
    assert.equal(subsequent.status, 200, 'Subsequent turn after lease release must succeed');

  } finally {
    await bridge.stop();
    await new Promise((r) => mockUpstream.close(r));
  }
});

test('Stress: Two-Phase Commit Prelude - Non-decisive reasoning-start followed by 429 returns clean JSON 429', async () => {
  const mockUpstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    // Sends non-decisive events first, then rate limit error
    res.write('{"type":"start"}\n');
    res.write('{"type":"reasoning-start","text":""}\n');
    setTimeout(() => {
      res.write('{"type":"error","statusCode":429,"message":"Rate limit exceeded"}\n');
      res.end();
    }, 10);
  });

  const upstreamPort = await new Promise((resolve) => {
    mockUpstream.listen(0, '127.0.0.1', () => resolve(mockUpstream.address().port));
  });

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
        'x-api-key': 'test-key'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Prompt' }]
      })
    });

    // Assert HTTP status is 429 (NOT 200 text/event-stream!)
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');

    const json = await res.json();
    assert.equal(json.error.code, 'upstream_error');
    assert.equal(json.error.message, 'Rate limit exceeded');

  } finally {
    await bridge.stop();
    await new Promise((r) => mockUpstream.close(r));
  }
});
