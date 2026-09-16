/**
 * @file tier5_adversarial.mjs
 * @description Tier 5 Adversarial Coverage Hardening & Empirical Verification Harness.
 * 
 * Verifies and proves failure modes, edge cases, and robustness invariants:
 * 1. Session Hint Extraction Bug (body.metadata.session_id and prompt_cache_key)
 * 2. Mid-stream Upstream Error Dropped (silent stream termination)
 * 3. Token Preflight Estimation Crash (TypeError on content: [null] and ignored system array)
 * 4. Chat Serializer Tool Name Unaliasing (search_tools -> tool_search missing)
 * 5. Responses API Completed Items Order (response.output array out of sync with output_index)
 * 6. Concurrency Stampede with Proper Headers (50 concurrent requests)
 * 7. Thinking Signature Invariants (0x12 / 0x20 bitwise payload)
 * 8. NDJSON Incremental Slicing (1-byte chunk multi-byte UTF-8 stress)
 */

import http from 'node:http';
import assert from 'node:assert/strict';
import { createBridgeServer } from '../src/server.mjs';
import { makeThinkingSignature } from '../src/egress/anthropic.mjs';
import { ResponsesSseSerializer } from '../src/egress/responses.mjs';
import { ChatSseSerializer } from '../src/egress/chat.mjs';
import { estimateAnthropicTokens } from '../src/ingress/anthropic.mjs';
import { parseNdjsonStream } from '../src/transport/ndjson.mjs';

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

const testResults = [];

async function runTest(name, fn) {
  console.log(`--- Running: ${name} ---`);
  try {
    const detail = await fn();
    testResults.push({ name, passed: true, detail });
    console.log(`✔ [PASS] ${name}: ${detail}\n`);
  } catch (err) {
    testResults.push({ name, passed: false, error: err.message });
    console.log(`✘ [DISCOVERY/BUG] ${name}:\n  ${err.message}\n`);
  }
}

