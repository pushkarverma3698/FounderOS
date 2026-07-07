/**
 * Unit tests for the context manager (rolling-window message trimmer).
 *
 * Why: LangGraph checkpointer stores ALL messages forever. Without trimming,
 * every LLM call pays O(n) tokens where n = turn count. createTrimmedPrompt()
 * returns a MessageModifier that prepends the system prompt and trims history
 * to a token budget before each LLM call — the Claude Code pattern.
 *
 * trimMessages from @langchain/core/messages is deterministic, so no mocks needed.
 * RED: these fail until src/infra/context-manager.ts is implemented.
 */

import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import {
  createAgentMiddleware,
  createTrimmedPrompt,
  countCompletedToolCalls,
  countPendingToolCalls,
  countScheduledToolCalls,
  estimateMessageTokens,
  stripMessageNames,
} from "../../../src/infra/context-manager.js";

function makeHistory(n: number): Array<HumanMessage | AIMessage> {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? new HumanMessage(`user turn ${i}`)
      : new AIMessage(`assistant turn ${i}`)
  );
}

describe("countCompletedToolCalls", () => {
  it("counts tool messages matched to prior ai tool calls", () => {
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "call_1", name: "search_web", args: { query: "linear" } },
          { id: "call_2", name: "search_web", args: { query: "linear app" } },
        ],
      }),
      new ToolMessage({ content: "result 1", tool_call_id: "call_1", name: "search_web" }),
      new ToolMessage({ content: "result 2", tool_call_id: "call_2", name: "search_web" }),
    ];
    expect(countCompletedToolCalls(messages, "search_web")).toBe(2);
  });

  it("counts pending tool calls without matching tool messages", () => {
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "call_1", name: "search_web", args: { query: "a" } },
          { id: "call_2", name: "search_web", args: { query: "b" } },
        ],
      }),
    ];
    expect(countPendingToolCalls(messages, "search_web")).toBe(2);
    expect(countScheduledToolCalls(messages, "search_web")).toBe(2);
  });
});

