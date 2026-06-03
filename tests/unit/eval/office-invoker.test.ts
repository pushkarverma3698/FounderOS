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

import { describe, it, expect } from "vitest";
import {
  routeFromMessages,
  collectDeptTools,
  extractObservation,
} from "../../../src/eval/office-invoker.js";

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

  it("returns null when there was no handoff", () => {
    expect(routeFromMessages([human("hi"), ai([])])).toBeNull();
  });

  it("ignores transfer targets that are not real departments (handoff-back)", () => {
    const msgs = [ai([{ name: "transfer_back_to_supervisor" }]), ai([{ name: "transfer_to_supervisor" }])];
    expect(routeFromMessages(msgs)).toBeNull();
  });

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
