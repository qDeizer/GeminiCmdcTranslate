/**
 * @file prelude.mjs
 * @description Two-Phase Commit Prelude Buffer for Upstream Error Interception.
 * 
 * DESIGN INVARIANTS:
 * 1. Do NOT commit HTTP 200 text/event-stream headers immediately upon connection.
 * 2. Buffer early upstream events until the first decisive content block arrives
 *    (non-empty text-delta, non-empty reasoning-delta, tool-input-start, tool-call).
 * 3. Empty reasoning-start ({ type: 'reasoning-start', text: '' }) does NOT trigger commitment,
 *    allowing rate-limit (429) or quota errors occurring immediately after to be returned as clean JSON.
 * 4. Once committed, the buffer flushes to downstream and streaming mode becomes irrevocable.
 */

import { BridgeHttpError } from '../types.mjs';

export class PreludeBuffer {
  constructor({ maxPreludeBytes = 64 * 1024, maxWaitMs = 2500 } = {}) {
    this.maxPreludeBytes = maxPreludeBytes;
    this.maxWaitMs = maxWaitMs;
    this.committed = false;
    this.events = [];
    this.bufferedBytes = 0;
    this.startedAt = Date.now();
  }

  /**
   * Evaluates whether an upstream event should trigger commitment of HTTP 200.
   * @param {Record<string, any>} event
   * @returns {boolean}
   */
  isDecisive(event) {
    if (!event || typeof event !== 'object') return false;

    // Upstream error or terminal abort must NOT commit HTTP 200
    if (event.type === 'error' || event.type === 'abort' || event.statusCode >= 400) {
      return false;
    }

    // Decisive events that signal actual content flow - commit IMMEDIATELY on first token
    if (event.type === 'text-delta' ||
        event.type === 'reasoning-delta' ||
        event.type === 'tool-input-start' ||
        event.type === 'tool-input-delta' ||
        event.type === 'tool-call' ||
        ((event.type === 'reasoning-start' || event.type === 'text-start') && typeof event.text === 'string' && event.text.length > 0)) {
      return true;
    }

    // Byte limit or time limit exceeded forces commitment
    if (this.bufferedBytes >= this.maxPreludeBytes) return true;
    if (Date.now() - this.startedAt >= this.maxWaitMs && this.events.length > 0) return true;

    return false;
  }

  /**
   * Ingests an event before commitment.
   * If an error occurs, throws BridgeHttpError before HTTP headers are sent.
   * 
   * @param {Record<string, any>} event
   * @returns {boolean} true if HTTP headers should now be committed
   */
  ingest(event) {
    if (this.committed) return true;

    // Check for upfront upstream error
    if (event.type === 'error' || event.statusCode >= 400) {
      const status = event.statusCode || event.status || 502;
      const msg = event.message || event.error?.message || 'Upstream Command Code error';
      throw new BridgeHttpError(status, 'upstream_error', msg, { upstreamEvent: event });
    }

    this.events.push(event);
    this.bufferedBytes += JSON.stringify(event).length;

    if (this.isDecisive(event)) {
      this.committed = true;
      return true;
    }

    return false;
  }

  /**
   * Drains buffered events upon commitment.
   * @returns {Array<Record<string, any>>}
   */
  flush() {
    this.committed = true;
    const drained = this.events;
    this.events = [];
    return drained;
  }
}
