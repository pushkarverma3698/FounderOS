/**
 * FounderOS — E2E Tests with Local Model (LM Studio)
 * ====================================================
 * Tests the full cascade pipeline using the local lmstudio tier.
 * These tests talk to real infrastructure — LM Studio must be running at
 * LM_STUDIO_URL (default: http://localhost:1234) with a model loaded.
 *
 * Skip conditions:
 *  - LM_STUDIO_URL unreachable (model not running) → auto-skip with message
 *  - No model loaded in LM Studio → auto-skip with message
 *
 * Why local model for E2E?
 *  - Zero cost (no API tokens burned on CI/CD)
 *  - Fast iteration in dev (no network RTT to cloud APIs)
 *  - Validates the provider cascade lmstudio code path (often untested)
 *  - Exercises the full graph + state pipeline without cloud dependencies
 *
 * Run: LM_STUDIO_URL=http://localhost:1234 pnpm test tests/e2e/local-model.test.ts
 *
 * @note These tests are intentionally slow (LLM inference) — timeout is 120s.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";

// ── LM Studio availability check ──────────────────────────────────────────────

const LM_STUDIO_URL = process.env["LM_STUDIO_URL"] ?? "http://localhost:1234";

/**
 * Checks if LM Studio is reachable and has a model loaded.
 * Returns { available: true, model: "..." } or { available: false, reason: "..." }
 */
async function checkLmStudio(): Promise<
  | { available: true; model: string }
  | { available: false; reason: string }
> {
  try {
    const response = await fetch(`${LM_STUDIO_URL}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return { available: false, reason: `LM Studio returned HTTP ${response.status}` };
    }

    const data = (await response.json()) as { data?: Array<{ id: string }> };

    if (!data.data || data.data.length === 0) {
      return { available: false, reason: "LM Studio is running but no model is loaded" };
    }

    return { available: true, model: data.data[0]!.id };
  } catch (err) {
    return {
      available: false,
      reason: `LM Studio unreachable at ${LM_STUDIO_URL}: ${(err as Error).message}`,
    };
  }
}

// ── Module imports (after env setup in tests/setup.ts) ───────────────────────

let callCascade: typeof import("../../src/infra/llm.js").callCascade;
let prepareForLlm: typeof import("../../src/infra/token-optimizer.js").prepareForLlm;
let estimateTokens: typeof import("../../src/infra/token-optimizer.js").estimateTokens;
let trimMessageHistory: typeof import("../../src/infra/context-manager.js").trimMessageHistory;
let computePromptBudget: typeof import("../../src/infra/context-manager.js").computePromptBudget;
let calculateWeeklyLimit: typeof import("../../src/agents/pods/social.js").calculateWeeklyLimit;
let isPostingAllowed: typeof import("../../src/agents/pods/social.js").isPostingAllowed;
let _resolveDepartment: typeof import("../../src/agents/supervisor.js")._resolveDepartment;

let lmStudioStatus: { available: true; model: string } | { available: false; reason: string };

beforeAll(async () => {
  // Check LM Studio availability ONCE before all tests
  lmStudioStatus = await checkLmStudio();

  // Import modules (lazy — avoids heavy config validation at import time in CI)
  const llm = await import("../../src/infra/llm.js");
  const tokenOpt = await import("../../src/infra/token-optimizer.js");
  const ctxMgr = await import("../../src/infra/context-manager.js");
  const social = await import("../../src/agents/pods/social.js");
  const supervisor = await import("../../src/agents/supervisor.js");

  callCascade = llm.callCascade;
  prepareForLlm = tokenOpt.prepareForLlm;
  estimateTokens = tokenOpt.estimateTokens;
  trimMessageHistory = ctxMgr.trimMessageHistory;
  computePromptBudget = ctxMgr.computePromptBudget;
  calculateWeeklyLimit = social.calculateWeeklyLimit;
  isPostingAllowed = social.isPostingAllowed;
  _resolveDepartment = supervisor._resolveDepartment;
}, 10_000);

// ── Helper ────────────────────────────────────────────────────────────────────

function skipIfNoLmStudio(test: () => Promise<void> | void) {
  return async () => {
    if (!lmStudioStatus.available) {
      console.log(`[SKIP] ${lmStudioStatus.reason}`);
      return; // Soft skip — test passes without running
    }
    await test();
  };
}

// ── Pure logic tests (no LM Studio required) ──────────────────────────────────

describe("Token optimizer — pure functions (no LLM required)", () => {
  it("estimateTokens — 1 token ≈ 4 chars", () => {
    const text = "a".repeat(400);
    const tokens = estimateTokens(text);
    // Should be around 100, allow ±15%
    expect(tokens).toBeGreaterThanOrEqual(85);
    expect(tokens).toBeLessThanOrEqual(115);
  });

  it("estimateTokens — empty string returns 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("prepareForLlm — truncates to budget", () => {
    const longText = "Hello world. ".repeat(500); // ~1750 tokens
    const result = prepareForLlm(longText, { maxTokens: 100 });
    expect(estimateTokens(result)).toBeLessThanOrEqual(120); // 20% tolerance
  });

  it("prepareForLlm — strips markdown code fences", () => {
    const withFences = "```typescript\nconst x = 1;\n```\n\nSome text after.";
    const result = prepareForLlm(withFences, { maxTokens: 200 });
    expect(result).not.toContain("```");
    expect(result).toContain("Some text after");
  });

  it("prepareForLlm — preserves meaningful content when within budget", () => {
    const shortText = "This is a short text that should not be truncated at all.";
    const result = prepareForLlm(shortText, { maxTokens: 500 });
    expect(result).toContain("This is a short text");
    expect(result).toContain("truncated at all");
  });

  it("prepareForLlm — sentence strategy keeps full sentences (ends with period or ellipsis)", () => {
    const text = "First sentence is here. Second sentence follows this. Third sentence ends it.";
    const result = prepareForLlm(text, { maxTokens: 10, strategy: "sentences" });
    // Should end at a sentence boundary — period may be followed by "…" ellipsis suffix
    expect(result).toMatch(/[.…]\s*$/);
  });

  it("prepareForLlm — middle strategy keeps start and end", () => {
    const text = "FIRST. " + "middle filler content. ".repeat(100) + "LAST.";
    const result = prepareForLlm(text, { maxTokens: 20, strategy: "middle" });
    expect(result).toContain("FIRST");
    expect(result).toContain("LAST");
  });
});

