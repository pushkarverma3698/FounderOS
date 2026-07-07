/**
 * Unit tests for the pure parts of the live office invoker.
 *
 * Live-test finding (2026-06-03): langgraph-supervisor defaults to
 * outputMode "last_message", so a sub-agent's internal tool calls never appear
 * in the top-level message trail — only the supervisor's own handoff does. So:
 *   - route  comes from the message trail (the supervisor's transfer_to_<dept>)
 *   - tools  come from a LangChain callback (handleToolStart), passed in as a
 *            list of tool names
 *
 * Both helpers are pure → testable without an LLM. RED until office-invoker.ts
 * exposes routeFromMessages / collectDeptTools / the 3-arg extractObservation.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  routeFromMessages,
  collectDeptTools,
  extractObservation,
} from "../../../src/eval/office-invoker.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { GoldenTask } from "../../../src/eval/types.js";

const ai = (toolCalls: Array<{ name: string }>) => ({
  _getType: () => "ai",
  content: "",
  tool_calls: toolCalls,
});
const human = (text: string) => ({ _getType: () => "human", content: text });

describe("routeFromMessages", () => {
  it("reads the routed department from a transfer_to_<dept> handoff", () => {
    expect(routeFromMessages([human("email alex"), ai([{ name: "transfer_to_comms" }])])).toBe("comms");
  });

  it("takes the last department when the supervisor re-routes", () => {
    const msgs = [ai([{ name: "transfer_to_research" }]), ai([{ name: "transfer_to_marketing" }])];
    expect(routeFromMessages(msgs)).toBe("marketing");
  });

  // test-integrity-ignore: null IS the exact contract for "no handoff" — there is no stronger assertion for this pure function's negative case.
  it("returns null when there was no handoff", () => {
    expect(routeFromMessages([human("hi"), ai([])])).toBeNull();
  });

  // test-integrity-ignore: null IS the exact contract when only non-department handoff targets appear — no stronger assertion applies.
  it("ignores transfer targets that are not real departments (handoff-back)", () => {
    const msgs = [ai([{ name: "transfer_back_to_supervisor" }]), ai([{ name: "transfer_to_supervisor" }])];
    expect(routeFromMessages(msgs)).toBeNull();
  });

  // test-integrity-ignore: null IS the exact contract for an empty trail — no stronger assertion applies.
  it("handles an empty trail", () => {
    expect(routeFromMessages([])).toBeNull();
  });
});

describe("collectDeptTools", () => {
  it("keeps department tool names in first-seen order", () => {
    expect(collectDeptTools(["search_web", "send_email"])).toEqual(["search_web", "send_email"]);
  });

  it("dedupes repeated tool calls", () => {
    expect(collectDeptTools(["search_web", "search_web", "read_emails"])).toEqual(["search_web", "read_emails"]);
  });

  it("excludes handoff tools (transfer_*) that also fire handleToolStart", () => {
    expect(collectDeptTools(["transfer_to_comms", "send_email"])).toEqual(["send_email"]);
  });

  it("returns [] for no tools", () => {
    expect(collectDeptTools([])).toEqual([]);
  });
});

describe("extractObservation", () => {
  it("combines route (from messages) + tools (from callback names) + hadInterrupt", () => {
    const msgs = [human("email alex"), ai([{ name: "transfer_to_comms" }])];
    const o = extractObservation(msgs, ["transfer_to_comms", "send_email"], true);
    expect(o.route).toBe("comms");
    expect(o.tools).toEqual(["send_email"]); // handoff excluded
    expect(o.hadInterrupt).toBe(true);
  });

  it("handles an empty run", () => {
    expect(extractObservation([], [], false)).toEqual({ route: null, tools: [], hadInterrupt: false });
  });
});

// ── makeOfficeInvoker forced_tool injection (Gate B fidelity) ──────────────────
// The eval MUST mirror the production gateway (office-run.ts:959-970): when native
// tool_choice forcing is on, inject the SAME configurable.forced_tool. Before this
// fix the eval never set it, so FORCE_TOOL_CHOICE=1 eval runs proved nothing about
// forcing. FORCE_TOOL_CHOICE_ENABLED is read at import time, so we reset+re-import
// the module under each env to observe both branches without any LLM.
describe("makeOfficeInvoker — forced_tool injection", () => {
  const SHELL_TASK: GoldenTask = { id: "t-shell", input: "run in terminal: ls -la" } as GoldenTask;

  afterEach(() => {
    delete process.env["FORCE_TOOL_CHOICE"];
    vi.resetModules();
  });

  async function runWith(force: boolean): Promise<RunnableConfig> {
    if (force) process.env["FORCE_TOOL_CHOICE"] = "1";
    else delete process.env["FORCE_TOOL_CHOICE"];
    vi.resetModules();
    const mod = await import("../../../src/eval/office-invoker.js");
    let captured: RunnableConfig = {};
    const fakeOffice = {
      invoke: async (_input: unknown, config: RunnableConfig) => {
        captured = config;
        return { messages: [] };
      },
    };
    const invoker = mod.makeOfficeInvoker(fakeOffice, async () => null);
    await invoker(SHELL_TASK);
    return captured;
  }

  it("injects forced_tool matching the production gateway when forcing is ON", async () => {
    const config = await runWith(true);
    expect(config.configurable?.["forced_tool"]).toBe("run_shell");
  });

  // test-integrity-ignore: undefined IS the exact contract when forcing is off (key must be absent, not just falsy) — no stronger assertion applies.
  it("does NOT inject forced_tool when forcing is OFF (default)", async () => {
    const config = await runWith(false);
    expect(config.configurable?.["forced_tool"]).toBeUndefined();
  });
});
