/**
 * Unit tests for calendarTool (GOOGLECALENDAR_CREATE_EVENT via Composio).
 *
 * Key scenarios:
 *  1. Happy path — all-day event (YYYY-MM-DD)
 *  2. Happy path — timed event (YYYY-MM-DDTHH:MM:SS)
 *  3. Soft failure — Composio returns 200 + message, no event id
 *  4. Missing API key → success: false early
 *  5. Thrown error → success: false
 *  6. Correct Composio field names (start_datetime not start.dateTime)
 *  7. All-day: end defaults to T23:59:00 same day
 *  8. Timed: end defaults to +1h (pure string arithmetic, no UTC conversion)
 *  9. 23:xx rollover to next day midnight
 * 10. Explicit end_date respected
 * 11. Past-date validation — date in the past → success: false
 * 12. Future date proceeds to Composio
 * 13. Grace window — 30 seconds ago passes through
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockExecuteComposioAction = vi.fn();
const mockGetComposioApiKey = vi.fn(() => "test-key");

vi.mock("../../../src/infra/composio.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    executeComposioAction: mockExecuteComposioAction,
    getComposioApiKey: mockGetComposioApiKey,
    getGCalConnectionId: () => "ca_test_gcal",
    getGCalUserId: () => "user_test",
  };
});

const mockHasBeenAudited = vi.fn(async () => false);
const mockWriteAuditEntry = vi.fn(async () => undefined);

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, hasBeenAudited: mockHasBeenAudited, writeAuditEntry: mockWriteAuditEntry };
});

/** Build a successful Composio response with a real event id. */
function successResult(id = "event_abc123") {
  return {
    data: {
      display_url: `https://www.google.com/calendar/event?eid=${id}`,
      response_data: {
        id,
        htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
        summary: "test",
      },
    },
  };
}

