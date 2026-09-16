# Gemini1: Command Code Native Translation Bridge
## Technical Architecture & Agent Implementation Blueprint

**Document Version:** 1.0.0  
**Target:** `Claude Desktop / Claude Code CLI / ChatGPT Codex Desktop ⇄ Gemini1 Bridge ⇄ Command Code Upstream (CLI 1.54.0 Wire)`  
**Runtime:** Pure Node.js (ESM, `>=22.0.0`), Zero External Runtime Dependencies (`node:http`, `node:https`, `node:crypto`, `node:stream`).

---

## 1. Executive Summary & Core Principles

The Gemini1 bridge is an ultra-fast, zero-overhead translation gateway running locally on loopback (`127.0.0.1:8741`). It enables standard AI agent clients (Claude Desktop, Claude Code CLI/VSCode, ChatGPT Codex Desktop, standard OpenAI SDKs) to communicate transparently with Command Code's private inference endpoint (`POST https://api.commandcode.ai/alpha/generate`).

### Core Invariants:
1. **Direct 1-Hop Pipeline:** No lossy intermediate conversions (e.g. Chat Completions pivot).
   - `Anthropic Messages API` $\to$ `CanonicalTurn` $\to$ `Command Code CLI 1.54.0 Wire Envelope`.
   - `OpenAI Responses API` $\to$ `CanonicalTurn` $\to$ `Command Code CLI 1.54.0 Wire Envelope`.
   - `Command Code NDJSON Stream` $\to$ `Anthropic SSE` / `Responses Named-SSE`.
2. **Strict Wire Parity with CLI 1.54.0:**
   - Headers: `User-Agent: cli`, `x-command-code-version: 1.54.0`, `x-cli-environment: production`, `x-project-slug: <slug>`, `x-taste-learning: true/false`, `x-session-id: <uuid>`.
   - Envelope: Strict key ordering (`config`, `memory: null`, `taste: null`, `skills: null`, `permissionMode: "auto-accept"`, `threadId`, `params`).
3. **Empty System Safeguard (~14K Token Bypass):**
   - If the client supplies no system prompt, inject `[{ type: "text", text: " " }]`.
   - Prevents Command Code upstream from injecting ~7,653 to 13,912 tokens of default CLI agent prompt!
4. **Claude Code 0x12 Thinking Signature:**
   - Emits synthetic thinking signatures with leading `0x12` byte before `content_block_stop`.
   - Normalizes token usage using `noCacheTokens` (preventing 2x token display inflation).
5. **Codex Responses Interleaved State Machine:**
   - Monotonic `sequence_number` (starting at 1) on every SSE frame.
   - `Map<string, ActiveItem>` tracks concurrent reasoning (`rs_...`) and function call (`fc_...`) items.
   - Unique, monotonic `output_index` per distinct item.
   - `tool_search` mapped to `type: "tool_search_call"` with `execution: "client"`.
6. **Two-Phase Commit Prelude Buffer:**
   - Buffers early events until first content byte.
   - Upstream rate limits (429) or quota errors (401/402/500) are returned as clean JSON HTTP errors before committing HTTP 200 headers.
7. **Anti-Stall Heartbeat Watchdog:**
   - 12-second idle watchdog sends `: ping` (Anthropic) or `: keepalive` (OpenAI/Responses) to prevent client socket disconnects during long model reasoning.
8. **Session Isolation & Concurrency Guard:**
   - HMAC conversation binding with mutual-exclusion lock (HTTP 409 Conflict if duplicate turns overlap on the same active conversation).

---

## 2. End-to-End Data Pipeline

```
  [Claude Desktop / CLI]             [ChatGPT Codex Desktop]
   POST /v1/messages                  POST /v1/responses
   POST /v1/v1/messages               POST /backend-api/codex/responses
            │                                     │
            ▼                                     ▼
   src/ingress/anthropic.mjs           src/ingress/responses.mjs
            │                                     │
            └───────────────┬─────────────────────┘
                            ▼
                    CanonicalTurn Model
                     (src/types.mjs)
                            │
                            ▼
                 src/commandcode/wire.mjs
          (Headers, Envelope, System Safeguard)
                            │
                            ▼
               POST /alpha/generate (HTTPS)
                            │
                            ▼
                Incremental NDJSON Stream
               (src/transport/ndjson.mjs)
                            │
                            ▼
              Two-Phase Commit Prelude Buffer
               (src/transport/prelude.mjs)
                            │
            ┌───────────────┴─────────────────────┐
            ▼                                     ▼
src/egress/anthropic.mjs             src/egress/responses.mjs
 (0x12 Sig, tool_use, ping)           (seq_num, interleaved Map)
            │                                     │
            ▼                                     ▼
    [Claude Client SSE]                 [Codex Client SSE]
```

---

## 3. Directory Layout & Module Responsibilities

