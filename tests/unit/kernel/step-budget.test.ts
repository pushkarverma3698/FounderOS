/**
 * AG-035: per-step tool budget. Read-only steps may use 15 calls; anything that can write stays at 6.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { TaskEnvelopeSchema, type TaskEnvelope, type StepResult } from "../../../src/kernel/contracts.js";
import {
  READ_ONLY_TOOLS,
  clampStep,
  clampStepCalls,
  isReadOnlyTool,
  stepTools,
  capReachedNote,
  MAX_READ_TOOL_CALLS_PER_STEP,
} from "../../../src/kernel/step-budget.js";
import { dispatch } from "../../../src/kernel/supervisor.js";
import { collect } from "../../../src/kernel/worker.js";
import { budgetNotesBlock } from "../../../src/kernel/synthesizer.js";
import { HITL_GATED_TOOLS } from "../../../src/infra/hitl.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

const envelope = (max: number, over: Record<string, unknown> = {}, constraints: Record<string, unknown> = {}): TaskEnvelope =>
  TaskEnvelopeSchema.parse({
    step_id: "s1",
    worker: "engineering",
    objective: "Why does the retry loop stop early",
    inputs: {},
    expected: { kind: "data", schema_ref: "text.summary" },
    constraints: { max_tool_calls: max, hitl_required: false, ...constraints },
    ...over,
  });

describe("envelope contract", () => {
  it("accepts 15 calls and rejects 16", () => {
    expect(MAX_READ_TOOL_CALLS_PER_STEP).toBe(15);
    expect(() => envelope(15)).not.toThrow();
    expect(() => envelope(16)).toThrow();
  });
});

describe("clampStep", () => {
  it("keeps 15 for a read-only step", () => {
    expect(clampStepCalls(envelope(15))).toBe(15);
    expect(clampStep(envelope(15)).constraints.max_tool_calls).toBe(15);
  });

  it("clamps a HITL-required step to 6", () => {
    expect(clampStep(envelope(15, {}, { hitl_required: true })).constraints.max_tool_calls).toBe(6);
  });

  it("clamps an action_receipt step to 6", () => {
    const step = envelope(15, { expected: { kind: "action_receipt", schema_ref: "action.summary" } });
    expect(clampStep(step).constraints.max_tool_calls).toBe(6);
  });

  it("leaves 6 or fewer untouched and returns the same object", () => {
    const step = envelope(4);
    expect(clampStep(step)).toBe(step);
  });
});

describe("stepTools", () => {
  const tools = [{ name: "github_read" }, { name: "github_write" }, { name: "set_reminder" }];

  it("narrows a long read step to read-only tools", () => {
    expect(stepTools(envelope(15), tools).map((t) => t.name)).toEqual(["github_read"]);
  });

  it("does not narrow a step at the normal cap", () => {
    expect(stepTools(envelope(6), tools)).toHaveLength(3);
  });
});

describe("READ_ONLY_TOOLS never includes a tool that can ask for approval", () => {
  it("is disjoint from HITL_GATED_TOOLS", () => {
    for (const name of READ_ONLY_TOOLS) {
      expect(HITL_GATED_TOOLS.has(name), name + " is HITL-gated").toBe(false);
      expect(isReadOnlyTool(name)).toBe(true);
    }
  });

  it("lists no tool whose definition calls hitlGate()", () => {
    const files = readdirSync("src/agents/agent-tools")
      .filter((f) => f.endsWith(".ts"))
      .map((f) => "src/agents/agent-tools/" + f)
      .concat("src/tools/skill-synthesizer.ts");
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      let prev = 0;
      for (const m of src.matchAll(/name:\s*"([a-z_]+)"/g)) {
        const segment = src.slice(prev, m.index);
        prev = m.index ?? prev;
        if (READ_ONLY_TOOLS.has(m[1]!) && segment.includes("hitlGate(")) offenders.push(file + ":" + m[1]);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every read-only name exists as a tool definition", () => {
    const files = ["src/agents/agent-tools", "src/tools"].flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(d + "/" + f, "utf8")));
    const all = files.join("\n");
    for (const name of READ_ONLY_TOOLS) expect(all, name).toContain('name: "' + name + '"');
  });
});

const stateFor = (step: TaskEnvelope, scratch: Array<AIMessage | ToolMessage> = []): KernelStateType =>
  ({
    mission: { goal: "g", status: "executing", plan: { schema_version: 1, goal: "g", steps: [step] }, cursor: 0 },
    results: [],
    attempts: {},
    scratch: { s1: scratch },
    step_receipts: { s1: [] },
    failure: null,
    reply: "",
  }) as unknown as KernelStateType;

const budgetOf = (u: ReturnType<typeof dispatch>): number | undefined => {
  const mission = u.mission as unknown as { plan?: { steps: TaskEnvelope[] } } | undefined;
  return mission?.plan?.steps[0]?.constraints.max_tool_calls;
};

describe("dispatch", () => {
  it("clamps a write step the planner asked 15 for, and keeps a read step at 15", () => {
    const write = dispatch(stateFor(envelope(15, {}, { hitl_required: true })));
    expect(budgetOf(write)).toBe(6);
    const read = dispatch(stateFor(envelope(15)));
    expect(budgetOf(read)).toBe(15);
  });
});

describe("cap reached note", () => {
  it("names the unanswered objective and reaches the reply", async () => {
    const step = envelope(1);
    const call = new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "github_read", args: {} }] });
    const state = stateFor(step, [call, new ToolMessage({ content: "ok", tool_call_id: "c1" }), new AIMessage("{\"text\":\"partial\"}")]);
    (state as unknown as { step_receipts: Record<string, unknown[]> }).step_receipts["s1"] = [];
    const update = await collect(state);
    const result = (update.results as StepResult[])[0];
    expect(result?.status).toBe("ok");
    if (result?.status === "ok") {
      expect(result.note).toBe(capReachedNote(step));
      expect(result.note).toContain("Why does the retry loop stop early");
      expect(budgetNotesBlock([result])).toContain("Note: Tool budget reached");
    }
  });

  it("adds nothing when no step hit its cap", () => {
    expect(budgetNotesBlock([])).toBe("");
  });
});
