/**
 * Phase C — context tools unit tests
 *
 * These tests verify that:
 * - read_context returns a sensible empty-state message when no data is stored
 * - update_context merges and persists data
 *
 * search_knowledge coverage lives in tests/unit/tools/knowledge.test.ts (it no
 * longer calls these DB queries — see src/tools/knowledge.ts).
 *
 * All tests mock the DB queries to avoid needing a live Postgres instance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CONTEXT_META_KEY, CONTEXT_STALE_MARKER } from "../../../src/db/context-meta.js";
import { CONTEXT_FOCUS_MAX_CHARS } from "../../../src/tools/context-guard.js";

// Mock DB queries before importing tools
const mockGetFounderContext = vi.fn(async (): Promise<Record<string, unknown>> => ({}));
const mockUpsertFounderContext = vi.fn(async (..._args: unknown[]) => {});
const mockWarn = vi.hoisted(() => vi.fn());

// read_context logs one warning when the row's context_meta is unreadable; the
// test reads it from here. Every other logger export stays real.
vi.mock("../../../src/infra/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/infra/logger.js")>();
  return {
    ...actual,
    childLogger: () => ({ warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    getFounderContext: mockGetFounderContext,
    upsertFounderContext: mockUpsertFounderContext,
  };
});

const { readContext, updateContext } = await import("../../../src/tools/context.js");

describe("readContext tool", () => {
  beforeEach(() => {
    mockGetFounderContext.mockResolvedValue({});
    mockWarn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a prompt to set context when empty", async () => {
    const result = await readContext.invoke({});
    expect(result).toContain("No business context stored yet");
  });

  // Every value carries its own date. The row-level "Last updated: <date>" footer
  // is gone: it put one date under June's values and a founder's last write alike.
  it("formats stored context as bullet points, each with the date it was confirmed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T05:30:00.000Z"));
    mockGetFounderContext.mockResolvedValue({
      active_clients: ["Acme Corp", "Beta Ltd"],
      current_priorities: ["Close Acme deal"],
      last_updated: "2026-06-01T00:00:00.000Z",
      [CONTEXT_META_KEY]: {
        active_clients: { at: "2026-09-29T19:00:00.000Z", source: "founder" },
        current_priorities: { at: "2026-06-01T00:00:00.000Z", source: "founder" },
      },
    });
    const result = await readContext.invoke({});
    expect(result).toContain("active clients: Acme Corp, Beta Ltd (confirmed 2026-09-30)");
    expect(result).toContain(`current priorities: Close Acme deal ${CONTEXT_STALE_MARKER} last confirmed 2026-06-01`);
    expect(result).not.toMatch(/last updated/i);
  });

  it("says a value with no date has an unknown date, and warns nowhere when the meta is simply absent", async () => {
    mockGetFounderContext.mockResolvedValue({ current_focus: "Phase D-Bis", last_updated: "2026-09-28T13:19:27Z" });
    const result = await readContext.invoke({});
    expect(result).toContain(`current focus: Phase D-Bis ${CONTEXT_STALE_MARKER} date unknown`);
    expect(result).not.toContain("2026-09-28");
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("logs one warning naming context_meta, and still answers, when the meta is corrupt", async () => {
    mockGetFounderContext.mockResolvedValue({ current_focus: "Ship", notes: "n", [CONTEXT_META_KEY]: "yesterday" });
    const result = await readContext.invoke({});
    expect(result).toContain(`current focus: Ship ${CONTEXT_STALE_MARKER} date unknown`);
    expect(result).toContain(`notes: n ${CONTEXT_STALE_MARKER} date unknown`);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockWarn.mock.calls[0])).toContain(CONTEXT_META_KEY);
  });

  // budget_alerts_sent (src/infra/daily-budget-alerts.ts) shares the JSONB row
  // and rendered to the founder as "budget alerts sent: [object Object]".
  it("never renders internal bookkeeping keys", async () => {
    mockGetFounderContext.mockResolvedValue({
      current_priorities: ["Close Acme deal"],
      budget_alerts_sent: { date: "2026-09-28", levels: [80] },
    });
    const result = await readContext.invoke({});
    expect(result).toContain("current priorities: Close Acme deal");
    expect(result).not.toContain("budget alerts sent");
    expect(result).not.toContain("[object Object]");
  });

  it("treats a row holding only bookkeeping as empty", async () => {
    mockGetFounderContext.mockResolvedValue({
      budget_alerts_sent: { date: "2026-09-28", levels: [80, 100] },
      last_updated: "2026-09-28T07:00:00.000Z",
    });
    const result = await readContext.invoke({});
    expect(result).toContain("No business context stored yet");
  });
});

describe("updateContext tool", () => {
  beforeEach(() => {
    mockGetFounderContext.mockResolvedValue({});
    mockUpsertFounderContext.mockResolvedValue(undefined);
  });

  it("calls upsertFounderContext with provided updates, as the founder's (that source is what dates them)", async () => {
    await updateContext.invoke({ updates: { active_clients: ["TestCo"] } });
    expect(mockUpsertFounderContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ active_clients: ["TestCo"] }),
      "founder",
    );
  });

  // current_focus was never a recognised key, so update_context REJECTED every
  // attempt to correct it: the June value could only be changed by editing the
  // database. It and active_projects are recognised now (and bounded).
  it("accepts current_focus and active_projects", async () => {
    const result = await updateContext.invoke({
      updates: { current_focus: "Close the Acme pilot", active_projects: ["FounderOS", "Naggar site"] },
    });
    expect(result).toContain("Context updated: current_focus, active_projects");
    expect(mockUpsertFounderContext).toHaveBeenCalledWith(
      expect.any(String),
      { current_focus: "Close the Acme pilot", active_projects: ["FounderOS", "Naggar site"] },
      "founder",
    );
  });

  it("writes nothing, stamps nothing, and says why when the guard rejects every key", async () => {
    mockUpsertFounderContext.mockClear();
    const result = await updateContext.invoke({ updates: { secret_plan: "delete prod" } });
    expect(mockUpsertFounderContext).not.toHaveBeenCalled();
    expect(result).toContain("Nothing saved to context.");
    expect(result).toContain("secret_plan (unrecognised key)");
    expect(result).toContain("Recognised keys:");
  });

  it("names the limit when a focus is too long, and writes nothing", async () => {
    mockUpsertFounderContext.mockClear();
    const result = await updateContext.invoke({ updates: { current_focus: "x".repeat(CONTEXT_FOCUS_MAX_CHARS + 1) } });
    expect(mockUpsertFounderContext).not.toHaveBeenCalled();
    expect(result).toContain(String(CONTEXT_FOCUS_MAX_CHARS));
    expect(result).toContain(String(CONTEXT_FOCUS_MAX_CHARS + 1));
  });

  it("returns a confirmation message listing updated keys", async () => {
    const result = await updateContext.invoke({
      updates: { active_clients: ["TestCo"], current_priorities: ["Ship Phase C"] },
    });
    expect(result).toContain("Context updated");
    expect(result).toContain("active_clients");
  });
});
