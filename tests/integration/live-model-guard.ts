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
 * True when the provider is not just KEYED but actually USABLE: one minimal
 * live probe call. A real-looking key with zero credits (402) or revoked auth
 * fails every test in a live suite with the same provider error — that is a
 * test-environment condition, not a code regression, so the suite should skip
 * LOUDLY (with the provider's reason) exactly as it does for an absent key.
 * The prod boot validator (`pnpm test:smoke`) still fails hard on a dead
 * provider, so no safety signal is lost. Costs one tiny call per suite run,
 * only when a key is configured (rule #23).
 */
export async function hasUsableLiveIntegrationModel(): Promise<boolean> {
  if (!hasLiveIntegrationModel()) return false;
  try {
    const { getModel } = await import("../../src/agents/model.js");
    await getModel().invoke("ping");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[live-model-guard] SKIP live suites — provider probe failed: ${msg.slice(0, 200)}`);
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
