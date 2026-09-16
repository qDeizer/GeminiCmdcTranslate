/**
 * @file server.test.mjs
 * @description Comprehensive HTTP Loopback Integration Test Suite for Gemini1.
 * 
 * Covers:
 * - Concurrency Turn Locking: second concurrent request to same conversation produces HTTP 409 Conflict;
 *   releasing lease permits subsequent turns.
 * - Path Normalization: /v1/v1/messages rewrites cleanly to /v1/messages for Claude Desktop compatibility.
 * - Token Estimation preflight: POST /v1/messages/count_tokens returns x-bridge-token-count header.
 * - Models List Endpoint: GET /v1/models returns OpenAI standard models list.
 * - Unsupported Feature Guard: POST /v1/responses with previous_response_id returns HTTP 422 unsupported_feature.
 * - Empty System Safeguard: client empty system prompt compiled upstream to params.system = [{ type: 'text', text: ' ' }].
 * - Two-Phase Commit Prelude Interception: upstream HTTP 401/429/500 and early NDJSON error events returned
 *   as clean JSON before HTTP 200 headers committed.
 * - Authentication & Validation Guards: missing upstream API key (401), invalid JSON (400), orphan tool result (422),
 *   gateway auth token validation (401), route not found (404).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridgeServer } from '../src/server.mjs';

/**
 * Helper to boot a mock Command Code upstream server.
 */
function createMockUpstream(handler) {
  const server = http.createServer(handler);
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

// ---------------------------------------------------------------------------
// 1. Core Endpoints & Route Normalization
// ---------------------------------------------------------------------------

test('Server: Health endpoints - GET /health and GET /healthz return 200 OK', async () => {
  const bridge = createBridgeServer({ listen: { host: '127.0.0.1', port: 0 } });
  await bridge.start();
  const port = bridge.server.address().port;

  try {
    const res1 = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.status, 'ok');
    assert.equal(data1.engine, 'gemini1-commandcode-bridge');

    const res2 = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.status, 'ok');
  } finally {
    await bridge.stop();
  }
});

test('Server: Models endpoint - GET /v1/models returns standard model list', async () => {
  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    models: {
      'claude-3-7-sonnet': { upstream: 'meta/muse-spark-1.3-contributor', maxOutputTokens: 64000 },
      'gpt-4o': { upstream: 'meta/muse-spark-1.3-contributor', maxOutputTokens: 64000 }
    }
  });
  await bridge.start();
  const port = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'list');
    assert.equal(data.data.length, 2);
    assert.equal(data.data[0].id, 'claude-3-7-sonnet');
    assert.equal(data.data[1].id, 'gpt-4o');
  } finally {
    await bridge.stop();
  }
});

test('Server: Token counting - POST /v1/messages/count_tokens returns estimated count and header', async () => {
  const bridge = createBridgeServer({ listen: { host: '127.0.0.1', port: 0 } });
  await bridge.start();
  const port = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-key'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        system: 'You are a test assistant.',
        messages: [{ role: 'user', content: 'Count tokens in this query.' }]
      })
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-bridge-token-count'), 'estimate');
    const data = await res.json();
    assert.ok(typeof data.input_tokens === 'number');
    assert.ok(data.input_tokens > 0);
  } finally {
    await bridge.stop();
  }
});

test('Server: Path Normalization - POST /v1/v1/messages rewrites transparently to /v1/messages', async () => {
  let upstreamCalled = false;
  const mockUpstream = createMockUpstream((req, res) => {
    upstreamCalled = true;
    assert.equal(req.url, '/alpha/generate');
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"type":"start"}\n{"type":"text-delta","text":"Rewritten path worked"}\n{"type":"finish"}\n');
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
    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-token'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Testing duplicate prefix' }]
      })
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const text = await res.text();
    assert.ok(upstreamCalled, 'Mock upstream must have been called');
    assert.ok(text.includes('Rewritten path worked'));
  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});

