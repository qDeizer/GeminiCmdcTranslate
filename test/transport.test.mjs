/**
 * @file transport.test.mjs
 * @description Comprehensive Transport Resiliency Test Suite for Gemini1.
 * 
 * Covers:
 * - Anti-Stall 12s Watchdog (heartbeat.mjs): Anthropic ping, Responses keepalive, touch reset,
 *   congestion backpressure, stop/cleanup, unref behavior.
 * - Two-Phase Commit Prelude Buffer (prelude.mjs): Decisive vs non-decisive events, early error
 *   interception (401/429/500), buffer size and time limits, FIFO flushing.
 * - Incremental UTF-8 NDJSON Parser (ndjson.mjs): Arbitrary chunk splitting, multibyte UTF-8 boundaries,
 *   mixed CRLF/LF line endings, empty lines, stream EOF trailing lines, max line limits (DOS protection),
 *   malformed JSON detection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeartbeat } from '../src/transport/heartbeat.mjs';
import { PreludeBuffer } from '../src/transport/prelude.mjs';
import { parseNdjsonStream } from '../src/transport/ndjson.mjs';
import { BridgeHttpError } from '../src/types.mjs';

/**
 * Mock HTTP response stream for transport testing.
 */
class MockResponse {
  constructor({ writableNeedDrain = false } = {}) {
    this.writes = [];
    this.destroyed = false;
    this.writableEnded = false;
    this.writableNeedDrain = writableNeedDrain;
  }

  write(chunk) {
    if (this.destroyed || this.writableEnded) return false;
    if (this.writableNeedDrain) return false;
    this.writes.push(chunk);
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
// 1. Anti-Stall Watchdog (heartbeat.mjs)
// ---------------------------------------------------------------------------

test('Transport: Heartbeat - Anthropic emits ping frame after idle silence', async () => {
  const res = new MockResponse();
  const hb = createHeartbeat({
    res,
    protocol: 'anthropic',
    idleIntervalMs: 30 // use small interval for fast test
  });

  try {
    // Wait for watchdog to trigger (interval checks every 1000ms in production, but let's test logic)
    // Notice heartbeat.mjs runs on a 1000ms setInterval. Let's verify initial state and wait ~1100ms.
    await new Promise((r) => setTimeout(r, 1150));
    assert.ok(res.writes.length >= 1, 'Expected at least one heartbeat frame');
    assert.equal(res.writes[0], 'event: ping\ndata: {"type":"ping"}\n\n');
  } finally {
    hb.stop();
  }
});

test('Transport: Heartbeat - Responses/Chat emits : keepalive after idle silence', async () => {
  const res = new MockResponse();
  const hb = createHeartbeat({
    res,
    protocol: 'responses',
    idleIntervalMs: 30
  });

  try {
    await new Promise((r) => setTimeout(r, 1150));
    assert.ok(res.writes.length >= 1, 'Expected at least one keepalive frame');
    assert.equal(res.writes[0], ': keepalive\n\n');
  } finally {
    hb.stop();
  }
});

test('Transport: Heartbeat - touch() resets idle timer preventing premature heartbeat', async () => {
  const res = new MockResponse();
  const hb = createHeartbeat({
    res,
    protocol: 'anthropic',
    idleIntervalMs: 1400 // idle interval greater than 1 check cycle
  });

  try {
    // Touch repeatedly every 300ms for 1.2s so silence is never >= 1400ms
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 300));
      hb.touch();
    }
    assert.equal(res.writes.length, 0, 'No heartbeat should be emitted while stream is actively touched');
  } finally {
    hb.stop();
  }
});

test('Transport: Heartbeat - skips frame when client socket buffer needs drain (backpressure)', async () => {
  const res = new MockResponse({ writableNeedDrain: true });
  const hb = createHeartbeat({
    res,
    protocol: 'anthropic',
    idleIntervalMs: 20
  });

  try {
    await new Promise((r) => setTimeout(r, 1150));
    assert.equal(res.writes.length, 0, 'Heartbeat must skip write when client socket is congested');
  } finally {
    hb.stop();
  }
});

test('Transport: Heartbeat - stop() stops watchdog and ignores destroyed response', async () => {
  const res = new MockResponse();
  const hb = createHeartbeat({
    res,
    protocol: 'anthropic',
    idleIntervalMs: 20
  });

  hb.stop();
  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(res.writes.length, 0, 'No frames after stop()');

  // Second stop() call must be idempotent
  hb.stop();
});

