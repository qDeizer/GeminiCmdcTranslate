/**
 * @file anthropic.mjs
 * @description Egress Serializer for Anthropic Messages API (Claude Desktop & Claude Code CLI).
 * 
 * DESIGN INVARIANTS:
 * 1. 0x12 Thinking Signature: Claude Code checks leading 0x12 byte (Base64 starts with 'E').
 *    Emitted as signature_delta before content_block_stop.
 * 2. Token Normalization: Upstream inputTokens includes cache reads. Use noCacheTokens
 *    (inputTokens - cacheRead - cacheWrite) to prevent doubled token counts.
 * 3. Stop Reason Normalization: Upstream "tool-calls" -> Anthropic "tool_use".
 * 4. Tool Name Unaliasing: Wire "search_tools" -> Client "tool_search".
 * 5. State Machine: Exactly one content block is open at a time; properly closed before next block.
 */

import { createHash, randomUUID } from 'node:crypto';
import { fromWireToolName } from '../commandcode/wire.mjs';

export function makeThinkingSignature(thinkingText) {
  const hash = createHash('sha256').update(thinkingText || 'gemini1-thinking').digest();
  const payload = Buffer.concat([Buffer.from([0x12, hash.length]), hash]);
  return payload.toString('base64');
}

export function normalizeUsageForAnthropic(rawUsage = {}) {
  const inputTokens = Number(rawUsage.inputTokens || 0);
  const cacheRead = Number(rawUsage.inputTokenDetails?.cacheReadTokens ?? rawUsage.cachedInputTokens ?? 0);
  const cacheWrite = Number(rawUsage.inputTokenDetails?.cacheWriteTokens ?? 0);
  const noCache = Number(
    rawUsage.inputTokenDetails?.noCacheTokens ?? Math.max(0, inputTokens - cacheRead - cacheWrite)
  );
  const outputTokens = Number(rawUsage.outputTokens || 0);

  return {
    input_tokens: noCache,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: outputTokens
  };
}

export class AnthropicSseSerializer {
  constructor(res, { messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 16)}`, model = 'claude-3-7-sonnet' } = {}) {
    this.res = res;
    this.messageId = messageId;
    this.model = model;
    this.blockIndex = -1;
    this.activeBlock = null; // 'thinking' | 'text' | 'tool_use'
    this.accumulatedThinking = '';
    this.started = false;
  }

  sse(eventType, data) {
    this.res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no'
    });
    if (typeof this.res.flushHeaders === 'function') {
      this.res.flushHeaders();
    }
    if (this.res.socket && typeof this.res.socket.setNoDelay === 'function') {
      this.res.socket.setNoDelay(true);
    }
    this.sse('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  closeCurrentBlock() {
    if (!this.activeBlock) return;

    if (this.activeBlock === 'thinking') {
      const sig = makeThinkingSignature(this.accumulatedThinking);
      this.sse('content_block_delta', {
        type: 'content_block_delta',
        index: this.blockIndex,
        delta: { type: 'signature_delta', signature: sig }
      });
      this.accumulatedThinking = '';
    }

    this.sse('content_block_stop', {
      type: 'content_block_stop',
      index: this.blockIndex
    });
    this.activeBlock = null;
  }

  processEvent(event) {
    if (!this.started) this.start();

    switch (event.type) {
      case 'reasoning-start':
      case 'reasoning-delta': {
        if (!event.text) break;
        if (this.activeBlock !== 'thinking') {
          this.closeCurrentBlock();
          this.blockIndex++;
          this.activeBlock = 'thinking';
          this.sse('content_block_start', {
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: { type: 'thinking', thinking: '' }
          });
        }
        this.accumulatedThinking += event.text;
        this.sse('content_block_delta', {
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: { type: 'thinking_delta', thinking: event.text }
        });
        break;
      }

      case 'text-start':
      case 'text-delta': {
        if (!event.text) break;
        if (this.activeBlock !== 'text') {
          this.closeCurrentBlock();
          this.blockIndex++;
          this.activeBlock = 'text';
          this.sse('content_block_start', {
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: { type: 'text', text: '' }
          });
        }
        this.sse('content_block_delta', {
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: { type: 'text_delta', text: event.text }
        });
        break;
      }

      case 'tool-call': {
        this.closeCurrentBlock();
        this.blockIndex++;
        const callId = event.toolCallId || `toolu_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const clientToolName = fromWireToolName(event.toolName);
        const inputStr = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});

        this.sse('content_block_start', {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: { type: 'tool_use', id: callId, name: clientToolName, input: {} }
        });
        this.sse('content_block_delta', {
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: { type: 'input_json_delta', partial_json: inputStr }
        });
        this.sse('content_block_stop', {
          type: 'content_block_stop',
          index: this.blockIndex
        });
        break;
      }

      case 'finish': {
        this.closeCurrentBlock();
        const rawReason = String(event.finishReason || event.rawFinishReason || '').toLowerCase();
        const stopReason = (rawReason === 'tool-calls' || rawReason === 'tool_calls' || rawReason === 'tool_use')
          ? 'tool_use'
          : (rawReason === 'length' ? 'max_tokens' : 'end_turn');

        const usage = normalizeUsageForAnthropic(event.totalUsage || {});

        this.sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: usage.output_tokens }
        });
        this.sse('message_stop', { type: 'message_stop' });
        break;
      }
    }
  }

  end() {
    this.closeCurrentBlock();
    this.res.end();
  }
}
