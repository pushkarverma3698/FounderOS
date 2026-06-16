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
const { hitlGate, idemKey } = await import("../../../src/agents/agent-tools/hitl.js");

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
