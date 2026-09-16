/**
 * @file chat.mjs
 * @description Egress Serializer for OpenAI Chat Completions API.
 * 
 * Supports:
 * - Streaming SSE chunks (POST /v1/chat/completions)
 * - Finish reason normalization ("tool-calls" -> "tool_calls")
 */

import { randomUUID } from 'node:crypto';
import { fromWireToolName } from '../commandcode/wire.mjs';

export class ChatSseSerializer {
  constructor(res, { completionId = `chatcmpl_${randomUUID().replace(/-/g, '').slice(0, 16)}`, model = 'gpt-4o' } = {}) {
    this.res = res;
    this.completionId = completionId;
    this.model = model;
    this.started = false;
    this.toolIndex = 0;
  }

  sse(data) {
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
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
    // First chunk with role
    this.sse({
      id: this.completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
    });
  }

  processEvent(event) {
    if (!this.started) this.start();

    switch (event.type) {
      case 'text-delta': {
        this.sse({
          id: this.completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: this.model,
          choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }]
        });
        break;
      }

      case 'tool-call': {
        const callId = event.toolCallId || `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const argsStr = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
        this.sse({
          id: this.completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: this.model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: this.toolIndex++,
                id: callId,
                type: 'function',
                function: { name: fromWireToolName(event.toolName), arguments: argsStr }
              }]
            },
            finish_reason: null
          }]
        });
        break;
      }

      case 'finish': {
        const rawReason = String(event.finishReason || event.rawFinishReason || '').toLowerCase();
        const finishReason = (rawReason === 'tool-calls' || rawReason === 'tool_calls' || rawReason === 'tool_use')
          ? 'tool_calls'
          : (rawReason === 'length' ? 'length' : 'stop');

        this.sse({
          id: this.completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: this.model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
        });
        this.res.write('data: [DONE]\n\n');
        break;
      }
    }
  }

  end() {
    this.res.end();
  }
}
