/**
 * Deterministic UTC timestamp formatting for received messages so the founder
 * (and the logs) always see a proper, readable date-time — not an epoch.
 */
import { describe, it, expect } from "vitest";
import { formatTimestamp } from "../../../src/infra/timestamp.js";

describe("formatTimestamp", () => {
  it("formats a Date as 'YYYY-MM-DD HH:mm:ss UTC'", () => {
    expect(formatTimestamp(new Date("2026-07-18T01:04:01.500Z"))).toBe("2026-07-18 01:04:01 UTC");
  });

  it("zero-pads every field", () => {
    expect(formatTimestamp(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02 03:04:05 UTC");
  });

  it("accepts epoch milliseconds", () => {
    expect(formatTimestamp(1752800641000)).toBe(formatTimestamp(new Date(1752800641000)));
  });

  it("is always UTC regardless of the host offset", () => {
    expect(formatTimestamp(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31 23:59:59 UTC");
  });

  it("never throws on an invalid date — returns a sentinel (it runs inside log calls)", () => {
    expect(() => formatTimestamp(NaN)).not.toThrow();
    expect(formatTimestamp(NaN)).toBe("invalid-timestamp");
    expect(formatTimestamp(new Date("not-a-date"))).toBe("invalid-timestamp");
  });
});
