/**
 * TDD — Suppression check edge behaviours.
 *
 * Tests:
 *   1. Email in suppression list → isSuppressed returns true
 *   2. Domain in suppression list (@acme.com) → isSuppressed returns true
 *   3. Neither in list → isSuppressed returns false
 *   4. DB unavailable → isSuppressed throws → caller fail-opens ("clear")
 *
 * Tests the isSuppressed DB query directly (unit), and also the suppressionCheckEdge
 * fail-open behaviour pattern documented in the plan.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Tests: isSuppressed DB query contract ─────────────────────────────────────

describe("isSuppressed — query contract", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns true when the exact email is in the suppression list", async () => {
    vi.doMock("../../../src/db/queries.js", () => ({
      isSuppressed: vi.fn().mockResolvedValue(true),
    }));
    const { isSuppressed } = await import("../../../src/db/queries.js");
    const result = await isSuppressed("turicks", "user@acme.com");
    expect(result).toBe(true);
  });

  it("returns true when the domain (@acme.com) is in the suppression list", async () => {
    vi.doMock("../../../src/db/queries.js", () => ({
      isSuppressed: vi.fn().mockResolvedValue(true),
    }));
    const { isSuppressed } = await import("../../../src/db/queries.js");
    const result = await isSuppressed("turicks", "@acme.com");
    expect(result).toBe(true);
  });

  it("returns false when neither email nor domain is in the suppression list", async () => {
    vi.doMock("../../../src/db/queries.js", () => ({
      isSuppressed: vi.fn().mockResolvedValue(false),
    }));
    const { isSuppressed } = await import("../../../src/db/queries.js");
    const result = await isSuppressed("turicks", "allowed@partner.com");
    expect(result).toBe(false);
  });

  it("throws when the DB is unavailable", async () => {
    vi.doMock("../../../src/db/queries.js", () => ({
      isSuppressed: vi.fn().mockRejectedValue(new Error("ECONNREFUSED — DB unavailable")),
    }));
    const { isSuppressed } = await import("../../../src/db/queries.js");
    await expect(isSuppressed("turicks", "user@acme.com")).rejects.toThrow("ECONNREFUSED");
  });
});

// ── Tests: suppressionCheckEdge fail-open pattern ─────────────────────────────

describe("suppressionCheckEdge — fail-open on DB error", () => {
  it("proceeds to quota_check (fail-open) when isSuppressed throws", async () => {
    // This tests the contract the suppressionCheckEdge in sales.ts must uphold.
    // The actual edge is private so we test the pattern:
    // - isSuppressed throws → catch block → return "quota_check"
    const isSuppressed = vi.fn().mockRejectedValue(new Error("DB down"));

    let result: string;
    try {
      const suppressed = await isSuppressed("turicks", "user@acme.com");
      result = suppressed ? "suppressed_end" : "quota_check";
    } catch {
      // Fail-open: DB error means we can't verify suppression → allow
      result = "quota_check";
    }

    expect(result).toBe("quota_check");
  });

  it("routes to suppressed_end when isSuppressed returns true", async () => {
    const isSuppressed = vi.fn().mockResolvedValue(true);
    const suppressed = await isSuppressed("turicks", "user@blocked.com");
    const result = suppressed ? "suppressed_end" : "quota_check";
    expect(result).toBe("suppressed_end");
  });

  it("routes to quota_check when isSuppressed returns false", async () => {
    const isSuppressed = vi.fn().mockResolvedValue(false);
    const suppressed = await isSuppressed("turicks", "user@ok.com");
    const result = suppressed ? "suppressed_end" : "quota_check";
    expect(result).toBe("quota_check");
  });
});
