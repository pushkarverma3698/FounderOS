/**
 * Unit tests for the conversation history window — the PERMANENT fix for the
 * "loops / same reply every time" bug.
 *
 * Root cause (documented in checkpointer.ts 70-78): the stable per-chat thread
 * accumulates the full message history forever, so old turns get replayed every
 * message and the model anchors on stale state. computeHistoryTrim decides which
 * messages to delete (by id) to keep only the last N turns — pure + deterministic,
 * so it never strands a leading orphaned tool message (which Gemini rejects).
 */

import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { computeHistoryTrim } from "../../../src/infra/history-window.js";

/** Build a realistic trail of `turns` human/ai rounds, each with an id. */
function trail(turns: number) {
  const msgs = [];
  for (let i = 0; i < turns; i++) {
    msgs.push(new HumanMessage({ content: `q${i}`, id: `h${i}` }));
    msgs.push(new AIMessage({ content: `a${i}`, id: `a${i}` }));
  }
  return msgs;
}

describe("computeHistoryTrim", () => {
  it("keeps everything when under the turn limit", () => {
    const msgs = trail(3);
    const { toRemove, toKeep } = computeHistoryTrim(msgs, { keepTurns: 12 });
    expect(toRemove).toEqual([]);
    expect(toKeep).toHaveLength(6);
  });

  it("removes the oldest turns beyond keepTurns, keeping the last N", () => {
    const msgs = trail(20); // 20 human messages
    const { toRemove, toKeep } = computeHistoryTrim(msgs, { keepTurns: 5 });
    // keep the last 5 human turns = 10 messages
    expect(toKeep).toHaveLength(10);
    // removed the first 15 turns = 30 messages
    expect(toRemove).toHaveLength(30);
  });

  it("always keeps a HumanMessage at the front of the kept window (no orphan tool message)", () => {
    const msgs = trail(20);
    const { toKeep } = computeHistoryTrim(msgs, { keepTurns: 3 });
    expect(toKeep[0]!._getType()).toBe("human");
  });

  it("preserves tool-call/tool-result pairs inside the kept window", () => {
    // a single turn with a tool round
    const msgs = [
      new HumanMessage({ content: "old", id: "h0" }),
      new AIMessage({ content: "old a", id: "a0" }),
      new HumanMessage({ content: "list files", id: "h1" }),
      new AIMessage({ content: "", id: "a1", tool_calls: [{ name: "list_dir", args: {}, id: "tc1" }] }),
      new ToolMessage({ content: "DIR LISTING", id: "t1", tool_call_id: "tc1" }),
      new AIMessage({ content: "here are the files", id: "a2" }),
    ];
    const { toKeep, toRemove } = computeHistoryTrim(msgs, { keepTurns: 1 });
    // keep only the last human turn onward (h1 ... a2)
    expect(toKeep[0]!._getType()).toBe("human");
    expect((toKeep[0] as HumanMessage).content).toBe("list files");
    expect(toKeep).toHaveLength(4);
    expect(toRemove).toEqual(["h0", "a0"]);
  });

  it("returns no removals for an empty trail", () => {
    expect(computeHistoryTrim([], { keepTurns: 12 })).toEqual({ toRemove: [], toKeep: [] });
  });

  it("ignores messages without an id when building the removal list", () => {
    const msgs = [
      new HumanMessage({ content: "no id" }), // no id
      new AIMessage({ content: "no id a" }), // no id
      ...trail(5).map((m, i) => {
        // give the recent ones ids
        (m as { id?: string }).id = `r${i}`;
        return m;
      }),
    ];
    const { toRemove } = computeHistoryTrim(msgs, { keepTurns: 2 });
    // the id-less old messages can't be removed by id → excluded from removal list
    expect(toRemove.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  it("defaults keepTurns to a sane value when not provided", () => {
    const msgs = trail(50);
    const { toKeep } = computeHistoryTrim(msgs);
    // default keeps a bounded window, far fewer than 100 messages
    expect(toKeep.length).toBeLessThan(50);
    expect(toKeep[0]!._getType()).toBe("human");
  });
});
