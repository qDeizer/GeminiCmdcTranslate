/**
 * @file session.mjs
 * @description Hierarchical Session Manager, HMAC Conversation Binding & Turn Locking.
 * 
 * DESIGN INVARIANTS:
 * 1. Independent conversations never share a native session or thread.
 * 2. The same conversation reuses a stable session across multi-turn exchanges.
 * 3. Concurrent turns on the same active conversation fail fast with 409 Conflict.
 * 4. Raw prompt text is never hashed or stored to prevent cross-project bleeding.
 */

import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { BridgeHttpError } from './types.mjs';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(str) {
  return typeof str === 'string' && UUID_REGEX.test(str);
}

export function createSessionManager({
  secret = process.env.COMMANDCODE_BRIDGE_SECRET || 'gemini1-default-secret-salt-2026',
  now = () => Date.now(),
  ttlMs = 12 * 60 * 60 * 1000 // 12 hours TTL
} = {}) {
  /** @type {Map<string, { sessionId: string, threadId: string, traceId: string, expiresAt: number, busy: boolean }>} */
  const entries = new Map();

  function digest(protocol, accountId, hint) {
    return createHmac('sha256', secret)
      .update(protocol).update('\0')
      .update(accountId).update('\0')
      .update(hint)
      .digest('hex');
  }

  function extractTraceId(headers = {}) {
    const raw = headers['traceparent'];
    if (typeof raw === 'string') {
      const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(raw.trim());
      if (match) return match[1].toLowerCase();
    }
    return null;
  }

  function extractHint(protocol, headers = {}, body = {}) {
    // 1. Direct session headers
    const headerHint = headers['x-session-id'] ||
                       headers['x-claude-code-session-id'] ||
                       headers['x-conversation-id'] ||
                       headers['x-astra-conversation-id'] ||
                       headers['x-codex-window-id'] ||
                       headers['session-id'] ||
                       headers['thread-id'];
    if (headerHint) return String(headerHint);

    // 2. Incoming W3C traceparent header trace-id
    const incomingTrace = extractTraceId(headers);
    if (incomingTrace) return incomingTrace;

    // 3. Body session hints
    if (body.metadata?.session_id) return String(body.metadata.session_id);
    if (body.prompt_cache_key) return String(body.prompt_cache_key);
    if (body.conversation_id) return String(body.conversation_id);
    if (body.conversationId) return String(body.conversationId);
    if (body.session_id) return String(body.session_id);
    if (body.sessionId) return String(body.sessionId);
    if (body.thread_id) return String(body.thread_id);
    if (body.threadId) return String(body.threadId);

    // 4. User ID embedded session
    if (typeof body.metadata?.user_id === 'string') {
      const raw = body.metadata.user_id;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.session_id) return String(parsed.session_id);
      } catch {}
      const match = /_session_([0-9a-f-]{36})/i.exec(raw);
      if (match) return match[1];
      return raw;
    }

    // 5. Multi-turn conversation prefix heuristic (preserves continuity when clients don't send headers)
    if (Array.isArray(body.messages) && body.messages.length > 0) {
      const firstMsg = body.messages[0];
      if (firstMsg) {
        let text = '';
        if (typeof firstMsg.content === 'string') {
          text = firstMsg.content;
        } else if (Array.isArray(firstMsg.content)) {
          const firstBlock = firstMsg.content[0];
          text = typeof firstBlock === 'string' ? firstBlock : (firstBlock?.text || '');
        }
        if (text && text.trim()) {
          return `conv_prefix_${createHmac('sha256', secret).update(text.trim()).digest('hex').slice(0, 16)}`;
        }
      }
    }

    return null;
  }

  /**
   * Acquire session credentials and exclusive lock for a turn.
   * 
   * @param {Object} params
   * @param {'anthropic'|'responses'|'chat'} params.protocol
   * @param {string} params.accountId
   * @param {Record<string, any>} [params.headers]
   * @param {Record<string, any>} [params.body]
   * @param {boolean} [params.includeThreadId=true]
   * @returns {{ sessionId: string, threadId?: string, traceId: string, newSpanId: () => string, release: () => void }}
   */
  function acquire({ protocol, accountId, headers = {}, body = {}, includeThreadId = true }) {
    // 1. Clean expired entries periodically
    const currentTime = now();
    for (const [k, v] of entries.entries()) {
      if (v.expiresAt <= currentTime) entries.delete(k);
    }

    // 2. Resolve conversation hint
    const incomingTraceId = extractTraceId(headers);
    const hint = extractHint(protocol, headers, body);
    const key = hint ? digest(protocol, accountId, String(hint)) : randomUUID();

    let entry = entries.get(key);
    if (!entry || entry.expiresAt <= currentTime) {
      entry = {
        sessionId: randomUUID(),
        threadId: randomUUID(),
        traceId: incomingTraceId || randomBytes(16).toString('hex'),
        expiresAt: currentTime + ttlMs,
        busy: false
      };
      entries.set(key, entry);
    } else if (incomingTraceId && entry.traceId !== incomingTraceId) {
      entry.traceId = incomingTraceId;
    }

    // 3. Mutual exclusion check on active turns
    if (entry.busy) {
      throw new BridgeHttpError(409, 'conversation_busy', 'Another turn is actively processing in this conversation.');
    }

    entry.busy = true;
    entry.expiresAt = currentTime + ttlMs;

    let released = false;
    return {
      sessionId: entry.sessionId,
      threadId: includeThreadId ? entry.threadId : undefined,
      traceId: entry.traceId,
      newSpanId() {
        return randomBytes(8).toString('hex');
      },
      release() {
        if (!released) {
          released = true;
          entry.busy = false;
        }
      }
    };
  }

  return { acquire, isValidUuid };
}
