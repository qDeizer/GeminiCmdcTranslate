/**
 * @file responses.mjs
 * @description Egress Serializer for OpenAI Responses API (ChatGPT Desktop Codex Mode).
 * 
 * DESIGN INVARIANTS:
 * 1. Monotonic sequence_number: Every single emitted SSE event MUST contain an incrementing
 *    sequence_number starting at 1.
 * 2. Interleaved Items: Reasoning (rs_...) and function call (fc_...) can be open concurrently!
 *    Track active items using a Map<string, ActiveItem> instead of a single variable.
 * 3. Dynamic output_index: Each distinct output item receives its own unique output_index.
 * 4. tool_search mapping: Native search_tools maps to type: 'tool_search_call' with execution: 'client'.
 * 5. Terminal [DONE]: Emitted after response.completed.
 */

import { randomUUID } from 'node:crypto';
import { fromWireToolName } from '../commandcode/wire.mjs';

export class ResponsesSseSerializer {
  constructor(res, { responseId = `resp_${randomUUID().replace(/-/g, '').slice(0, 16)}`, model = 'gpt-4o' } = {}) {
    this.res = res;
    this.responseId = responseId;
    this.model = model;
    this.sequence = 1;
    this.nextOutputIndex = 0;
    this.activeItems = new Map();
    this.completedItems = [];
    this.started = false;
  }

  emit(eventType, data = {}) {
    this.res.write(`event: ${eventType}\ndata: ${JSON.stringify({
      type: eventType,
      sequence_number: this.sequence++,
      ...data
    })}\n\n`);
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
    this.emit('response.created', {
      response: { id: this.responseId, status: 'in_progress', model: this.model }
    });
    this.emit('response.in_progress', {
      response: { id: this.responseId, status: 'in_progress' }
    });
  }

  processEvent(event) {
    if (!this.started) this.start();

    switch (event.type) {
      case 'reasoning-delta': {
        let reasoningItem = this.activeItems.get('reasoning');
        if (!reasoningItem) {
          const id = `rs_${this.responseId}`;
          const outIdx = this.nextOutputIndex++;
          reasoningItem = {
            id,
            type: 'reasoning',
            outputIndex: outIdx,
            summaryIndex: 0,
            textBuf: ''
          };
          this.activeItems.set('reasoning', reasoningItem);

          this.emit('response.output_item.added', {
            output_index: outIdx,
            item: { id, type: 'reasoning', summary: [] }
          });
          this.emit('response.reasoning_summary_part.added', {
            item_id: id,
            output_index: outIdx,
            summary_index: 0,
            part: { type: 'summary_text', text: '' }
          });
        }

        reasoningItem.textBuf += event.text;
        this.emit('response.reasoning_summary_text.delta', {
          item_id: reasoningItem.id,
          output_index: reasoningItem.outputIndex,
          summary_index: 0,
          delta: event.text
        });
        break;
      }

      case 'text-delta': {
        let msgItem = this.activeItems.get('message');
        if (!msgItem) {
          const id = `msg_${this.responseId}`;
          const outIdx = this.nextOutputIndex++;
          msgItem = {
            id,
            type: 'message',
            outputIndex: outIdx,
            contentIndex: 0,
            textBuf: ''
          };
          this.activeItems.set('message', msgItem);

          this.emit('response.output_item.added', {
            output_index: outIdx,
            item: { id, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
          });
          this.emit('response.content_part.added', {
            item_id: id,
            output_index: outIdx,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] }
          });
        }

        msgItem.textBuf += event.text;
        this.emit('response.output_text.delta', {
          item_id: msgItem.id,
          output_index: msgItem.outputIndex,
          content_index: 0,
          delta: event.text
        });
        break;
      }

      case 'tool-call': {
        // Interleaving support: function call item starts without closing ongoing reasoning!
        const callId = event.toolCallId || `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const outIdx = this.nextOutputIndex++;
        const isSearch = event.toolName === 'search_tools';
        const clientName = fromWireToolName(event.toolName);
        const argsStr = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});

        const itemType = isSearch ? 'tool_search_call' : 'function_call';
        const itemId = `${isSearch ? 'tsc' : 'fc'}_${callId}`;

        const itemPayload = isSearch
          ? { id: itemId, type: itemType, execution: 'client', name: clientName, arguments: '' }
          : { id: itemId, type: itemType, call_id: callId, name: clientName, arguments: '' };

        this.emit('response.output_item.added', {
          output_index: outIdx,
          item: itemPayload
        });

        this.emit('response.function_call_arguments.delta', {
          item_id: itemId,
          output_index: outIdx,
          delta: argsStr
        });

        this.emit('response.function_call_arguments.done', {
          item_id: itemId,
          output_index: outIdx,
          arguments: argsStr
        });

        const completedItem = {
          ...itemPayload,
          outputIndex: outIdx,
          arguments: argsStr,
          status: 'completed'
        };

        this.emit('response.output_item.done', {
          output_index: outIdx,
          item: completedItem
        });

        this.completedItems.push(completedItem);
        break;
      }

      case 'finish': {
        // Close reasoning item if open
        const reasoning = this.activeItems.get('reasoning');
        if (reasoning) {
          this.emit('response.reasoning_summary_text.done', {
            item_id: reasoning.id,
            output_index: reasoning.outputIndex,
            summary_index: 0,
            text: reasoning.textBuf
          });
          this.emit('response.reasoning_summary_part.done', {
            item_id: reasoning.id,
            output_index: reasoning.outputIndex,
            summary_index: 0
          });
          const doneReasoning = {
            id: reasoning.id,
            type: 'reasoning',
            outputIndex: reasoning.outputIndex,
            summary: [{ type: 'summary_text', text: reasoning.textBuf }],
            status: 'completed'
          };
          this.emit('response.output_item.done', {
            output_index: reasoning.outputIndex,
            item: doneReasoning
          });
          this.completedItems.push(doneReasoning);
          this.activeItems.delete('reasoning');
        }

        // Close message item if open
        const message = this.activeItems.get('message');
        if (message) {
          this.emit('response.output_text.done', {
            item_id: message.id,
            output_index: message.outputIndex,
            content_index: 0,
            text: message.textBuf
          });
          const part = { type: 'output_text', text: message.textBuf, annotations: [] };
          this.emit('response.content_part.done', {
            item_id: message.id,
            output_index: message.outputIndex,
            content_index: 0,
            part
          });
          const doneMessage = {
            id: message.id,
            type: 'message',
            role: 'assistant',
            outputIndex: message.outputIndex,
            status: 'completed',
            content: [part]
          };
          this.emit('response.output_item.done', {
            output_index: message.outputIndex,
            item: doneMessage
          });
          this.completedItems.push(doneMessage);
          this.activeItems.delete('message');
        }

        const sortedOutput = [...this.completedItems].sort((a, b) => (a.outputIndex ?? 0) - (b.outputIndex ?? 0));
        this.emit('response.completed', {
          response: {
            id: this.responseId,
            status: 'completed',
            output: sortedOutput,
            usage: event.totalUsage || {}
          }
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
