import { describe, it, expect, afterEach } from "vitest";
import { startTurn, activePromptHash, seamLogLevel, setTraceSink, type TraceEvent } from "../../../src/infra/trace.js";

afterEach(() => setTraceSink(null));

describe("TurnTrace", () => {
  it("assigns a turnId and records events in order with elapsed ms", () => {
    const t = startTurn({ chatId: 42, kind: "message", promptHash: "abc123" });
    expect(t.turnId).toMatch(/[0-9a-f-]{10,}/);
    t.event("turn.in", { textLen: 5 });
    t.event("turn.out", { chunks: 1 });
    expect(t.events.map((e) => e.seam)).toEqual(["turn.in", "turn.out"]);
    expect(t.events[0]!.turnId).toBe(t.turnId);
    expect(typeof t.events[0]!.ms).toBe("number");
  });

  it("scrubs PII from event data", () => {
    const t = startTurn({ chatId: 1, kind: "message", promptHash: "x" });
    t.event("tool.call", { input: "email me at jane@acme.com" });
    expect(JSON.stringify(t.events[0]!.data)).toContain("[EMAIL]");
  });

  it("never throws even if the sink throws", () => {
    setTraceSink(() => { throw new Error("sink boom"); });
    const t = startTurn({ chatId: 1, kind: "message", promptHash: "x" });
    expect(() => t.event("turn.in")).not.toThrow();
  });

  it("notifies a test sink with each event", () => {
    const seen: TraceEvent[] = [];
    setTraceSink((e) => seen.push(e));
    const t = startTurn({ chatId: 1, kind: "resume", promptHash: "x" });
    t.event("hitl.resume", { decision: "approved" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.seam).toBe("hitl.resume");
  });

  it("activePromptHash is stable and short", () => {
    expect(activePromptHash("hello")).toBe(activePromptHash("hello"));
    expect(activePromptHash("hello")).toHaveLength(12);
    expect(activePromptHash("a")).not.toBe(activePromptHash("b"));
  });

  // 2026-07-11 harvest undercounted failures: turn.error was emitted at info (30),
  // invisible to any level-based log digest. Error seams carry their true severity.
  it("seamLogLevel maps error seams to their true severity", () => {
    expect(seamLogLevel("turn.error")).toBe("error");
    expect(seamLogLevel("tool.error")).toBe("warn");
    expect(seamLogLevel("turn.in")).toBe("info");
    expect(seamLogLevel("turn.out")).toBe("info");
    expect(seamLogLevel("turn.progress")).toBe("info");
  });
});
