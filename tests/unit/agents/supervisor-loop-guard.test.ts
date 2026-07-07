/**
 * Unit tests for the supervisor handoff loop guard.
 *
 * Why: the within-department repeat-guard only bounds identical tool calls
 * inside ONE department. This is the other, previously-unfixed loop class
 * (MEMORY.md: "T35 chained-synthesis LOOPS") — the SUPERVISOR itself
 * re-transfers to the same department over and over. Pure + deterministic
 * (rule #16) so it never depends on the model choosing to stop.
 *
 * RED until src/agents/supervisor-loop-guard.ts is implemented.
 */

import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  departmentFromHandoffToolName,
  countHandoffsToDepartment,
  isRunawayHandoff,
  supervisorLoopGuardPostModelHook,
  SUPERVISOR_LOOP_HARD_STOP_THRESHOLD,
  SUPERVISOR_LOOP_STOP_MESSAGE,
} from "../../../src/agents/supervisor-loop-guard.js";

describe("departmentFromHandoffToolName", () => {
  it("extracts the department name from a transfer_to_<dept> tool name", () => {
    expect(departmentFromHandoffToolName("transfer_to_engineering")).toBe("engineering");
    expect(departmentFromHandoffToolName("transfer_to_research")).toBe("research");
  });

  it("returns null for non-handoff tool names", () => {
    expect(departmentFromHandoffToolName("github_read")).toBeNull();
    expect(departmentFromHandoffToolName("search_web")).toBeNull();
  });

  it("returns null for a bare prefix with no department suffix", () => {
    expect(departmentFromHandoffToolName("transfer_to_")).toBeNull();
  });
});

function handoffMessage(id: string, dept: string) {
  return new AIMessage({
    content: "",
    tool_calls: [{ id, name: `transfer_to_${dept}`, args: {} }],
  });
}

describe("countHandoffsToDepartment", () => {
  it("counts every handoff tool call targeting the given department", () => {
    const messages = [
      new HumanMessage("do the multi-step task"),
      handoffMessage("h1", "engineering"),
      new ToolMessage({ content: "ok", tool_call_id: "h1", name: "transfer_to_engineering" }),
      new AIMessage("engineering's answer"),
      handoffMessage("h2", "engineering"),
    ];
    expect(countHandoffsToDepartment(messages, "engineering")).toBe(2);
  });

  it("does not count handoffs to a different department", () => {
    const messages = [handoffMessage("h1", "research"), handoffMessage("h2", "engineering")];
    expect(countHandoffsToDepartment(messages, "engineering")).toBe(1);
  });

  it("returns 0 when there are no handoffs at all", () => {
    expect(countHandoffsToDepartment([new HumanMessage("hi")], "engineering")).toBe(0);
  });
});

describe("isRunawayHandoff", () => {
  it("returns null when the last message is not a handoff", () => {
    const messages = [new HumanMessage("hi"), new AIMessage("just an answer")];
    expect(isRunawayHandoff(messages)).toBeNull();
  });

  it("returns null when the department has been tried fewer than the threshold", () => {
    const messages = [
      handoffMessage("h1", "engineering"),
      new AIMessage("partial"),
      handoffMessage("h2", "engineering"),
    ];
    expect(isRunawayHandoff(messages)).toBeNull();
  });

  it("flags a runaway handoff once the department has already been tried threshold times", () => {
    const priorHandoffs = Array.from({ length: SUPERVISOR_LOOP_HARD_STOP_THRESHOLD }, (_, i) =>
      handoffMessage(`h${i}`, "engineering"),
    );
    const messages = [...priorHandoffs, handoffMessage("h_final", "engineering")];
    const result = isRunawayHandoff(messages);
    expect(result).toEqual({ department: "engineering", priorCount: SUPERVISOR_LOOP_HARD_STOP_THRESHOLD });
  });

  it("does not confuse repeated handoffs to DIFFERENT departments as a runaway", () => {
    const messages = [
      handoffMessage("h1", "research"),
      handoffMessage("h2", "comms"),
      handoffMessage("h3", "personal"),
      handoffMessage("h4", "engineering"),
    ];
    expect(isRunawayHandoff(messages)).toBeNull();
  });
});

describe("supervisorLoopGuardPostModelHook", () => {
  it("returns no state update ({}) when there is no runaway handoff", () => {
    const state = { messages: [new HumanMessage("hi"), new AIMessage("answer")] };
    expect(supervisorLoopGuardPostModelHook(state)).toEqual({});
  });

  it("replaces a runaway handoff with a terminal stop message + closes the pending tool call", () => {
    const priorHandoffs = Array.from({ length: SUPERVISOR_LOOP_HARD_STOP_THRESHOLD }, (_, i) =>
      handoffMessage(`h${i}`, "engineering"),
    );
    const finalHandoff = handoffMessage("h_final", "engineering");
    const state = { messages: [...priorHandoffs, finalHandoff] };

    const result = supervisorLoopGuardPostModelHook(state) as { messages: unknown[] };
    expect(result.messages).toBeDefined();

    // A ToolMessage closes the pending "h_final" tool call (valid message sequence).
    const toolMsg = result.messages.find(
      (m): m is ToolMessage => m instanceof ToolMessage && m.tool_call_id === "h_final",
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toBe(SUPERVISOR_LOOP_STOP_MESSAGE);

    // The LAST message is a plain AIMessage with no tool_calls (ends the graph turn).
    const lastMsg = result.messages[result.messages.length - 1] as AIMessage;
    expect(lastMsg).toBeInstanceOf(AIMessage);
    expect(lastMsg.tool_calls ?? []).toHaveLength(0);
    expect(lastMsg.content).toBe(SUPERVISOR_LOOP_STOP_MESSAGE);
  });
});
