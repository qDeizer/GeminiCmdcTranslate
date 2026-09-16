/**
 * @file effort.mjs
 * @description Command Code Native Reasoning Effort Catalog & Adaptive Level Mapper.
 * 
 * DESIGN INVARIANTS:
 * 1. Zero External Dependencies: Pure Node.js.
 * 2. Model-Adaptive Mapping: Maps client reasoning efforts (Claude budget_tokens,
 *    OpenAI reasoning_effort) to native Command Code upstream supported levels.
 * 3. Graceful Fallback / Clamping: When a requested effort is not supported by the target
 *    upstream model (e.g. 'max' requested on a model that only supports up to 'xhigh'),
 *    it clamps to the nearest supported level instead of failing upstream.
 * 4. Safe Omission: When a target model does not support reasoning (e.g. Haiku or
 *    non-thinking models), reasoning_effort is omitted from the native params.
 */

import { BridgeHttpError } from '../types.mjs';

export const KNOWN_MODEL_EFFORTS = {
  // Meta Muse Spark series
  'meta/muse-spark-1.3': ['low', 'medium', 'high', 'xhigh', 'max'],
  'meta/muse-spark-1.3-contributor': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2-contributor': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.1': ['low', 'medium', 'high', 'xhigh'],

  // Claude models on Command Code
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-haiku-4-5-20251001': [],

  // OpenAI / Codex models
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4-mini': ['low', 'medium', 'high'],
  'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],

  // DeepSeek models
  'deepseek/deepseek-v4-pro': ['high', 'max'],
  'deepseek/deepseek-v4-flash': ['high', 'max'],
  'deepseek/deepseek-v4-flash-vision-exp': ['high', 'max'],
  'deepseek/deepseek-v4-flash-fast': ['low', 'high', 'max'],
  'deepseek/deepseek-v4.1-flash': ['low', 'high', 'max'],

  // Google Gemini models
  'google/gemini-3.8-flash': ['low', 'medium', 'high'],
  'google/gemini-3.7-flash': ['low', 'medium', 'high'],
  'google/gemini-3.6-flash': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.1-flash-lite': ['low', 'medium', 'high'],

  // Moonshot / Zhipu / Qwen / xAI / MiniMax
  'moonshotai/Kimi-K3': ['low', 'high', 'max'],
  'moonshotai/Kimi-K2.5': [],
  'zai-org/GLM-5.3': ['low', 'high', 'max'],
  'z-ai/glm-5.3-flash': ['low', 'high', 'max'],
  'glm/glm-5.3-flash': ['low', 'high', 'max'],
  'zai-org/GLM-5.2': ['high', 'max'],
  'xai/grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'xai/grok-4.5': ['low', 'medium', 'high'],
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Flash': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-27B': ['low', 'medium', 'xhigh'],
  'MiniMaxAI/MiniMax-M3': ['low', 'medium', 'high'],
  'minimax/minimax-m3-free': ['low', 'medium', 'high']
};

export const EFFORT_WEIGHTS = {
  'none': 0,
  'minimal': 1,
  'low': 2,
  'medium': 3,
  'high': 4,
  'xhigh': 5,
  'max': 6
};

/**
 * Resolves the appropriate reasoning_effort parameter for the target model.
 * 
 * @param {string} targetModel Upstream model ID
 * @param {string|undefined} requestedEffort Client requested effort level
 * @param {Object} [modelConfig={}] Model configuration containing optional effortMap or supportedEfforts
 * @returns {string|undefined} The resolved effort string, or undefined if not supported / disabled.
 */
