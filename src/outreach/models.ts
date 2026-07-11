/**
 * Model bindings for outreach reflection loop.
 * Generator → heavy cloud model (Gemini/OpenRouter via existing factory).
 * Reflector → local OpenAI-compatible endpoint (LM Studio / Ollama).
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { getModel, parseModelId, type ParsedModelId } from "../agents/model.js";
import type { ModelProvider } from "../agents/model.js";

export interface OutreachModelConfig {
  /** Provider-prefixed id, e.g. google-genai:gemini-2.5-flash */
  generatorModelId?: string;
  /** OpenAI-compatible model name on the local server */
  reflectorModelName?: string;
  /** LM Studio / Ollama OpenAI base URL */
  reflectorBaseUrl?: string;
  reflectorApiKey?: string;
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

function resolveReflectorBaseUrl(cfg: OutreachModelConfig): string {
  const raw =
    cfg.reflectorBaseUrl?.trim() ||
    process.env["OUTREACH_REFLECTOR_BASE_URL"]?.trim() ||
    process.env["LM_STUDIO_URL"]?.trim() ||
    process.env["OLLAMA_URL"]?.trim() ||
    "http://localhost:1234";
  return raw.endsWith("/v1") ? raw : `${raw.replace(/\/$/, "")}/v1`;
}

function resolveReflectorModelName(cfg: OutreachModelConfig): string {
  return (
    cfg.reflectorModelName?.trim() ||
    process.env["OUTREACH_REFLECTOR_MODEL"]?.trim() ||
    process.env["LM_STUDIO_MODEL"]?.trim() ||
    "local-model"
  );
}

/** Heavy cloud model for initial personalized draft (quality). */
export function buildGeneratorModel(cfg: OutreachModelConfig = {}): BaseChatModel {
  const id = resolveGeneratorModelId(cfg);
  const prev = process.env["AGENT_MODEL"];
  process.env["AGENT_MODEL"] = id;
  try {
    return getModel();
  } finally {
    if (prev === undefined) delete process.env["AGENT_MODEL"];
    else process.env["AGENT_MODEL"] = prev;
  }
}

/** Local OpenAI-compatible model for cheap rewrite passes (reflection). */
export function buildReflectorModel(cfg: OutreachModelConfig = {}): BaseChatModel {
  const temperature = cfg.temperature ?? 0;
  return new ChatOpenAI({
    model: resolveReflectorModelName(cfg),
    temperature,
    maxRetries: 1,
    apiKey: cfg.reflectorApiKey ?? process.env["OPENAI_API_KEY"] ?? "local-no-key",
    configuration: { baseURL: resolveReflectorBaseUrl(cfg) },
  });
}

/** Parse generator model id for logging / cost attribution. */
export function describeGeneratorModel(cfg: OutreachModelConfig = {}): ParsedModelId {
  return parseModelId(resolveGeneratorModelId(cfg));
}

export type { ModelProvider };
