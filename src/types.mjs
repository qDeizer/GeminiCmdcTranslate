/**
 * @file types.mjs
 * @description Canonical Turn & Wire Contract Type Definitions for Gemini1 Bridge.
 * 
 * DESIGN PRINCIPLE:
 * No universal ChatMessage lossy pivot.
 * Anthropic Messages and OpenAI Responses decode directly into a lossless CanonicalTurn.
 * The CanonicalTurn compiles directly into the Command Code CLI 1.54.0 wire format.
 */

/**
 * Supported client protocols.
 * @typedef {'anthropic' | 'responses' | 'chat'} ClientProtocol
 */

/**
 * Message roles in canonical turn representation.
 * @typedef {'user' | 'assistant' | 'tool'} CanonicalRole
 */

/**
 * Content part union for CanonicalMessage:
 * - text: standard text content
 * - image: mediaType + dataUrl or base64
 * - reasoning: assistant thought process
 * - tool-call: assistant invoked a tool
 * - tool-result: execution result of a tool
 * 
 * @typedef {
 *   | { type: 'text', text: string }
 *   | { type: 'image', mediaType: string, dataUrl: string }
 *   | { type: 'reasoning', text: string, bridgeSignature?: string }
 *   | { type: 'tool-call', id: string, name: string, input: Record<string, any>, owner: 'client' | 'provider' }
 *   | { type: 'tool-result', id: string, name: string, text: string, isError?: boolean }
 * } CanonicalPart
 */

/**
 * Canonical representation of a single conversation turn item.
 * @typedef {Object} CanonicalMessage
 * @property {CanonicalRole} role
 * @property {CanonicalPart[]} parts
 */

/**
 * Canonical tool definition.
 * @typedef {Object} CanonicalTool
 * @property {string} name
 * @property {string} [description]
 * @property {Record<string, any>} inputSchema
 */

/**
 * Canonical system prompt section.
 * @typedef {Object} CanonicalSystemSection
 * @property {string} text
 * @property {boolean | 'ephemeral'} [cache]
 */

/**
 * Canonical Turn Model: The single source of truth passed between Ingress and Wire Compiler.
 * @typedef {Object} CanonicalTurn
 * @property {ClientProtocol} protocol
 * @property {string} publicModel - Client requested model identifier
 * @property {CanonicalSystemSection[]} system
 * @property {CanonicalMessage[]} messages
 * @property {CanonicalTool[]} tools
 * @property {boolean} stream
 * @property {number} [maxOutputTokens]
 * @property {number} [temperature]
 * @property {string} [reasoningEffort]
 * @property {boolean} [requestedThinking]
 */

/**
 * Command Code CLI 1.54.0 Native Wire Envelope.
 * @typedef {Object} NativeWireEnvelope
 * @property {Record<string, any>} config
 * @property {null} memory
 * @property {null} taste
 * @property {null} skills
 * @property {'standard' | 'auto-accept' | 'plan'} permissionMode
 * @property {string} [threadId] - Valid UUID only!
 * @property {string} [mode]
 * @property {string} [promptCache]
 * @property {Object} params
 * @property {string} params.model
 * @property {Array<{ role: string, content: any[] }>} params.messages
 * @property {Array<{ name: string, description?: string, input_schema: any }>} params.tools
 * @property {Array<{ type: 'text', text: string, cache_control?: any }>} params.system
 * @property {number} params.max_tokens
 * @property {boolean} params.stream
 * @property {number} [params.temperature]
 * @property {string} [params.reasoning_effort]
 */

/**
 * Standard HTTP error with status code and RFC 7807 problem details.
 */
export class BridgeHttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, any>} [details]
   */
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'BridgeHttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        type: this.code,
        message: this.message,
        status: this.status,
        ...this.details
      }
    };
  }
}

/**
 * Utility assertion helpers.
 */
export function assertObject(val, errMessage = 'Expected object') {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new BridgeHttpError(400, 'invalid_payload', errMessage);
  }
  return val;
}

export function assertString(val, errMessage = 'Expected string') {
  if (typeof val !== 'string' || !val.trim()) {
    throw new BridgeHttpError(400, 'invalid_string', errMessage);
  }
  return val;
}
