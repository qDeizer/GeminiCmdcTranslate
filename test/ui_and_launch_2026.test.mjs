/**
 * @file ui_and_launch_2026.test.mjs
 * @description Test Suite for UI Launch Controls, Case-Insensitive Model Routing & Custom Effort Mappings.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridgeServer } from '../src/server.mjs';
import { resolveReasoningEffort } from '../src/commandcode/effort.mjs';
import { buildWireEnvelope } from '../src/commandcode/wire.mjs';

test('UI & Launch: POST /api/launch/claude returns 200 and triggers launch', async () => {
  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    apiKey: 'user_4LAqUa13XBiddVG8Lqzr35dCt8VKdkvTBDyxhKAdRYuduhJVCfv9E64pzhdxPcbvyZGwE36ixvECzkF5bemjwdWq'
  });
  await bridge.start();
  const port = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/launch/claude`, { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.message.includes('Claude'));
  } finally {
    await bridge.stop();
  }
});

test('UI & Launch: POST /api/launch/codex returns 200 and triggers launch', async () => {
  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    apiKey: 'user_4LAqUa13XBiddVG8Lqzr35dCt8VKdkvTBDyxhKAdRYuduhJVCfv9E64pzhdxPcbvyZGwE36ixvECzkF5bemjwdWq'
  });
  await bridge.start();
  const port = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/launch/codex`, { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.message.includes('Codex'));
  } finally {
    await bridge.stop();
  }
});

test('Effort Mapping: reject mapping throws HTTP 422 unsupported_effort', () => {
  const modelConfig = {
    upstream: 'deepseek/deepseek-v4.1-flash',
    effortMap: {
      'none': 'reject',
      'low': 'low',
      'high': 'high'
    }
  };

  assert.throws(() => {
    resolveReasoningEffort('deepseek/deepseek-v4.1-flash', 'none', modelConfig);
  }, (err) => {
    return err.status === 422 && err.code === 'unsupported_effort';
  });
});

test('Effort Mapping: unspecified mapping governs missing effort', () => {
  const modelConfigOmit = {
    upstream: 'deepseek/deepseek-v4.1-flash',
    effortMap: {
      'unspecified': 'omit'
    }
  };
  const resolvedOmit = resolveReasoningEffort('deepseek/deepseek-v4.1-flash', undefined, modelConfigOmit);
  assert.equal(resolvedOmit, undefined, 'Unspecified with omit should omit reasoning effort');

  const modelConfigLevel = {
    upstream: 'deepseek/deepseek-v4.1-flash',
    effortMap: {
      'unspecified': 'low'
    }
  };
  const resolvedLevel = resolveReasoningEffort('deepseek/deepseek-v4.1-flash', undefined, modelConfigLevel);
  assert.equal(resolvedLevel, 'low', 'Unspecified with low should map to low');

  const modelConfigReject = {
    upstream: 'deepseek/deepseek-v4.1-flash',
    effortMap: {
      'unspecified': 'reject'
    }
  };
  assert.throws(() => {
    resolveReasoningEffort('deepseek/deepseek-v4.1-flash', undefined, modelConfigReject);
  }, (err) => {
    return err.status === 422 && err.code === 'unsupported_effort';
  });
});

test('Model Routing: Case-insensitive alias matching resolves Opus-6 to opus-6', async () => {
  const upstreamRequests = [];
  const mockUpstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    upstreamRequests.push({ headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ type: 'text-delta', text: 'response' }) + '\n');
    res.end(JSON.stringify({ type: 'finish', finishReason: 'stop' }) + '\n');
  });
  await new Promise(r => mockUpstream.listen(0, '127.0.0.1', r));
  const upPort = mockUpstream.address().port;

  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 },
    native: { baseUrl: `http://127.0.0.1:${upPort}` },
    apiKey: 'user_4LAqUa13XBiddVG8Lqzr35dCt8VKdkvTBDyxhKAdRYuduhJVCfv9E64pzhdxPcbvyZGwE36ixvECzkF5bemjwdWq',
    models: {
      'opus-6': {
        upstream: 'deepseek/deepseek-v4.1-flash',
        defaultEffort: 'low',
        maxOutputTokens: 64000
      }
    }
  });
  await bridge.start();
  const bridgePort = bridge.server.address().port;

  try {
    // Client sends 'Opus-6' with capital O
    const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'Opus-6',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });

    assert.equal(res.status, 200);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].body.params.model, 'deepseek/deepseek-v4.1-flash');
  } finally {
    await bridge.stop();
    await new Promise(r => mockUpstream.close(r));
  }
});

test('Dashboard UI: All mockup elements present in GET /', async () => {
  const bridge = createBridgeServer({
    listen: { host: '127.0.0.1', port: 0 }
  });
  await bridge.start();
  const port = bridge.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();

    // Top Bar elements
    assert.ok(html.includes('id="apiKey"'), 'Must have apiKey input');
    assert.ok(html.includes('id="discover-btn"'), 'Must have check/discover button');
    assert.ok(html.includes('id="manualModelInput"'), 'Must have manual model input');
    assert.ok(html.includes('id="addManualModelBtn"'), 'Must have add manual model button');

    // Section headers and launch buttons
    assert.ok(html.includes('claude'), 'Must have claude section');
    assert.ok(html.includes('chatgpt'), 'Must have chatgpt section');
    assert.ok(html.includes('id="launchClaudeBtn"'), 'Must have Claude launch button');
    assert.ok(html.includes('id="launchCodexBtn"'), 'Must have Codex launch button');

    // Effort mapping modal elements
    assert.ok(html.includes('id="effortModal"'), 'Must have effort modal');
    assert.ok(html.includes('id="effort_unspecified"'), 'Must have Effort gelmezse selector');
    assert.ok(html.includes('id="effort_none"'), 'Must have none effort selector');
    assert.ok(html.includes('id="effort_minimal"'), 'Must have minimal effort selector');
    assert.ok(html.includes('id="effort_low"'), 'Must have low effort selector');
    assert.ok(html.includes('id="effort_medium"'), 'Must have medium effort selector');
    assert.ok(html.includes('id="effort_high"'), 'Must have high effort selector');
    assert.ok(html.includes('id="effort_xhigh"'), 'Must have xhigh effort selector');
    assert.ok(html.includes('id="effort_max"'), 'Must have max effort selector');

    // Dynamic model-aware & custom effort elements
    assert.ok(html.includes('id="customEffortRowsContainer"'), 'Must have container for custom client efforts');
    assert.ok(html.includes('id="newCustomEffortKey"'), 'Must have input for new custom effort name');
    assert.ok(html.includes('id="addCustomEffortBtn"'), 'Must have button to add custom effort level');
    assert.ok(html.includes('id="modalTargetModelName"'), 'Must display target model in modal');
  } finally {
    await bridge.stop();
  }
});

test('Effort Mapping: Custom client effort levels (e.g. ultracode -> max) resolve accurately', () => {
  const modelConfig = {
    upstream: 'deepseek/deepseek-v4.1-flash',
    effortMap: {
      'ultracode': 'max',
      'adaptive': 'low',
      'budget:1024': 'low'
    }
  };

  // Custom named level 'ultracode' maps to 'max'
  const resolvedUltracode = resolveReasoningEffort('deepseek/deepseek-v4.1-flash', 'ultracode', modelConfig);
  assert.equal(resolvedUltracode, 'max');

  // Custom override for 'adaptive' maps to 'low'
  const resolvedAdaptive = resolveReasoningEffort('deepseek/deepseek-v4.1-flash', 'adaptive', modelConfig);
  assert.equal(resolvedAdaptive, 'low');

  // Case-insensitive matching: 'UltraCode' maps to 'max'
  const resolvedCase = resolveReasoningEffort('deepseek/deepseek-v4.1-flash', 'UltraCode', modelConfig);
  assert.equal(resolvedCase, 'max');
});

test('Wire Normalization: glm/glm-5.3-flash is defensively normalized to z-ai/glm-5.3-flash', () => {
  const turn = {
    protocol: 'anthropic',
    publicModel: 'fable5',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    system: []
  };
  const modelConfig = {
    upstream: 'glm/glm-5.3-flash',
    defaultEffort: 'high'
  };
  const envelope = buildWireEnvelope(turn, {}, modelConfig, { sessionId: 'sess_test' });
  assert.equal(envelope.params.model, 'z-ai/glm-5.3-flash', 'Should normalize glm/ prefix to z-ai/');
});

