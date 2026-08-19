/**
 * Gateway-side cost attribution (AG-009).
 *
 * Two behaviours are covered here:
 *  1. withCostIdentity — the kernel-boot wrapper that opens the attribution
 *     scope. It knows the STAGE at construction and learns the WORKER from the
 *     exact tool array the kernel's agent node passes to bindTools().
 *  2. kernelCostSink — the row it hands to logLlmCost now carries the real
 *     actor and stage instead of the constants "kernel" / "primary".
 *
 * No database: src/db/queries.js is mocked at the module boundary, the same way
 * tests/unit/gateway/kernel-run.test.ts and the sweep tests do it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import {
  currentCostAttribution,
  UNATTRIBUTED_AGENT,
  UNATTRIBUTED_STAGE,
  type CostAttribution,
} from "../../../src/infra/budget.js";
import type { KernelBindableModel, KernelTool } from "../../../src/kernel/index.js";

const logLlmCost = vi.fn(async (_row: Record<string, unknown>) => undefined);
vi.mock("../../../src/db/queries.js", () => ({
  logLlmCost: (...a: unknown[]) => logLlmCost(...(a as [Record<string, unknown>])),
  getPendingInterrupt: vi.fn(async () => null),
  resolveInterrupt: vi.fn(async () => ({})),
  getTodayCostUsd: vi.fn(async () => 0),
  insertScheduledTask: vi.fn(async () => ({ id: "t" })),
}));

const { withCostIdentity, buildWorkerSpecs } = await import("../../../src/gateway/kernel-boot.js");
const { kernelCostSink } = await import("../../../src/gateway/kernel-run.js");

/**
 * A model that records the attribution visible at the moment it is invoked —
 * exactly where BudgetGuardCallback.handleLLMEnd reads it.
 */
function spyModel(seen: (CostAttribution | undefined)[]): KernelBindableModel {
  const record = async (): Promise<AIMessage> => {
    seen.push(currentCostAttribution());
    return new AIMessage("ok");
  };
  return { invoke: record, bindTools: () => ({ invoke: record }) };
}

describe("withCostIdentity", () => {
  it("attributes an unbound call to the stage-level actor", async () => {
    const seen: (CostAttribution | undefined)[] = [];
    const model = withCostIdentity(spyModel(seen), { agent: "planner", stage: "planner" });

    await model.invoke([]);

    expect(seen).toEqual([{ agent: "planner", stage: "planner" }]);
  });

  it("names the worker when bound to that worker's own tool array", async () => {
    const seen: (CostAttribution | undefined)[] = [];
    const model = withCostIdentity(spyModel(seen), { agent: "worker", stage: "worker" });
    const jobhunt = buildWorkerSpecs().find((s) => s.id === "jobhunt");
    expect(jobhunt).toBeDefined();

    await model.bindTools!(jobhunt!.tools).invoke([]);

    expect(seen).toEqual([{ agent: "jobhunt", stage: "worker" }]);
  });

  it("distinguishes two workers bound from the same worker model", async () => {
    const seen: (CostAttribution | undefined)[] = [];
    const model = withCostIdentity(spyModel(seen), { agent: "worker", stage: "worker" });
    const specs = buildWorkerSpecs();
    const research = specs.find((s) => s.id === "research")!;
    const engineering = specs.find((s) => s.id === "engineering")!;

    await model.bindTools!(research.tools).invoke([]);
    await model.bindTools!(engineering.tools).invoke([]);

    expect(seen.map((a) => a?.agent)).toEqual(["research", "engineering"]);
  });

  it("does NOT invent a worker id for a tool array that belongs to no worker", async () => {
    const seen: (CostAttribution | undefined)[] = [];
    const model = withCostIdentity(spyModel(seen), { agent: "worker", stage: "worker" });
    const strangers: KernelTool[] = [{ name: "not_a_worker_tool" } as unknown as KernelTool];

    await model.bindTools!(strangers).invoke([]);

    expect(seen).toEqual([{ agent: "worker", stage: "worker" }]);
  });

  it("keeps the stage when a worker id cannot be resolved — under-precise, never wrong", async () => {
    const seen: (CostAttribution | undefined)[] = [];
    const model = withCostIdentity(spyModel(seen), { agent: "synthesizer", stage: "synthesizer" });

    await model.invoke([]);

    expect(seen[0]!.stage).toBe("synthesizer");
  });
});

describe("kernelCostSink", () => {
  beforeEach(() => logLlmCost.mockClear());

  /** Wait for the fire-and-forget insert the sink deliberately does not await. */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("writes the worker as agent and the stage as tier", async () => {
    kernelCostSink({
      model: "gemini-flash-latest",
      inputTokens: 4210,
      outputTokens: 388,
      usd: 0.00043,
      attribution: { agent: "jobhunt", stage: "worker" },
    });
    await flush();

    expect(logLlmCost).toHaveBeenCalledTimes(1);
    expect(logLlmCost.mock.calls[0]![0]).toMatchObject({
      agent: "jobhunt",
      tier: "worker",
      model: "gemini-flash-latest",
      tokens_in: 4210,
      tokens_out: 388,
    });
  });

  it("marks a call with no attribution scope as unattributed instead of blaming a worker", async () => {
    kernelCostSink({ model: "gemini-flash-latest", inputTokens: 10, outputTokens: 5, usd: 0.000001 });
    await flush();

    expect(logLlmCost.mock.calls[0]![0]).toMatchObject({
      agent: UNATTRIBUTED_AGENT,
      tier: UNATTRIBUTED_STAGE,
    });
  });

  it("never populates lead_id — that FK belongs to outbound sales attribution", async () => {
    kernelCostSink({
      model: "gemini-flash-latest",
      inputTokens: 1,
      outputTokens: 1,
      usd: 0,
      attribution: { agent: "research", stage: "worker" },
    });
    await flush();

    expect(logLlmCost.mock.calls[0]![0]!["lead_id"]).toBeUndefined();
  });

  it("does not throw when the ledger write rejects — a DB blip must not kill the turn", async () => {
    logLlmCost.mockRejectedValueOnce(new Error("connection refused"));

    expect(() =>
      kernelCostSink({
        model: "gemini-flash-latest",
        inputTokens: 1,
        outputTokens: 1,
        usd: 0,
        attribution: { agent: "planner", stage: "planner" },
      }),
    ).not.toThrow();
    await flush();
  });
});
