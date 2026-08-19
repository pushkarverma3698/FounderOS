/**
 * Unit tests for per-call cost attribution (AG-009).
 *
 * Why: ai_call_costs.agent/tier were constants ("kernel"/"primary") for every
 * LLM call, so the planner, each worker, and the synthesizer were
 * indistinguishable in the ledger. The BudgetGuardCallback is attached ONCE per
 * run and cannot know which graph node invoked the model, so the identity is
 * carried in an async-local scope entered by the model wrapper that DOES know
 * it (kernel-boot builds a distinct model per stage).
 *
 * Fixtures only — no database, no LLM.
 */

import { describe, it, expect } from "vitest";
import type { LLMResult } from "@langchain/core/outputs";
import {
  BudgetTracker,
  BudgetGuardCallback,
  withCostAttribution,
  currentCostAttribution,
  type AccruedCall,
} from "../../../src/infra/budget.js";

/** An LLMResult shaped like a real Gemini response with usage metadata. */
function llmResult(promptTokens: number, completionTokens: number): LLMResult {
  return {
    generations: [[{ text: "ok", generationInfo: {} }]],
    llmOutput: { tokenUsage: { promptTokens, completionTokens } },
  } as unknown as LLMResult;
}

const CAPS = { maxUsd: 100, maxTokens: 1_000_000 };

describe("withCostAttribution / currentCostAttribution", () => {
  it("exposes the attribution to code running inside the scope", () => {
    const seen = withCostAttribution({ agent: "jobhunt", stage: "worker" }, () =>
      currentCostAttribution(),
    );
    expect(seen).toEqual({ agent: "jobhunt", stage: "worker" });
  });

  it("returns undefined OUTSIDE any scope — an unattributed call must not borrow someone else's identity", () => {
    withCostAttribution({ agent: "planner", stage: "planner" }, () => undefined);
    expect(currentCostAttribution()).toBeUndefined();
  });

  it("survives an await inside the scope", async () => {
    const seen = await withCostAttribution({ agent: "research", stage: "worker" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentCostAttribution();
    });
    expect(seen).toEqual({ agent: "research", stage: "worker" });
  });

  it("restores the outer attribution when a nested scope exits", () => {
    const seen = withCostAttribution({ agent: "planner", stage: "planner" }, () => {
      withCostAttribution({ agent: "jobhunt", stage: "worker" }, () => currentCostAttribution());
      return currentCostAttribution();
    });
    expect(seen).toEqual({ agent: "planner", stage: "planner" });
  });
});

describe("BudgetGuardCallback attribution passthrough", () => {
  it("stamps the in-scope attribution onto the accrued call", async () => {
    const calls: AccruedCall[] = [];
    const cb = new BudgetGuardCallback(new BudgetTracker(CAPS), "gemini-2.5-flash", (c) =>
      calls.push(c),
    );

    await withCostAttribution({ agent: "jobhunt", stage: "worker" }, () =>
      cb.handleLLMEnd(llmResult(1000, 500)),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.attribution).toEqual({ agent: "jobhunt", stage: "worker" });
    expect(calls[0]!.inputTokens).toBe(1000);
    expect(calls[0]!.outputTokens).toBe(500);
  });

  it("leaves attribution undefined when the call happens outside any stage scope", async () => {
    const calls: AccruedCall[] = [];
    const cb = new BudgetGuardCallback(new BudgetTracker(CAPS), "gemini-2.5-flash", (c) =>
      calls.push(c),
    );

    await cb.handleLLMEnd(llmResult(10, 10));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.attribution).toBeUndefined();
  });

  it("attributes two calls in different scopes to different spenders", async () => {
    const calls: AccruedCall[] = [];
    const cb = new BudgetGuardCallback(new BudgetTracker(CAPS), "gemini-2.5-flash", (c) =>
      calls.push(c),
    );

    await withCostAttribution({ agent: "planner", stage: "planner" }, () =>
      cb.handleLLMEnd(llmResult(100, 100)),
    );
    await withCostAttribution({ agent: "synthesizer", stage: "synthesizer" }, () =>
      cb.handleLLMEnd(llmResult(200, 200)),
    );

    expect(calls.map((c) => c.attribution?.agent)).toEqual(["planner", "synthesizer"]);
    expect(calls.map((c) => c.attribution?.stage)).toEqual(["planner", "synthesizer"]);
  });

  it("still accrues into the tracker — attribution must not change budget behaviour", async () => {
    const tracker = new BudgetTracker(CAPS);
    const cb = new BudgetGuardCallback(tracker, "gemini-2.5-flash");

    await withCostAttribution({ agent: "jobhunt", stage: "worker" }, () =>
      cb.handleLLMEnd(llmResult(1000, 1000)),
    );

    expect(tracker.summary.totalTokens).toBe(2000);
    expect(tracker.summary.totalUsd).toBeGreaterThan(0);
  });
});