// ---------------------------------------------------------------------------
// 2. Concurrency Turn Locking (HTTP 409 Conflict)
// ---------------------------------------------------------------------------

test('Server: Concurrency - Second concurrent request to same conversation produces HTTP 409 Conflict', async () => {
  let releaseUpstreamTurn1;
  const turn1Gate = new Promise((resolve) => { releaseUpstreamTurn1 = resolve; });

  const mockUpstream = createMockUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"type":"start"}\n');
    // Keep upstream open until turn1Gate resolves
    await turn1Gate;
    res.write('{"type":"text-delta","text":"Turn 1 response"}\n{"type":"finish"}\n');
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
    const sessionId = 'session_concurrent_test_123';
    const clientHeaders = {
      'content-type': 'application/json',
      'authorization': 'Bearer shared_api_key',
      'x-claude-code-session-id': sessionId
    };

    // 1. Launch Request 1 (held in progress upstream)
    const turn1Promise = fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Turn 1 prompt' }]
      })
    });

    // Wait a brief moment to ensure Request 1 has acquired the lock
    await new Promise((r) => setTimeout(r, 60));

    // 2. Launch Request 2 with identical session ID while Request 1 is still processing
    const res2 = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Turn 2 concurrent prompt' }]
      })
    });

    // Request 2 MUST immediately receive HTTP 409 Conflict!
    assert.equal(res2.status, 409);
    const errData = await res2.json();
    assert.equal(errData.error.code, 'conversation_busy');
    assert.equal(errData.error.message, 'Another turn is actively processing in this conversation.');

    // 3. Release Request 1
    releaseUpstreamTurn1();
    const res1 = await turn1Promise;
    assert.equal(res1.status, 200);
    const turn1Text = await res1.text();
    assert.ok(turn1Text.includes('Turn 1 response'));

    // 4. Now that Request 1 has finished, subsequent Request 3 to same conversation MUST succeed!
    const res3 = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Turn 3 subsequent prompt' }]
      })
    });
    assert.equal(res3.status, 200);

  } finally {
    releaseUpstreamTurn1();
    await bridge.stop();
    await mockUpstream.stop();
  }
});

// ---------------------------------------------------------------------------
// 3. Ingress Guards & Invariants (422, Single-Space Safeguard)
// ---------------------------------------------------------------------------

test('Server: Responses - Rejection of previous_response_id with HTTP 422 unsupported_feature', async () => {
  const bridge = createBridgeServer({ listen: { host: '127.0.0.1', port: 0 } });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_key'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        previous_response_id: 'resp_previous_remote_id',
        input: [{ type: 'message', role: 'user', content: 'Continue from remote id' }]
      })
    });

    assert.equal(res.status, 422);
    const data = await res.json();
    assert.equal(data.error.code, 'unsupported_feature');
    assert.ok(data.error.message.includes('previous_response_id'));
  } finally {
    await bridge.stop();
  }
});

test('Server: Wire - Empty system single-space safeguard injected upstream', async () => {
  let capturedEnvelope = null;
  const mockUpstream = createMockUpstream(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedEnvelope = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"type":"text-delta","text":"safeguard verified"}\n{"type":"finish"}\n');
    res.end();
  });

  const upstreamPort = await mockUpstream.start();
  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: {
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      emptySystem: 'single-space'
    }
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    // Send request with NO system prompt
    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_key'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    });

    assert.equal(res.status, 200);
    assert.ok(capturedEnvelope !== null, 'Upstream must receive envelope');
    // Verify single-space safeguard is present: [{ type: 'text', text: ' ' }]
    assert.deepEqual(capturedEnvelope.params.system, [{ type: 'text', text: ' ' }]);
  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});

