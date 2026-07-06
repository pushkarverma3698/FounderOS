/**
 * REGRESSION — sweepDeptSignals must not silently swallow signals whose event
 * type shares a `to_dept` with another event type.
 * ============================================================================
 * `consumePendingEvents(tenant, toDept)` claims (FOR UPDATE SKIP LOCKED) and
 * marks CONSUMED every unconsumed dept_signals row for that (tenant, to_dept)
 * pair — it has no event_type filter. DEFAULT_TARGET_DEPT routes FOUR event
 * types to "sales" (lead_discovered, demo_ready, site_deployed,
 * proof_drop_ready) and TWO to "engineering" (proposal_approved,
 * design_brief_ready). The original sweep called consumePendingEvents once
 * PER EVENT TYPE, so the first call for a shared toDept claimed-and-discarded
 * every other event type's rows before their own turn — those signals were
 * silently lost, never nudging the founder, with zero test coverage catching
 * it. Found auditing multi-department signal routing for scale (2026-07-06).
 *
 * APPEND-ONLY. If a case here goes red, the sweep regressed to the old
 * one-claim-per-event-type shape — fix the sweep, not the test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeptSignal } from "../../../src/db/schema.js";

const consumePendingEvents = vi.fn<(tenant: string, toDept: string) => Promise<DeptSignal[]>>();
const sendToChat = vi.fn(async () => {});

vi.mock("../../../src/db/queries.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/db/queries.js")>()),
  consumePendingEvents,
}));
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToChat }));

const { sweepDeptSignals } = await import("../../../src/infra/scheduler.js");

function signal(event_type: string, to_dept: string, id: number): DeptSignal {
  return {
    id,
    tenant_id: "turicks",
    from_dept: "research",
    to_dept,
    event_type,
    payload: { company: "Acme" },
    consumed: false,
    thread_id: null,
    created_at: new Date(`2026-07-0${(id % 9) + 1}T00:00:00.000Z`),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("sweepDeptSignals — shared to_dept event types", () => {
  beforeEach(() => {
    consumePendingEvents.mockReset();
    sendToChat.mockClear();
  });

  it("claims each toDept exactly ONCE per sweep, not once per event type", async () => {
    consumePendingEvents.mockResolvedValue([]);
    await sweepDeptSignals();

    // Two distinct toDept values across all 6 event types today: sales, engineering.
    const calledDepts = consumePendingEvents.mock.calls.map((c) => c[1]);
    expect(new Set(calledDepts).size).toBe(calledDepts.length);
  });

  /**
   * Simulates the REAL DB semantics: consumePendingEvents claims-and-marks-
   * consumed on every call, so a second call for the same toDept returns
   * empty. A stateless mock that always returns the same rows would pass even
   * against the old buggy code (each of its per-event-type calls would just
   * re-see the same never-actually-consumed mock data) — this is what makes
   * the test a genuine regression guard rather than a false-positive green.
   */
  function statefulConsumeMock(rowsByDept: Record<string, DeptSignal[]>) {
    const remaining = new Map(Object.entries(rowsByDept));
    return vi.fn(async (_tenant: string, toDept: string) => {
      const rows = remaining.get(toDept) ?? [];
      remaining.set(toDept, []); // claimed — a second call for this dept gets nothing
      return rows;
    });
  }

  it("nudges for a LATER-processed event type sharing a toDept with an earlier one (core regression)", async () => {
    // Both destined for "sales": lead_discovered (processed first in the
    // formatter map) and demo_ready (processed later). Before the fix, the
    // demo_ready row would already be gone by the time its own iteration ran.
    consumePendingEvents.mockImplementation(
      statefulConsumeMock({
        sales: [signal("lead_discovered", "sales", 1), signal("demo_ready", "sales", 2)],
      }),
    );

    await sweepDeptSignals();

    expect(consumePendingEvents).toHaveBeenCalledWith("turicks", "sales");
    // consumePendingEvents for "sales" must be called exactly once (single claim).
    expect(consumePendingEvents.mock.calls.filter((c) => c[1] === "sales")).toHaveLength(1);
    // Both a lead nudge AND a demo-ready nudge must have gone out — neither
    // event type's rows were discarded by the other's claim.
    expect(sendToChat).toHaveBeenCalled();
    const allText = sendToChat.mock.calls.map((c) => String(c[0])).join("\n---\n");
    expect(allText.toLowerCase()).toMatch(/lead/);
    expect(allText.toLowerCase()).toMatch(/demo/);
  });

  it("nudges for a later engineering-shared event type too (proposal_approved + design_brief_ready)", async () => {
    consumePendingEvents.mockImplementation(
      statefulConsumeMock({
        engineering: [signal("proposal_approved", "engineering", 3), signal("design_brief_ready", "engineering", 4)],
      }),
    );

    await sweepDeptSignals();

    expect(consumePendingEvents.mock.calls.filter((c) => c[1] === "engineering")).toHaveLength(1);
    const allText = sendToChat.mock.calls.map((c) => String(c[0])).join("\n---\n");
    expect(allText.toLowerCase()).toMatch(/proposal/);
    expect(allText.toLowerCase()).toMatch(/design/);
  });

  it("sends nothing when there are no pending signals for a dept", async () => {
    consumePendingEvents.mockResolvedValue([]);
    await sweepDeptSignals();
    expect(sendToChat).not.toHaveBeenCalled();
  });
});
