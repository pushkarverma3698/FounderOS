/**
 * Model bindings for outreach reflection loop.
 * Generator → primary cloud model (Gemini via existing factory).
 * Reflector → OpenRouter free-tier model (cheap rewrite passes, no local server).
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getModel, parseModelId, type ParsedModelId } from "../agents/model.js";
import type { ModelProvider } from "../agents/model.js";

/** Prod-aligned free reflector default (founder directive: no paid fallback). */
export const DEFAULT_REFLECTOR_MODEL = "openrouter:meta-llama/llama-3.3-70b-instruct:free";

export interface OutreachModelConfig {
  /** Provider-prefixed id, e.g. google-genai:gemini-2.5-flash */
  generatorModelId?: string;
  /** Provider-prefixed id for reflection rewrites, e.g. openrouter:…:free */
  reflectorModelId?: string;
  temperature?: number;
}

function resolveGeneratorModelId(cfg: OutreachModelConfig): string {
  return (
    cfg.generatorModelId?.trim() ||
    process.env["OUTREACH_GENERATOR_MODEL"]?.trim() ||
    process.env["AGENT_MODEL"]?.trim() ||
    "google-genai:gemini-2.5-flash"
  );
}

function resolveReflectorModelId(cfg: OutreachModelConfig): string {
  return (
    cfg.reflectorModelId?.trim() ||
    process.env["OUTREACH_REFLECTOR_MODEL"]?.trim() ||
    DEFAULT_REFLECTOR_MODEL
  );
}

function withTemporaryAgentModel<T>(modelId: string, fn: () => T): T {
  const prev = process.env["AGENT_MODEL"];
  process.env["AGENT_MODEL"] = modelId;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env["AGENT_MODEL"];
    else process.env["AGENT_MODEL"] = prev;
  }
}

/** Primary cloud model for the initial personalized draft (quality). */
export function buildGeneratorModel(cfg: OutreachModelConfig = {}): BaseChatModel {
  return withTemporaryAgentModel(resolveGeneratorModelId(cfg), () => getModel());
}

/** OpenRouter free model for reflection rewrites (validation-error fixes). */
export function buildReflectorModel(cfg: OutreachModelConfig = {}): BaseChatModel {
  return withTemporaryAgentModel(resolveReflectorModelId(cfg), () => getModel());
}

export function describeGeneratorModel(cfg: OutreachModelConfig = {}): ParsedModelId {
  return parseModelId(resolveGeneratorModelId(cfg));
}

export function describeReflectorModel(cfg: OutreachModelConfig = {}): ParsedModelId {
  return parseModelId(resolveReflectorModelId(cfg));
}

export type { ModelProvider };
