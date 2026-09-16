# Gemini1: Command Code Native Translation Bridge

> **High-fidelity, zero-dependency translation gateway connecting Claude Desktop, Claude Code CLI, and ChatGPT Codex Desktop to Command Code upstream inference (`/alpha/generate`).**

---

## Features

- **Zero External Dependencies:** Built with pure Node.js standard libraries (`node:http`, `node:https`, `node:crypto`, `node:stream`).
- **Web Dashboard UI (`/ui` or `/`):** Single-page visual manager for configuring API keys, discovering upstream models, and editing model aliases with live persistence to `config.json`.
- **Dynamic Model Discovery:** Queries Command Code upstream (`/provider/v1/models`, `/alpha/models`, `/v1/models`) to list accessible models, with offline fallback catalog.
- **Adaptive Reasoning Effort Mapping:** Maps Claude `budget_tokens` and OpenAI `reasoning_effort` to Command Code levels (`low`, `medium`, `high`, `xhigh`, `max`) with automatic model-aware clamping.
- **Direct 1-Hop Architecture:** Real-time token-by-token streaming with TCP Nagle disabled (`setNoDelay`) and immediate first-token prelude flushing.
- **W3C Traceparent & Multi-Turn Session Continuity:** Reuses consistent `x-session-id`, `threadId`, and `traceId` across consecutive turns.
- **Empty System Safeguard (~14K Token Bypass):** Injects `[{ type: "text", text: " " }]` when no system prompt is provided, dropping input tokens from ~13,912 down to ~85!
- **Claude Code 0x12 Thinking Signature:** Produces valid `signature_delta` compatible with Claude Code CLI shallow-verification.
- **Codex Responses Interleaved State Machine:** Monotonic `sequence_number` (starting at 1), distinct `output_index` per item, and support for concurrent reasoning + tool calling.
- **Anti-Stall Heartbeat Watchdog:** 12-second idle keeper (`event: ping` / `: keepalive`) preventing socket dropouts during long thinking sessions.
- **Two-Phase Commit Prelude:** Buffers early frames to catch upfront upstream errors (401, 429, 500) and return clean HTTP JSON before committing SSE headers.

---

## Quick Start

### 1. Requirements
- Node.js `>= 22.0.0`

### 2. Running the Bridge
```bash
# Set your Command Code API key:
export COMMANDCODE_API_KEY="user_your_key_here"

# (Optional) Set a local gateway security token:
export COMMANDCODE_BRIDGE_TOKEN="optional_secret_token"

# Start the server (default port 8741):
npm start
```

### 3. Dashboard Web UI
Once the server is running, visit:
```
http://127.0.0.1:8741/ui
```
In the Dashboard you can:
- Enter and save your Command Code API Key.
- Click **"Verify & Discover Models"** to query upstream Command Code API for available models.
- Map client models (Claude Code / Codex / OpenAI) to Command Code models, adjust reasoning effort, and set max tokens.
- Save settings directly to `config.json`.

### 4. Running Verification Tests
```bash
# Run 106 unit & integration tests:
npm test

# Run 9 Tier-5 adversarial edge-case tests:
node test/tier5_adversarial.mjs

# Run syntax verification check across all 15 modules:
npm run check
```

---

## Client Configurations

### 1. Claude Desktop App
Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {},
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8741",
    "ANTHROPIC_API_KEY": "user_your_commandcode_api_key"
  }
}
```

### 2. Claude Code CLI
```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8741"
export ANTHROPIC_API_KEY="user_your_commandcode_api_key"
claude
```

### 3. ChatGPT Codex Desktop (Codex Mode)
In your Codex configuration (`~/.codex/config.toml` or UI):
```toml
[model_providers.commandcode]
base_url = "http://127.0.0.1:8741/backend-api/codex"
wire_api = "responses"
stream_idle_timeout_ms = 360000
```

### 4. Standard OpenAI Python SDK
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8741/v1",
    api_key="user_your_commandcode_api_key"
)

response = client.chat.completions.create(
    model="meta/muse-spark-1.3-contributor",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

---

## Project Structure

- `src/types.mjs`: Canonical Turn model, part union definitions, and error formatting.
- `src/session.mjs`: Hierarchical HMAC conversation binding, W3C traceparent extraction, turn locking (409 Conflict), and TTL management.
- `src/commandcode/wire.mjs`: Native 1.54.0 CLI headers, envelope compiler, tool name mapper, and empty system safeguard.
- `src/commandcode/effort.mjs`: Model-adaptive reasoning effort mapper, token budget translator, and model catalog.
- `src/ui/dashboard.mjs`: Zero-dependency single-page HTML/CSS/JS dashboard.
- `src/ingress/`:
  - `anthropic.mjs`: Claude Messages decoder (`/v1/messages`, `/v1/v1/messages`, `/count_tokens`).
  - `responses.mjs`: OpenAI Responses decoder (`/v1/responses`, `/backend-api/codex/responses`).
  - `chat.mjs`: OpenAI Chat decoder (`/v1/chat/completions`, `/v1/models`).
- `src/transport/`:
  - `ndjson.mjs`: Incremental, chunk-safe UTF-8 NDJSON parser.
  - `prelude.mjs`: Two-Phase Commit prelude buffer & early error gate.
  - `heartbeat.mjs`: 12-second anti-stall ping keeper.
- `src/egress/`:
  - `anthropic.mjs`: Claude SSE serializer (0x12 thinking signature, usage normalization).
  - `responses.mjs`: Codex Responses named-SSE serializer (monotonic sequence, interleaved items).
  - `chat.mjs`: OpenAI Chat chunk serializer.
- `src/server.mjs`: HTTP gateway dispatcher, routing, and lifecycle orchestrator.
- `test/`:
  - `contract.test.mjs`, `transport.test.mjs`, `egress.test.mjs`, `server.test.mjs`, `replay.test.mjs`, `features_2026.test.mjs`: 106 automated tests.
  - `tier5_adversarial.mjs`: 9 standalone adversarial edge-case stress tests.

---

## Instructions for Downstream Agents

If you are an agent building upon this foundation:
1. **Preserve Wire Fidelity:** Do not modify the key order in `src/commandcode/wire.mjs`.
2. **Do Not Bypass the Safeguard:** The empty system placeholder in `wire.mjs` is critical to prevent 14K token enjection.
3. **Use the CanonicalTurn Model:** When adding new client protocols, decode them into `CanonicalTurn` in `src/ingress/` rather than modifying `wire.mjs`.
4. **Maintain 1-Hop Streaming:** Keep streaming reducers in `src/egress/` tied directly to the native NDJSON events.
5. **Run Tests:** Always verify your changes with `npm test` and `npm run check`.
