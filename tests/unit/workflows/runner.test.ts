/**
 * TDD — Workflow Runner (runWorkflow + validateParams)
 * RED: write and watch fail before any implementation exists.
 */

import { describe, it, expect, vi } from "vitest";
import { runWorkflow, validateParams } from "../../../src/workflows/runner.js";
import type { WorkflowDef } from "../../../src/workflows/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeWorkflow(overrides: Partial<WorkflowDef> = {}): WorkflowDef {
  return {
    id: "test-wf",
    name: "Test Workflow",
    description: "desc",
    params: ["company"],
    steps: [
      { id: "step1", label: "Step One", task: "Score {company}" },
      { id: "step2", label: "Step Two", task: "Research {company}" },
      { id: "step3", label: "Step Three", task: "Email {company}" },
    ],
    ...overrides,
  };
}

function makeCallbacks(stepResults: boolean[]) {
  const statusMessages: string[] = [];
  let callIdx = 0;

  return {
    callbacks: {
      sendStatus: vi.fn(async (msg: string) => { statusMessages.push(msg); }),
      runStep: vi.fn(async (_task: string) => stepResults[callIdx++] ?? true),
    },
    getStatus: () => statusMessages,
    getStepTasks: () => (vi.mocked(vi.fn()).mock?.calls ?? []),
  };
}

// ── runWorkflow ───────────────────────────────────────────────────────────────

