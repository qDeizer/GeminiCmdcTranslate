/**
 * @file wire.mjs
 * @description Command Code CLI 1.54.0 Wire Envelope, Header & Message Compiler.
 * 
 * DESIGN INVARIANTS:
 * 1. 1:1 Wire Headers: User-Agent: cli, x-command-code-version: 1.54.0, x-cli-environment: production.
 * 2. Empty System Safeguard: When system prompt is empty/absent, inject [{ type: 'text', text: ' ' }]
 *    to prevent upstream from injecting 7,653 - 13,912 tokens of default CLI agent prompt.
 * 3. Tool Aliasing: tool_search <-> search_tools bidirectional mapping.
 * 4. Assistant Multi-Turn Strict Ordering: [reasoning, text, tool-call].
 * 5. User Turn Separation: tool_result items compile to role: 'tool' prior to role: 'user' text/image.
 * 6. Strict Key Ordering: config, memory:null, taste:null, skills:null, permissionMode, threadId, params.
 */

import { randomBytes } from 'node:crypto';
import { BridgeHttpError, assertObject } from '../types.mjs';
import { isValidUuid } from '../session.mjs';
import { resolveReasoningEffort } from './effort.mjs';

export const WIRE_CONSTANTS = {
  USER_AGENT: 'cli',
  CLI_VERSION: '1.54.0',
  CLI_ENVIRONMENT: 'production',
  DEFAULT_MAX_TOKENS: 64000,
  TOOL_SEARCH: 'tool_search',
  SEARCH_TOOLS: 'search_tools'
};

export function toWireToolName(name) {
  return name === WIRE_CONSTANTS.TOOL_SEARCH ? WIRE_CONSTANTS.SEARCH_TOOLS : name;
}

export function fromWireToolName(name) {
  return name === WIRE_CONSTANTS.SEARCH_TOOLS ? WIRE_CONSTANTS.TOOL_SEARCH : name;
}

/**
 * Builds authentic Command Code 1.54.0 HTTP request headers.
 */
export function buildWireHeaders(profile, identity, apiKey) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new BridgeHttpError(401, 'missing_api_key', 'Command Code upstream API key is required.');
  }

  const traceId = (identity && identity.traceId) ? identity.traceId : randomBytes(16).toString('hex');
  const spanId = (identity && typeof identity.newSpanId === 'function')
    ? identity.newSpanId()
    : randomBytes(8).toString('hex');

  return {
    'content-type': 'application/json',
    'user-agent': WIRE_CONSTANTS.USER_AGENT,
    'x-command-code-version': profile.cliVersion || WIRE_CONSTANTS.CLI_VERSION,
    'x-cli-environment': profile.cliEnvironment || WIRE_CONSTANTS.CLI_ENVIRONMENT,
    'x-project-slug': profile.projectSlug || 'default-workspace',
    'x-taste-learning': String(Boolean(profile.tasteLearning)),
    'x-session-id': identity.sessionId,
    'authorization': `Bearer ${apiKey.trim()}`,
    'traceparent': `00-${traceId}-${spanId}-01`
  };
}

/**
 * Compiles canonical messages into strict native wire messages.
 * 
 * @param {import('../types.mjs').CanonicalMessage[]} messages 
 * @returns {Array<{ role: string, content: any[] }>}
 */