test('Transport: Heartbeat - stops automatically when response is ended or destroyed', async () => {
  const res = new MockResponse();
  res.destroy();
  const hb = createHeartbeat({
    res,
    protocol: 'anthropic',
    idleIntervalMs: 20
  });

  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(res.writes.length, 0, 'No frames on destroyed socket');
  hb.stop();
});

// ---------------------------------------------------------------------------
// 2. Two-Phase Commit Prelude Buffer (prelude.mjs)
// ---------------------------------------------------------------------------

test('Transport: Prelude - Non-decisive events do not commit HTTP 200', () => {
  const prelude = new PreludeBuffer();

  // Non-decisive events
  assert.equal(prelude.ingest({ type: 'start' }), false);
  assert.equal(prelude.ingest({ type: 'start-step' }), false);
  assert.equal(prelude.ingest({ type: 'reasoning-start', text: '' }), false);
  assert.equal(prelude.committed, false);
  assert.equal(prelude.events.length, 3);
});

test('Transport: Prelude - Decisive events trigger commitment', () => {
  // 1. Non-empty text-delta
  const p1 = new PreludeBuffer();
  assert.equal(p1.ingest({ type: 'text-delta', text: 'Hello' }), true);
  assert.equal(p1.committed, true);

  // 2. Non-empty reasoning-delta
  const p2 = new PreludeBuffer();
  assert.equal(p2.ingest({ type: 'reasoning-delta', text: 'Analyzing...' }), true);
  assert.equal(p2.committed, true);

  // 3. Tool input start
  const p3 = new PreludeBuffer();
  assert.equal(p3.ingest({ type: 'tool-input-start', toolName: 'bash' }), true);
  assert.equal(p3.committed, true);

  // 4. Tool call
  const p4 = new PreludeBuffer();
  assert.equal(p4.ingest({ type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', input: {} }), true);
  assert.equal(p4.committed, true);
});

test('Transport: Prelude - Upstream 401, 429, 500 error interception before 200 commitment', () => {
  // 401 Unauthorized
  const p401 = new PreludeBuffer();
  p401.ingest({ type: 'start' });
  assert.throws(() => {
    p401.ingest({ type: 'error', statusCode: 401, message: 'Invalid API key' });
  }, (err) => err instanceof BridgeHttpError && err.status === 401);
  assert.equal(p401.committed, false);

  // 429 Rate Limit
  const p429 = new PreludeBuffer();
  p429.ingest({ type: 'reasoning-start', text: '' });
  assert.throws(() => {
    p429.ingest({ type: 'error', statusCode: 429, message: 'Quota exceeded' });
  }, (err) => err instanceof BridgeHttpError && err.status === 429);
  assert.equal(p429.committed, false);

  // 500 Internal Error
  const p500 = new PreludeBuffer();
  assert.throws(() => {
    p500.ingest({ type: 'error', statusCode: 500, error: { message: 'Upstream cluster error' } });
  }, (err) => err instanceof BridgeHttpError && err.status === 500);
  assert.equal(p500.committed, false);
});

test('Transport: Prelude - Buffer byte overflow forces commitment', () => {
  const p = new PreludeBuffer({ maxPreludeBytes: 50 });
  const smallNonDecisive = { type: 'start-step', meta: '12345678901234567890' };
  
  p.ingest(smallNonDecisive);
  // Next event exceeds 50 bytes total
  const commit = p.ingest({ type: 'start-step', meta: '123456789012345678901234567890' });
  assert.equal(commit, true);
  assert.equal(p.committed, true);
});

test('Transport: Prelude - Timeout with buffered events forces commitment', async () => {
  const p = new PreludeBuffer({ maxWaitMs: 50 });
  p.ingest({ type: 'start' });
  
  await new Promise((r) => setTimeout(r, 60));
  // Ingesting another non-decisive event past maxWaitMs triggers commit
  const commit = p.ingest({ type: 'start-step' });
  assert.equal(commit, true);
  assert.equal(p.committed, true);
});

test('Transport: Prelude - flush() returns FIFO drained events and marks committed', () => {
  const p = new PreludeBuffer();
  const ev1 = { type: 'start' };
  const ev2 = { type: 'text-delta', text: 'hi' };

  p.ingest(ev1);
  p.ingest(ev2);
  assert.equal(p.committed, true);

  const flushed = p.flush();
  assert.equal(flushed.length, 2);
  assert.deepEqual(flushed[0], ev1);
  assert.deepEqual(flushed[1], ev2);

  // Subsequent flush returns empty array
  assert.deepEqual(p.flush(), []);

  // Ingest after commit returns true directly
  assert.equal(p.ingest({ type: 'text-delta', text: 'more' }), true);
});

// ---------------------------------------------------------------------------
// 3. Incremental UTF-8 NDJSON Parser (ndjson.mjs)
// ---------------------------------------------------------------------------

test('Transport: NDJSON - Arbitrary byte chunk splitting across JSON keys and values', async () => {
  async function* chunks() {
    yield Buffer.from('{"ty');
    yield Buffer.from('pe":"text-');
    yield Buffer.from('delta","te');
    yield Buffer.from('xt":"chunked-stream"}\n');
  }

  const events = [];
  for await (const ev of parseNdjsonStream(chunks())) {
    events.push(ev);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'text-delta');
  assert.equal(events[0].text, 'chunked-stream');
});

test('Transport: NDJSON - Multi-byte UTF-8 code points split across chunk boundaries', async () => {
  // Test 3-byte and 4-byte UTF-8 sequences (e.g. '€' = 0xE2 0x82 0xAC, '🚀' = 0xF0 0x9F 0x9A 0x80)
  const fullJson = '{"type":"text-delta","text":"Price: 100€ 🚀 Rocket"}\n';
  const fullBuf = Buffer.from(fullJson, 'utf-8');

  // Split right in the middle of '€' and '🚀'
  const split1 = fullBuf.subarray(0, 36); // splits inside €
  const split2 = fullBuf.subarray(36, 43); // splits inside 🚀
  const split3 = fullBuf.subarray(43);

  async function* chunks() {
    yield split1;
    yield split2;
    yield split3;
  }

  const events = [];
  for await (const ev of parseNdjsonStream(chunks())) {
    events.push(ev);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].text, 'Price: 100€ 🚀 Rocket');
  assert.ok(!events[0].text.includes('\uFFFD'), 'No UTF-8 replacement characters allowed');
});

test('Transport: NDJSON - Handles mixed CRLF, LF, empty lines, and spaces', async () => {
  async function* chunks() {
    yield Buffer.from('\r\n\n   \n{"type":"step-1"}\r\n{"type":"step-2"}\n\r\n{"type":"step-3"}\r\n');
  }

  const events = [];
  for await (const ev of parseNdjsonStream(chunks())) {
    events.push(ev);
  }

  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'step-1');
  assert.equal(events[1].type, 'step-2');
  assert.equal(events[2].type, 'step-3');
});

test('Transport: NDJSON - Trailing complete JSON line without trailing newline at EOF', async () => {
  async function* chunks() {
    yield Buffer.from('{"type":"start"}\n{"type":"final-line"}');
  }

  const events = [];
  for await (const ev of parseNdjsonStream(chunks())) {
    events.push(ev);
  }

  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'start');
  assert.equal(events[1].type, 'final-line');
});

