/**
 * Probe: is Gemini 2.5 Flash implicit prompt caching firing for FounderOS?
 * ========================================================================
 * Sends the REAL production system prefix (buildSupervisorPrompt + capability
 * manifest) as a stable SystemMessage, then fires several calls with different
 * trailing user questions. If implicit caching works, calls after the first
 * should report cached input tokens.
 *
 * Run: node --env-file=.env --import tsx/esm scripts/probe-implicit-cache.ts
 *
 * Reads usage from AIMessage.usage_metadata + response_metadata. Gemini surfaces
 * cached tokens as cachedContentTokenCount / cached_content_token_count and/or
 * usage_metadata.input_token_details.cache_read depending on adapter version.
 */
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { getModel } from "../src/agents/model.js";
import { buildSupervisorPrompt } from "../src/agents/system-prompts.js";
import { buildCapabilityManifest } from "../src/agents/capabilities.js";

function usageOf(res: unknown): Record<string, unknown> {
  const r = res as { usage_metadata?: unknown; response_metadata?: Record<string, unknown> };
  return {
    usage_metadata: r.usage_metadata ?? null,
    response_usage:
      (r.response_metadata?.["usage_metadata"] as unknown) ??
      (r.response_metadata?.["tokenUsage"] as unknown) ??
      null,
  };
}

async function main() {
  const model = getModel();
  // Realistic, large, STABLE prefix (the actual production supervisor prefix).
  const prefix = `${buildSupervisorPrompt()}\n\n${buildCapabilityManifest()}`;
  const sys = new SystemMessage(prefix);
  console.log(`[probe] stable prefix chars=${prefix.length} (~${Math.ceil(prefix.length / 4)} tok)\n`);

  const questions = [
    "Say only the word READY.",
    "Reply with only the digit 1.",
    "Reply with only the digit 2.",
    "Reply with only the digit 3.",
  ];

  for (let i = 0; i < questions.length; i++) {
    const t0 = Date.now();
    const res = await model.invoke([sys, new HumanMessage(questions[i]!)]);
    const ms = Date.now() - t0;
    console.log(`[call ${i + 1}] ${ms}ms  ${JSON.stringify(usageOf(res))}`);
  }
  // NOTE (2026-06-14): @langchain/google-genai@0.1.12 exposes only
  // {promptTokens, completionTokens, totalTokens} — NO cachedContentTokenCount.
  // Implicit caching still applies server-side (free), but is not measurable in
  // app until the adapter is upgraded (deferred — see ADR). Re-run after upgrade.
  console.log("\n[probe] Look for a nonzero cached token field on calls 2+.");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("[probe] FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