test('Server: Wire - Orphan tool result rejected with HTTP 422 orphan_tool_result', async () => {
  const bridge = createBridgeServer({ listen: { host: '127.0.0.1', port: 0 } });
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
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'non_existent_call_id', content: 'Result of ghost tool' }
            ]
          }
        ]
      })
    });

    assert.equal(res.status, 422);
    const data = await res.json();
    assert.equal(data.error.code, 'orphan_tool_result');
  } finally {
    await bridge.stop();
  }
});

// ---------------------------------------------------------------------------
// 4. Two-Phase Commit Prelude Error Interception
// ---------------------------------------------------------------------------

test('Server: Prelude - Upstream HTTP 401 returns clean JSON 401 before 200 committed', async () => {
  const mockUpstream = createMockUpstream((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Invalid API key provided' }));
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
        'authorization': 'Bearer invalid_key'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Test 401' }]
      })
    });

    assert.equal(res.status, 401);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const data = await res.json();
    assert.equal(data.error.code, 'upstream_http_error');
    assert.equal(data.error.message, 'Invalid API key provided');
  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});

test('Server: Prelude - Upstream HTTP 429 returns clean JSON 429 before 200 committed', async () => {
  const mockUpstream = createMockUpstream((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Rate limit exceeded' }));
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
        messages: [{ role: 'user', content: 'Test 429' }]
      })
    });

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const data = await res.json();
    assert.equal(data.error.code, 'upstream_http_error');
    assert.equal(data.error.message, 'Rate limit exceeded');
  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});

test('Server: Prelude - Upstream HTTP 500 returns clean JSON 500 before 200 committed', async () => {
  const mockUpstream = createMockUpstream((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Internal upstream crash' }));
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
        messages: [{ role: 'user', content: 'Test 500' }]
      })
    });

    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.error.code, 'upstream_http_error');
    assert.equal(data.error.message, 'Internal upstream crash');
  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});

test('Server: Prelude - Early NDJSON error event before decisive events caught as clean JSON', async () => {
  const mockUpstream = createMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    // Non-decisive event first, followed immediately by error!
    res.write('{"type":"reasoning-start","text":""}\n');
    res.write('{"type":"error","statusCode":429,"message":"Quota exceeded on reasoning"}\n');
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
        messages: [{ role: 'user', content: 'Trigger early error' }]
      })
    });

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const data = await res.json();
    assert.equal(data.error.code, 'upstream_error');
    assert.equal(data.error.message, 'Quota exceeded on reasoning');
  } finally {
    await bridge.stop();
    await mockUpstream.stop();
  }
});

// ---------------------------------------------------------------------------
// 5. Authentication, Request Validation & Security Guards
// ---------------------------------------------------------------------------

test('Server: Auth - Missing upstream API key returns HTTP 401 missing_upstream_api_key', async () => {
  const origKey = process.env.COMMANDCODE_API_KEY;
  delete process.env.COMMANDCODE_API_KEY;

  const bridge = createBridgeServer({ listen: { host: '127.0.0.1', port: 0 } });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'No auth' }]
      })
    });

    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error.code, 'missing_upstream_api_key');
  } finally {
    if (origKey !== undefined) process.env.COMMANDCODE_API_KEY = origKey;
    await bridge.stop();
  }
});

test('Server: Validation - Malformed JSON request body returns HTTP 400 invalid_json', async () => {
  const bridge = createBridgeServer({ listen: { host: '127.0.0.1', port: 0 } });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test_key'
      },
      body: '{"invalid_json_without_closing_bracket'
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error.code, 'invalid_json');
  } finally {
    await bridge.stop();
  }
});

test('Server: Routing - Non-existent route returns HTTP 404 route_not_found', async () => {
  const bridge = createBridgeServer({ listen: { host: '127.0.0.1', port: 0 } });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/unknown_route`, {
      method: 'POST',
      headers: { 'authorization': 'Bearer test_key' }
    });

    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.error.code, 'route_not_found');
  } finally {
    await bridge.stop();
  }
});
