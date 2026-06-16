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

export const DEFAULT_AGENT_MODEL = "openrouter:openai/gpt-4o-mini";

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
  return buildModel(parsed, resolveTemperature());
}

export function getModelFallbackMiddleware() {
  const fallbacks = getFallbackModelIds();
  if (fallbacks.length === 0) return [];
  return [modelFallbackMiddleware(...fallbacks.map((id) => buildModel(parseModelId(id), resolveTemperature())))];
}

function buildModel(parsed: ParsedModelId, temperature: number): BaseChatModel {
  if (parsed.provider === "google-genai") {
    return new ChatGoogleGenerativeAI({
      model: parsed.model,
      temperature,
      maxRetries: 2,
      ...(process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
        ? { apiKey: process.env["GOOGLE_GENERATIVE_AI_API_KEY"] }
        : {}),
    });
  }

  if (parsed.provider === "anthropic") {
    return new ChatAnthropic({
      model: parsed.model,
      temperature,
      maxRetries: 2,
      ...(process.env["ANTHROPIC_API_KEY"] ? { apiKey: process.env["ANTHROPIC_API_KEY"] } : {}),
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

  return new ChatOpenAI({
    model: parsed.model,
    temperature,
    maxRetries: 2,
    ...(process.env["OPENAI_API_KEY"] ? { apiKey: process.env["OPENAI_API_KEY"] } : {}),
  });
}
