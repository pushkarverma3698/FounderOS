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
  costAttributionMetadata,
  attributionFromMetadata,
  COST_AGENT_METADATA_KEY,
  COST_STAGE_METADATA_KEY,
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

describe("costAttributionMetadata / attributionFromMetadata", () => {
  it("round-trips an attribution through run metadata", () => {
    const meta = costAttributionMetadata({ agent: "jobhunt", stage: "worker" });
    expect(meta).toEqual({ [COST_AGENT_METADATA_KEY]: "jobhunt", [COST_STAGE_METADATA_KEY]: "worker" });
    expect(attributionFromMetadata(meta)).toEqual({ agent: "jobhunt", stage: "worker" });
  });

  it("preserves other metadata keys around it", () => {
    const meta = { langgraph_node: "agent", ...costAttributionMetadata({ agent: "research", stage: "worker" }) };
    expect(attributionFromMetadata(meta)).toEqual({ agent: "research", stage: "worker" });
  });

  it("returns undefined for absent, empty, or unrelated metadata", () => {
    expect(attributionFromMetadata(undefined)).toBeUndefined();
    expect(attributionFromMetadata({})).toBeUndefined();
    expect(attributionFromMetadata({ langgraph_node: "agent" })).toBeUndefined();
  });

  it("does NOT accept a half-populated payload — a missing stage is unattributed, not guessed", () => {
    expect(attributionFromMetadata({ [COST_AGENT_METADATA_KEY]: "jobhunt" })).toBeUndefined();
    expect(attributionFromMetadata({ [COST_STAGE_METADATA_KEY]: "worker" })).toBeUndefined();
  });

  it("rejects a stage that is not one of the three kernel nodes", () => {
    expect(
      attributionFromMetadata({
        [COST_AGENT_METADATA_KEY]: "jobhunt",
        [COST_STAGE_METADATA_KEY]: "sideways",
      }),
    ).toBeUndefined();
  });

  it("rejects a non-string or empty agent", () => {
    expect(
      attributionFromMetadata({ [COST_AGENT_METADATA_KEY]: "", [COST_STAGE_METADATA_KEY]: "worker" }),
    ).toBeUndefined();
    expect(
      attributionFromMetadata({ [COST_AGENT_METADATA_KEY]: 7, [COST_STAGE_METADATA_KEY]: "worker" }),
    ).toBeUndefined();
  });
});

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

describe("BudgetGuardCallback attribution passthrough", () => {
  it("stamps the attribution recorded at start onto the accrued call", async () => {
    const calls: AccruedCall[] = [];
    const cb = new BudgetGuardCallback(new BudgetTracker(CAPS), "gemini-2.5-flash", (c) => calls.push(c));

    await cb.handleChatModelStart(
      {}, [], RUN_A, undefined, undefined, undefined,
      costAttributionMetadata({ agent: "jobhunt", stage: "worker" }),
    );
    await cb.handleLLMEnd(llmResult(1000, 500), RUN_A);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.attribution).toEqual({ agent: "jobhunt", stage: "worker" });
    expect(calls[0]!.inputTokens).toBe(1000);
    expect(calls[0]!.outputTokens).toBe(500);
  });

  it("keeps two interleaved runs apart by runId", async () => {
    const calls: AccruedCall[] = [];
    const cb = new BudgetGuardCallback(new BudgetTracker(CAPS), "gemini-2.5-flash", (c) => calls.push(c));

    await cb.handleChatModelStart(
      {}, [], RUN_A, undefined, undefined, undefined,
      costAttributionMetadata({ agent: "jobhunt", stage: "worker" }),
    );
    await cb.handleChatModelStart(
      {}, [], RUN_B, undefined, undefined, undefined,
      costAttributionMetadata({ agent: "planner", stage: "planner" }),
    );
    // End them in the OPPOSITE order to prove the pairing is by id, not order.
    await cb.handleLLMEnd(llmResult(10, 10), RUN_B);
    await cb.handleLLMEnd(llmResult(20, 20), RUN_A);

    expect(calls.map((c) => c.attribution?.agent)).toEqual(["planner", "jobhunt"]);
  });

  it("leaves attribution undefined when the call carried no metadata", async () => {
    const calls: AccruedCall[] = [];
    const cb = new BudgetGuardCallback(new BudgetTracker(CAPS), "gemini-2.5-flash", (c) => calls.push(c));

    await cb.handleChatModelStart({}, [], RUN_A);
    await cb.handleLLMEnd(llmResult(10, 10), RUN_A);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.attribution).toBeUndefined();
  });

  it("does not reuse a consumed attribution for a later unattributed run", async () => {
    const calls: AccruedCall[] = [];
    const cb = new BudgetGuardCallback(new BudgetTracker(CAPS), "gemini-2.5-flash", (c) => calls.push(c));

    await cb.handleChatModelStart(
      {}, [], RUN_A, undefined, undefined, undefined,
      costAttributionMetadata({ agent: "jobhunt", stage: "worker" }),
    );
    await cb.handleLLMEnd(llmResult(10, 10), RUN_A);
    await cb.handleLLMEnd(llmResult(10, 10), RUN_A);

    expect(calls.map((c) => c.attribution?.agent)).toEqual(["jobhunt", undefined]);
  });

  it("drops the pending entry when the call errors, so it cannot be billed later", async () => {
    const calls: AccruedCall[] = [];
    const cb = new BudgetGuardCallback(new BudgetTracker(CAPS), "gemini-2.5-flash", (c) => calls.push(c));

    await cb.handleChatModelStart(
      {}, [], RUN_A, undefined, undefined, undefined,
      costAttributionMetadata({ agent: "jobhunt", stage: "worker" }),
    );
    await cb.handleLLMError(new Error("503"), RUN_A);
    await cb.handleLLMEnd(llmResult(10, 10), RUN_A);

    expect(calls[0]!.attribution).toBeUndefined();
  });

  it("still accrues into the tracker — attribution must not change budget behaviour", async () => {
    const tracker = new BudgetTracker(CAPS);
    const cb = new BudgetGuardCallback(tracker, "gemini-2.5-flash");

    await cb.handleChatModelStart(
      {}, [], RUN_A, undefined, undefined, undefined,
      costAttributionMetadata({ agent: "jobhunt", stage: "worker" }),
    );
    await cb.handleLLMEnd(llmResult(1000, 1000), RUN_A);

    expect(tracker.summary.totalTokens).toBe(2000);
    expect(tracker.summary.totalUsd).toBeGreaterThan(0);
  });
});
