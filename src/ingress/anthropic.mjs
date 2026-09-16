/**
 * @file anthropic.mjs
 * @description Ingress Adapter for Anthropic Messages API (Claude Desktop & Claude Code CLI).
 * 
 * Supports:
 * - POST /v1/messages
 * - POST /v1/v1/messages (Path-normalized Claude Desktop duplicate /v1)
 * - POST /v1/messages/count_tokens
 */

import { BridgeHttpError, assertObject } from '../types.mjs';

/**
 * Decodes an Anthropic Messages request body into a CanonicalTurn.
 * 
 * @param {Record<string, any>} body
 * @returns {import('../types.mjs').CanonicalTurn}
 */
export function decodeAnthropicRequest(body) {
  assertObject(body, 'Anthropic request body must be a JSON object');

  const publicModel = String(body.model || '').trim();
  if (!publicModel) {
    throw new BridgeHttpError(400, 'missing_model', 'Anthropic request requires a "model" parameter.');
  }

  // 1. System blocks
  const system = [];
  if (typeof body.system === 'string' && body.system.trim()) {
    system.push({ text: body.system.trim() });
  } else if (Array.isArray(body.system)) {
    for (const sec of body.system) {
      if (typeof sec === 'string') {
        system.push({ text: sec });
      } else if (sec && typeof sec === 'object' && sec.type === 'text') {
        system.push({
          text: String(sec.text || ''),
          cache: sec.cache_control?.type === 'ephemeral' ? 'ephemeral' : false
        });
      }
    }
  }

  // 2. Messages translation
  if (!Array.isArray(body.messages)) {
    throw new BridgeHttpError(400, 'invalid_messages', 'Anthropic "messages" must be an array.');
  }

  const messages = [];
  for (const msg of body.messages) {
    assertObject(msg, 'Each message item must be an object');
    const role = msg.role;
    if (role !== 'user' && role !== 'assistant') {
      throw new BridgeHttpError(400, 'invalid_role', `Unsupported Anthropic role "${role}".`);
    }

    const parts = [];

    // Simple string content
    if (typeof msg.content === 'string') {
      parts.push({ type: 'text', text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        assertObject(block, 'Content block must be an object');
        const blockType = block.type;

        if (blockType === 'text') {
          parts.push({ type: 'text', text: String(block.text || '') });
        } else if (blockType === 'thinking') {
          // Replayed thinking block from a previous assistant turn
          parts.push({
            type: 'reasoning',
            text: String(block.thinking || ''),
            bridgeSignature: typeof block.signature === 'string' ? block.signature : undefined
          });
        } else if (blockType === 'tool_use') {
          parts.push({
            type: 'tool-call',
            id: String(block.id || ''),
            name: String(block.name || ''),
            input: assertObject(block.input || {}, `Invalid tool_use input in block ${block.id}`),
            owner: 'client'
          });
        } else if (blockType === 'tool_result') {
          let textResult = '';
          if (typeof block.content === 'string') {
            textResult = block.content;
          } else if (Array.isArray(block.content)) {
            textResult = block.content
              .filter(c => c && c.type === 'text')
              .map(c => c.text || '')
              .join('\n');
          }
          parts.push({
            type: 'tool-result',
            id: String(block.tool_use_id || ''),
            name: 'tool', // will be linked via toolCallId in wire compiler
            text: textResult,
            isError: Boolean(block.is_error)
          });
        } else if (blockType === 'image') {
          if (block.source?.type === 'base64') {
            parts.push({
              type: 'image',
              mediaType: block.source.media_type || 'image/png',
              dataUrl: `data:${block.source.media_type};base64,${block.source.data}`
            });
          }
        }
      }
    }

    messages.push({ role, parts });
  }

  // 3. Tools translation
  const tools = [];
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (t && typeof t === 'object' && t.name) {
        tools.push({
          name: t.name,
          description: t.description || '',
          inputSchema: t.input_schema || { type: 'object', properties: {} }
        });
      }
    }
  }

  // 4. Adaptive & Extended Thinking
  let reasoningEffort;
  let requestedThinking = false;
  if (body.thinking?.type === 'disabled') {
    reasoningEffort = 'none';
  } else if (body.output_config?.effort) {
    requestedThinking = true;
    reasoningEffort = body.output_config.effort;
  } else if (body.thinking?.effort) {
    requestedThinking = true;
    reasoningEffort = body.thinking.effort;
  } else if (body.thinking?.type === 'adaptive') {
    requestedThinking = true;
    reasoningEffort = 'adaptive';
  } else if (body.thinking?.type === 'enabled') {
    requestedThinking = true;
    if (body.thinking.effort) {
      reasoningEffort = body.thinking.effort;
    } else {
      const budget = Number(body.thinking.budget_tokens || 0);
      reasoningEffort = budget > 24000 ? 'max' : (budget > 8000 ? 'high' : (budget > 2000 ? 'medium' : 'low'));
    }
  } else if (body.reasoning_effort) {
    requestedThinking = true;
    reasoningEffort = body.reasoning_effort;
  }

  return {
    protocol: 'anthropic',
    publicModel,
    system,
    messages,
    tools,
    stream: Boolean(body.stream),
    maxOutputTokens: body.max_tokens ? Number(body.max_tokens) : undefined,
    temperature: body.temperature !== undefined ? Number(body.temperature) : undefined,
    reasoningEffort,
    requestedThinking
  };
}

/**
 * Approximates token count for POST /v1/messages/count_tokens.
 * Standard heuristic: ~3.8 characters per token.
 */
export function estimateAnthropicTokens(body) {
  let charCount = 0;
  if (!body || typeof body !== 'object') return 1;

  if (typeof body.system === 'string') {
    charCount += body.system.length;
  } else if (Array.isArray(body.system)) {
    for (const s of body.system) {
      if (typeof s === 'string') {
        charCount += s.length;
      } else if (s && typeof s === 'object' && s.text) {
        charCount += s.text.length;
      }
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== 'object') continue;
      if (typeof msg.content === 'string') {
        charCount += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (!b || typeof b !== 'object') continue;
          if (b.text) charCount += b.text.length;
          if (b.thinking) charCount += b.thinking.length;
          if (b.input) charCount += JSON.stringify(b.input).length;
        }
      }
    }
  }
  return Math.max(1, Math.ceil(charCount / 3.8));
}
