/**
 * @file responses.mjs
 * @description Ingress Adapter for OpenAI Responses API (ChatGPT Desktop Codex Mode).
 * 
 * Supports:
 * - POST /v1/responses
 * - POST /backend-api/codex/responses
 */

import { BridgeHttpError, assertObject } from '../types.mjs';

/**
 * Decodes an OpenAI Responses request body into a CanonicalTurn.
 * 
 * @param {Record<string, any>} body
 * @returns {import('../types.mjs').CanonicalTurn}
 */
export function decodeResponsesRequest(body) {
  assertObject(body, 'Responses request body must be a JSON object');

  const publicModel = String(body.model || '').trim();
  if (!publicModel) {
    throw new BridgeHttpError(400, 'missing_model', 'Responses request requires a "model" parameter.');
  }

  // Unsupported remote storage checks (P0 constraint)
  if (body.previous_response_id) {
    throw new BridgeHttpError(422, 'unsupported_feature', 'Remote state continuation via previous_response_id is not supported; client must provide full input history.');
  }

  // 1. System instructions
  const system = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    system.push({ text: body.instructions.trim() });
  }

  // 2. Input item list
  const messages = [];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      assertObject(item, 'Each input item must be an object');
      const itemType = item.type;

      if (itemType === 'message') {
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        const parts = [];

        if (typeof item.content === 'string') {
          parts.push({ type: 'text', text: item.content });
        } else if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part && typeof part === 'object') {
              if (part.type === 'input_text' || part.type === 'output_text') {
                parts.push({ type: 'text', text: String(part.text || '') });
              } else if (part.type === 'image_url' && part.image_url?.url) {
                parts.push({
                  type: 'image',
                  mediaType: 'image/png',
                  dataUrl: part.image_url.url
                });
              }
            }
          }
        }
        messages.push({ role, parts });
      } else if (itemType === 'function_call' || itemType === 'custom_tool_call' || itemType === 'tool_search_call') {
        // Assistant invoked a tool in history
        const callId = item.call_id || item.id || `call_${Math.random().toString(36).slice(2, 10)}`;
        const name = itemType === 'tool_search_call' ? 'tool_search' : (item.name || 'tool');
        let inputObj = {};
        try {
          inputObj = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : (item.arguments || {});
        } catch {
          inputObj = { raw: item.arguments };
        }

        messages.push({
          role: 'assistant',
          parts: [{
            type: 'tool-call',
            id: callId,
            name,
            input: inputObj,
            owner: 'client'
          }]
        });
      } else if (itemType === 'function_call_output' || itemType === 'tool_search_output') {
        // Tool result execution output
        const callId = item.call_id || '';
        const outputText = typeof item.output === 'string' ? item.output : JSON.stringify(item.output || {});
        messages.push({
          role: 'tool',
          parts: [{
            type: 'tool-result',
            id: callId,
            name: 'tool',
            text: outputText
          }]
        });
      }
    }
  }

  // 3. Tools definitions
  const tools = [];
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (t && typeof t === 'object') {
        if (t.type === 'function' && t.name) {
          tools.push({
            name: t.name,
            description: t.description || '',
            inputSchema: t.parameters || { type: 'object', properties: {} }
          });
        } else if (t.type === 'tool_search') {
          tools.push({
            name: 'tool_search',
            description: 'Search tools available in the workspace',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
          });
        }
      }
    }
  }

  return {
    protocol: 'responses',
    publicModel,
    system,
    messages,
    tools,
    stream: Boolean(body.stream),
    maxOutputTokens: body.max_output_tokens ? Number(body.max_output_tokens) : undefined,
    temperature: body.temperature !== undefined ? Number(body.temperature) : undefined,
    reasoningEffort: body.reasoning?.effort || undefined,
    requestedThinking: Boolean(body.reasoning)
  };
}
