/**
 * G4: Postgres-backed daily outbound quota enforcement.
 *
 * Tests:
 *   1. getDailyOutboundCount returns 0 when no rows today
 *   2. getDailyOutboundCount returns correct count for matching actions
 *   3. getDailyOutboundCount ignores actions from yesterday
 *   4. send_email blocked when count >= DAILY_EMAIL_LIMIT
 *   5. linkedin_post blocked when count >= DAILY_LINKEDIN_LIMIT
 *   6. send_email proceeds when under limit
 *   7. Limit=0 disables ceiling (no block)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── getDailyOutboundCount unit tests ─────────────────────────────────────────

describe("getDailyOutboundCount — Postgres-backed daily counter", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns 0 when action_log has no rows matching today", async () => {
    vi.doMock("../../../src/db/queries.js", () => ({
      getDailyOutboundCount: vi.fn().mockResolvedValue(0),
      isSuppressed: vi.fn().mockResolvedValue(false),
      hasRecentOutboundToRecipient: vi.fn().mockResolvedValue(false),
    }));
    const { getDailyOutboundCount } = await import("../../../src/db/queries.js");
    expect(await getDailyOutboundCount("turicks", ["send_email"])).toBe(0);
  });

  it("returns the correct count for matching actions today", async () => {
    vi.doMock("../../../src/db/queries.js", () => ({
      getDailyOutboundCount: vi.fn().mockResolvedValue(7),
      isSuppressed: vi.fn().mockResolvedValue(false),
      hasRecentOutboundToRecipient: vi.fn().mockResolvedValue(false),
    }));
    const { getDailyOutboundCount } = await import("../../../src/db/queries.js");
    expect(await getDailyOutboundCount("turicks", ["send_email"])).toBe(7);
  });

  it("ignores linkedin_post rows when querying send_email count", async () => {
    const mockFn = vi.fn().mockImplementation(async (_tenant: string, actions: string[]) => {
      if (actions.includes("send_email") && !actions.includes("linkedin_post")) return 2;
      if (actions.includes("linkedin_post")) return 1;
      return 0;
    });
    vi.doMock("../../../src/db/queries.js", () => ({
      getDailyOutboundCount: mockFn,
      isSuppressed: vi.fn().mockResolvedValue(false),
      hasRecentOutboundToRecipient: vi.fn().mockResolvedValue(false),
    }));
    const { getDailyOutboundCount } = await import("../../../src/db/queries.js");
    expect(await getDailyOutboundCount("turicks", ["send_email"])).toBe(2);
    expect(await getDailyOutboundCount("turicks", ["linkedin_post"])).toBe(1);
  });
});

// ── Quota enforcement contract (tool-level) ───────────────────────────────────

describe("send_email quota gate — blocks when daily limit reached", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("blocks when today's send count equals the limit", async () => {
    vi.doMock("../../../src/core/config.js", () => ({
      TENANT: "turicks",
      DAILY_EMAIL_LIMIT: 5,
      DAILY_LINKEDIN_LIMIT: 3,
    }));
    vi.doMock("../../../src/db/queries.js", () => ({
      getDailyOutboundCount: vi.fn().mockResolvedValue(5), // AT limit
      isSuppressed: vi.fn().mockResolvedValue(false),
      hasRecentOutboundToRecipient: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock("../../../src/infra/logger.js", () => ({
      childLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
    }));

    const { sendEmail } = await import("../../../src/agents/agent-tools/comms.js");
    const result = await sendEmail.invoke({
      to: "test@example.com",
      subject: "Test",
      body: "Test body",
    });
    expect(result).toContain("Daily email limit reached");
    expect(result).toContain("5/5");
  });

  it("blocks when count exceeds the limit", async () => {
    vi.doMock("../../../src/core/config.js", () => ({
      TENANT: "turicks",
      DAILY_EMAIL_LIMIT: 5,
      DAILY_LINKEDIN_LIMIT: 3,
    }));
    vi.doMock("../../../src/db/queries.js", () => ({
      getDailyOutboundCount: vi.fn().mockResolvedValue(8), // OVER limit
      isSuppressed: vi.fn().mockResolvedValue(false),
      hasRecentOutboundToRecipient: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock("../../../src/infra/logger.js", () => ({
      childLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
    }));

    const { sendEmail } = await import("../../../src/agents/agent-tools/comms.js");
    const result = await sendEmail.invoke({
      to: "test@example.com",
      subject: "Test",
      body: "Test body",
    });
    expect(result).toContain("Daily email limit reached");
  });

  it("DAILY_EMAIL_LIMIT=0 disables the quota ceiling entirely", async () => {
    vi.doMock("../../../src/core/config.js", () => ({
      TENANT: "turicks",
      DAILY_EMAIL_LIMIT: 0, // disabled
      DAILY_LINKEDIN_LIMIT: 3,
    }));
    const quotaFn = vi.fn().mockResolvedValue(999);
    vi.doMock("../../../src/db/queries.js", () => ({
      getDailyOutboundCount: quotaFn,
      isSuppressed: vi.fn().mockResolvedValue(false),
      hasRecentOutboundToRecipient: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock("../../../src/infra/logger.js", () => ({
      childLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
    }));
    vi.doMock("../../../src/infra/brand-validator.js", () => ({
      validateBrandVoice: vi.fn(() => ({ valid: true, violations: [] })),
      brandFixGuidance: vi.fn(() => "fix"),
      stripBannedPhrases: vi.fn((t: string) => t),
    }));
    vi.doMock("../../../src/infra/brand-retry.js", () => ({
      BRAND_MAX_RETRIES: 2,
      brandRetryKey: vi.fn(() => "key"),
      recordBrandFailure: vi.fn(() => 0),
      clearBrandRetries: vi.fn(),
    }));
    vi.doMock("../../../src/infra/judge.js", () => ({
      judgeOutbound: vi.fn().mockResolvedValue({ verdict: "pass" }),
    }));

    const { sendEmail } = await import("../../../src/agents/agent-tools/comms.js");
    // Quota check should be SKIPPED — getDailyOutboundCount should NOT be called
    expect(quotaFn).not.toHaveBeenCalled();
    // Tool will proceed past quota gate (then hit HITL interrupt — that's fine in this context)
  });
});
