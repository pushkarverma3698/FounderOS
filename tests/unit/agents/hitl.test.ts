/**
 * Unit tests for HITL core primitives: hitlGate() + idemKey()
 * ==============================================================
 * These two functions gate every external write in FounderOS.
 * If they break silently, HITL approvals are bypassed — P0 safety risk.
 *
 * Edge cases covered:
 *  idemKey:
 *    1. Deterministic — same inputs always produce the same key
 *    2. Format: "{prefix}:{TENANT}:{16-hex}" — machine-parseable
 *    3. Different parts → different hash (collision resistance)
 *    4. Different prefix → different key (even with same parts)
 *    5. Multiple parts joined by "|" separator (order matters)
 *
 *  hitlGate:
 *    6. Returns null when interrupt returns "approved" (execution continues)
 *    7. Returns rejection string when interrupt returns "rejected"
 *    8. Returns rejection string for ANY non-approved value (empty, other, undefined-ish)
 *    9. The rejection message is exactly "❌ Rejected by founder."
 *   10. Passes full ApprovalRequest payload (kind:"approval" injected) to interrupt
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted, declared before dynamic import) ──────────────────────────

const mockInterrupt = vi.fn();

vi.mock("@langchain/langgraph", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, interrupt: mockInterrupt };
});

vi.mock("../../../src/db/queries.js", () => ({
  createInterrupt: vi.fn().mockResolvedValue("test-interrupt-id"),
  getPendingInterrupt: vi.fn().mockResolvedValue(null),
}));

// Dynamic import AFTER mocks are hoisted
const { hitlGate, idemKey, timeBucket, recurringIdemKey } = await import(
  "../../../src/agents/agent-tools/hitl.js"
);

// ── Helpers ───────────────────────────────────────────────────────────────────

const APPROVAL_PAYLOAD = {
  action: "send_email",
  title: "Send email to alice@example.com",
  summary: "Compose and send email",
  preview: "Subject: Hello",
  args: { to: "alice@example.com" },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("idemKey", () => {
  it("is deterministic — same inputs always produce the same key", () => {
    const key1 = idemKey("email", "alice@example.com", "Hello subject");
    const key2 = idemKey("email", "alice@example.com", "Hello subject");
    expect(key1).toBe(key2);
  });

  it("has format '{prefix}:{TENANT}:{16-hex}'", () => {
    const key = idemKey("gcal", "meeting", "2026-06-05");
    // e.g. "gcal:turicks:abc1234567890def"
    const parts = key.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("gcal");
    expect(parts[1]).toBe("turicks"); // TENANT default
    expect(parts[2]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("different parts produce different keys (not always the same hash)", () => {
    const key1 = idemKey("email", "alice@example.com", "Subject A");
    const key2 = idemKey("email", "alice@example.com", "Subject B");
    expect(key1).not.toBe(key2);
  });

  it("different prefix produces a different key even with identical parts", () => {
    const key1 = idemKey("email", "alice@example.com");
    const key2 = idemKey("linkedin", "alice@example.com");
    // Prefix changes the full key string, not just the hash
    expect(key1).not.toBe(key2);
    // But the hash part (same parts) should be the same
    expect(key1.split(":")[2]).toBe(key2.split(":")[2]);
  });

  it("part order matters — swapping parts yields a different hash", () => {
    const key1 = idemKey("test", "partA", "partB");
    const key2 = idemKey("test", "partB", "partA");
    expect(key1).not.toBe(key2);
  });

  it("single part works without error", () => {
    expect(() => idemKey("email", "alice@example.com")).not.toThrow();
    const key = idemKey("email", "alice@example.com");
    expect(key).toMatch(/^email:turicks:[0-9a-f]{16}$/);
  });
});

// ── P0 #2: idempotency window — both failure directions (roadmap audit) ───────
//
// idemKey() is the resume-safe default (time-invariant). recurringIdemKey() is
// the opt-in windowed variant for scheduled senders. These tests pin BOTH
// failure modes the roadmap names:
//   • "too narrow"  → double-sends slip through (must be impossible for idemKey
//                      across an approval gap, and impossible for recurringIdemKey
//                      within one window).
//   • "too broad"   → legitimately-repeated actions deduped forever (must be
//                      fixable via recurringIdemKey across windows).

describe("timeBucket (UTC, pure, injectable instant)", () => {
  it("day granularity → ISO date in UTC", () => {
    expect(timeBucket("day", new Date("2026-06-29T23:30:00Z"))).toBe("2026-06-29");
  });

  it("month granularity → YYYY-MM", () => {
    expect(timeBucket("month", new Date("2026-06-29T12:00:00Z"))).toBe("2026-06");
  });

  it("week granularity → ISO-8601 week label", () => {
    // 2026-06-29 is a Monday; ISO week 27 of 2026.
    expect(timeBucket("week", new Date("2026-06-29T00:00:00Z"))).toBe("2026-W27");
  });

  it("uses UTC, not local TZ — boundary instant doesn't drift", () => {
    // 23:30Z stays on the 29th regardless of where the server runs.
    expect(timeBucket("day", new Date("2026-06-29T23:59:59Z"))).toBe("2026-06-29");
    expect(timeBucket("day", new Date("2026-06-30T00:00:01Z"))).toBe("2026-06-30");
  });
});

describe("idemKey resume-safety — guards the 'too narrow' double-send", () => {
  it("is time-invariant: identical across an approval gap that crosses midnight", () => {
    // Initial interrupt fires at 23:59 on the 29th; founder approves at 00:01 on
    // the 30th and the tool re-runs. The key MUST match or the action re-fires.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-29T23:59:00Z"));
      const atInterrupt = idemKey("email", "alice@example.com", "Quarterly invoice");
      vi.setSystemTime(new Date("2026-06-30T00:01:00Z")); // approval crosses the day boundary
      const atResume = idemKey("email", "alice@example.com", "Quarterly invoice");
      expect(atResume).toBe(atInterrupt); // → hasBeenAudited() skips the 2nd send
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("recurringIdemKey — fixes the 'too broad' permanent-dedup, no within-window double-send", () => {
  it("same content in the SAME window → same key (within-window dedupe holds)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-29T09:00:00Z"));
      const first = recurringIdemKey("newsletter", "week", "weekly digest body");
      vi.setSystemTime(new Date("2026-06-30T18:00:00Z")); // later, same ISO week
      const second = recurringIdemKey("newsletter", "week", "weekly digest body");
      expect(second).toBe(first); // duplicate send inside one week is still deduped
    } finally {
      vi.useRealTimers();
    }
  });

  it("same content in the NEXT window → different key (legit repeat is allowed)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-01T09:00:00Z")); // June
      const june = recurringIdemKey("newsletter", "month", "monthly digest body");
      vi.setSystemTime(new Date("2026-07-01T09:00:00Z")); // July — a new, allowed send
      const july = recurringIdemKey("newsletter", "month", "monthly digest body");
      expect(july).not.toBe(june); // the next month's identical newsletter is NOT swallowed
    } finally {
      vi.useRealTimers();
    }
  });

  it("differs from the plain idemKey for the same parts (window is part of the hash)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-29T09:00:00Z"));
      const plain = idemKey("newsletter", "body");
      const windowed = recurringIdemKey("newsletter", "month", "body");
      expect(windowed).not.toBe(plain);
      expect(windowed).toMatch(/^newsletter:turicks:[0-9a-f]{16}$/); // same shape
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hitlGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when interrupt returns 'approved' — execution continues", async () => {
    mockInterrupt.mockReturnValue("approved");
    const result = await hitlGate(APPROVAL_PAYLOAD, { configurable: { thread_id: "turicks:1" } });
    expect(result).toBeNull();
  });

  it("returns rejection string when interrupt returns 'rejected'", async () => {
    mockInterrupt.mockReturnValue("rejected");
    const result = await hitlGate(APPROVAL_PAYLOAD);
    expect(result).toBe("❌ Rejected by founder.");
  });

  it("returns rejection string for any non-approved value — empty string", async () => {
    mockInterrupt.mockReturnValue("");
    const result = await hitlGate(APPROVAL_PAYLOAD);
    expect(result).toBe("❌ Rejected by founder.");
  });

  it("returns rejection string for any non-approved value — arbitrary string", async () => {
    mockInterrupt.mockReturnValue("maybe");
    const result = await hitlGate(APPROVAL_PAYLOAD);
    expect(result).toBe("❌ Rejected by founder.");
  });

  it("returns rejection string when interrupt returns null (unresolved resume)", async () => {
    mockInterrupt.mockReturnValue(null);
    const result = await hitlGate(APPROVAL_PAYLOAD);
    expect(result).toBe("❌ Rejected by founder.");
  });

  it("passes kind:'approval' + full payload to interrupt (contract verification)", async () => {
    mockInterrupt.mockReturnValue("approved");
    await hitlGate(APPROVAL_PAYLOAD);

    expect(mockInterrupt).toHaveBeenCalledOnce();
    expect(mockInterrupt).toHaveBeenCalledWith({
      kind: "approval",
      action: APPROVAL_PAYLOAD.action,
      title: APPROVAL_PAYLOAD.title,
      summary: APPROVAL_PAYLOAD.summary,
      preview: APPROVAL_PAYLOAD.preview,
      args: APPROVAL_PAYLOAD.args,
    });
  });

  it("always calls interrupt exactly once per gate invocation", async () => {
    mockInterrupt.mockReturnValue("approved");
    await hitlGate(APPROVAL_PAYLOAD);
    expect(mockInterrupt).toHaveBeenCalledTimes(1);
  });

  it("does not call interrupt on construct — only on invocation", () => {
    // Accessing the function should not trigger interrupt
    expect(mockInterrupt).not.toHaveBeenCalled();
  });
});
