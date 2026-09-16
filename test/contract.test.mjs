/**
 * @file contract.test.mjs
 * @description Foundational Contract & Architecture Verification Test Suite for Gemini1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager } from '../src/session.mjs';
import { buildWireEnvelope, buildWireHeaders, compileMessages, toWireToolName, fromWireToolName } from '../src/commandcode/wire.mjs';
import { decodeAnthropicRequest, estimateAnthropicTokens } from '../src/ingress/anthropic.mjs';
import { decodeResponsesRequest } from '../src/ingress/responses.mjs';
import { decodeChatRequest } from '../src/ingress/chat.mjs';
import { parseNdjsonStream } from '../src/transport/ndjson.mjs';
import { PreludeBuffer } from '../src/transport/prelude.mjs';
import { makeThinkingSignature, normalizeUsageForAnthropic } from '../src/egress/anthropic.mjs';
import { createBridgeServer } from '../src/server.mjs';
import http from 'node:http';

test('1. Wire Headers & Envelope Contract', () => {
  const profile = {
    cliVersion: '1.54.0',
    cliEnvironment: 'production',
    projectSlug: 'test-slug',
    tasteLearning: true,
    emptySystem: 'single-space',
    permissionMode: 'auto-accept'
  };
  const identity = {
    sessionId: 'sess_12345',
    threadId: '11111111-2222-4333-8444-555555555555'
  };

  const headers = buildWireHeaders(profile, identity, 'test_key');
  assert.equal(headers['user-agent'], 'cli');
  assert.equal(headers['x-command-code-version'], '1.54.0');
  assert.equal(headers['x-cli-environment'], 'production');
  assert.equal(headers['x-project-slug'], 'test-slug');
  assert.equal(headers['x-taste-learning'], 'true');
  assert.equal(headers['x-session-id'], 'sess_12345');
  assert.equal(headers['authorization'], 'Bearer test_key');

  const turn = {
    protocol: 'anthropic',
    publicModel: 'claude-3-7-sonnet',
    system: [],
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'Hello' }] }
    ],
    tools: [
      { name: 'tool_search', description: 'Search', inputSchema: {} }
    ],
    stream: true
  };

  const envelope = buildWireEnvelope(turn, profile, { upstream: 'meta/muse-spark-1.3-contributor', maxOutputTokens: 64000 }, identity);
  assert.equal(envelope.memory, null);
  assert.equal(envelope.taste, null);
  assert.equal(envelope.skills, null);
  assert.equal(envelope.permissionMode, 'auto-accept');
  assert.equal(envelope.threadId, '11111111-2222-4333-8444-555555555555');
  assert.equal(envelope.params.model, 'meta/muse-spark-1.3-contributor');
  assert.equal(envelope.params.max_tokens, 64000);
  
  // Empty system safeguard verification:
  assert.deepEqual(envelope.params.system, [{ type: 'text', text: ' ' }]);
  
  // Tool name aliasing verification:
  assert.equal(envelope.params.tools[0].name, 'search_tools');
});

test('2. Multi-turn Assistant Strict Ordering & Tool Result Separation', () => {
  const messages = [
    {
      role: 'assistant',
      parts: [
        { type: 'tool-call', id: 'call_1', name: 'read_file', input: { path: 'a.txt' }, owner: 'client' },
        { type: 'text', text: 'Reading file...' },
        { type: 'reasoning', text: 'I need to check a.txt' }
      ]
    },
    {
      role: 'user',
      parts: [
        { type: 'tool-result', id: 'call_1', name: 'read_file', text: 'file content' },
        { type: 'text', text: 'Please proceed' }
      ]
    }
  ];

  const wire = compileMessages(messages);
  
  // Assistant order must be strictly: [reasoning, text, tool-call]
  assert.equal(wire[0].role, 'assistant');
  assert.equal(wire[0].content[0].type, 'reasoning');
  assert.equal(wire[0].content[1].type, 'text');
  assert.equal(wire[0].content[2].type, 'tool-call');

  // User turn must separate tool-result into role: 'tool' prior to role: 'user'
  assert.equal(wire[1].role, 'tool');
  assert.equal(wire[1].content[0].type, 'tool-result');
  assert.equal(wire[1].content[0].toolCallId, 'call_1');
  assert.equal(wire[1].content[0].toolName, 'read_file');

  assert.equal(wire[2].role, 'user');
  assert.equal(wire[2].content[0].type, 'text');
});

test('3. Session Manager Concurrency Locking & Isolation', () => {
  const sm = createSessionManager();
  const lease1 = sm.acquire({
    protocol: 'anthropic',
    accountId: 'acc_1',
    headers: { 'x-claude-code-session-id': 'sess_a' }
  });
  assert.ok(lease1.sessionId);

  // Same conversation concurrent turn must throw 409
  assert.throws(() => {
    sm.acquire({
      protocol: 'anthropic',
      accountId: 'acc_1',
      headers: { 'x-claude-code-session-id': 'sess_a' }
    });
  }, (err) => err.status === 409);

  // Release lock
  lease1.release();

  // After release, acquiring again succeeds with the same session ID
  const lease2 = sm.acquire({
    protocol: 'anthropic',
    accountId: 'acc_1',
    headers: { 'x-claude-code-session-id': 'sess_a' }
  });
  assert.equal(lease2.sessionId, lease1.sessionId);
  lease2.release();
});

test('4. Ingress Decoders Fidelity', () => {
  // Anthropic Decoder
  const anthropicTurn = decodeAnthropicRequest({
    model: 'claude-3-7-sonnet',
    messages: [{ role: 'user', content: 'Test' }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' }
  });
  assert.equal(anthropicTurn.protocol, 'anthropic');
  assert.equal(anthropicTurn.reasoningEffort, 'high');
  assert.equal(anthropicTurn.requestedThinking, true);

  // Token estimate
  const est = estimateAnthropicTokens({ messages: [{ role: 'user', content: '12345678' }] });
  assert.ok(est >= 2);

  // Responses Decoder
  const responsesTurn = decodeResponsesRequest({
    model: 'gpt-4o',
    instructions: 'You are an agent',
    input: [
      { type: 'message', role: 'user', content: 'Run command' },
      { type: 'function_call', call_id: 'call_cmd', name: 'bash', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call_cmd', output: 'ok' }
    ],
    tools: [
      { type: 'function', name: 'bash', parameters: {} }
    ]
  });
  assert.equal(responsesTurn.protocol, 'responses');
  assert.equal(responsesTurn.system[0].text, 'You are an agent');
  assert.equal(responsesTurn.messages.length, 3);
  assert.equal(responsesTurn.messages[1].parts[0].type, 'tool-call');
  assert.equal(responsesTurn.messages[2].parts[0].type, 'tool-result');
});

test('5. Incremental NDJSON Parser with Split Chunks', async () => {
  async function* makeChunks() {
    yield Buffer.from('{"type":"st');
    yield Buffer.from('art"}\r\n{"type":"text-delta","text":"he');
    yield Buffer.from('llo"}\n{"type":"finish"}\n');
  }

  const events = [];
  for await (const ev of parseNdjsonStream(makeChunks())) {
    events.push(ev);
  }
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'start');
  assert.equal(events[1].type, 'text-delta');
  assert.equal(events[1].text, 'hello');
  assert.equal(events[2].type, 'finish');
});

test('6. Two-Phase Commit Prelude Error Interception', () => {
  const prelude = new PreludeBuffer();
  
  // Non-decisive event: empty reasoning-start
  const commit1 = prelude.ingest({ type: 'reasoning-start', text: '' });
  assert.equal(commit1, false);
  assert.equal(prelude.committed, false);

  // Upfront error arrives -> throws BridgeHttpError before HTTP 200 commitment!
  assert.throws(() => {
    prelude.ingest({ type: 'error', statusCode: 429, message: 'Rate limit exceeded' });
  }, (err) => err.status === 429);
});

test('7. Egress Serialization Invariants', () => {
  // 0x12 thinking signature starts with 'E' in base64
  const sig = makeThinkingSignature('test reasoning');
  assert.ok(sig.startsWith('E'));
  const rawBytes = Buffer.from(sig, 'base64');
  assert.equal(rawBytes[0], 0x12);

  // Token count normalization
  const usage = normalizeUsageForAnthropic({
    inputTokens: 1000,
    inputTokenDetails: { cacheReadTokens: 900, noCacheTokens: 100, cacheWriteTokens: 0 },
    outputTokens: 50
  });
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.cache_read_input_tokens, 900);
  assert.equal(usage.output_tokens, 50);
});

test('8. Server Loopback & Health Check', async () => {
  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 19874 }
  });
  await bridge.start();

  try {
    const res = await fetch('http://127.0.0.1:19874/health');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.engine, 'gemini1-commandcode-bridge');

    const modelsRes = await fetch('http://127.0.0.1:19874/v1/models');
    assert.equal(modelsRes.status, 200);
    const modelsData = await modelsRes.json();
    assert.equal(modelsData.object, 'list');
  } finally {
    await bridge.stop();
  }
});
