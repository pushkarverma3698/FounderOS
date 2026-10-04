/**
 * recall_conversation as the worker sees it: the privacy boundary and the registration.
 *
 * A guest in an allow-listed group chat runs every non-HITL tool (src/gateway/chat-access.ts), so the chat a
 * recall reads must come from the RUN's thread id, never from anything the model or the guest can type.
 * The registration test pins that admin (and its memory sub-agent) actually hold the tool: a tool nobody
 * can call is the same as no tool.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnQuery } from "../../../src/db/conversation-turns.js";

const find = vi.fn(async (_q: TurnQuery) => ({ turns: [], total: 0 }));
const earliest = vi.fn(async (_threadId: string) => new Date("2026-10-01T00:00:00Z"));

vi.mock("../../../src/db/conversation-turns.js", () => ({
  findConversationTurns: (q: TurnQuery) => find(q),
  earliestConversationTurn: (threadId: string) => earliest(threadId),
  recordConversationTurn: vi.fn(),
}));

const { recallConversationTool } = await import("../../../src/agents/agent-tools/memory.js");
const { DEPARTMENT_TOOLS, ADMIN_SUBAGENT_TOOLS } = await import("../../../src/agents/capabilities.js");

beforeEach(() => {
  find.mockClear();
  earliest.mockClear();
});

describe("recall_conversation — one chat's log, never another's", () => {
  it("searches the thread of the run it is called in", async () => {
    await recallConversationTool.invoke({ when: "yesterday" }, { configurable: { thread_id: "turicks:8924092987" } });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0]![0].threadId).toBe("turicks:8924092987");
    expect(earliest).toHaveBeenCalledWith("turicks:8924092987");
  });

  it("ignores a thread id smuggled in through the arguments", async () => {
    await recallConversationTool.invoke(
      { when: "yesterday", threadId: "turicks:founder-private", thread_id: "turicks:founder-private" } as never,
      { configurable: { thread_id: "turicks:group" } },
    );
    expect(find.mock.calls[0]![0].threadId).toBe("turicks:group");
  });

  it("refuses to search at all when the run has no thread id", async () => {
    const out = await recallConversationTool.invoke({ when: "yesterday" }, {});
    expect(find).not.toHaveBeenCalled();
    expect(String(out)).toContain("can't tell which chat");
  });

  it("accepts the nulls a model sends for omitted optional fields", async () => {
    await recallConversationTool.invoke({ when: null, about: "visa", more: null }, { configurable: { thread_id: "turicks:1" } });
    expect(find.mock.calls[0]![0]).toMatchObject({ threadId: "turicks:1", terms: ["visa"], limit: 5 });
  });
});

describe("recall_conversation — registered where the founder's question lands", () => {
  const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name);

  it("is on the admin worker and on its memory sub-agent", () => {
    expect(names(DEPARTMENT_TOOLS["admin"]!)).toContain("recall_conversation");
    expect(names(ADMIN_SUBAGENT_TOOLS["memory_context"]!)).toContain("recall_conversation");
  });

  it("needs no approval: it is read-only, so it is not a gated tool", async () => {
    const { HITL_GATED_TOOLS } = await import("../../../src/agents/capabilities.js");
    expect(HITL_GATED_TOOLS.has("recall_conversation")).toBe(false);
  });
});