const { calendarTool } = await import("../../../src/tools/calendar.js");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("calendarTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetComposioApiKey.mockReturnValue("test-key");
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue(undefined);
  });

  // ── Happy paths ──────────────────────────────────────────────────────────────

  it("returns success: true with event_id on an all-day event", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult("ev_allday"));

    const result = await calendarTool.execute({ title: "UK", date: "2026-07-02" });

    expect(result.success).toBe(true);
    expect((result.data as { event_id: string }).event_id).toBe("ev_allday");
  });

  it("returns success: true with event_id on a timed event", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult("ev_timed"));

    const result = await calendarTool.execute({
      title: "Stand-up",
      date: "2026-07-10T09:00:00",
    });

    expect(result.success).toBe(true);
    expect((result.data as { event_id: string }).event_id).toBe("ev_timed");
  });

  // ── Field names (contract with Composio) ─────────────────────────────────────

  it("calls Composio with GOOGLECALENDAR_CREATE_EVENT and flat start_datetime field", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult());

    await calendarTool.execute({ title: "UK", date: "2026-07-02" });

    const [action, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(action).toBe("GOOGLECALENDAR_CREATE_EVENT");
    // Must use flat start_datetime, NOT nested start.dateTime or start.date
    expect(args).toHaveProperty("start_datetime");
    expect(args).not.toHaveProperty("start");
    expect(args).toHaveProperty("end_datetime");
    expect(args).not.toHaveProperty("end");
    expect(args).toHaveProperty("summary", "UK");
  });

  it("uses start_datetime T00:00:00 for an all-day date string", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult());

    await calendarTool.execute({ title: "Test", date: "2026-07-02" });

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args["start_datetime"]).toBe("2026-07-02T00:00:00");
  });

  it("uses start_datetime verbatim for a timed datetime string", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult());

    await calendarTool.execute({ title: "Test", date: "2026-07-10T14:30:00" });

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args["start_datetime"]).toBe("2026-07-10T14:30:00");
  });

  // ── Default end_datetime logic ────────────────────────────────────────────────

  it("defaults end_datetime to T23:59:00 same day for an all-day event", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult());

    await calendarTool.execute({ title: "UK", date: "2026-07-02" });

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args["end_datetime"]).toBe("2026-07-02T23:59:00");
  });

  it("defaults end_datetime to +1h for a timed event (pure string, no UTC conversion)", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult());

    await calendarTool.execute({ title: "Test", date: "2026-07-10T14:00:00" });

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    // The critical test: +1h of 14:00 MUST be 15:00, not 13:00 (which a UTC conversion would give for UTC+2)
    expect(args["end_datetime"]).toBe("2026-07-10T15:00:00");
  });

  it("rolls 23:xx to next day 00:xx when adding one hour", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult());

    await calendarTool.execute({ title: "Late", date: "2026-07-10T23:30:00" });

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args["end_datetime"]).toBe("2026-07-11T00:30:00");
  });

  it("respects an explicit end_date (YYYY-MM-DD) for all-day events", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult());

    await calendarTool.execute({ title: "Long", date: "2026-07-02", end_date: "2026-07-05" });

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args["end_datetime"]).toBe("2026-07-05T23:59:00");
  });

  it("respects an explicit end_date (datetime string) for timed events", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult());

    await calendarTool.execute({
      title: "Block",
      date: "2026-07-10T09:00:00",
      end_date: "2026-07-10T12:00:00",
    });

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args["end_datetime"]).toBe("2026-07-10T12:00:00");
  });

  it("forwards optional description to Composio args", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult());

    await calendarTool.execute({
      title: "Test",
      date: "2026-07-10",
      description: "Some notes",
    });

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args["description"]).toBe("Some notes");
  });

  it("defaults timezone to Europe/Amsterdam", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult());

    await calendarTool.execute({ title: "Test", date: "2026-07-10" });

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args["timezone"]).toBe("Europe/Amsterdam");
  });

  // ── Soft-failure detection ────────────────────────────────────────────────────

  it("returns success: false when Composio returns 200 + message with no event id", async () => {
    mockExecuteComposioAction.mockResolvedValue({
      data: { message: "start_datetime is required" },
    });

    const result = await calendarTool.execute({ title: "UK", date: "2026-07-02" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("start_datetime");
  });

  it("returns success: false when Composio response has no event id at all", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { response_data: {} } });

    const result = await calendarTool.execute({ title: "UK", date: "2026-07-02" });

    expect(result.success).toBe(false);
  });

  // ── Error handling ────────────────────────────────────────────────────────────

  it("returns success: false when COMPOSIO_API_KEY is missing", async () => {
    mockGetComposioApiKey.mockReturnValue(undefined);

    const result = await calendarTool.execute({ title: "UK", date: "2026-07-02" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("COMPOSIO_API_KEY");
    expect(mockExecuteComposioAction).not.toHaveBeenCalled();
  });

  it("returns success: false when Composio throws a network error", async () => {
    mockExecuteComposioAction.mockRejectedValue(new Error("Network timeout"));

    const result = await calendarTool.execute({ title: "UK", date: "2026-07-02" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Network timeout");
  });

  // ── Idempotency (Rule 4 in TOOL-STANDARDS — same key never creates twice) ─────

  it("skips creation and returns skipped when idempotency_key already audited", async () => {
    mockHasBeenAudited.mockResolvedValue(true);

    const result = await calendarTool.execute({
      title: "UK",
      date: "2026-07-02",
      idempotency_key: "gcal:turicks:abc123",
      tenant_id: "turicks",
    });

    expect(result.success).toBe(true);
    expect((result.data as { skipped: boolean }).skipped).toBe(true);
    // The whole point: a duplicate request must NOT hit Composio again
    expect(mockExecuteComposioAction).not.toHaveBeenCalled();
  });

  it("writes an audit entry after a successful create when idempotency_key is provided", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult("ev_audit"));

    await calendarTool.execute({
      title: "UK",
      date: "2026-07-02",
      idempotency_key: "gcal:turicks:abc123",
      tenant_id: "turicks",
    });

    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create_calendar_event", idempotency_key: "gcal:turicks:abc123" }),
    );
  });

  it("does NOT write an audit entry on soft failure — so a retry can still create the event", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { message: "rate limited" } });

    await calendarTool.execute({
      title: "UK",
      date: "2026-07-02",
      idempotency_key: "gcal:turicks:abc123",
      tenant_id: "turicks",
    });

    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("still works without an idempotency_key (back-compat — no audit, always creates)", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult("ev_noidem"));

    const result = await calendarTool.execute({ title: "UK", date: "2026-07-02" });

    expect(result.success).toBe(true);
    expect(mockHasBeenAudited).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  // ── Past-date validation ──────────────────────────────────────────────────────

  it("rejects a past date (yesterday) with success: false and an error about 'past'", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dateStr = yesterday.toISOString().slice(0, 10); // "YYYY-MM-DD"

    const result = await calendarTool.execute({ title: "Past Event", date: dateStr });

    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toContain("past");
    expect(mockExecuteComposioAction).not.toHaveBeenCalled();
  });

  it("proceeds to Composio when the date is in the future (tomorrow)", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult("ev_future"));
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dateStr = tomorrow.toISOString().slice(0, 10);

    const result = await calendarTool.execute({ title: "Future Event", date: dateStr });

    expect(result.success).toBe(true);
    expect(mockExecuteComposioAction).toHaveBeenCalledOnce();
  });

  it("passes through a date exactly 30 seconds ago (within the 60-second grace window)", async () => {
    mockExecuteComposioAction.mockResolvedValue(successResult("ev_grace"));
    // 30 seconds ago — still within the 60-second grace window
    const thirtySecondsAgo = new Date(Date.now() - 30_000);
    const dateStr = thirtySecondsAgo.toISOString().replace("Z", "").slice(0, 19);

    const result = await calendarTool.execute({ title: "Right Now Event", date: dateStr });

    expect(result.success).toBe(true);
    expect(mockExecuteComposioAction).toHaveBeenCalledOnce();
  });
});
