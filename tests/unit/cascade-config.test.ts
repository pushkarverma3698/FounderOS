/**
 * Cascade configuration invariants (regression guards).
 *
 * These encode lessons from the CEO live battery (2026-05-31):
 *   - Bug-1: CEO routing tier must NOT use a reasoning model (gemini-2.5-pro)
 *     with a tight token cap — thinking tokens exhaust maxOutputTokens and the
 *     model returns empty text, breaking task routing for Gemini-only users.
 *   - R1: anti-sycophancy — when no Anthropic key is present, the critic must
 *     fall back to a NON-Gemini family before Gemini, since the generators are
 *     Gemini. A non-Google entry must precede any Google entry in the critic tier.
 *   - R3: every cloud cascade model id must have a cost-map entry, otherwise
 *     cost tracking silently records $0 and the budget guard is blind.
 */

import { describe, it, expect } from "vitest";
import { CASCADE, MODEL_COST_PER_1M, TIER_MAX_TOKENS } from "../../src/core/config.js";
import type { CascadeTier } from "../../src/core/registry.js";

describe("cascade config — cost-map coverage (R3)", () => {
  it("every cloud cascade model id has a MODEL_COST_PER_1M entry", () => {
    const missing: string[] = [];
    for (const [tier, entries] of Object.entries(CASCADE)) {
      // The video tier (Veo) is priced per second of output, not per token — a
      // token cost-map entry would be misleading, so it is exempt from this guard.
      if (tier === "video") continue;
      for (const e of entries) {
        // lmstudio model id is dynamic (env) and free/local — skip cost coverage.
        if (e.provider === "lmstudio") continue;
        if (!(e.modelId in MODEL_COST_PER_1M)) missing.push(`${tier}:${e.provider}:${e.modelId}`);
      }
    }
    expect(missing, `cascade models missing from MODEL_COST_PER_1M: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("cascade config — CEO routing tier (Bug-1)", () => {
  it("does NOT use the reasoning model gemini-2.5-pro for routing", () => {
    const ids = CASCADE.ceo.map((e) => e.modelId);
    expect(ids).not.toContain("gemini-2.5-pro");
  });

  it("first Google entry in the CEO tier is gemini-2.5-flash (non-reasoning)", () => {
    const firstGoogle = CASCADE.ceo.find((e) => e.provider === "google");
    expect(firstGoogle?.modelId).toBe("gemini-2.5-flash");
  });

  it("CEO routing tier still keeps a non-Gemini reliable primary (claude) first", () => {
    expect(CASCADE.ceo[0]?.provider).toBe("anthropic");
  });
});

describe("cascade config — critic anti-sycophancy ordering (R1)", () => {
  it("a non-Google fallback precedes the first Google entry in the critic tier", () => {
    const firstGoogleIdx = CASCADE.critic.findIndex((e) => e.provider === "google");
    const firstNonAnthropicNonGoogleIdx = CASCADE.critic.findIndex(
      (e) => e.provider !== "anthropic" && e.provider !== "google",
    );
    expect(firstGoogleIdx, "critic tier should contain a Google entry").toBeGreaterThanOrEqual(0);
    expect(firstNonAnthropicNonGoogleIdx, "critic tier should contain a non-Google free fallback").toBeGreaterThanOrEqual(0);
    // The non-Google fallback must come BEFORE Gemini so a Gemini generator is
    // critiqued by a different family when no Anthropic key is configured.
    expect(firstNonAnthropicNonGoogleIdx).toBeLessThan(firstGoogleIdx);
  });

  it("critic tier still prefers Claude (Anthropic) first when available", () => {
    expect(CASCADE.critic[0]?.provider).toBe("anthropic");
  });
});

describe("cascade config — token budgets sane for routing", () => {
  it("CEO tier max tokens is small (classification, not generation)", () => {
    const tier: CascadeTier = "ceo";
    expect(TIER_MAX_TOKENS[tier]).toBeLessThanOrEqual(1024);
  });
});