describe("createTrimmedPrompt", () => {
  it("returns a callable MessageModifier", () => {
    const modifier = createTrimmedPrompt("You are an assistant.", {});
    expect(typeof modifier).toBe("function");
  });

  it("empty history → only the system message is returned", async () => {
    const modifier = createTrimmedPrompt("You are an assistant.", { maxTokens: 4000 });
    const result = await modifier([]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(SystemMessage);
    expect((result[0] as SystemMessage).content).toBe("You are an assistant.");
  });

  it("short history (under budget) passes through unchanged + system prepended", async () => {
    const modifier = createTrimmedPrompt("System.", { maxTokens: 4000 });
    const history = makeHistory(4); // tiny, well under 4000 tokens
    const result = await modifier(history);
    // system msg + 4 history messages
    expect(result[0]).toBeInstanceOf(SystemMessage);
    expect(result.length).toBe(5);
  });

  it("large history is trimmed — result stays within token budget", async () => {
    const modifier = createTrimmedPrompt("System.", { maxTokens: 500 });
    const history = makeHistory(100); // ~100 * ~15 chars * 0.25 tokens ≈ 375 tokens — but let's be safe
    // Each message is ~13 chars → ~3-4 tokens. 100 messages = ~350 tokens.
    // Use very small budget to force trimming.
    const tinyModifier = createTrimmedPrompt("System.", { maxTokens: 100 });
    const result = await tinyModifier(history);
    // All returned messages (excluding system) must sum to <= 100 tokens
    const totalTokens = estimateMessageTokens(result);
    expect(totalTokens).toBeLessThanOrEqual(150); // small buffer for system msg overhead
    // Must have fewer messages than the full 100 history
    expect(result.length).toBeLessThan(101);
  });

  it("system prompt is always the first message regardless of trimming", async () => {
    const modifier = createTrimmedPrompt("Fixed system.", { maxTokens: 50 });
    const history = makeHistory(50);
    const result = await modifier(history);
    expect(result[0]).toBeInstanceOf(SystemMessage);
    expect((result[0] as SystemMessage).content).toBe("Fixed system.");
  });

  it("most recent messages are kept when trimming (rolling window)", async () => {
    const modifier = createTrimmedPrompt("Sys.", { maxTokens: 100 });
    // Create distinct messages so we can identify which were kept
    const history = [
      new HumanMessage("OLDEST message — should be trimmed"),
      new AIMessage("old reply"),
      new HumanMessage("middle message"),
      new AIMessage("middle reply"),
      new HumanMessage("NEWEST message — must be kept"),
      new AIMessage("newest reply"),
    ];
    const result = await modifier(history);
    const contents = result.map((m) => (typeof m.content === "string" ? m.content : ""));
    // The newest message must be present
    expect(contents.some((c) => c.includes("NEWEST"))).toBe(true);
  });

  // Roadmap #11 — task-anchor projection (opt-in, deterministic)
  it("default (no anchor): the original task CAN be dropped by the rolling window", async () => {
    const modifier = createTrimmedPrompt("Sys.", { maxTokens: 60 });
    const history = [
      new HumanMessage("TASK: migrate the billing service to the new schema"),
      ...Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0 ? new AIMessage(`reply ${i} with some filler content here`) : new HumanMessage(`follow-up ${i} with filler`),
      ),
      new HumanMessage("NEWEST follow-up"),
    ];
    const result = await modifier(history);
    const contents = result.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(contents.some((c) => c.includes("NEWEST"))).toBe(true);
    expect(contents.some((c) => c.includes("TASK: migrate"))).toBe(false); // task lost
  });

  it("preserveTaskAnchor: the original task survives even when the window is full", async () => {
    const modifier = createTrimmedPrompt("Sys.", { maxTokens: 60, preserveTaskAnchor: true });
    const history = [
      new HumanMessage("TASK: migrate the billing service to the new schema"),
      ...Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0 ? new AIMessage(`reply ${i} with some filler content here`) : new HumanMessage(`follow-up ${i} with filler`),
      ),
      new HumanMessage("NEWEST follow-up"),
    ];
    const result = await modifier(history);
    const contents = result.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(contents.some((c) => c.includes("TASK: migrate"))).toBe(true);  // anchor kept
    expect(contents.some((c) => c.includes("NEWEST"))).toBe(true);          // recency kept too
    expect(contents.filter((c) => c.includes("TASK: migrate")).length).toBe(1); // not duplicated
  });

  it("preserveTaskAnchor on a short thread does not duplicate the first message", async () => {
    const modifier = createTrimmedPrompt("Sys.", { maxTokens: 4000, preserveTaskAnchor: true });
    const history = [new HumanMessage("only task"), new AIMessage("ok")];
    const result = await modifier(history);
    const contents = result.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(contents.filter((c) => c === "only task").length).toBe(1);
  });
});

describe("estimateMessageTokens", () => {
  it("returns 0 for empty array", () => {
    expect(estimateMessageTokens([])).toBe(0);
  });

  it("estimates ~1 token per 4 chars", () => {
    const msgs = [new HumanMessage("a".repeat(400))]; // 400 chars → ~100 tokens
    const estimate = estimateMessageTokens(msgs);
    expect(estimate).toBeGreaterThanOrEqual(90);
    expect(estimate).toBeLessThanOrEqual(110);
  });
});

describe("createAgentMiddleware", () => {
  it("returns dynamic prompt + trimming middleware for LangChain v1 agents", () => {
    const middleware = createAgentMiddleware("System.", { maxTokens: 100 });
    expect(middleware).toHaveLength(2);
  });

  it("strips provider-incompatible message names without mutating originals", () => {
    const msg = new AIMessage({ content: "hello", name: "supervisor" });
    const [result] = stripMessageNames([msg]);
    expect(result).not.toBe(msg);
    expect(result?.name).toBeUndefined();
    expect(msg.name).toBe("supervisor");
  });

  it("enforces per-tool call limits via scheduled count", () => {
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call_1", name: "claude_code", args: { task: "build" } }],
      }),
      new ToolMessage({
        content: "❌ CLI missing [[TOOL_FAILURE stage=auth]]",
        tool_call_id: "call_1",
        name: "claude_code",
      }),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call_2", name: "claude_code", args: { task: "build again" } }],
      }),
    ];
    expect(countScheduledToolCalls(messages, "claude_code")).toBe(2);
    expect(countScheduledToolCalls(messages, "claude_code") < 1).toBe(false);
  });
});
