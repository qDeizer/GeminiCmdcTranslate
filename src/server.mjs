/**
 * @file server.mjs
 * @description Gemini1 Production HTTP Gateway Server.
 * 
 * DESIGN INVARIANTS:
 * 1. Zero External Dependencies: Built strictly using node:http, node:https, node:crypto.
 * 2. 1-Hop Direct Translation: Ingress decodes to CanonicalTurn; Wire Compiler encodes to CC 1.54.0.
 * 3. Client Path Normalization: /v1/v1/messages is safely routed to the Anthropic handler.
 * 4. Two-Phase Commit Prelude: Buffer events until first content byte; return clean JSON errors on early failure.
 * 5. Anti-Stall Heartbeat: 12-second idle watchdog keeps Claude & Codex sockets alive during long model thinking.
 * 6. Session Isolation & Concurrency Guard: Mutual exclusion lock prevents turn collision on active sessions.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { BridgeHttpError } from './types.mjs';
import { createSessionManager } from './session.mjs';
import { buildWireHeaders, buildWireEnvelope } from './commandcode/wire.mjs';
import { decodeAnthropicRequest, estimateAnthropicTokens } from './ingress/anthropic.mjs';
import { decodeResponsesRequest } from './ingress/responses.mjs';
import { decodeChatRequest, formatModelsList } from './ingress/chat.mjs';
import { parseNdjsonStream } from './transport/ndjson.mjs';
import { PreludeBuffer } from './transport/prelude.mjs';
import { createHeartbeat } from './transport/heartbeat.mjs';
import { AnthropicSseSerializer } from './egress/anthropic.mjs';
import { ResponsesSseSerializer } from './egress/responses.mjs';
import { ChatSseSerializer } from './egress/chat.mjs';
import { getDashboardHtml } from './ui/dashboard.mjs';
import { getCatalogModels, KNOWN_MODEL_EFFORTS } from './commandcode/effort.mjs';

export function createBridgeServer(config = {}) {
  const isTestEnv = process.execArgv.includes('--test') || process.env.NODE_ENV === 'test' || (process.argv[1] && process.argv[1].includes('test'));
  const configPath = config.configPath !== undefined ? config.configPath : (isTestEnv ? null : resolve(process.cwd(), 'config.json'));
  let loadedFileConfig = {};
  if (configPath && existsSync(configPath)) {
    try {
      loadedFileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {}
  }

  const listenConfig = config.listen || loadedFileConfig.listen || { host: '127.0.0.1', port: 8741 };
  const nativeConfig = {
    baseUrl: 'https://api.commandcode.ai',
    cliVersion: '1.54.0',
    cliEnvironment: 'production',
    projectSlug: 'default-workspace',
    emptySystem: 'single-space',
    permissionMode: 'auto-accept',
    ...(loadedFileConfig.native || {}),
    ...(config.native || {})
  };
  const DEFAULT_MODELS = {
    'claude-3-7-sonnet-20250219': { upstream: 'meta/muse-spark-1.3-contributor', defaultEffort: 'high', maxOutputTokens: 64000 },
    'claude-3-7-sonnet': { upstream: 'meta/muse-spark-1.3-contributor', defaultEffort: 'high', maxOutputTokens: 64000 },
    'claude-3-5-sonnet-20241022': { upstream: 'meta/muse-spark-1.3-contributor', defaultEffort: 'high', maxOutputTokens: 64000 },
    'claude-3-5-sonnet': { upstream: 'meta/muse-spark-1.3-contributor', defaultEffort: 'high', maxOutputTokens: 64000 },
    'claude-code': { upstream: 'meta/muse-spark-1.3-contributor', defaultEffort: 'high', maxOutputTokens: 64000 },
    'gpt-4o': { upstream: 'meta/muse-spark-1.3-contributor', defaultEffort: 'medium', maxOutputTokens: 64000 },
    'default': { upstream: 'meta/muse-spark-1.3-contributor', defaultEffort: 'high', maxOutputTokens: 64000 }
  };
  const modelsConfig = config.models || loadedFileConfig.models || { ...DEFAULT_MODELS };

  let configuredApiKey = config.apiKey || loadedFileConfig.apiKey || process.env.COMMANDCODE_API_KEY || '';

  const gatewayToken = process.env.COMMANDCODE_BRIDGE_TOKEN || '';
  const sessionManager = createSessionManager();

  function verifyAuth(req) {
    if (!gatewayToken) return true; // Gateway auth disabled
    const auth = req.headers['authorization'] || '';
    const key = req.headers['x-api-key'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (key || '');
    if (!token) return false;

    const bufA = Buffer.from(token);
    const bufB = Buffer.from(gatewayToken);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }

  function resolveUpstreamApiKey(req) {
    // 1. Env variable takes precedence
    if (process.env.COMMANDCODE_API_KEY) {
      return process.env.COMMANDCODE_API_KEY;
    }
    // 2. Client provided key in Authorization / x-api-key
    const auth = req.headers['authorization'] || '';
    const headerKey = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-api-key'] || '');
    if (headerKey && (headerKey.startsWith('cc_') || !configuredApiKey)) {
      return headerKey;
    }
    // 3. UI/config configured API key
    if (configuredApiKey) {
      return configuredApiKey;
    }
    return headerKey || '';
  }

  async function readJsonBody(req, maxBytes = 16 * 1024 * 1024) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new BridgeHttpError(413, 'request_too_large', 'Request payload exceeded 16MB limit.');
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf-8');
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new BridgeHttpError(400, 'invalid_json', 'Request body contains invalid JSON.');
    }
  }

  function writeJson(res, status, obj) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify(obj));
  }

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    let pathname = parsedUrl.pathname;

    // Normalize duplicate /v1 prefixes (e.g. Claude Desktop appends /v1/messages)
    if (pathname.startsWith('/v1/v1/')) {
      pathname = pathname.replace('/v1/v1/', '/v1/');
    }

    // Real-time TCP stream optimization (Disable Nagle's algorithm)
    if (req.socket && typeof req.socket.setNoDelay === 'function') {
      req.socket.setNoDelay(true);
    }
    if (res.socket && typeof res.socket.setNoDelay === 'function') {
      res.socket.setNoDelay(true);
    }

    // Health check routes
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/healthz')) {
      return writeJson(res, 200, { status: 'ok', engine: 'gemini1-commandcode-bridge', timestamp: Date.now() });
    }

    // Models list route
    if (req.method === 'GET' && pathname === '/v1/models') {
      return writeJson(res, 200, formatModelsList(modelsConfig));
    }

    // Dashboard Web UI
    if (req.method === 'GET' && (pathname === '/' || pathname === '/ui')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache'
      });
      return res.end(getDashboardHtml());
    }

    // Configuration API
    if (req.method === 'GET' && pathname === '/api/config') {
      return writeJson(res, 200, {
        apiKey: configuredApiKey || '',
        apiKeyConfigured: Boolean(configuredApiKey),
        models: modelsConfig,
        native: nativeConfig,
        listen: listenConfig
      });
    }

    if (req.method === 'POST' && pathname === '/api/config') {
      const body = await readJsonBody(req);
      if (typeof body.apiKey === 'string') {
        const trimmed = body.apiKey.trim();
        // Defensive check: do not overwrite real key with masked string containing ellipsis
        if (trimmed && !trimmed.includes('...')) {
          configuredApiKey = trimmed;
        } else if (!trimmed) {
          configuredApiKey = '';
        }
      }
      if (body.models && typeof body.models === 'object') {
        // Clear existing keys so deletions in UI are respected
        for (const k of Object.keys(modelsConfig)) {
          delete modelsConfig[k];
        }
        Object.assign(modelsConfig, body.models);
      }
      if (body.native && typeof body.native === 'object') {
        Object.assign(nativeConfig, body.native);
      }
      const toSave = {
        listen: listenConfig,
        ...(configuredApiKey ? { apiKey: configuredApiKey } : {}),
        native: nativeConfig,
        models: modelsConfig
      };
      try {
        writeFileSync(configPath, JSON.stringify(toSave, null, 2) + '\n', 'utf8');
      } catch (err) {
        console.warn('[Gemini1] Warning: could not write to config.json:', err.message);
      }
      return writeJson(res, 200, { success: true, message: 'Configuration saved and active.' });
    }

    // Upstream Models Discovery API
    if (req.method === 'GET' && pathname === '/api/upstream-models') {
      const queryKey = parsedUrl.searchParams.get('apiKey');
      const effectiveKey = queryKey || configuredApiKey || process.env.COMMANDCODE_API_KEY || '';
      let models = [];
      let source = 'catalog-fallback';

      if (effectiveKey) {
        const candidateEndpoints = [
          `${nativeConfig.baseUrl || 'https://api.commandcode.ai'}/provider/v1/models`,
          `${nativeConfig.baseUrl || 'https://api.commandcode.ai'}/alpha/models`,
          `${nativeConfig.baseUrl || 'https://api.commandcode.ai'}/v1/models`
        ];

        for (const upstreamUrl of candidateEndpoints) {
          try {
            const upstreamRes = await fetch(upstreamUrl, {
              method: 'GET',
              headers: {
                'authorization': `Bearer ${effectiveKey.trim()}`,
                'user-agent': 'cli',
                'x-command-code-version': nativeConfig.cliVersion || '1.54.0',
                'x-cli-environment': nativeConfig.cliEnvironment || 'production'
              },
              signal: AbortSignal.timeout(4000)
            });

            if (upstreamRes.ok) {
              const data = await upstreamRes.json();
              const rawList = Array.isArray(data) ? data : (data.data || data.models || []);
              if (Array.isArray(rawList) && rawList.length > 0) {
                source = 'upstream';
                models = rawList.map(item => {
                  const id = typeof item === 'string' ? item : (item.id || item.name || '');
                  return {
                    id,
                    name: id.split('/').pop().replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
                    efforts: item.efforts || item.reasoning_efforts || (KNOWN_MODEL_EFFORTS[id] || ['low', 'medium', 'high', 'xhigh']),
                    maxOutputTokens: item.max_tokens || 64000,
                    supportsReasoning: Boolean(item.efforts?.length || KNOWN_MODEL_EFFORTS[id]?.length)
                  };
                });
                break;
              }
            }
          } catch (err) {
            // Try next candidate endpoint
          }
        }
      }

      if (models.length === 0) {
        models = getCatalogModels();
      }

      // Merge any models configured in modelsConfig (including manually added models)
      for (const mCfg of Object.values(modelsConfig)) {
        if (mCfg && mCfg.upstream && !models.some(m => m.id === mCfg.upstream)) {
          models.unshift({
            id: mCfg.upstream,
            name: mCfg.upstream.split('/').pop().replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            efforts: mCfg.supportedEfforts || KNOWN_MODEL_EFFORTS[mCfg.upstream] || ['low', 'medium', 'high', 'xhigh', 'max'],
            maxOutputTokens: mCfg.maxOutputTokens || 64000,
            supportsReasoning: true
          });
        }
      }

      return writeJson(res, 200, {
        success: true,
        source,
        count: models.length,
        models
      });
    }

    // Client Process Launch API (Claude Code & ChatGPT Codex)
    if (req.method === 'POST' && (pathname === '/api/launch/claude' || pathname === '/api/launch/codex')) {
      const isClaude = pathname.endsWith('claude');
      const host = listenConfig.host || '127.0.0.1';
      const port = listenConfig.port || 8741;
      const key = configuredApiKey || process.env.COMMANDCODE_API_KEY || 'cc_bridge_key';

      try {
        if (process.platform === 'win32') {
          const title = isClaude ? 'Claude Code CLI' : 'ChatGPT Codex';
          const cmd = isClaude
            ? `set ANTHROPIC_BASE_URL=http://${host}:${port}&& set ANTHROPIC_API_KEY=${key}&& claude`
            : `set OPENAI_BASE_URL=http://${host}:${port}/v1&& set OPENAI_API_KEY=${key}&& codex`;

          const child = spawn('cmd.exe', ['/c', 'start', `"${title}"`, 'cmd.exe', '/k', cmd], {
            detached: true,
            stdio: 'ignore',
            windowsVerbatimArguments: true
          });
          child.unref();
        } else {
          const env = {
            ...process.env,
            ...(isClaude ? {
              ANTHROPIC_BASE_URL: `http://${host}:${port}`,
              ANTHROPIC_API_KEY: key
            } : {
              OPENAI_BASE_URL: `http://${host}:${port}/v1`,
              OPENAI_API_KEY: key
            })
          };
          const child = spawn(isClaude ? 'claude' : 'codex', [], { detached: true, stdio: 'ignore', env });
          child.unref();
        }
        return writeJson(res, 200, { success: true, message: `${isClaude ? 'Claude' : 'Codex'} launched successfully.` });
      } catch (err) {
        return writeJson(res, 500, { success: false, error: `Launch failed: ${err.message}` });
      }
    }

    // Gateway Authentication Check
    if (!verifyAuth(req)) {
      return writeJson(res, 401, { error: { code: 'unauthorized', message: 'Invalid gateway authentication token.' } });
    }

    const abortController = new AbortController();
    req.on('aborted', () => abortController.abort(new Error('client_aborted')));
    res.on('close', () => {
      if (!res.writableEnded) abortController.abort(new Error('client_closed'));
    });

    let sessionLease = null;
    let heartbeat = null;

    try {
      // Token counting endpoint
      if (req.method === 'POST' && pathname === '/v1/messages/count_tokens') {
        const body = await readJsonBody(req);
        const tokens = estimateAnthropicTokens(body);
        res.setHeader('x-bridge-token-count', 'estimate');
        return writeJson(res, 200, { input_tokens: tokens });
      }

      // Main translation pipelines
      let protocol = null;
      let turn = null;
      let rawBody = null;

      if (req.method === 'POST' && pathname === '/v1/messages') {
        protocol = 'anthropic';
        rawBody = await readJsonBody(req);
        turn = decodeAnthropicRequest(rawBody);
      } else if (req.method === 'POST' && (pathname === '/v1/responses' || pathname === '/backend-api/codex/responses')) {
        protocol = 'responses';
        rawBody = await readJsonBody(req);
        turn = decodeResponsesRequest(rawBody);
      } else if (req.method === 'POST' && pathname === '/v1/chat/completions') {
        protocol = 'chat';
        rawBody = await readJsonBody(req);
        turn = decodeChatRequest(rawBody);
      } else {
        return writeJson(res, 404, { error: { code: 'route_not_found', message: `Route ${req.method} ${pathname} not found.` } });
      }

      const apiKey = resolveUpstreamApiKey(req);
      if (!apiKey) {
        throw new BridgeHttpError(401, 'missing_upstream_api_key', 'Command Code upstream API key is required in Authorization header or COMMANDCODE_API_KEY environment variable.');
      }

      // Resolve model mapping (case-insensitive with fallback)
      let modelConfig = modelsConfig[turn.publicModel]
        || modelsConfig[turn.publicModel.toLowerCase()]
        || Object.entries(modelsConfig).find(([k]) => k.toLowerCase() === turn.publicModel.toLowerCase())?.[1]
        || modelsConfig['default']
        || {
          upstream: 'meta/muse-spark-1.3-contributor',
          maxOutputTokens: 64000
        };

      if (modelConfig.upstream === 'glm/glm-5.3-flash') {
        modelConfig = { ...modelConfig, upstream: 'z-ai/glm-5.3-flash' };
      }

      // Acquire exclusive session lock for this turn
      sessionLease = sessionManager.acquire({
        protocol,
        accountId: apiKey.slice(0, 16),
        headers: req.headers,
        body: rawBody,
        includeThreadId: true
      });

      // Compile into native Command Code 1.54.0 wire format
      const wireHeaders = buildWireHeaders(nativeConfig, sessionLease, apiKey);
      const wireEnvelope = buildWireEnvelope(turn, nativeConfig, modelConfig, sessionLease);

      // Perform upstream request
      const upstreamUrl = `${nativeConfig.baseUrl || 'https://api.commandcode.ai'}/alpha/generate`;
      const upstreamRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers: wireHeaders,
        body: JSON.stringify(wireEnvelope),
        signal: abortController.signal
      });

      if (!upstreamRes.ok) {
        const errorText = await upstreamRes.text();
        let parsedErr = { message: errorText };
        try { parsedErr = JSON.parse(errorText); } catch {}
        throw new BridgeHttpError(upstreamRes.status, 'upstream_http_error', parsedErr.message || 'Command Code upstream rejected request.', parsedErr);
      }

      // Stream processing with Two-Phase Commit Prelude
      const prelude = new PreludeBuffer();
      let serializer = null;

      if (protocol === 'anthropic') {
        serializer = new AnthropicSseSerializer(res, { model: turn.publicModel });
      } else if (protocol === 'responses') {
        serializer = new ResponsesSseSerializer(res, { model: turn.publicModel });
      } else {
        serializer = new ChatSseSerializer(res, { model: turn.publicModel });
      }

      for await (const nativeEvent of parseNdjsonStream(upstreamRes.body)) {
        if (!prelude.committed) {
          const shouldCommit = prelude.ingest(nativeEvent);
          if (shouldCommit) {
            // Commit HTTP 200 and start heartbeat watchdog
            serializer.start();
            if (typeof res.flushHeaders === 'function') {
              res.flushHeaders();
            }
            if (res.socket && typeof res.socket.setNoDelay === 'function') {
              res.socket.setNoDelay(true);
            }
            heartbeat = createHeartbeat({ res, protocol, idleIntervalMs: 12000 });
            for (const bufferedEvent of prelude.flush()) {
              serializer.processEvent(bufferedEvent);
            }
          }
        } else {
          if (nativeEvent.type === 'error' || nativeEvent.statusCode >= 400) {
            const status = nativeEvent.statusCode || nativeEvent.status || 502;
            const msg = nativeEvent.message || nativeEvent.error?.message || 'Upstream stream error';
            throw new BridgeHttpError(status, 'upstream_stream_error', msg);
          }
          heartbeat?.touch();
          serializer.processEvent(nativeEvent);
        }
      }

      // If stream finished without any events
      if (!prelude.committed) {
        serializer.start();
        if (typeof res.flushHeaders === 'function') {
          res.flushHeaders();
        }
        if (res.socket && typeof res.socket.setNoDelay === 'function') {
          res.socket.setNoDelay(true);
        }
        for (const bufferedEvent of prelude.flush()) {
          serializer.processEvent(bufferedEvent);
        }
      }

      heartbeat?.stop();
      serializer.end();

    } catch (err) {
      if (!res.headersSent) {
        const status = err.status || 500;
        const code = err.code || 'internal_server_error';
        writeJson(res, status, { error: { code, message: err.message, details: err.details } });
      } else {
        // Stream was already committed; terminate with protocol-safe event
        if (res.writable && !res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
          res.end();
        }
      }
    } finally {
      heartbeat?.stop();
      sessionLease?.release();
    }
  });

  return {
    server,
    start() {
      return new Promise((resolve) => {
        server.listen(listenConfig.port, listenConfig.host, () => {
          resolve(listenConfig);
        });
      });
    },
    stop() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

// Auto-run if executed directly as entrypoint
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const port = parseInt(process.env.PORT || '8741', 10);
  const host = process.env.HOST || '127.0.0.1';
  const bridge = createBridgeServer({
    listen: { host, port }
  });
  bridge.start().then(() => {
    console.log(`[Gemini1 Bridge] Listening on http://${host}:${port}`);
    console.log(`[Gemini1 Bridge] Upstream target: https://api.commandcode.ai/alpha/generate`);
    console.log(`[Gemini1 Bridge] Ready for Claude Desktop, Claude Code CLI, and ChatGPT Codex.`);
  });
}
