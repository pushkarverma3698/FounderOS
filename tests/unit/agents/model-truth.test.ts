/**
 * Model truth (AG-031 part 1): an ai_call_costs row must name the model that
 * answered the stage, not the primary model the run was constructed with.
 *
 * Prod 2026-10-07: WORKER_AGENT_MODEL=openrouter:inclusionai/ling-3.0-flash, yet
 * all 311 rows said google-genai:gemini-3.8-flash. Cause: enforceRunBudget() is
 * built with AGENT_MODEL, and handleLLMEnd only used it as a fallback when the
 * response carried no model under the keys `model` / `model_id`. Providers do not
 * report it there (OpenAI-compatible: generationInfo.model_name; Gemini: nothing),
 * so every row fell back to AGENT_MODEL regardless of which model ran.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";

vi.mock("../../../src/db/queries.js", () => ({
  logLlmCost: vi.fn(async () => undefined),
  getPendingInterrupt: vi.fn(async () => null),
  resolveInterrupt: vi.fn(async () => ({})),
  getTodayCostUsd: vi.fn(async () => 0),
  insertScheduledTask: vi.fn(async () => ({ id: "t" })),
}));

const { enforceRunBudget, BudgetGuardCallback, BudgetTracker } = await import("../../../src/infra/budget.js");
const { withCostIdentity } = await import("../../../src/gateway/kernel-boot.js");
const { getWorkerModel } = await import("../../../src/agents/model.js");
const truth = await import("../../../src/agents/model-truth.js");

const PRIMARY = "google-genai:gemini-3.8-flash";
const LING = "openrouter:inclusionai/ling-3.0-flash";
type Bindable = Parameters<typeof withCostIdentity>[0];

describe("cost rows record the model that answered", () => {
  it("a worker-stage call records the worker model, not the run's primary", async () => {
    const rows: { model: string }[] = [];
    const budget = enforceRunBudget(PRIMARY, (c) => rows.push(c));
    const raw = new FakeListChatModel({ responses: ["ok"], callbacks: [budget.callback] });

    await withCostIdentity(raw as unknown as Bindable, { agent: "worker", stage: "worker", model: LING }).invoke([
      new HumanMessage("hi"),
    ]);
    await awaitAllCallbacks();

    expect(rows.map((r) => r.model)).toEqual([LING]);
  });

  it("the planner stage keeps recording the primary", async () => {
    const rows: { model: string }[] = [];
    const budget = enforceRunBudget(PRIMARY, (c) => rows.push(c));
    const raw = new FakeListChatModel({ responses: ["ok"], callbacks: [budget.callback] });

    await withCostIdentity(raw as unknown as Bindable, { agent: "planner", stage: "planner", model: PRIMARY }).invoke([
      new HumanMessage("hi"),
    ]);
    await awaitAllCallbacks();

    expect(rows.map((r) => r.model)).toEqual([PRIMARY]);
  });

  it("a model name reported by the provider wins over the declared one", async () => {
    const rows: { model: string }[] = [];
    const cb = new BudgetGuardCallback(new BudgetTracker({ maxUsd: 100, maxTokens: 1e7 }), PRIMARY, (c) => rows.push(c));
    const result: LLMResult = {
      generations: [[{ text: "x", generationInfo: { model_name: "inclusionai/ling-3.0-flash" } }]],
      llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 5 } },
    };
    await cb.handleLLMEnd(result);

    expect(rows[0]!.model).toBe("inclusionai/ling-3.0-flash");
  });
});

describe("worker model resolution is reported, not silent", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    truth.resetWorkerModelChoiceForTests();
  });

  it("a buildable worker id is the effective id", () => {
    process.env["AGENT_MODEL"] = PRIMARY;
    process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "g";
    process.env["WORKER_AGENT_MODEL"] = LING;
    process.env["OPENROUTER_API_KEY"] = "k";
    getWorkerModel();
    expect(truth.getEffectiveWorkerModelId()).toBe(LING);
    expect(truth.describeStageModels(PRIMARY).worker).toBe(LING);
  });

  it("falls back to the primary with the reason, logged once", () => {
    process.env["AGENT_MODEL"] = PRIMARY;
    process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "g";
    process.env["WORKER_AGENT_MODEL"] = "anthropic:claude-sonnet-5-5";
    delete process.env["ANTHROPIC_API_KEY"];
    const warn = vi.fn();
    truth.setModelTruthLogForTests({ warn });

    getWorkerModel();
    getWorkerModel();

    expect(truth.getEffectiveWorkerModelId()).toBe(PRIMARY);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toBe(
      `worker model anthropic:claude-sonnet-5-5 unavailable: ANTHROPIC_API_KEY is not set; using ${PRIMARY}`,
    );
  });
});
