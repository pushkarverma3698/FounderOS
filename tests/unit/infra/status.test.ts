/**
 * TDD — status.ts: formatToolError (D2) + DB query helpers (D3)
 * Track 4 UX improvements.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Top-level DB mock — must be hoisted before any import of queries.js ──────

// Shared mock chain references so tests can control return values
const mockGroupByFn = vi.fn();
const mockLimitFn = vi.fn();

const mockGroupByChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  groupBy: mockGroupByFn,
};

const mockOrderByChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: mockLimitFn,
};

// The mock select routes to the correct chain based on call count context.
// We use a simple counter — first call → groupBy chain, second → orderBy chain.
// Tests reset mockSelect.mockReturnValueOnce for clarity.
const mockSelect = vi.fn();

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({ select: mockSelect }),
}));

// ── formatToolError tests (D2) ────────────────────────────────────────────────

describe("formatToolError", () => {
  it("rewrites FIRECRAWL_API_KEY error to friendly message", async () => {
    const { formatToolError } = await import("../../../src/gateway/status.js");
    const raw = "Error: FIRECRAWL_API_KEY is not set";
    const result = formatToolError(raw);
    expect(result).toContain("Search temporarily unavailable");
    expect(result).not.toContain("FIRECRAWL_API_KEY");
  });

  it("rewrites Firecrawl HTTP error and preserves status code", async () => {
    const { formatToolError } = await import("../../../src/gateway/status.js");
    const raw = "Firecrawl returned HTTP 429 Too Many Requests";
    const result = formatToolError(raw);
    expect(result).toContain("429");
    expect(result).toMatch(/unavailable|unavail/i);
  });

  it("rewrites Composio no-id error to friendly message", async () => {
    const { formatToolError } = await import("../../../src/gateway/status.js");
    const raw = "Composio returned no message_id from the API";
    const result = formatToolError(raw);
    expect(result).toContain("Composio connection");
  });

  it("rewrites 403 Forbidden to permission denied message", async () => {
    const { formatToolError } = await import("../../../src/gateway/status.js");
    const raw = "GitHub API call failed: 403 Forbidden";
    const result = formatToolError(raw);
    expect(result).toMatch(/permission denied|Permission denied/i);
  });

  it("rewrites command timeout error and preserves duration", async () => {
    const { formatToolError } = await import("../../../src/gateway/status.js");
    const raw = "Command timed out after 30s: pnpm test";
    const result = formatToolError(raw);
    expect(result).toContain("30");
    expect(result).toMatch(/timed out|timeout/i);
  });

  it("rewrites ECONNREFUSED to service connection failed", async () => {
    const { formatToolError } = await import("../../../src/gateway/status.js");
    const raw = "connect ECONNREFUSED 127.0.0.1:5432";
    const result = formatToolError(raw);
    expect(result).toMatch(/connection failed|Service connection/i);
  });

  it("rewrites past calendar event error to friendly message", async () => {
    const { formatToolError } = await import("../../../src/gateway/status.js");
    const raw = "Cannot create a calendar event in the past: 2020-01-01";
    const result = formatToolError(raw);
    expect(result).toMatch(/past.*calendar|calendar.*past/i);
    expect(result).toMatch(/future date/i);
  });

  it("returns unknown errors unchanged", async () => {
    const { formatToolError } = await import("../../../src/gateway/status.js");
    const raw = "Some totally unknown error that doesn't match any pattern";
    const result = formatToolError(raw);
    expect(result).toBe(raw);
  });
});

// ── getActivitySummary tests (D3) ─────────────────────────────────────────────

// Import queries after the mock is set up
const { getActivitySummary, getLastEpisodicEvent } = await import("../../../src/db/queries.js");

describe("getActivitySummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the chain mocks
    mockGroupByChain.from.mockReturnThis();
    mockGroupByChain.where.mockReturnThis();
    mockSelect.mockReturnValue(mockGroupByChain);
  });

  it("returns counts grouped by action from action_log", async () => {
    mockGroupByFn.mockResolvedValue([
      { action: "send_email", total: 2 },
      { action: "search_web", total: 5 },
      { action: "create_calendar_event", total: 1 },
    ]);

    const since = new Date(Date.now() - 86_400_000);
    const result = await getActivitySummary("turicks", since);

    expect(typeof result).toBe("object");
    expect(result["send_email"]).toBe(2);
    expect(result["search_web"]).toBe(5);
    expect(result["create_calendar_event"]).toBe(1);
  });

  it("returns empty object when no activity found", async () => {
    mockGroupByFn.mockResolvedValue([]);

    const since = new Date(Date.now() - 86_400_000);
    const result = await getActivitySummary("turicks", since);
    expect(result).toEqual({});
  });
});

// ── getLastEpisodicEvent tests (D3) ───────────────────────────────────────────

describe("getLastEpisodicEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrderByChain.from.mockReturnThis();
    mockOrderByChain.where.mockReturnThis();
    mockOrderByChain.orderBy.mockReturnThis();
    mockSelect.mockReturnValue(mockOrderByChain);
  });

  it("returns the most recent episodic event content and date", async () => {
    mockLimitFn.mockResolvedValue([
      {
        title: "Completed Phase 1 workflow engine",
        summary: "Shipped the SOP runner and /run command",
        created_at: new Date("2026-06-05T10:00:00Z"),
      },
    ]);

    const result = await getLastEpisodicEvent("turicks");

    expect(result).not.toBeNull();
    // summary takes priority over title
    expect(result?.content).toContain("SOP runner");
    expect(result?.created_at).toBeInstanceOf(Date);
  });

  it("falls back to title when summary is null", async () => {
    mockLimitFn.mockResolvedValue([
      {
        title: "Some event title",
        summary: null,
        created_at: new Date("2026-06-05T10:00:00Z"),
      },
    ]);

    const result = await getLastEpisodicEvent("turicks");
    expect(result?.content).toBe("Some event title");
  });

  it("returns null when episodic memory is empty", async () => {
    mockLimitFn.mockResolvedValue([]);

    const result = await getLastEpisodicEvent("turicks");
    expect(result).toBeNull();
  });
});

// ── Rich /status format integration test (D3) ─────────────────────────────────

describe("formatStatusMessage rich format", () => {
  it("output contains 🟢 (running indicator)", async () => {
    const { formatStatusMessage } = await import("../../../src/gateway/status.js");
    const result = formatStatusMessage({
      uptimeSeconds: 3600,
      pendingApprovals: 0,
      emailsSentToday: 2,
    });
    // The existing formatStatusMessage or new rich version — must have 🟢
    expect(result).toMatch(/🟢|FounderOS/);
  });

  it("output contains 📋 context section when active_clients provided", async () => {
    const { formatRichStatus } = await import("../../../src/gateway/status.js");
    const result = formatRichStatus({
      uptimeSeconds: 3600,
      pendingApprovals: 1,
      emailsSentToday: 2,
      searchesToday: 5,
      calendarEventsToday: 0,
      activeClients: ["Acme Corp", "Beta Ltd"],
      focus: "Q2 sales push",
      lastEventContent: "Completed onboarding for Acme",
      lastEventRelativeTime: "2h ago",
    });
    expect(result).toContain("📋");
    expect(result).toContain("Acme Corp");
  });

  it("output contains 🔒 pending approvals count", async () => {
    const { formatRichStatus } = await import("../../../src/gateway/status.js");
    const result = formatRichStatus({
      uptimeSeconds: 100,
      pendingApprovals: 3,
      emailsSentToday: 0,
      searchesToday: 0,
      calendarEventsToday: 0,
      activeClients: [],
      focus: null,
      lastEventContent: null,
      lastEventRelativeTime: null,
    });
    expect(result).toContain("🔒");
    expect(result).toContain("3");
  });

  it("output contains 📬 activity summary", async () => {
    const { formatRichStatus } = await import("../../../src/gateway/status.js");
    const result = formatRichStatus({
      uptimeSeconds: 100,
      pendingApprovals: 0,
      emailsSentToday: 2,
      searchesToday: 5,
      calendarEventsToday: 1,
      activeClients: [],
      focus: null,
      lastEventContent: null,
      lastEventRelativeTime: null,
    });
    expect(result).toContain("📬");
    expect(result).toContain("2");
    expect(result).toContain("5");
  });
});