describe("runWorkflow", () => {
  it("completes successfully when all steps return true", async () => {
    const wf = makeWorkflow();
    const { callbacks } = makeCallbacks([true, true, true]);

    const result = await runWorkflow(wf, { company: "Acme" }, callbacks);

    expect(result).toEqual({ completed: true, stepsRun: 3 });
  });

  it("aborts and returns false when a step returns false", async () => {
    const wf = makeWorkflow();
    const { callbacks } = makeCallbacks([true, false]);

    const result = await runWorkflow(wf, { company: "Acme" }, callbacks);

    expect(result.completed).toBe(false);
    expect(result.stepsRun).toBe(2);
    expect(result.abortedAt).toBe("step2");
  });

  it("does NOT run steps after the aborting step", async () => {
    const wf = makeWorkflow();
    const { callbacks } = makeCallbacks([true, false]);

    await runWorkflow(wf, { company: "Acme" }, callbacks);

    expect(callbacks.runStep).toHaveBeenCalledTimes(2);
  });

  it("aborts on the first step correctly", async () => {
    const wf = makeWorkflow();
    const { callbacks } = makeCallbacks([false]);

    const result = await runWorkflow(wf, { company: "Acme" }, callbacks);

    expect(result).toEqual({ completed: false, stepsRun: 1, abortedAt: "step1" });
    expect(callbacks.runStep).toHaveBeenCalledTimes(1);
  });

  it("passes rendered task (slots filled) to runStep", async () => {
    const wf = makeWorkflow({
      params: ["company"],
      steps: [{ id: "score", task: "Score {company} against ICP" }],
    });
    const { callbacks } = makeCallbacks([true]);

    await runWorkflow(wf, { company: "Stripe" }, callbacks);

    expect(callbacks.runStep).toHaveBeenCalledWith("Score Stripe against ICP");
  });

  it("renders template with multiple params", async () => {
    const wf = makeWorkflow({
      params: ["company", "target"],
      steps: [{ id: "email", task: "Email {target} at {company}" }],
    });
    const { callbacks } = makeCallbacks([true]);

    await runWorkflow(wf, { company: "Acme", target: "founders" }, callbacks);

    expect(callbacks.runStep).toHaveBeenCalledWith("Email founders at Acme");
  });

  it("sends an intro status message before any steps run", async () => {
    const wf = makeWorkflow();
    const statusMessages: string[] = [];
    const callbacks = {
      sendStatus: vi.fn(async (msg: string) => { statusMessages.push(msg); }),
      runStep: vi.fn(async () => true),
    };

    await runWorkflow(wf, { company: "Acme" }, callbacks);

    // First status message is the intro (contains the workflow name)
    expect(statusMessages[0]).toContain("Test Workflow");
    expect(statusMessages[0]).toContain("3 steps");
  });

  it("sends per-step progress messages with step number", async () => {
    const wf = makeWorkflow({
      steps: [
        { id: "s1", label: "Alpha", task: "Do alpha" },
        { id: "s2", label: "Beta", task: "Do beta" },
      ],
    });
    const statusMessages: string[] = [];
    const callbacks = {
      sendStatus: vi.fn(async (msg: string) => { statusMessages.push(msg); }),
      runStep: vi.fn(async () => true),
    };

    await runWorkflow(wf, {}, callbacks);

    expect(statusMessages.some((m) => m.includes("1/2") && m.includes("Alpha"))).toBe(true);
    expect(statusMessages.some((m) => m.includes("2/2") && m.includes("Beta"))).toBe(true);
  });

  it("sends a completion status message when all steps succeed", async () => {
    const wf = makeWorkflow();
    const statusMessages: string[] = [];
    const callbacks = {
      sendStatus: vi.fn(async (msg: string) => { statusMessages.push(msg); }),
      runStep: vi.fn(async () => true),
    };

    await runWorkflow(wf, { company: "Acme" }, callbacks);

    expect(statusMessages.at(-1)).toContain("3 steps done");
  });

  it("sends an abort status message that names the step that failed", async () => {
    const wf = makeWorkflow({
      steps: [
        { id: "score", label: "ICP Score", task: "Score" },
        { id: "email", label: "Send Email", task: "Email" },
      ],
    });
    const statusMessages: string[] = [];
    const callbacks = {
      sendStatus: vi.fn(async (msg: string) => { statusMessages.push(msg); }),
      runStep: vi.fn(async (_task: string) => statusMessages.filter(m => m.includes("2/2")).length > 0 ? false : true),
    };

    // Step 1 passes, step 2 fails
    let call = 0;
    callbacks.runStep = vi.fn(async () => (call++ === 0 ? true : false));

    await runWorkflow(wf, {}, callbacks);

    expect(statusMessages.at(-1)).toContain("Send Email");
  });

  it("handles a workflow with zero steps (edge case)", async () => {
    const wf = makeWorkflow({ steps: [] });
    const { callbacks } = makeCallbacks([]);

    const result = await runWorkflow(wf, {}, callbacks);

    expect(result).toEqual({ completed: true, stepsRun: 0 });
    expect(callbacks.runStep).not.toHaveBeenCalled();
  });

  it("does not include abortedAt in result when workflow completes", async () => {
    const wf = makeWorkflow();
    const { callbacks } = makeCallbacks([true, true, true]);

    const result = await runWorkflow(wf, { company: "Acme" }, callbacks);

    expect(result.abortedAt).toBeUndefined();
  });

  // ── Error recovery (step throws) ──────────────────────────────────────────────

  it("sets completed: false and abortedAt when a required step throws an error", async () => {
    const wf = makeWorkflow({
      steps: [
        { id: "s1", label: "Step One", task: "Task one" },
        { id: "s2", label: "Step Two", task: "Task two" },
        { id: "s3", label: "Step Three", task: "Task three" },
      ],
    });
    const callbacks = {
      sendStatus: vi.fn(async () => undefined),
      runStep: vi.fn()
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error("Unexpected LLM error")),
    };

    const result = await runWorkflow(wf, {}, callbacks);

    expect(result.completed).toBe(false);
    expect(result.abortedAt).toBe("s2");
  });

  it("calls sendStatus with a 'failed' message when a step throws", async () => {
    const wf = makeWorkflow({
      steps: [{ id: "s1", label: "Alpha Step", task: "Do alpha" }],
    });
    const statusMessages: string[] = [];
    const callbacks = {
      sendStatus: vi.fn(async (msg: string) => { statusMessages.push(msg); }),
      runStep: vi.fn().mockRejectedValueOnce(new Error("Boom")),
    };

    await runWorkflow(wf, {}, callbacks);

    const failMsg = statusMessages.find((m) => m.toLowerCase().includes("failed"));
    expect(failMsg).toBeDefined();
    expect(failMsg).toContain("Alpha Step");
  });

  it("sets stepsRun to the index of the failed step (abort at step 2 of 3)", async () => {
    const wf = makeWorkflow({
      steps: [
        { id: "s1", task: "Step 1" },
        { id: "s2", task: "Step 2" },
        { id: "s3", task: "Step 3" },
      ],
    });
    const callbacks = {
      sendStatus: vi.fn(async () => undefined),
      runStep: vi.fn()
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error("Error on step 2")),
    };

    const result = await runWorkflow(wf, {}, callbacks);

    expect(result.stepsRun).toBe(2);
    expect(callbacks.runStep).toHaveBeenCalledTimes(2);
  });

  it("continues to the next step when an optional step throws", async () => {
    const wf = makeWorkflow({
      steps: [
        { id: "s1", label: "Required Step", task: "Required" },
        { id: "s2", label: "Optional Step", task: "Optional", optional: true },
        { id: "s3", label: "Final Step", task: "Final" },
      ],
    });
    const callbacks = {
      sendStatus: vi.fn(async () => undefined),
      runStep: vi.fn()
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error("Optional failed"))
        .mockResolvedValueOnce(true),
    };

    const result = await runWorkflow(wf, {}, callbacks);

    expect(result.completed).toBe(true);
    expect(callbacks.runStep).toHaveBeenCalledTimes(3);
  });

  it("returns completed: true with stepsRun count when all optional steps fail", async () => {
    const wf = makeWorkflow({
      steps: [
        { id: "s1", label: "Opt A", task: "Task A", optional: true },
        { id: "s2", label: "Opt B", task: "Task B", optional: true },
      ],
    });
    const callbacks = {
      sendStatus: vi.fn(async () => undefined),
      runStep: vi.fn()
        .mockRejectedValueOnce(new Error("Opt A failed"))
        .mockRejectedValueOnce(new Error("Opt B failed")),
    };

    const result = await runWorkflow(wf, {}, callbacks);

    expect(result.completed).toBe(true);
    expect(result.stepsRun).toBe(2);
  });
});

// ── validateParams ────────────────────────────────────────────────────────────

describe("validateParams", () => {
  const wf = makeWorkflow({ params: ["company", "target"] });

  it("returns empty array when all required params are present", () => {
    expect(validateParams(wf, { company: "Acme", target: "founders" })).toEqual([]);
  });

  it("returns missing param names when a param is absent", () => {
    expect(validateParams(wf, { company: "Acme" })).toContain("target");
  });

  it("returns all missing params when none are provided", () => {
    const missing = validateParams(wf, {});
    expect(missing).toContain("company");
    expect(missing).toContain("target");
    expect(missing.length).toBe(2);
  });

  it("treats whitespace-only value as missing", () => {
    const missing = validateParams(wf, { company: "  ", target: "founders" });
    expect(missing).toContain("company");
    expect(missing).not.toContain("target");
  });

  it("accepts a workflow with no required params", () => {
    const noParamWf = makeWorkflow({ params: [] });
    expect(validateParams(noParamWf, {})).toEqual([]);
  });

  it("does not flag extra (unrequired) params as errors", () => {
    const missing = validateParams(wf, { company: "Acme", target: "cto", extra: "ignored" });
    expect(missing).toEqual([]);
  });
});
