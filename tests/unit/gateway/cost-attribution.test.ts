/**
 * Gateway-side cost attribution (AG-009).
 *
 * Two behaviours are covered here:
 *  1. withCostIdentity — the kernel-boot wrapper that attaches the attribution
 *     to the invoke config as run metadata. It knows the STAGE at construction
 *     and learns the WORKER from the exact tool array the kernel's agent node
 *     passes to bindTools().
 *  2. kernelCostSink — the row it hands to logLlmCost now carries the real
 *     actor and stage instead of the constants "kernel" / "primary".
 *
 * No database: src/db/queries.js is mocked at the module boundary, the same way
 * tests/unit/gateway/kernel-run.test.ts and the sweep tests do it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import {
  BudgetGuardCallback,
  BudgetTracker,
  attributionFromMetadata,
  type AccruedCall,
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
 * A model that records the attribution carried in the run metadata it is invoked
 * with — exactly the payload LangChain hands to the callback's start hook.
 */
function spyModel(seen: (CostAttribution | undefined)[]): KernelBindableModel {
  const record = async (_messages: unknown, config?: RunnableConfig): Promise<AIMessage> => {
    seen.push(attributionFromMetadata(config?.metadata));
    return new AIMessage("ok");
  };
  return {
    invoke: record as KernelBindableModel["invoke"],
    bindTools: () => ({ invoke: record as KernelBindableModel["invoke"] }),
  };
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

  it("sets ONLY metadata, so the ambient callbacks on the config survive", async () => {
    const seenConfig: (RunnableConfig | undefined)[] = [];
    const model = withCostIdentity(
      {
        invoke: (async (_m: unknown, config?: RunnableConfig) => {
          seenConfig.push(config);
          return new AIMessage("ok");
        }) as KernelBindableModel["invoke"],
      },
      { agent: "planner", stage: "planner" },
    );

    await model.invoke([]);

    expect(Object.keys(seenConfig[0] ?? {})).toEqual(["metadata"]);
  });
});

/**
 * REGRESSION (AG-009 review): attribution must survive LangChain's REAL callback
 * dispatch, not just a direct handleLLMEnd() call.
 *
 * @langchain/core dispatches handlers through a module-level p-queue with
 * concurrency 1 whenever `awaitHandlers` is false — and it is false here,
 * because it is set from LANGCHAIN_CALLBACKS_BACKGROUND === "false" and that
 * variable is unset in this repo (see callbacks/base.js and
 * singletons/callbacks.js). Queued handlers therefore run detached from the
 * caller's async context: the first task runs in the caller's context and the
 * rest drain from that task's continuation, inheriting ITS context.
 *
 * So an AsyncLocalStorage-based identity silently bills every concurrent call to
 * whichever one happened to open the queue. Nothing is "lost" — the ledger just
 * gets confident wrong data, which is the worst available failure. The identity
 * therefore travels as DATA on the call (run metadata, correlated by runId),
 * where dispatch timing cannot touch it.
 *
 * Concurrency is reachable in production: withChatTurnLock serialises one chat,
 * but a scheduled task (scheduled-task-run.ts:136) or a mission resume
 * (mission-resume.ts:165) can overlap a live turn from another chat.
 */
describe("attribution under REAL LangChain callback dispatch", () => {
  const CAPS = { maxUsd: 1000, maxTokens: 10_000_000 };

  it("attributes three SEQUENTIAL invocations to their own spenders", async () => {
    const accrued: AccruedCall[] = [];
    const cb = new BudgetGuardCallback(new BudgetTracker(CAPS), "fake", (c) => accrued.push(c));
    const raw = new FakeListChatModel({ responses: ["ok", "ok", "ok"], callbacks: [cb] });

    for (const agent of ["alpha", "beta", "gamma"]) {
      await withCostIdentity(raw as unknown as KernelBindableModel, { agent, stage: "worker" }).invoke([
        new HumanMessage("hi"),
      ]);
    }
    await awaitAllCallbacks();

    expect(accrued.map((c) => c.attribution?.agent)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("attributes three CONCURRENT invocations to their own spenders", async () => {
    const accrued: AccruedCall[] = [];
    const cb = new BudgetGuardCallback(new BudgetTracker(CAPS), "fake", (c) => accrued.push(c));
    const raw = new FakeListChatModel({ responses: ["ok", "ok", "ok"], callbacks: [cb] });

    await Promise.all(
      ["alpha", "beta", "gamma"].map((agent) =>
        withCostIdentity(raw as unknown as KernelBindableModel, { agent, stage: "worker" }).invoke([
          new HumanMessage("hi"),
        ]),
      ),
    );
    await awaitAllCallbacks();

    expect(accrued).toHaveLength(3);
    expect(accrued.map((c) => c.attribution?.agent).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("attributes concurrent calls from DIFFERENT stages without bleeding across them", async () => {
    const accrued: AccruedCall[] = [];
    const cb = new BudgetGuardCallback(new BudgetTracker(CAPS), "fake", (c) => accrued.push(c));
    const raw = new FakeListChatModel({ responses: ["ok", "ok", "ok", "ok"], callbacks: [cb] });
    const model = (agent: string, stage: "planner" | "worker" | "synthesizer") =>
      withCostIdentity(raw as unknown as KernelBindableModel, { agent, stage });

    await Promise.all([
      model("planner", "planner").invoke([new HumanMessage("a")]),
      model("jobhunt", "worker").invoke([new HumanMessage("b")]),
      model("research", "worker").invoke([new HumanMessage("c")]),
      model("synthesizer", "synthesizer").invoke([new HumanMessage("d")]),
    ]);
    await awaitAllCallbacks();

    const pairs = accrued.map((c) => `${c.attribution?.agent}/${c.attribution?.stage}`).sort();
    expect(pairs).toEqual([
      "jobhunt/worker",
      "planner/planner",
      "research/worker",
      "synthesizer/synthesizer",
    ]);
  });

  it("leaves a call made through an UNWRAPPED model unattributed rather than borrowing an identity", async () => {
    const accrued: AccruedCall[] = [];
    const cb = new BudgetGuardCallback(new BudgetTracker(CAPS), "fake", (c) => accrued.push(c));
    const raw = new FakeListChatModel({ responses: ["ok", "ok"], callbacks: [cb] });

    await Promise.all([
      withCostIdentity(raw as unknown as KernelBindableModel, {
        agent: "jobhunt",
        stage: "worker",
      }).invoke([new HumanMessage("a")]),
      raw.invoke([new HumanMessage("b")]),
    ]);
    await awaitAllCallbacks();

    expect(accrued.map((c) => c.attribution?.agent).sort()).toEqual(["jobhunt", undefined]);
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
