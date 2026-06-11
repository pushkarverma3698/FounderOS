import { describe, it, expect } from "vitest";
import { isWedgedState, pendingInterruptCount, type WedgeState } from "../../../src/infra/wedge.js";

/**
 * Regression for the live production wedge (thread turicks:6775330211): an
 * aborted run left `next` on a pending node with no interrupt, so every later
 * message resumed the stuck node and looped to the recursion limit. The fix
 * keys off this exact predicate, so it must never regress.
 */
describe("isWedgedState", () => {
  it("returns false for a healthy completed thread (no pending node)", () => {
    const state: WedgeState = { next: [], tasks: [] };
    expect(isWedgedState(state)).toBe(false);
  });

  it("returns false when next is undefined", () => {
    expect(isWedgedState({})).toBe(false);
    expect(isWedgedState(null)).toBe(false);
    expect(isWedgedState(undefined)).toBe(false);
  });

  it("returns TRUE for an aborted run: pending node, zero interrupts (the wedge)", () => {
    const state: WedgeState = { next: ["personal"], tasks: [{}] };
    expect(isWedgedState(state)).toBe(true);
  });

  it("matches the exact live wedge shape (next=[personal], task without interrupts)", () => {
    const state: WedgeState = { next: ["personal"], tasks: [{ interrupts: [] }] };
    expect(isWedgedState(state)).toBe(true);
  });

  it("returns FALSE for a legitimate HITL pause (pending node WITH an interrupt)", () => {
    const state: WedgeState = {
      next: ["comms"],
      tasks: [{ interrupts: [{ value: { title: "Approve email" } }] }],
    };
    expect(isWedgedState(state)).toBe(false);
  });

  it("returns false when a pending node has an interrupt even among multiple tasks", () => {
    const state: WedgeState = {
      next: ["comms"],
      tasks: [{ interrupts: [] }, { interrupts: [{ value: {} }] }],
    };
    expect(isWedgedState(state)).toBe(false);
  });
});

describe("pendingInterruptCount", () => {
  it("sums interrupts across all parked tasks", () => {
    expect(pendingInterruptCount({ tasks: [{ interrupts: [{}, {}] }, { interrupts: [{}] }] })).toBe(3);
  });
  it("is 0 for no tasks / null", () => {
    expect(pendingInterruptCount({ tasks: [] })).toBe(0);
    expect(pendingInterruptCount(null)).toBe(0);
  });
});
