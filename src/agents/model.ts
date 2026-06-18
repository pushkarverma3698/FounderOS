/**
 * FounderOS — Model Factory
 * =========================
 * Small, provider-agnostic model selection for the office graph.
 *
 * The model layer must stay boring: return plain LangChain chat model instances
 * and let LangChain/LangGraph handle tool binding, retries, and fallback
 * middleware. Never synthesize model output here.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { modelFallbackMiddleware } from "langchain";

export const RETRY_BACKOFF_MS = [2_000, 4_000, 8_000] as const;

export type ModelProvider = "google-genai" | "openai" | "anthropic" | "openrouter";

export interface ParsedModelId {
  provider: ModelProvider;
  model: string;
  id: string;
}

// Safety-net default when AGENT_MODEL is unset. Use the documented production
// model (CLAUDE.md), a strong agentic tool-caller — NOT a small model. A weak
// default (the old openrouter:openai/gpt-4o-mini) meant any env that forgot to
// set AGENT_MODEL silently degraded to a model that chats instead of calling
// tools. Dev/CI always set AGENT_MODEL explicitly; this only bites on misconfig,
// where Gemini Flash is the far safer failure mode.
export const DEFAULT_AGENT_MODEL = "openrouter:google/gemini-2.5-flash-preview-05-20";

export function is503Error(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("503") ||
    msg.includes("500") ||
    msg.includes("429") ||
    msg.includes("high demand") ||
    msg.includes("Service Unavailable") ||
    msg.includes("Internal Server Error") ||
    /rate.?limit/i.test(msg) ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("socket hang up") ||
    /fetch failed/i.test(msg) ||
    /network (error|timeout)/i.test(msg)
  );
}

export function isQuotaExhaustedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    /credits?\s*(are\s*)?depleted/.test(msg) ||
    /exceeded your current quota/.test(msg) ||
    /quota.*exceeded/.test(msg) ||
    /insufficient\s*(credits|funds|quota|balance)/.test(msg) ||
    /payment\s*required/.test(msg) ||
    (/\bbilling\b/.test(msg) && /quota|credit|exceed|depleted|payment/.test(msg))
  );
}

function resolveTemperature(): number {
  const raw = process.env["AGENT_TEMPERATURE"];
  if (raw === undefined) return 0;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function inferLegacyProvider(model: string): ModelProvider {
  const lower = model.toLowerCase();
  if (lower.includes("gemini")) return "google-genai";
  if (lower.includes("claude")) return "anthropic";
  return "openai";
}

export function parseModelId(modelId: string): ParsedModelId {
  const trimmed = modelId.trim();
  if (!trimmed) {
    throw new Error("AGENT_MODEL cannot be empty.");
  }

  const separator = trimmed.indexOf(":");
  if (separator === -1) {
    const provider = inferLegacyProvider(trimmed);
    return { provider, model: trimmed, id: `${provider}:${trimmed}` };
  }

  const provider = trimmed.slice(0, separator) as ModelProvider;
  const model = trimmed.slice(separator + 1);
  if (!model) {
    throw new Error(`Model id "${modelId}" is missing the model name after the provider prefix.`);
  }

  if (!["google-genai", "openai", "anthropic", "openrouter"].includes(provider)) {
    throw new Error(
      `Unsupported AGENT_MODEL provider "${provider}". Use google-genai:, openai:, anthropic:, or openrouter:.`,
    );
  }

  return { provider, model, id: `${provider}:${model}` };
}

export function getConfiguredModelId(): string {
  return process.env["AGENT_MODEL"]?.trim() || DEFAULT_AGENT_MODEL;
}

export function getFallbackModelIds(): string[] {
  return (process.env["AGENT_FALLBACK_MODELS"] ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

export function getModel(): BaseChatModel {
  const parsed = parseModelId(getConfiguredModelId());
  const model = buildModel(parsed, resolveTemperature());
  if (!model) throw new Error(`Primary model ${parsed.id} is not configured (missing API key).`);
  return model;
}

/** @deprecated Supervisor uses getModel() — withFallbacks breaks createSupervisor bindTools. */
export function getSupervisorModel(): BaseChatModel {
  return getModel();
}

export function getModelFallbackMiddleware() {
  const fallbacks = buildFallbackModels();
  if (fallbacks.length === 0) return [];
  return [modelFallbackMiddleware(...fallbacks)];
}

function buildModel(
  parsed: ParsedModelId,
  temperature: number,
  opts: { optional?: boolean } = {},
): BaseChatModel | null {
  const optional = opts.optional ?? false;

  if (parsed.provider === "google-genai") {
    if (!process.env["GOOGLE_GENERATIVE_AI_API_KEY"]) {
      if (optional) return null;
      throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is required for google-genai: models.");
    }
    return new ChatGoogleGenerativeAI({
      model: parsed.model,
      temperature,
      maxRetries: 2,
      apiKey: process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
    });
  }

  if (parsed.provider === "anthropic") {
    if (!process.env["ANTHROPIC_API_KEY"]) {
      if (optional) return null;
      throw new Error("ANTHROPIC_API_KEY is required for anthropic: models.");
    }
    return new ChatAnthropic({
      model: parsed.model,
      temperature,
      maxRetries: 2,
      apiKey: process.env["ANTHROPIC_API_KEY"],
    });
  }

  if (parsed.provider === "openrouter") {
    return new ChatOpenAI({
      model: parsed.model,
      temperature,
      maxRetries: 2,
      apiKey: process.env["OPENROUTER_API_KEY"] || "missing-openrouter-key",
      configuration: { baseURL: "https://openrouter.ai/api/v1" },
    });
  }

  if (!process.env["OPENAI_API_KEY"] && optional) return null;
  return new ChatOpenAI({
    model: parsed.model,
    temperature,
    maxRetries: 2,
    ...(process.env["OPENAI_API_KEY"] ? { apiKey: process.env["OPENAI_API_KEY"] } : {}),
  });
}

function buildFallbackModels(): BaseChatModel[] {
  return getFallbackModelIds()
    .map((id) => buildModel(parseModelId(id), resolveTemperature(), { optional: true }))
    .filter((m): m is BaseChatModel => m !== null);
}
