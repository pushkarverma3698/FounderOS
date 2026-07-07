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
  forceToolChoiceMiddleware,
  createTrimmedPrompt,
  countCompletedToolCalls,
  countPendingToolCalls,
  countScheduledToolCalls,
  estimateMessageTokens,
  stripMessageNames,
} from "../../../src/infra/context-manager.js";
import { repeatGuardBlockMessage } from "../../../src/agents/agent-tools/repeat-guard.js";

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

// H4 fix: forceToolChoiceMiddleware sets the model's native toolChoice for a
// department's FIRST call to a pre-router-named tool, then stops once that
// tool has been called once. A fake `handler` just echoes the request it
// received so these tests can assert on exactly what was passed through —
// no real model/provider call.
describe("forceToolChoiceMiddleware (H4)", () => {
  const echo = async (req: unknown) => req;
  function fakeRequest(overrides: Record<string, unknown> = {}) {
    return {
      messages: [],
      tools: [{ name: "run_shell" }, { name: "read_file" }],
      runtime: { configurable: {} },
      ...overrides,
    };
  }

  it("does nothing when no forced_tool is set in configurable", async () => {
    const mw = forceToolChoiceMiddleware();
    const req = fakeRequest();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await (mw as any).wrapModelCall(req, echo)) as { toolChoice?: unknown };
    expect(out.toolChoice).toBeUndefined();
  });

  it("does nothing when the named tool isn't in this department's tool set", async () => {
    const mw = forceToolChoiceMiddleware();
    const req = fakeRequest({ runtime: { configurable: { forced_tool: "github_write" } } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await (mw as any).wrapModelCall(req, echo)) as { toolChoice?: unknown };
    expect(out.toolChoice).toBeUndefined();
  });

  it("sets toolChoice to the named function when forced_tool matches an available tool", async () => {
    const mw = forceToolChoiceMiddleware();
    const req = fakeRequest({ runtime: { configurable: { forced_tool: "run_shell" } } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await (mw as any).wrapModelCall(req, echo)) as {
      toolChoice?: { type: string; function: { name: string } };
    };
    expect(out.toolChoice).toEqual({ type: "function", function: { name: "run_shell" } });
  });

  it("stops forcing once the tool has already been called once this turn", async () => {
    const mw = forceToolChoiceMiddleware();
    const messages = [
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "run_shell", args: {} }] }),
      new ToolMessage({ content: "done", tool_call_id: "c1", name: "run_shell" }),
    ];
    const req = fakeRequest({ messages, runtime: { configurable: { forced_tool: "run_shell" } } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await (mw as any).wrapModelCall(req, echo)) as { toolChoice?: unknown };
    expect(out.toolChoice).toBeUndefined();
  });
});

// Repeat-guard hard stop (2026-07-07 — GitHub github_read infinite-loop incident):
// the repeat-guard's "STOP" ToolMessage is a plain instruction the model can
// ignore — and a weak/aggressive model (gemini-2.5-pro observed live) DID ignore
// it, re-issuing the identical tool call for 2.5+ minutes of paid LLM calls.
// This is the deterministic fix: once N repeat-guard blocks have accumulated in
// the message window, strip ALL tools from the next model call (the same
// proven mechanism as `stopToolsAfterFailure` above) so the model is physically
// unable to call a tool and must answer in plain text — no reliance on the
// model choosing to obey an instruction (rule #16).
describe("createAgentMiddleware — repeat-guard hard stop (loop termination)", () => {
  const echo = async (req: unknown) => req;

  function repeatGuardToolMessage(id: string, toolName = "github_read") {
    return new ToolMessage({
      content: repeatGuardBlockMessage(toolName, "GitHub data"),
      tool_call_id: id,
      name: toolName,
    });
  }

  it("passes tools through unchanged when no repeat-guard block has fired yet", async () => {
    const mw = createAgentMiddleware("Sys.")[1]!;
    const req = {
      messages: [new HumanMessage("list my repos")],
      tools: [{ name: "github_read" }],
      state: { messages: [] },
      runtime: { configurable: {} },
    };
    const out = (await (mw as any).wrapModelCall(req, echo)) as { tools: unknown[] };
    expect(out.tools).toHaveLength(1);
  });

  it("passes tools through after a single repeat-guard block (one retry is allowed)", async () => {
    const mw = createAgentMiddleware("Sys.")[1]!;
    const messages = [
      new HumanMessage("list my repos"),
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "github_read", args: {} }] }),
      repeatGuardToolMessage("c1"),
    ];
    const req = {
      messages,
      tools: [{ name: "github_read" }],
      state: { messages },
      runtime: { configurable: {} },
    };
    const out = (await (mw as any).wrapModelCall(req, echo)) as { tools: unknown[] };
    expect(out.tools).toHaveLength(1);
  });

  it("strips ALL tools once the repeat-guard block count reaches the hard-stop threshold", async () => {
    const mw = createAgentMiddleware("Sys.")[1]!;
    const messages = [
      new HumanMessage("list my repos"),
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "github_read", args: {} }] }),
      repeatGuardToolMessage("c1"),
      new AIMessage({ content: "", tool_calls: [{ id: "c2", name: "github_read", args: {} }] }),
      repeatGuardToolMessage("c2"),
    ];
    const req = {
      messages,
      tools: [{ name: "github_read" }],
      state: { messages },
      runtime: { configurable: {} },
    };
    const out = (await (mw as any).wrapModelCall(req, echo)) as { tools: unknown[] };
    expect(out.tools).toHaveLength(0);
  });

  it("stripping tools is scoped to the repeat-guard marker, not any tool result", async () => {
    const mw = createAgentMiddleware("Sys.")[1]!;
    const messages = [
      new HumanMessage("search for linear"),
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "search_web", args: {} }] }),
      new ToolMessage({ content: "normal result 1", tool_call_id: "c1", name: "search_web" }),
      new AIMessage({ content: "", tool_calls: [{ id: "c2", name: "search_web", args: {} }] }),
      new ToolMessage({ content: "normal result 2", tool_call_id: "c2", name: "search_web" }),
    ];
    const req = {
      messages,
      tools: [{ name: "search_web" }],
      state: { messages },
      runtime: { configurable: {} },
    };
    const out = (await (mw as any).wrapModelCall(req, echo)) as { tools: unknown[] };
    expect(out.tools).toHaveLength(1);
  });
});
