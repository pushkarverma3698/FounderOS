/**
 * Regression net for the checkpoint migration guard (commit 9429131 / PR #345).
 * A stale ARRAY-shaped checkpoint (written before the isolated-records upgrade)
 * must be DISCARDED, not spread into a corrupt {"0":…,"1":…} record — the latter
 * crashed 100% of prod workers. This is the exact reducer that took prod down;
 * it had no direct test until now.
 */

import { describe, it, expect } from "vitest";
import { accumulatingRecord, RESET } from "../../../src/kernel/state.js";

describe("accumulatingRecord migration guard", () => {
  it("discards a stale array-shaped checkpoint instead of spreading it into a corrupt record", () => {
    const { reducer } = accumulatingRecord<{ id: string }>();
    // What a pre-PR#345 checkpoint deserializes to for this channel: a flat array.
    const staleArrayCheckpoint = [{ id: "old" }] as unknown as Record<string, { id: string }[]>;

    const result = reducer(staleArrayCheckpoint, { step1: { set: [{ id: "new" }] } });

    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual({ step1: [{ id: "new" }] });
    expect(result).not.toHaveProperty("0"); // NOT { "0": {id:"old"}, step1: [...] } — the crash shape
  });

  it("appends per step_id on a normal record", () => {
    const { reducer } = accumulatingRecord<{ id: string }>();
    const curr = { step1: [{ id: "a" }] };
    expect(reducer(curr, { step1: [{ id: "b" }] })).toEqual({ step1: [{ id: "a" }, { id: "b" }] });
  });

  it("RESET clears the whole record; a per-step RESET deletes just that step", () => {
    const { reducer } = accumulatingRecord<{ id: string }>();
    expect(reducer({ s: [{ id: "a" }] }, RESET)).toEqual({});
    expect(reducer({ s: [{ id: "a" }], t: [{ id: "b" }] }, { s: RESET })).toEqual({ t: [{ id: "b" }] });
  });

  it("{ set } replaces a step's list", () => {
    const { reducer } = accumulatingRecord<{ id: string }>();
    expect(reducer({ s: [{ id: "a" }] }, { s: { set: [{ id: "z" }] } })).toEqual({ s: [{ id: "z" }] });
  });
});
