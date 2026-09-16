/**
 * @file chat.mjs
 * @description Ingress Adapter for standard OpenAI Chat Completions API.
 * 
 * Supports:
 * - POST /v1/chat/completions
 * - GET /v1/models
 */

import { BridgeHttpError, assertObject } from '../types.mjs';

/**
 * Decodes standard OpenAI Chat Completions payload into a CanonicalTurn.
 * 
 * @param {Record<string, any>} body
 * @returns {import('../types.mjs').CanonicalTurn}
 */
export function decodeChatRequest(body) {
  assertObject(body, 'Chat Completions request body must be an object');

  const publicModel = String(body.model || '').trim();
  if (!publicModel) {
    throw new BridgeHttpError(400, 'missing_model', 'Chat Completions requires a "model" parameter.');
  }

  const system = [];
  const messages = [];

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      assertObject(msg, 'Message item must be an object');
      const role = msg.role;

      if (role === 'system') {
        if (typeof msg.content === 'string') {
          system.push({ text: msg.content });
        }
      } else if (role === 'user' || role === 'assistant') {
        const parts = [];
        if (typeof msg.content === 'string') {
          parts.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const p of msg.content) {
            if (p.type === 'text') {
              parts.push({ type: 'text', text: p.text || '' });
            } else if (p.type === 'image_url' && p.image_url?.url) {
              parts.push({
                type: 'image',
                mediaType: 'image/png',
                dataUrl: p.image_url.url
              });
            }
          }
        }

        if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            let inputObj = {};
            try {
              inputObj = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
            } catch {
              inputObj = { raw: tc.function?.arguments };
            }
            parts.push({
              type: 'tool-call',
              id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
              name: tc.function?.name || 'tool',
              input: inputObj,
              owner: 'client'
            });
          }
        }

        messages.push({ role, parts });
      } else if (role === 'tool') {
        messages.push({
          role: 'tool',
          parts: [{
            type: 'tool-result',
            id: msg.tool_call_id || '',
            name: 'tool',
            text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || {})
          }]
        });
      }
    }
  }

  const tools = [];
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (t.type === 'function' && t.function?.name) {
        tools.push({
          name: t.function.name,
          description: t.function.description || '',
          inputSchema: t.function.parameters || { type: 'object', properties: {} }
        });
      }
    }
  }

  return {
    protocol: 'chat',
    publicModel,
    system,
    messages,
    tools,
    stream: Boolean(body.stream),
    maxOutputTokens: body.max_tokens ? Number(body.max_tokens) : undefined,
    temperature: body.temperature !== undefined ? Number(body.temperature) : undefined,
    reasoningEffort: body.reasoning_effort || body.reasoning?.effort || undefined
  };
}

/**
 * Formats configured models into standard OpenAI GET /v1/models response.
 */
export function formatModelsList(modelsConfig) {
  const data = Object.keys(modelsConfig).map(id => ({
    id,
    object: 'model',
    created: 1726000000,
    owned_by: 'commandcode-native-bridge'
  }));

  return {
    object: 'list',
    data
  };
}
