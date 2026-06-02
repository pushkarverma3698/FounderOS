/**
 * Unit tests for extractObservation — the pure part of the live office invoker.
 *
 * It reads what the office actually did from the message trail: which department
 * the supervisor handed off to (transfer_to_<dept> tool call), which tools ran,
 * and whether the run paused for approval. Pure → testable without an LLM.
 * RED until src/eval/office-invoker.ts exists.
 */

import { describe, it, expect } from "vitest";
import { extractObservation } from "../../../src/eval/office-invoker.js";

// Minimal message stand-ins matching what LangGraph returns (tool_calls on AIMessages).
const ai = (toolCalls: Array<{ name: string }>) => ({
  _getType: () => "ai",
  content: "",
  tool_calls: toolCalls,
});
const human = (text: string) => ({ _getType: () => "human", content: text });

describe("extractObservation", () => {
  it("reads the routed department from a transfer_to_<dept> handoff", () => {
    const msgs = [human("email alex"), ai([{ name: "transfer_to_comms" }])];
    const o = extractObservation(msgs, false);
    expect(o.route).toBe("comms");
  });

  it("collects department tool calls but excludes the transfer handoff", () => {
    const msgs = [
      human("email alex"),
      ai([{ name: "transfer_to_comms" }]),
      ai([{ name: "send_email" }]),
    ];
    const o = extractObservation(msgs, true);
    expect(o.tools).toEqual(["send_email"]);
    expect(o.tools).not.toContain("transfer_to_comms");
    expect(o.hadInterrupt).toBe(true);
  });

  it("dedupes repeated tool calls", () => {
    const msgs = [ai([{ name: "transfer_to_research" }]), ai([{ name: "search_web" }, { name: "search_web" }])];
    const o = extractObservation(msgs, false);
    expect(o.tools).toEqual(["search_web"]);
  });

  it("takes the last department when the supervisor re-routes", () => {
    const msgs = [ai([{ name: "transfer_to_research" }]), ai([{ name: "transfer_to_marketing" }])];
    expect(extractObservation(msgs, false).route).toBe("marketing");
  });

  it("returns route null when there was no handoff", () => {
    const msgs = [human("hi"), ai([])];
    expect(extractObservation(msgs, false).route).toBeNull();
  });

  it("ignores transfer targets that are not real departments (e.g. handoff-back)", () => {
    const msgs = [ai([{ name: "transfer_back_to_supervisor" }]), ai([{ name: "transfer_to_supervisor" }])];
    expect(extractObservation(msgs, false).route).toBeNull();
  });

  it("handles an empty trail without throwing", () => {
    const o = extractObservation([], false);
    expect(o).toEqual({ route: null, tools: [], hadInterrupt: false });
  });
});