export function resolveReasoningEffort(targetModel, requestedEffort, modelConfig = {}) {
  // If model explicitly disables reasoning effort
  if (modelConfig.supportsReasoningEffort === false) {
    return undefined;
  }

  // If client did not request thinking/effort
  if (!requestedEffort) {
    if (modelConfig.effortMap && typeof modelConfig.effortMap === 'object') {
      const unspecified = modelConfig.effortMap['unspecified'] ?? modelConfig.effortMap['default'];
      if (unspecified === 'reject') {
        throw new BridgeHttpError(422, 'unsupported_effort', 'Reasoning effort is required for this model.');
      }
      if (unspecified === 'omit' || unspecified === 'none') {
        return undefined;
      }
      if (unspecified) {
        requestedEffort = unspecified;
      }
    }
    if (!requestedEffort) {
      if (modelConfig.defaultEffort) {
        requestedEffort = modelConfig.defaultEffort;
      } else {
        return undefined;
      }
    }
  }

  // Check if requestedEffort is directly mapped in effortMap BEFORE numeric budget conversion
  const rawKey = String(requestedEffort).trim();
  const rawLower = rawKey.toLowerCase();
  if (modelConfig.effortMap && typeof modelConfig.effortMap === 'object') {
    let custom = modelConfig.effortMap[rawLower] ?? modelConfig.effortMap[rawKey];
    if (custom === undefined) {
      const foundEntry = Object.entries(modelConfig.effortMap).find(([k]) => k.toLowerCase().trim() === rawLower);
      if (foundEntry) custom = foundEntry[1];
    }
    if (custom !== undefined) {
      if (custom === 'reject') {
        throw new BridgeHttpError(422, 'unsupported_effort', `Reasoning effort "${requestedEffort}" is rejected by configuration.`);
      }
      if (custom === 'omit' || custom === 'none' || !custom) return undefined;
      return custom;
    }
  }

  // Handle numeric token budgets directly (e.g. 1024, 8000, 32000)
  const numBudget = Number(requestedEffort);
  if (!isNaN(numBudget) && numBudget > 100) {
    requestedEffort = numBudget > 24000 ? 'max' : (numBudget > 8000 ? 'high' : (numBudget > 2000 ? 'medium' : 'low'));
  }

  let normalized = String(requestedEffort).toLowerCase().trim();

  // If user provided a custom effortMap in modelConfig, check normalized key
  if (modelConfig.effortMap && typeof modelConfig.effortMap === 'object') {
    let custom = modelConfig.effortMap[normalized];
    if (custom === undefined) {
      const foundEntry = Object.entries(modelConfig.effortMap).find(([k]) => k.toLowerCase().trim() === normalized);
      if (foundEntry) custom = foundEntry[1];
    }
    if (custom !== undefined) {
      if (custom === 'reject') {
        throw new BridgeHttpError(422, 'unsupported_effort', `Reasoning effort "${requestedEffort}" is rejected by configuration.`);
      }
      if (custom === 'omit' || custom === 'none' || !custom) return undefined;
      return custom;
    }
  }

  if (normalized === 'adaptive') {
    normalized = 'high';
  } else if (normalized === 'auto') {
    normalized = 'high';
  }

  // Explicit 'none' or 'disabled' means omit
  if (normalized === 'none' || normalized === 'disabled' || normalized === 'omit') {
    return undefined;
  }

  // Determine supported efforts for the target model
  let supported = modelConfig.supportedEfforts;
  if (!Array.isArray(supported)) {
    supported = KNOWN_MODEL_EFFORTS[targetModel];
    // If unknown model, default to standard set unless specified
    if (!Array.isArray(supported)) {
      supported = ['low', 'medium', 'high', 'xhigh'];
    }
  }

  // If the model does not support any reasoning efforts (e.g. non-reasoning model)
  if (supported.length === 0) {
    return undefined;
  }

  // If directly supported, return as-is
  if (supported.includes(normalized)) {
    return normalized;
  }

  // Otherwise, find the closest supported effort level
  const targetWeight = EFFORT_WEIGHTS[normalized] ?? 4;
  let closest = supported[0];
  let minDiff = Infinity;

  for (const level of supported) {
    const weight = EFFORT_WEIGHTS[level] ?? 4;
    const diff = Math.abs(weight - targetWeight);
    if (diff < minDiff) {
      minDiff = diff;
      closest = level;
    } else if (diff === minDiff) {
      // Tie-breaker: prefer lower or equal to avoid budget overruns
      if (weight <= targetWeight) {
        closest = level;
      }
    }
  }

  return closest;
}

/**
 * Returns a normalized list of accessible models from the catalog.
 * Used as an offline/fallback source for model discovery.
 */
export function getCatalogModels() {
  return Object.entries(KNOWN_MODEL_EFFORTS).map(([id, efforts]) => ({
    id,
    name: id.split('/').pop().replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    efforts: [...efforts],
    maxOutputTokens: 64000,
    supportsReasoning: efforts.length > 0
  }));
}
