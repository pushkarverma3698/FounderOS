/**
 * Shared guard for live integration suites — skips when the configured
 * AGENT_MODEL provider has no real API key (not a placeholder "test" value).
 */
import { parseModelId, getConfiguredModelId } from "../../src/agents/model.js";

function isRealKey(value: string | undefined): boolean {
  const v = (value ?? "").trim();
  return v.length > 20 && !v.includes("test") && v !== "missing-openrouter-key";
}

/** True when the primary AGENT_MODEL provider has a usable live key. */
export function hasLiveIntegrationModel(): boolean {
  const parsed = parseModelId(getConfiguredModelId());
  switch (parsed.provider) {
    case "google-genai":
      return isRealKey(process.env["GOOGLE_GENERATIVE_AI_API_KEY"]);
    case "openrouter":
      return isRealKey(process.env["OPENROUTER_API_KEY"]);
    case "anthropic":
      return isRealKey(process.env["ANTHROPIC_API_KEY"]);
    case "openai":
      return isRealKey(process.env["OPENAI_API_KEY"]);
    default:
      return false;
  }
}

/**
 * 3-level nested subgraph HITL (engineering CTO) needs a model that reliably
 * chains supervisor → sub-supervisor → worker → tool. OpenRouter gpt-4o-mini
 * loops or skips tools; gate these suites on google-genai only.
 */
export function hasReliableNestedIntegrationModel(): boolean {
  const parsed = parseModelId(getConfiguredModelId());
  return parsed.provider === "google-genai" && isRealKey(process.env["GOOGLE_GENERATIVE_AI_API_KEY"]);
}
