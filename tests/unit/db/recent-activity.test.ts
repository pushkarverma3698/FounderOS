/**
 * Unit test — the pure half of the recent-activity reader (AG-029). The SQL is exercised on the VPS, not here.
 */
import { describe, it, expect } from "vitest";
import { toActivityRow, windowStart } from "../../../src/db/recent-activity.js";

describe("toActivityRow", () => {
  it("prefers metadata.occurred_at over created_at and reads the title", () => {
    const r = toActivityRow({
      created_at: "2026-10-06T03:00:00Z",
      project: "founderos",
      content: "body",
      metadata: { origin: "mac-agy", occurred_at: "2026-10-05T12:00:00Z", title: "T" },
    });
    expect(r).toEqual({ at: new Date("2026-10-05T12:00:00Z"), origin: "mac-agy", project: "founderos", title: "T", content: "body" });
  });
  it("falls back to created_at when occurred_at is not a date", () => {
    const r = toActivityRow({ created_at: "2026-10-06T03:00:00Z", project: null, content: "b", metadata: { origin: "vps-daemon", occurred_at: "soon" } });
    expect(r?.at.toISOString()).toBe("2026-10-06T03:00:00.000Z");
    expect(r?.title).toBeNull();
  });
  it("drops a row with no origin or no usable time instead of printing a dateless line", () => {
    expect(toActivityRow({ created_at: "2026-10-06T03:00:00Z", project: null, content: "b", metadata: {} })).toBeNull();
    expect(toActivityRow({ created_at: null, project: null, content: "b", metadata: { origin: "mac-claude" } })).toBeNull();
  });
});

describe("windowStart", () => {
  const now = new Date("2026-10-06T10:00:00Z");
  it("defaults to 36 h back, honours windowHours, and an explicit since wins", () => {
    expect(windowStart({ now }).toISOString()).toBe("2026-10-04T22:00:00.000Z");
    expect(windowStart({ now, windowHours: 1 }).toISOString()).toBe("2026-10-06T09:00:00.000Z");
    expect(windowStart({ now, windowHours: 1, since: new Date("2026-10-01T00:00:00Z") }).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});
