/**
 * Phase 3 wiring: outboundQualityGate = brand-validator (gate 1) + Claude judge
 * (gate 2). Gate 2 is fail-open and only runs when no real send happens, so with
 * no ANTHROPIC_API_KEY in the test env the judge is a no-op pass and the gate
 * behaves like the deterministic brand check — proving gate 1 still governs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { outboundQualityGate } from "../../../src/agents/agent-tools/comms.js";
import { _resetBrandRetries } from "../../../src/infra/brand-retry.js";
import { _resetJudgeCache } from "../../../src/infra/judge.js";

const cfg = { configurable: { thread_id: "t_gate" } };

// Pin gate 2 to its no-op (fail-open) mode so the unit test never makes a live
// Claude call. The judge's own behaviour is covered in judge.test.ts.
let savedKey: string | undefined;
beforeEach(() => {
  _resetBrandRetries();
  _resetJudgeCache();
  savedKey = process.env["ANTHROPIC_API_KEY"];
  delete process.env["ANTHROPIC_API_KEY"];
});
afterEach(() => {
  if (savedKey !== undefined) process.env["ANTHROPIC_API_KEY"] = savedKey;
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

  it("passes a clean draft through (judge is a no-op without ANTHROPIC_API_KEY)", async () => {
    const res = await outboundQualityGate(
      "Hi Sam, saw your team shipped the billing revamp. We build small AI tools that cut support load — worth a 15-min look?",
      "outreach",
      cfg,
    );
    expect(res.proceed).toBe(true);
    expect(res.fix).toBeUndefined();
  });
});