export function compileMessages(messages) {
  const wire = [];
  const knownToolCalls = new Map(); // toolCallId -> wireToolName

  for (const message of messages) {
    if (message.role === 'assistant') {
      const reasoningParts = [];
      const textParts = [];
      const toolCallParts = [];

      for (const part of message.parts) {
        if (part.type === 'reasoning') {
          reasoningParts.push({ type: 'reasoning', text: part.text });
        } else if (part.type === 'text') {
          textParts.push({ type: 'text', text: part.text });
        } else if (part.type === 'tool-call') {
          const wireName = toWireToolName(part.name);
          knownToolCalls.set(part.id, wireName);
          if (part.owner === 'provider') continue; // Skip upstream provider executed tools
          toolCallParts.push({
            type: 'tool-call',
            toolCallId: part.id,
            toolName: wireName,
            input: assertObject(part.input, `Invalid input for tool call ${part.id}`)
          });
        }
      }

      // Enforce strict order: [reasoning, text, tool-call]
      const content = [...reasoningParts, ...textParts, ...toolCallParts];
      if (content.length > 0) {
        wire.push({ role: 'assistant', content });
      }
      continue;
    }

    if (message.role === 'user') {
      const toolParts = [];
      const userParts = [];

      for (const part of message.parts) {
        if (part.type === 'tool-result') {
          const wireName = knownToolCalls.get(part.id);
          if (!wireName) {
            throw new BridgeHttpError(422, 'orphan_tool_result', `Tool result for ID ${part.id} has no preceding tool-call in history.`);
          }
          toolParts.push({
            type: 'tool-result',
            toolCallId: part.id,
            toolName: wireName,
            output: {
              type: 'text',
              value: part.text
            }
          });
        } else if (part.type === 'text') {
          userParts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image') {
          userParts.push({
            type: 'image',
            image: part.dataUrl,
            mimeType: part.mediaType
          });
        }
      }

      // Upstream expects tool results in role: 'tool' prior to role: 'user'
      if (toolParts.length > 0) {
        wire.push({ role: 'tool', content: toolParts });
      }
      if (userParts.length > 0) {
        wire.push({ role: 'user', content: userParts });
      }
      continue;
    }

    if (message.role === 'tool') {
      const toolParts = [];
      for (const part of message.parts) {
        if (part.type === 'tool-result') {
          const wireName = knownToolCalls.get(part.id) || toWireToolName(part.name || 'tool');
          toolParts.push({
            type: 'tool-result',
            toolCallId: part.id,
            toolName: wireName,
            output: { type: 'text', value: part.text }
          });
        }
      }
      if (toolParts.length > 0) {
        wire.push({ role: 'tool', content: toolParts });
      }
      continue;
    }

    throw new BridgeHttpError(400, 'unexpected_role', `Message role "${message.role}" is not supported.`);
  }

  return wire;
}

/**
 * Builds the exact, ordered JSON request envelope.
 * 
 * @param {import('../types.mjs').CanonicalTurn} turn
 * @param {Object} profile
 * @param {Object} modelConfig
 * @param {{ sessionId: string, threadId?: string }} identity
 * @returns {import('../types.mjs').NativeWireEnvelope}
 */
export function buildWireEnvelope(turn, profile, modelConfig, identity) {
  // Empty System Safeguard: Deterministic check for substantial system prompt
  const substantialSystem = Array.isArray(turn.system)
    ? turn.system.filter(s => s && typeof s.text === 'string' && s.text.trim().length > 0)
    : [];

  let system;
  if (substantialSystem.length > 0) {
    system = substantialSystem.map((section, idx, all) => ({
      type: 'text',
      text: idx < all.length - 1 ? `${section.text}\n` : section.text,
      ...(section.cache === 'ephemeral' ? { cache_control: { type: 'ephemeral' } } : {})
    }));
  } else if (profile.emptySystem === 'single-space') {
    // Single space bypass drops token consumption from ~13,912 to ~85 tokens!
    system = [{ type: 'text', text: ' ' }];
  } else {
    system = [];
  }

  // Compile tools with byte-exact deterministic property ordering
  const tools = (turn.tools || []).map(tool => ({
    name: toWireToolName(tool.name),
    description: tool.description || '',
    input_schema: tool.inputSchema || { type: 'object', properties: {} }
  }));

  const maxTokens = Math.min(
    turn.maxOutputTokens || modelConfig.maxOutputTokens || WIRE_CONSTANTS.DEFAULT_MAX_TOKENS,
    modelConfig.maxOutputTokens || WIRE_CONSTANTS.DEFAULT_MAX_TOKENS
  );

  let targetModel = modelConfig.upstream || turn.publicModel;
  if (targetModel === 'glm/glm-5.3-flash') {
    targetModel = 'z-ai/glm-5.3-flash';
  }
  const resolvedEffort = resolveReasoningEffort(targetModel, turn.reasoningEffort, modelConfig);

  const wireConfig = {
    workingDir: process.cwd(),
    date: new Date().toISOString().split('T')[0],
    environment: profile.cliEnvironment || 'production',
    structure: [],
    isGitRepo: false,
    currentBranch: 'main',
    mainBranch: 'main',
    gitStatus: '',
    recentCommits: [],
    ...(profile.config || {})
  };

  // Envelope with strict key ordering
  const envelope = {
    config: wireConfig,
    memory: null,
    taste: null,
    skills: null,
    permissionMode: profile.permissionMode || 'auto-accept'
  };

  if (identity.threadId && isValidUuid(identity.threadId)) {
    envelope.threadId = identity.threadId;
  }

  envelope.params = {
    model: targetModel,
    messages: compileMessages(turn.messages),
    tools,
    system,
    max_tokens: maxTokens,
    stream: true,
    ...(turn.temperature !== undefined ? { temperature: turn.temperature } : {}),
    ...(resolvedEffort ? { reasoning_effort: resolvedEffort } : {})
  };

  return envelope;
}
