/**
 * Unit tests for calendarTool — tool boundary (idempotency, past-date guard, audit).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockProviderCreateCalendarEvent = vi.fn();

vi.mock("../../../src/infra/providers/index.js", () => ({
  providerCreateCalendarEvent: mockProviderCreateCalendarEvent,
}));

const mockHasBeenAudited = vi.fn(async () => false);
const mockWriteAuditEntry = vi.fn(async () => undefined);

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, hasBeenAudited: mockHasBeenAudited, writeAuditEntry: mockWriteAuditEntry };
});

const { calendarTool } = await import("../../../src/tools/calendar.js");

function successResult(id = "event_abc123") {
  return {
    success: true,
    data: {
      event_id: id,
      title: "test",
      date: "2026-07-02T00:00:00",
      html_link: `https://www.google.com/calendar/event?eid=${id}`,
    },
  };
}

describe("calendarTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue(undefined);
    mockProviderCreateCalendarEvent.mockResolvedValue(successResult());
  });

  it("returns success: true with event_id on an all-day event", async () => {
    const result = await calendarTool.execute({ title: "UK", date: "2026-07-02" });

    expect(result.success).toBe(true);
    expect((result.data as { event_id: string }).event_id).toBe("event_abc123");
    expect(mockProviderCreateCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "UK",
        start_datetime: "2026-07-02T00:00:00",
        end_datetime: "2026-07-02T23:59:00",
      }),
    );
  });

  it("returns success: false on provider soft failure", async () => {
    mockProviderCreateCalendarEvent.mockResolvedValue({
      success: false,
      error: "Invalid time range",
    });

    const result = await calendarTool.execute({ title: "Bad", date: "2026-07-10T09:00:00" });

    expect(result.success).toBe(false);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("rejects past dates", async () => {
    const result = await calendarTool.execute({ title: "Past", date: "2020-01-01" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("past");
    expect(mockProviderCreateCalendarEvent).not.toHaveBeenCalled();
  });

  it("skips when idempotency key already used", async () => {
    mockHasBeenAudited.mockResolvedValue(true);

    const result = await calendarTool.execute({
      title: "Dup",
      date: "2026-07-02",
      idempotency_key: "cal:dup",
    });

    expect(result.success).toBe(true);
    expect((result.data as { skipped: boolean }).skipped).toBe(true);
    expect(mockProviderCreateCalendarEvent).not.toHaveBeenCalled();
  });

  it("timed event end defaults to +1h", async () => {
    await calendarTool.execute({ title: "Timed", date: "2026-07-10T09:00:00" });

    expect(mockProviderCreateCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        start_datetime: "2026-07-10T09:00:00",
        end_datetime: "2026-07-10T10:00:00",
      }),
    );
  });
});
