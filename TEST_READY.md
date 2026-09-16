# TEST_READY: Gemini1 4-Tier E2E Test Suite Specification & Results

**Status**: ALL TESTS PASSING (100% Pass Rate)  
**Date**: 2026-09-15  
**Target Codebase**: `C:\Users\Emre\Desktop\Taha\Gemini1`  
**External Runtime Dependencies**: 0 (Pure Node.js built-ins)  

---

## 1. Test Runner & Verification Commands

```bash
# Execute entire 4-tier E2E test suite (66 tests across 5 test files)
npm test

# Validate syntax across all 12 source modules
npm run check
```

### Baseline Execution Output:
```
> gemini1-commandcode-bridge@1.0.0 test
> node --test test/*.test.mjs

✔ 1. Wire Headers & Envelope Contract (3.4ms)
✔ 2. Multi-turn Assistant Strict Ordering & Tool Result Separation (0.3ms)
✔ 3. Session Manager Concurrency Locking & Isolation (2.0ms)
✔ 4. Ingress Decoders Fidelity (1.2ms)
✔ 5. Incremental NDJSON Parser with Split Chunks (0.9ms)
✔ 6. Two-Phase Commit Prelude Error Interception (0.5ms)
✔ 7. Egress Serialization Invariants (1.3ms)
✔ 8. Server Loopback & Health Check (40.7ms)
✔ Egress: Anthropic - start() commits HTTP 200 headers and message_start event (1.7ms)
✔ Egress: Anthropic - 0x12 thinking signature delta emitted before content_block_stop (1.0ms)
✔ Egress: Anthropic - makeThinkingSignature invariants across empty and non-empty text (0.2ms)
✔ Egress: Anthropic - tool_call block unaliases search_tools to tool_search (0.5ms)
✔ Egress: Anthropic - finish event stop_reason normalization and token usage (0.5ms)
✔ Egress: Anthropic - normalizeUsageForAnthropic prevents double counting with noCacheTokens (0.2ms)
✔ Egress: Anthropic - end() closes active block and finishes stream (0.2ms)
✔ Egress: Responses - Monotonic sequence_number starts strictly at 1 and increases monotonically (0.8ms)
✔ Egress: Responses - Unique output_index per item (0.5ms)
✔ Egress: Responses - Concurrent interleaved reasoning (rs_...) and tool calling (fc_...) (0.5ms)
✔ Egress: Responses - Native search_tools maps to type tool_search_call with execution client (0.3ms)
✔ Egress: Responses - Finish event emits response.completed and terminal [DONE] (0.3ms)
✔ Egress: Chat - start() emits initial chunk with assistant role and empty content (0.2ms)
✔ Egress: Chat - text-delta emits streaming chunks (0.3ms)
✔ Egress: Chat - tool-call emits function call delta with incremental index (0.2ms)
✔ Egress: Chat - finish event normalizes finish_reason and emits [DONE] (0.3ms)
✔ Egress: Chat - end() terminates response stream (0.1ms)
✔ Replay: Anthropic - Basic text stream translates to standard Claude SSE frames (49.4ms)
✔ Replay: Anthropic - Muse Spark deep reasoning stream with 0x12 signature and token normalization (17.8ms)
✔ Replay: Anthropic - Tool call unaliases search_tools to tool_search with tool_use stop reason (10.8ms)
✔ Replay: Responses - Monotonic sequence numbering and unique output indexing (11.3ms)
✔ Replay: Responses - Interleaved reasoning and tool calls execute concurrently (13.6ms)
✔ Replay: Prelude - Non-decisive start followed by 429 returns clean JSON 429 (8.5ms)
✔ Replay: Transport - High packet fragmentation (3-byte slices) parses cleanly without corruption (1459.3ms)
✔ Server: Health endpoints - GET /health and GET /healthz return 200 OK (41.1ms)
✔ Server: Models endpoint - GET /v1/models returns standard model list (10.1ms)
✔ Server: Token counting - POST /v1/messages/count_tokens returns estimated count and header (11.3ms)
✔ Server: Path Normalization - POST /v1/v1/messages rewrites transparently to /v1/messages (12.6ms)
✔ Server: Concurrency - Second concurrent request to same conversation produces HTTP 409 Conflict (91.8ms)
✔ Server: Responses - Rejection of previous_response_id with HTTP 422 unsupported_feature (5.6ms)
✔ Server: Wire - Empty system single-space safeguard injected upstream (7.2ms)
✔ Server: Wire - Orphan tool result rejected with HTTP 422 orphan_tool_result (3.9ms)
✔ Server: Prelude - Upstream HTTP 401 returns clean JSON 401 before 200 committed (5.7ms)
✔ Server: Prelude - Upstream HTTP 429 returns clean JSON 429 before 200 committed (6.2ms)
✔ Server: Prelude - Upstream HTTP 500 returns clean JSON 500 before 200 committed (5.7ms)
✔ Server: Prelude - Early NDJSON error event before decisive events caught as clean JSON (6.2ms)
✔ Server: Auth - Missing upstream API key returns HTTP 401 missing_upstream_api_key (3.9ms)
✔ Server: Validation - Malformed JSON request body returns HTTP 400 invalid_json (4.5ms)
✔ Server: Routing - Non-existent route returns HTTP 404 route_not_found (2.8ms)
✔ Transport: Heartbeat - Anthropic emits ping frame after idle silence (1161.0ms)
✔ Transport: Heartbeat - Responses/Chat emits : keepalive after idle silence (1161.1ms)
✔ Transport: Heartbeat - touch() resets idle timer preventing premature heartbeat (1227.1ms)
✔ Transport: Heartbeat - skips frame when client socket buffer needs drain (backpressure) (1157.8ms)
✔ Transport: Heartbeat - stop() stops watchdog and ignores destroyed response (1155.5ms)
✔ Transport: Heartbeat - stops automatically when response is ended or destroyed (1154.0ms)
✔ Transport: Prelude - Non-decisive events do not commit HTTP 200 (1.4ms)
✔ Transport: Prelude - Decisive events trigger commitment (0.3ms)
✔ Transport: Prelude - Upstream 401, 429, 500 error interception before 200 commitment (1.2ms)
✔ Transport: Prelude - Buffer byte overflow forces commitment (0.5ms)
✔ Transport: Prelude - Timeout with buffered events forces commitment (64.4ms)
✔ Transport: Prelude - flush() returns FIFO drained events and marks committed (1.7ms)
✔ Transport: NDJSON - Arbitrary byte chunk splitting across JSON keys and values (0.8ms)
✔ Transport: NDJSON - Multi-byte UTF-8 code points split across chunk boundaries (0.5ms)
✔ Transport: NDJSON - Handles mixed CRLF, LF, empty lines, and spaces (0.4ms)
✔ Transport: NDJSON - Trailing complete JSON line without trailing newline at EOF (0.4ms)
✔ Transport: NDJSON - Exceeding maxLineBytes throws 502 upstream_line_too_large (0.7ms)
✔ Transport: NDJSON - Malformed JSON line throws 502 invalid_upstream_json (0.6ms)
✔ Transport: NDJSON - Truncated JSON at stream EOF throws 502 truncated_upstream_json (0.5ms)
ℹ tests 66
ℹ suites 0
ℹ pass 66
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

---

## 2. Test Suite Topology & Tier Coverage Breakdown

| Test File | Primary Focus Area | Number of Tests | Pass / Fail |
|:---|:---|:---:|:---:|
| `test/contract.test.mjs` | Foundational contracts & baseline unit verification | 8 | 8 / 0 |
| `test/transport.test.mjs` | 12s Watchdog, Two-Phase Prelude, Incremental NDJSON | 19 | 19 / 0 |
| `test/egress.test.mjs` | Anthropic 0x12 thinking, Responses seq/index/interleaving, Chat deltas | 17 | 17 / 0 |
| `test/server.test.mjs` | HTTP loopback, 409 conflict, /v1/v1/ rewrite, token counting, models, safeguards | 15 | 15 / 0 |
| `test/replay.test.mjs` | Live production recordings replay, packet fragmentation stress | 7 | 7 / 0 |
| **Total** | **All 4 Testing Tiers** | **66** | **66 / 0** |

### 4-Tier Test Mapping:

- **Tier 1 - Feature Coverage (>=5 tests per feature area)**:
  - Transport (Watchdog, Prelude, NDJSON): 19 tests
  - Egress (Anthropic, Responses, Chat): 17 tests
  - Server & Router (Endpoints, Normalization, Guarding): 15 tests
- **Tier 2 - Boundary & Corner Cases**:
  - Buffer byte overflow & timeout forced commitment (`test/transport.test.mjs`)
  - Multi-byte UTF-8 code point split across arbitrary chunk boundaries without replacement characters (`test/transport.test.mjs`)
  - Empty, missing, and extreme-length reasoning thinking signatures (`test/egress.test.mjs`)
  - Orphan tool results rejected with HTTP 422 (`test/server.test.mjs`)
  - Missing authorization key rejected with HTTP 401 (`test/server.test.mjs`)
  - Malformed request JSON rejected with HTTP 400 (`test/server.test.mjs`)
  - Oversized NDJSON line rejected with HTTP 502 (`test/transport.test.mjs`)
- **Tier 3 - Cross-Feature Combinations**:
  - Interleaved active items: concurrent reasoning (`rs_...`) and tool calling (`fc_...`) executing without closing reasoning (`test/egress.test.mjs`, `test/replay.test.mjs`)
  - Watchdog heartbeat backpressure awareness: drops ping when client buffer is congested (`test/transport.test.mjs`)
  - Concurrency lock collision on active conversation (HTTP 409) followed by lease release and successful subsequent turn (`test/server.test.mjs`)
  - Two-Phase Commit Prelude: non-decisive empty reasoning-start followed by delayed 429 rate limit error intercepted as clean HTTP 429 JSON response before HTTP 200 headers committed (`test/server.test.mjs`, `test/replay.test.mjs`)
- **Tier 4 - Real-World Application Scenarios (Replay Fixtures)**:
  - `stream_basic_text.ndjson`: Full Claude Messages completion assembly
  - `stream_reasoning_muse.ndjson`: Deep reasoning Muse Spark stream with Base64 0x12 thinking signature and `noCacheTokens` usage normalization
  - `stream_tool_call_search.ndjson`: Tool search unaliasing and client execution mapping
  - `stream_interleaved_reasoning_tool.ndjson`: Full multi-turn concurrent tool calling and reasoning accumulation
  - `stream_delayed_rate_limit.ndjson`: Upstream delayed rate limiting interception
  - Severe TCP packet fragmentation (3-byte slices) assembly stress testing

---

## 3. Requirement Conformance Checklist

### R1. Preserve Core Wire Invariants (CLI 1.54.0)
- [x] **R1.1 Headers**: Exact CLI 1.54.0 headers constructed (`User-Agent: cli`, `x-command-code-version: 1.54.0`, `x-cli-environment: production`, `x-project-slug`).
- [x] **R1.2 Envelope Ordering**: Strictly ordered keys (`config`, `memory: null`, `taste: null`, `skills: null`, `permissionMode: "auto-accept"`, `threadId`, `params`).
- [x] **R1.3 Empty System Safeguard**: `emptySystem: 'single-space'` (`[{ type: 'text', text: ' ' }]`) verified end-to-end on loopback server, preventing upstream ~14K prompt injection.
- [x] **R1.4 Assistant Role Ordering**: Enforces `[reasoning, text, tool-call]` order in assistant turns.
- [x] **R1.5 User Turn Separation**: Emits `role: 'tool'` prior to `role: 'user'` on tool result turns.
- [x] **R1.6 Tool Name Aliasing**: Bidirectional `tool_search` $\leftrightarrow$ `search_tools` mapping verified across wire and egress.

### R2. Client Protocol Fidelity
- [x] **R2.1 Anthropic Messages**: `POST /v1/messages` and path-normalized `POST /v1/v1/messages` return valid Claude SSE streams.
- [x] **R2.2 0x12 Thinking Signature**: Emits Base64 signature starting with `'E'` (byte `0x12`) in `signature_delta` before `content_block_stop`.
- [x] **R2.3 Token Usage Normalization**: Calculates `noCacheTokens` (`inputTokens - cacheRead - cacheWrite`) to eliminate 2x displayed token inflation in Claude CLI.
- [x] **R2.4 Token Preflight Estimation**: `POST /v1/messages/count_tokens` returns estimated tokens and `x-bridge-token-count: estimate` header.
- [x] **R2.5 OpenAI Responses (Codex Mode)**: Monotonic `sequence_number` strictly starting at 1 on every frame, unique `output_index` per distinct item.
- [x] **R2.6 Concurrent Items Interleaving**: `activeItems` Map manages concurrent `rs_...` reasoning and `fc_...` tool calls without premature block termination.
- [x] **R2.7 Tool Search Mapping**: Translates native `search_tools` to `type: "tool_search_call"`, `execution: "client"`.
- [x] **R2.8 Unsupported Feature Guard**: Rejects `previous_response_id` with HTTP 422 `unsupported_feature`.
- [x] **R2.9 OpenAI Chat Completions**: Handles `POST /v1/chat/completions` deltas and `GET /v1/models` listing.

### R3. Resilient Transport & Streaming
- [x] **R3.1 Two-Phase Commit Prelude**: Buffers early events; intercepts upstream 401, 429, 500, and early NDJSON errors before HTTP 200 headers are sent.
- [x] **R3.2 Anti-Stall 12s Watchdog**: Sends `event: ping\ndata: {"type":"ping"}\n\n` (Anthropic) or `: keepalive\n\n` (Responses/Chat) during idle silence; skips during socket congestion.
- [x] **R3.3 Concurrency Turn Locking**: Rejects overlapping turns on the same active conversation with HTTP 409 `conversation_busy`; releases lease cleanly in `finally`.
- [x] **R3.4 Incremental NDJSON Parser**: Robust UTF-8 chunk parsing handling fragmented packets, multi-byte code points across boundaries, CRLF, and 8MB line limits.

---

## 4. Zero External Dependencies Verification

```json
{
  "name": "gemini1-commandcode-bridge",
  "dependencies": {},
  "devDependencies": {}
}
```
All tests, serializers, parsers, and servers operate strictly on Node.js built-ins:
- `node:test` (Native Test Runner)
- `node:assert/strict` (Assertions)
- `node:http` (HTTP Server & Loopback Client)
- `node:crypto` (HMAC Session Hashing & 0x12 Signature SHA-256)
- `node:fs/promises` (Fixture Loading)
- `node:path` / `node:url` (ESM Path Resolution)