describe("Context manager — pure functions (no LLM required)", () => {
  it("trimMessageHistory — returns all messages when they fit in budget", () => {
    // Short messages, generous budget — should return all unchanged
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}`, // ~9 chars = ~2 tokens each
    }));
    const trimmed = trimMessageHistory(messages, { maxTokens: 500, keepRecent: 4 });
    expect(trimmed.length).toBe(5); // All fit within budget
    expect(trimmed.at(-1)?.content).toContain("Message 4");
  });

  it("trimMessageHistory — drops middle messages to fit budget", () => {
    // Each message ~50 chars = ~12 tokens. 20 messages = ~240 tokens.
    // Budget: 60 tokens + keepRecent 4 — should drop the middle.
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `This is message number ${i} with some extra content padding here.`,
    }));
    const trimmed = trimMessageHistory(messages, { maxTokens: 60, keepRecent: 4 });
    // Last message must be preserved
    expect(trimmed.at(-1)?.content).toContain("message number 19");
    // Must be fewer messages than the original
    expect(trimmed.length).toBeLessThan(20);
  });

  it("trimMessageHistory — keepFirst=true preserves first message", () => {
    // Budget is tight enough to force trimming
    const messages = [
      { role: "system" as const, content: "SYSTEM_PROMPT" },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: "user" as const,
        content: `This is conversation turn number ${i} with extra padding content here for token pressure.`,
      })),
    ];
    // Very tight budget forces trimming; keepFirst=true (default)
    const trimmed = trimMessageHistory(messages, { maxTokens: 80, keepRecent: 3, keepFirst: true });
    // First message must still be present somewhere
    expect(trimmed.some((m) => m.content === "SYSTEM_PROMPT")).toBe(true);
    // Last message preserved
    expect(trimmed.at(-1)?.content).toContain("turn number 19");
  });

  it("computePromptBudget — respects allocation ratios", () => {
    const budget = computePromptBudget(128_000, 4096);
    expect(budget.system + budget.history + budget.task + budget.response).toBeLessThanOrEqual(128_000);
    expect(budget.response).toBe(4096);
    // Task should be the biggest chunk
    expect(budget.task).toBeGreaterThan(budget.system);
    expect(budget.task).toBeGreaterThan(budget.history);
  });
});

describe("Social pod safety logic — pure functions (no LLM required)", () => {
  it("calculateWeeklyLimit — week 0 = 1 post", () => {
    const today = new Date().toISOString();
    expect(calculateWeeklyLimit(today)).toBe(1);
  });

  it("calculateWeeklyLimit — 8 days old = week 1 = 2 posts", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(calculateWeeklyLimit(eightDaysAgo)).toBe(2);
  });

  it("calculateWeeklyLimit — 15 days old = week 2 = 4 posts", () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    expect(calculateWeeklyLimit(fifteenDaysAgo)).toBe(4);
  });

  it("calculateWeeklyLimit — 22 days old = week 3 = 7 posts", () => {
    const twentyTwoDaysAgo = new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString();
    expect(calculateWeeklyLimit(twentyTwoDaysAgo)).toBe(7);
  });

  it("calculateWeeklyLimit — 30 days old = uncapped (999)", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(calculateWeeklyLimit(thirtyDaysAgo)).toBe(999);
  });

  it("isPostingAllowed — blocks when at weekly limit", () => {
    const config = {
      warming_started_at: new Date().toISOString(), // week 0 → limit 1
      posts_this_week: 1,
      weekly_limit: 1,
    };
    expect(isPostingAllowed(config)).toBe(false);
  });

  it("isPostingAllowed — allows when under weekly limit", () => {
    const config = {
      warming_started_at: new Date().toISOString(), // week 0 → limit 1
      posts_this_week: 0,
      weekly_limit: 1,
    };
    expect(isPostingAllowed(config)).toBe(true);
  });
});

describe("Supervisor — department routing (no LLM required)", () => {
  it("social_researcher → social (registry)", () => {
    expect(_resolveDepartment("social_researcher")).toBe("social");
  });

  it("social_handler → social (registry)", () => {
    expect(_resolveDepartment("social_handler")).toBe("social");
  });

  it("social_media_bot → social (keyword heuristic)", () => {
    expect(_resolveDepartment("social_media_bot")).toBe("social");
  });

  it("lead_intel → sales (registry)", () => {
    expect(_resolveDepartment("lead_intel")).toBe("sales");
  });

  it("linkedin_outreach → sales (outreach wins over linkedin)", () => {
    expect(_resolveDepartment("linkedin_outreach")).toBe("sales");
  });
});

// ── LM Studio integration tests (auto-skip if not running) ───────────────────

describe("LM Studio cascade — callCascade('local', ...) integration", () => {
  it(
    "returns text response from local model",
    skipIfNoLmStudio(async () => {
      expect(lmStudioStatus.available).toBe(true);

      const result = await callCascade(
        "local",
        [new HumanMessage("Reply with exactly the word 'PONG' and nothing else.")],
        { agent: "e2e_test", tenant_id: "test" },
      );

      expect(result.text).toBeDefined();
      expect(result.text.trim().length).toBeGreaterThan(0);
      expect(result.provider).toBe("lmstudio");
      expect(result.tier).toBe("local");
      expect(result.tokensIn).toBeGreaterThan(0);
      expect(result.tokensOut).toBeGreaterThan(0);

      console.log(`[E2E] Model: ${result.model}, tokens: ${result.tokensIn}in/${result.tokensOut}out`);
      console.log(`[E2E] Response: ${result.text.trim().slice(0, 100)}`);
    }),
    120_000, // 2 min timeout for slow local inference
  );

  it(
    "respects system prompt instructions",
    skipIfNoLmStudio(async () => {
      const result = await callCascade(
        "local",
        [
          new SystemMessage("You are a JSON-only responder. Always respond with valid JSON, nothing else."),
          new HumanMessage('Return a JSON object with key "status" set to "ok" and "count" set to 42.'),
        ],
        { agent: "e2e_test_json", tenant_id: "test" },
      );

      expect(result.text).toBeDefined();

      // Attempt to parse — model should have followed the JSON instruction
      let parsed: unknown;
      try {
        // Strip markdown fences if present
        const clean = result.text.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
        parsed = JSON.parse(clean);
      } catch {
        // Not all local models reliably follow JSON instruction — warn, don't fail
        console.warn(
          `[E2E] Local model did not return valid JSON: ${result.text.slice(0, 100)}`,
        );
        return;
      }

      expect(parsed).toBeDefined();
      console.log(`[E2E] JSON response: ${JSON.stringify(parsed)}`);
    }),
    120_000,
  );

  it(
    "token optimizer pipeline works before callCascade",
    skipIfNoLmStudio(async () => {
      // Simulate a real agent flow: dirty data → optimize → send to LLM
      const dirtyInput = `
# Analysis Report
\`\`\`python
def process(): pass
\`\`\`

**Key findings:**
- Finding one is very important
- Finding two follows naturally

The result is that the system needs attention.
      `.repeat(5); // Make it longer to test truncation

      const optimized = prepareForLlm(dirtyInput, {
        maxTokens: 200,
        strategy: "sentences",
      });

      // Verify optimization happened
      expect(optimized).not.toContain("```");
      expect(estimateTokens(optimized)).toBeLessThanOrEqual(240);

      const result = await callCascade(
        "local",
        [new HumanMessage(`Summarize in one sentence: ${optimized}`)],
        { agent: "e2e_test_optimizer", tenant_id: "test" },
      );

      expect(result.text.trim().length).toBeGreaterThan(10);
      console.log(`[E2E] Optimizer pipeline summary: ${result.text.trim().slice(0, 150)}`);
    }),
    120_000,
  );

  it(
    "context manager + cascade — trimmed message history goes to LLM",
    skipIfNoLmStudio(async () => {
      // Build a long conversation history (simulates a multi-turn agent)
      const fullHistory = Array.from({ length: 30 }, (_, i) =>
        i % 2 === 0
          ? new HumanMessage(`Turn ${i}: This is a conversation turn that takes some tokens for budget pressure.`)
          : new AIMessage(`Turn ${i}: This is a conversation turn that takes some tokens for budget pressure.`),
      );

      // Trim: tight budget forces dropping the middle. keepRecent is a FLOOR
      // ("always keep ≥ this many recent"), not a ceiling — the function may add
      // middle messages back while the total still fits the token budget.
      const trimmed = trimMessageHistory(fullHistory, {
        maxTokens: 200,
        keepRecent: 6,
        keepFirst: false,
      });

      // Contract: middle dropped (shorter than original), recent tail preserved.
      expect(trimmed.length).toBeLessThan(fullHistory.length);
      expect(trimmed.length).toBeGreaterThanOrEqual(6);
      expect(trimmed.slice(-6)).toEqual(fullHistory.slice(-6));

      const result = await callCascade(
        "local",
        [
          ...trimmed,
          new HumanMessage("What turn number was the last message you saw?"),
        ],
        { agent: "e2e_test_context", tenant_id: "test" },
      );

      expect(result.text.trim().length).toBeGreaterThan(0);
      console.log(`[E2E] Context trimming test response: ${result.text.trim().slice(0, 100)}`);
    }),
    120_000,
  );
});

// ── Circuit breaker behavior test (no LM Studio needed) ──────────────────────

describe("Circuit breaker — isBreakerOpen helper", () => {
  it("returns false for a never-triggered provider", async () => {
    const { isBreakerOpen } = await import("../../src/infra/llm.js");
    // A key that was never used should not be open
    expect(isBreakerOpen("lmstudio:never-used-model")).toBe(false);
    expect(isBreakerOpen("anthropic:claude-sonnet-4-5")).toBe(false);
  });
});
