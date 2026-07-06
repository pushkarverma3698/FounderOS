/**
 * Phase 3 wiring: outboundQualityGate = brand-validator (gate 1) + independent
 * judge (gate 2). Gate 2 is fail-open and only runs when no real send happens, so
 * with NO provider key in the test env the judge is a no-op pass and the gate
 * behaves like the deterministic brand check — proving gate 1 still governs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { outboundQualityGate } from "../../../src/agents/agent-tools/comms.js";
import { _resetBrandRetries } from "../../../src/infra/brand-retry.js";
import { _resetJudgeCache, _resetJudgeModel } from "../../../src/infra/judge.js";

const cfg = { configurable: { thread_id: "t_gate" } };

// Pin gate 2 to its no-op (fail-open) mode so the unit test never makes a live
// model call. The default judge provider is OpenRouter, so clear BOTH keys.
// The judge's own behaviour is covered (with an injected fake) in judge.test.ts.
const saved: Record<string, string | undefined> = {};
const JUDGE_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"] as const;
beforeEach(() => {
  _resetBrandRetries();
  _resetJudgeCache();
  _resetJudgeModel();
  for (const k of JUDGE_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of JUDGE_KEYS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
});

describe("outboundQualityGate", () => {
  it("blocks (proceed:false) when gate 1 brand-validator flags the draft", async () => {
    // Banned hype phrasing should trip the deterministic brand check first.
    const res = await outboundQualityGate(
      "Let's leverage synergy to disrupt and unlock game-changing paradigm shifts!",
      "linkedin",
      cfg,
    );
    expect(res.proceed).toBe(false);
    expect(res.fix).toBeTruthy();
  });

  it("passes a clean draft through (judge is a no-op with no provider key)", async () => {
    const res = await outboundQualityGate(
      "Hi Sam, saw your team shipped the billing revamp. We build small AI tools that cut support load — worth a 15-min look?",
      "outreach",
      cfg,
    );
    expect(res.proceed).toBe(true);
    expect(res.fix).toBeUndefined();
  });

  // M5 fix: this exact scenario (no judge key configured → gate 2 no-op pass)
  // must surface a visible warning on the HITL card — before the fix, a
  // silently-skipped judge was indistinguishable from a genuine pass.
  it("M5: surfaces a degraded-gate warning on the HITL card when the judge is a no-op", async () => {
    const res = await outboundQualityGate(
      "Hi Sam, saw your team shipped the billing revamp. We build small AI tools that cut support load — worth a 15-min look?",
      "outreach",
      cfg,
    );
    expect(res.proceed).toBe(true);
    expect(res.warning).toMatch(/quality judge.*unavailable/i);
  });
});