async function main() {
  console.log('=== Starting Tier 5 Adversarial Empirical Verification Suite ===\n');

  // =========================================================================
  // Test 1: Session Hint Extraction via body.metadata.session_id
  // =========================================================================
  await runTest('Finding 1.1: Session Hint from body.metadata.session_id', async () => {
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
      // Turn 1
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

      await new Promise((r) => setTimeout(r, 80));

      // Turn 2 with identical metadata.session_id
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

      // Wait a short time to let Turn 2 hit bridge
      await new Promise((r) => setTimeout(r, 80));

      // Now release upstream so requests can complete
      releaseUpstream();
      const [res1, res2] = await Promise.all([turn1Promise, res2Promise]);

      console.log(`  Turn 1 HTTP status: ${res1.status}, Turn 2 HTTP status: ${res2.status}`);
      console.log(`  Max concurrent requests hitting upstream: ${maxConcurrentUpstream}`);

      if (res2.status !== 409 || maxConcurrentUpstream > 1) {
        throw new Error(
          `VULNERABILITY CONFIRMED: Session lock bypassed! Turn 2 got HTTP ${res2.status} (expected 409). ` +
          `${maxConcurrentUpstream} concurrent requests reached upstream because server.mjs passes 'turn' ` +
          `(CanonicalTurn) to sessionManager.acquire instead of raw request body, discarding body.metadata!`
        );
      }
      return 'Session lock respected via body.metadata.session_id';
    } finally {
      releaseUpstream?.();
      await bridge.stop();
      await mockUpstream.stop();
    }
  });

  // =========================================================================
  // Test 2: Responses API Session Hint via prompt_cache_key
  // =========================================================================
  await runTest('Finding 1.2: Session Hint from body.prompt_cache_key', async () => {
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

      await new Promise((r) => setTimeout(r, 80));

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

      await new Promise((r) => setTimeout(r, 80));

      releaseUpstream();
      const [res1, res2] = await Promise.all([turn1Promise, res2Promise]);

      console.log(`  Turn 1 HTTP status: ${res1.status}, Turn 2 HTTP status: ${res2.status}`);
      console.log(`  Max concurrent requests hitting upstream: ${maxConcurrentUpstream}`);

      if (res2.status !== 409 || maxConcurrentUpstream > 1) {
        throw new Error(
          `VULNERABILITY CONFIRMED: Responses session lock bypassed! Turn 2 got HTTP ${res2.status} (expected 409). ` +
          `Turn discarded prompt_cache_key!`
        );
      }
      return 'Session lock respected via body.prompt_cache_key';
    } finally {
      releaseUpstream?.();
      await bridge.stop();
      await mockUpstream.stop();
    }
  });

  // =========================================================================
  // Test 3: Upstream Mid-Stream Error Event After HTTP 200 Commitment
  // =========================================================================
  await runTest('Finding 2: Mid-stream upstream error handling after HTTP 200 committed', async () => {
    const mockUpstream = createMockUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      // Decisive event commits 200
      res.write('{"type":"text-delta","text":"hello initial"}\n');
      // Upstream crash mid-stream!
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

      assert.equal(res.status, 200);
      const text = await res.text();
      console.log('  Emitted stream body:\n' + text.trim());

      const hasErrorEvent = text.includes('event: error') || text.includes('Upstream internal explosion');
      if (!hasErrorEvent) {
        throw new Error(
          `SPECIFICATION FLAW CONFIRMED: Stream terminated cleanly without notifying client of mid-stream error! ` +
          `serializer.processEvent ignores nativeEvent.type === 'error', and no error is thrown in server.mjs loop.`
        );
      }
      return 'Client was notified of mid-stream error';
    } finally {
      await bridge.stop();
      await mockUpstream.stop();
    }
  });

  // =========================================================================
  // Test 4: Token Preflight Estimation under Adversarial Input
  // =========================================================================
  await runTest('Finding 3: estimateAnthropicTokens robustness with null block & system array', async () => {
    // 1. Array of system blocks
    const est1 = estimateAnthropicTokens({
      system: [
        { type: 'text', text: 'You are an adversarial tester.' },
        { type: 'text', text: 'Secondary system instruction.' }
      ],
      messages: [{ role: 'user', content: 'test' }]
    });
    console.log(`  estimateAnthropicTokens with system array returned: ${est1} tokens`);
    // 'test' is 4 chars -> 2 tokens. System is 59 chars -> ~16 tokens.
    if (est1 <= 2) {
      console.log(`  Note: estimateAnthropicTokens completely ignores system array! (counted ${est1} tokens)`);
    }

    // 2. Malformed null block in content array
    try {
      estimateAnthropicTokens({
        messages: [{ role: 'user', content: [null] }]
      });
      return 'Handled null content block without crash';
    } catch (err) {
      throw new Error(`UNHANDLED EXCEPTION CONFIRMED: estimateAnthropicTokens crashed on content: [null] with: ${err.message}`);
    }
  });

  // =========================================================================
  // Test 5: Chat Serializer Tool Name Unaliasing (search_tools -> tool_search)
  // =========================================================================
  await runTest('Finding 4: ChatSseSerializer tool name unaliasing', async () => {
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

    const toolCallChunk = writtenChunks.find(c => c.includes('tool_calls'));
    assert.ok(toolCallChunk, 'Expected tool_calls chunk');
    
    const parsed = JSON.parse(toolCallChunk.replace(/^data: /, '').trim());
    const funcName = parsed.choices[0].delta.tool_calls[0].function.name;

    console.log(`  ChatSseSerializer emitted function name: "${funcName}"`);
    if (funcName !== 'tool_search') {
      throw new Error(`INVARIANT VIOLATION CONFIRMED: ChatSseSerializer emitted wire name "${funcName}" instead of client name "tool_search"!`);
    }
    return 'ChatSseSerializer correctly unaliased search_tools -> tool_search';
  });

  // =========================================================================
  // Test 6: Responses API Output Items Ordering in response.completed
  // =========================================================================
  await runTest('Finding 5: ResponsesSseSerializer output array indexing order in response.completed', async () => {
    const writtenChunks = [];
    const mockRes = {
      writeHead() {},
      write(chunk) { writtenChunks.push(chunk); return true; },
      end() {}
    };

    const serializer = new ResponsesSseSerializer(mockRes, { model: 'gpt-4o' });
    serializer.start();

    // 1. Reasoning begins at output_index: 0
    serializer.processEvent({ type: 'reasoning-delta', text: 'Thinking step 1...' });

    // 2. Interleaved tool-call arrives at output_index: 1 and finishes
    serializer.processEvent({
      type: 'tool-call',
      toolCallId: 'call_bash_1',
      toolName: 'bash',
      input: { command: 'ls' }
    });

    // 3. Reasoning continues
    serializer.processEvent({ type: 'reasoning-delta', text: 'Thinking step 2...' });

    // 4. Finish closes reasoning
    serializer.processEvent({
      type: 'finish',
      finishReason: 'tool-calls',
      totalUsage: { inputTokens: 100, outputTokens: 20 }
    });

    const completedChunk = writtenChunks.find(c => c.includes('response.completed'));
    assert.ok(completedChunk, 'Expected response.completed frame');
    
    const lines = completedChunk.split('\n');
    const dataLine = lines.find(l => l.startsWith('data: '));
    const eventObj = JSON.parse(dataLine.slice(6));
    const outputArray = eventObj.response.output;

    console.log('  response.output item array order:', outputArray.map((o, idx) => `[${idx}] ${o.type} (${o.id})`));

    // In OpenAI Responses API, output item with output_index: 0 must be at output[0]
    if (outputArray[0].type !== 'reasoning' || outputArray[1].type !== 'function_call') {
      throw new Error(
        `ORDERING MISMATCH CONFIRMED: response.output has inverted elements! output[0]=${outputArray[0].type}, output[1]=${outputArray[1].type}. ` +
        `Items are pushed to completedItems in completion order rather than output_index order.`
      );
    }
    return 'response.output array order strictly matches output_index';
  });

  // =========================================================================
  // Test 7: Concurrency Stampede - 50 parallel requests
  // =========================================================================
  await runTest('Adversarial 7: High concurrency stampede (50 concurrent requests with headers)', async () => {
    let releaseUpstream;
    const gate = new Promise((resolve) => { releaseUpstream = resolve; });

    const mockUpstream = createMockUpstream(async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"type":"start"}\n');
      await gate;
      res.write('{"type":"text-delta","text":"ok"}\n{"type":"finish"}\n');
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
      const promises = [];
      const sessionA = 'stampede_sess_A';
      const sessionB = 'stampede_sess_B';

      for (let i = 0; i < 50; i++) {
        const sessId = i < 25 ? sessionA : sessionB;
        promises.push(
          fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'authorization': 'Bearer test_key_stampede',
              'x-claude-code-session-id': sessId
            },
            body: JSON.stringify({
              model: 'claude-3-7-sonnet',
              messages: [{ role: 'user', content: `Stampede ${i}` }]
            })
          })
        );
      }

      await new Promise((r) => setTimeout(r, 120));
      releaseUpstream();

      const responses = await Promise.all(promises);
      const statusesA = [];
      const statusesB = [];

      for (let i = 0; i < 50; i++) {
        if (i < 25) statusesA.push(responses[i].status);
        else statusesB.push(responses[i].status);
      }

      const passA = statusesA.filter(s => s === 200).length;
      const conflictA = statusesA.filter(s => s === 409).length;
      const passB = statusesB.filter(s => s === 200).length;
      const conflictB = statusesB.filter(s => s === 409).length;

      console.log(`  Session A: ${passA} succeeded (200), ${conflictA} rejected (409)`);
      console.log(`  Session B: ${passB} succeeded (200), ${conflictB} rejected (409)`);

      assert.equal(passA, 1, 'Exactly 1 request should succeed for Session A');
      assert.equal(conflictA, 24, '24 requests should be rejected with 409 for Session A');
      assert.equal(passB, 1, 'Exactly 1 request should succeed for Session B');
      assert.equal(conflictB, 24, '24 requests should be rejected with 409 for Session B');

      return 'Concurrency stampede handled with 100% precision: 2 succeeded, 48 cleanly rejected (409)';
    } finally {
      releaseUpstream?.();
      await bridge.stop();
      await mockUpstream.stop();
    }
  });

  // =========================================================================
  // Test 8: Thinking Signature Bitwise & Unicode Invariants
  // =========================================================================
  await runTest('Adversarial 8: Thinking signature bitwise and Unicode invariants', async () => {
    const testCases = [
      '',
      'short',
      'Thinking with Unicode: 🚀 語 🌟 and null byte \0 in reasoning',
      'A'.repeat(500000)
    ];

    for (const text of testCases) {
      const sig = makeThinkingSignature(text);
      assert.ok(typeof sig === 'string', 'Signature must be string');
      assert.ok(sig.startsWith('E'), 'Signature must start with Base64 character E');

      const raw = Buffer.from(sig, 'base64');
      assert.equal(raw[0], 0x12, 'Byte 0 must be 0x12');
      assert.equal(raw[1], 0x20, 'Byte 1 must be 0x20 (32-byte sha256 hash length)');
      assert.equal(raw.length, 34, 'Total signature payload must be exactly 34 bytes');
    }

    return 'Thinking signature maintains 0x12/0x20 34-byte contract across all inputs';
  });

  // =========================================================================
  // Test 9: NDJSON Multi-byte UTF-8 Slicing & Boundary Stress
  // =========================================================================
  await runTest('Adversarial 9: NDJSON 1-byte chunk fragmentation with 4-byte UTF-8 emojis', async () => {
    const jsonStr = '{"type":"text-delta","text":"Unicode 🦄 語 and mixed CRLF"}\r\n{"type":"finish"}\n';
    const utf8Bytes = Buffer.from(jsonStr, 'utf-8');

    async function* byteByByte() {
      for (let i = 0; i < utf8Bytes.length; i++) {
        yield Buffer.from([utf8Bytes[i]]);
      }
    }

    const events = [];
    for await (const ev of parseNdjsonStream(byteByByte())) {
      events.push(ev);
    }

    assert.equal(events.length, 2);
    assert.equal(events[0].text, 'Unicode 🦄 語 and mixed CRLF');
    assert.equal(events[1].type, 'finish');

    return '1-byte chunk fragmentation parsed without UTF-8 corruption';
  });

  console.log('\n=============================================================');
  console.log('                 TIER 5 VERIFICATION REPORT                  ');
  console.log('=============================================================');
  let passCount = 0;
  let failCount = 0;
  for (const r of testResults) {
    if (r.passed) {
      passCount++;
      console.log(`[PASS] ${r.name}`);
    } else {
      failCount++;
      console.log(`[DISCOVERY] ${r.name}`);
    }
  }
  console.log(`\nResults: ${testResults.length} total | ${passCount} passed | ${failCount} findings`);
}

main().catch(err => {
  console.error('Fatal harness error:', err);
  process.exit(1);
});