```
Gemini1/
├── package.json               # Pure Node.js ESM configuration (node --test)
├── config.example.json        # Upstream URLs, model mappings, timeouts
├── README.md                  # Quickstart, configuration, and client setup
├── ARCHITECTURE.md            # Technical blueprint and agent specifications
├── src/
│   ├── types.mjs              # CanonicalTurn, Part unions, Wire schemas, BridgeHttpError
│   ├── server.mjs             # HTTP gateway dispatcher, routing, error handler, lifecycle
│   ├── session.mjs            # HMAC conversation binding, turn locking, UUID validation
│   ├── commandcode/
│   │   └── wire.mjs           # Wire envelope compiler, headers builder, system safeguard
│   ├── ingress/
│   │   ├── anthropic.mjs      # Claude Messages API decoder & token estimator
│   │   ├── responses.mjs      # OpenAI Responses API decoder
│   │   └── chat.mjs           # OpenAI Chat Completions decoder & models formatter
│   ├── transport/
│   │   ├── ndjson.mjs         # Incremental byte-safe UTF-8 NDJSON line parser
│   │   ├── prelude.mjs        # Two-Phase Commit prelude buffer & early error gate
│   │   └── heartbeat.mjs      # 12s idle watchdog anti-stall ping generator
│   └── egress/
│       ├── anthropic.mjs      # Anthropic SSE serializer (0x12 signature, usage normalization)
│       ├── responses.mjs      # OpenAI Responses named-SSE serializer (interleaved items)
│       └── chat.mjs           # OpenAI Chat Completions chunk serializer
└── test/
    └── contract.test.mjs      # Comprehensive contract & architectural verification suite
```

---

## 4. Module Interface Specifications for Downstream Agents

### 4.1 `src/types.mjs`
Defines the lossless internal representation.
- `CanonicalTurn`: Contains `protocol`, `publicModel`, `system[]`, `messages[]`, `tools[]`, `stream`, `maxOutputTokens`, `reasoningEffort`.
- `CanonicalMessage`: Contains `role` (`'user' | 'assistant' | 'tool'`) and `parts[]`.
- `CanonicalPart`: Union of `text`, `image`, `reasoning`, `tool-call`, `tool-result`.
- `BridgeHttpError`: Standard error class producing `{ error: { type, message, status } }`.

### 4.2 `src/session.mjs`
- `createSessionManager({ secret, ttlMs })`:
  - `acquire({ protocol, accountId, headers, body, includeThreadId })`:
    Returns `{ sessionId, threadId, release() }`.
    Throws `409 conversation_busy` if the same conversation is already active.

### 4.3 `src/commandcode/wire.mjs`
- `buildWireHeaders(profile, identity, apiKey)`: Returns authentic 1.54.0 CLI headers.
- `buildWireEnvelope(turn, profile, modelConfig, identity)`: Produces the strictly ordered envelope.
  - Automatically injects `system: [{ type: 'text', text: ' ' }]` when client system prompt is empty.
  - Formats assistant history strictly as `[reasoning, text, tool-call]`.
  - Maps `tool_search` to `search_tools`.

### 4.4 `src/transport/ndjson.mjs`
- `parseNdjsonStream(stream, { maxLineBytes })`:
  Async generator yielding parsed JSON objects. Tolerates partial TCP chunk boundaries, split UTF-8 bytes, and Windows `\r\n`.

### 4.5 `src/transport/prelude.mjs`
- `PreludeBuffer({ maxPreludeBytes, maxWaitMs })`:
  - `ingest(event)`: Returns `true` when content is decisive.
  - Intercepts upfront HTTP 429/401/500 errors before HTTP headers are committed.

### 4.6 `src/transport/heartbeat.mjs`
- `createHeartbeat({ res, protocol, idleIntervalMs })`:
  Watches socket write activity; emits `: ping\n\n` or `: keepalive\n\n` if idle for 12 seconds.

### 4.7 `src/egress/anthropic.mjs`
- `AnthropicSseSerializer`:
  - Generates 0x12 fake thinking signature.
  - Reverses `search_tools` back to `tool_search`.
  - Maps upstream `finishReason: "tool-calls"` to `stop_reason: "tool_use"`.
  - Normalizes token usage using `noCacheTokens` (avoids 2x token inflation).

### 4.8 `src/egress/responses.mjs`
- `ResponsesSseSerializer`:
  - Manages monotonic `sequence_number` (starting at 1).
  - Interleaves concurrent reasoning and tool execution without collisions.
  - Assigns unique `output_index` to each distinct output item.

---

## 5. Verification Matrix

The foundation is verified using Node's native test runner (`npm test`):
1. **Wire Headers & Envelope Contract:** Verified key ordering, empty system placeholder, and tool name mapping.
2. **Multi-turn Assistant Order:** Verified strict `[reasoning, text, tool-call]` ordering and tool result role separation.
3. **Session Manager Concurrency:** Verified mutual-exclusion locking (409 Conflict) and cross-conversation isolation.
4. **Ingress Decoders:** Verified Anthropic (adaptive thinking effort, cache hints) and Responses (item list, function call/output).
5. **NDJSON Chunk Split:** Verified multi-byte UTF-8 split handling and CRLF tolerance.
6. **Two-Phase Commit Prelude:** Verified upfront error interception (429 JSON) and empty reasoning-start handling.
7. **Egress Serializers:** Verified 0x12 thinking signature ('E' prefix) and token normalization.
8. **Loopback Server:** Verified HTTP `/health`, `/v1/models`, and request routing.
