import { describe, it, expect } from "vitest";
import { GraphInterrupt } from "@langchain/langgraph";
import { TraceCallback } from "../../../src/infra/trace-callback.js";
import { startTurn } from "../../../src/infra/trace.js";

function fakeTrace() {
  return startTurn({ chatId: 1, kind: "message", promptHash: "x" });
}

describe("TraceCallback", () => {
  it("emits tool.call on handleToolStart with the tool name", async () => {
    const t = fakeTrace();
    const cb = new TraceCallback(t);
    await cb.handleToolStart({ id: ["langchain", "tools", "search_web"] } as any, "query text", "run-1");
    const ev = t.events.find((e) => e.seam === "tool.call");
    expect(ev?.data?.["tool"]).toBe("search_web");
  });

  it("emits tool.result on handleToolEnd", async () => {
    const t = fakeTrace();
    const cb = new TraceCallback(t);
    await cb.handleToolEnd("result body" as any, "run-1");
    expect(t.events.some((e) => e.seam === "tool.result")).toBe(true);
  });

  it("emits tool.error on handleToolError", async () => {
    const t = fakeTrace();
    const cb = new TraceCallback(t);
    await cb.handleToolError(new Error("kaboom"), "run-1");
    const ev = t.events.find((e) => e.seam === "tool.error");
    expect(ev?.data?.["error"]).toContain("kaboom");
  });

  it("logs a HITL GraphInterrupt as hitl.interrupt, NOT tool.error (2026-07-12 journal noise)", async () => {
    const t = fakeTrace();
    const cb = new TraceCallback(t);
    await cb.handleToolError(new GraphInterrupt([{ value: { kind: "approval" } }] as any), "run-1");
    expect(t.events.some((e) => e.seam === "tool.error")).toBe(false);
    expect(t.events.some((e) => e.seam === "hitl.interrupt")).toBe(true);
  });

  it("emits llm.call on handleLLMStart", async () => {
    const t = fakeTrace();
    const cb = new TraceCallback(t);
    await cb.handleLLMStart({ id: ["x"] } as any, ["prompt"], "run-1");
    expect(t.events.some((e) => e.seam === "llm.call")).toBe(true);
  });
});
