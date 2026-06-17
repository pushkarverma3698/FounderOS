/**
 * P6 — hierarchy depth mapping + golden trace ordering.
 */
import { describe, it, expect } from "vitest";
import { hierarchyDepth } from "../../../src/infra/trace.js";
import { TraceCallback } from "../../../src/infra/trace-callback.js";
import { startTurn, setTraceSink, type TraceEvent } from "../../../src/infra/trace.js";

describe("hierarchyDepth (P6)", () => {
  it("maps CEO → CTO → worker depths", () => {
    expect(hierarchyDepth("supervisor")).toBe(0);
    expect(hierarchyDepth("engineering")).toBe(1);
    expect(hierarchyDepth("coder")).toBe(2);
    expect(hierarchyDepth("devops")).toBe(2);
    expect(hierarchyDepth("research")).toBeNull();
  });
});

describe("TraceCallback hierarchy seams", () => {
  it("emits ordered hierarchy.enter events for CEO → CTO → worker", async () => {
    const events: TraceEvent[] = [];
    setTraceSink((e) => events.push(e));
    const trace = startTurn({ chatId: 1, kind: "message", promptHash: "abc" });
    const cb = new TraceCallback(trace);

    await cb.handleChainStart({ id: ["langgraph", "supervisor"] }, {}, "r1", undefined, [], {}, "supervisor");
    await cb.handleChainStart({ id: ["langgraph", "engineering"] }, {}, "r2", "r1", [], {}, "engineering");
    await cb.handleChainStart({ id: ["langgraph", "devops"] }, {}, "r3", "r2", [], {}, "devops");

    const enters = events.filter((e) => e.seam === "hierarchy.enter");
    expect(enters.map((e) => e.data?.["depth"])).toEqual([0, 1, 2]);
    expect(enters.map((e) => e.data?.["agent"])).toEqual(["supervisor", "engineering", "devops"]);
    expect(enters.every((e) => e.turnId === trace.turnId)).toBe(true);

    setTraceSink(null);
  });
});