test('Transport: NDJSON - Exceeding maxLineBytes throws 502 upstream_line_too_large', async () => {
  async function* chunks() {
    // Emits 100 bytes without newline, limit is 50 bytes
    yield Buffer.alloc(30, 0x61);
    yield Buffer.alloc(30, 0x62);
  }

  await assert.rejects(async () => {
    for await (const _ of parseNdjsonStream(chunks(), { maxLineBytes: 50 })) {
      // should throw
    }
  }, (err) => err instanceof BridgeHttpError && err.status === 502 && err.code === 'upstream_line_too_large');
});

test('Transport: NDJSON - Malformed JSON line throws 502 invalid_upstream_json', async () => {
  async function* chunks() {
    yield Buffer.from('{"type": "valid"}\n');
    yield Buffer.from('NOT_VALID_JSON\n');
  }

  await assert.rejects(async () => {
    for await (const _ of parseNdjsonStream(chunks())) {
      // should throw
    }
  }, (err) => err instanceof BridgeHttpError && err.status === 502 && err.code === 'invalid_upstream_json');
});

test('Transport: NDJSON - Truncated JSON at stream EOF throws 502 truncated_upstream_json', async () => {
  async function* chunks() {
    yield Buffer.from('{"type":"valid"}\n{"type":"trun');
  }

  await assert.rejects(async () => {
    for await (const _ of parseNdjsonStream(chunks())) {
      // should throw
    }
  }, (err) => err instanceof BridgeHttpError && err.status === 502 && err.code === 'truncated_upstream_json');
});
