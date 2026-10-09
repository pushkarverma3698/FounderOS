/** J2 (2026-10-09): the bot said "no calendar read tool"; comms carried only create_calendar_event. */
import { describe, expect, it } from "vitest";
import { calendarWindow, listCalendarEvents } from "../../../src/agents/agent-tools/calendar-read.js";
import { DEPARTMENT_TOOLS, HITL_GATED_TOOLS } from "../../../src/agents/capabilities.js";

const NOW = new Date("2026-10-09T06:27:00Z"); // 11:57 IST on 9 Oct

describe("calendarWindow", () => {
  it("defaults to the founder's calendar day containing now", () => {
    expect(calendarWindow({}, NOW, "Asia/Kolkata")).toEqual({
      time_min: "2026-10-08T18:30:00.000Z",
      time_max: "2026-10-09T18:30:00.000Z",
    });
  });
  it("starts a plain date at that day's local midnight and spans `days` days", () => {
    expect(calendarWindow({ from: "2026-10-12", days: 3 }, NOW, "Asia/Kolkata")).toEqual({
      time_min: "2026-10-11T18:30:00.000Z",
      time_max: "2026-10-14T18:30:00.000Z",
    });
  });
  it("keeps an ISO datetime as given", () => {
    expect(calendarWindow({ from: "2026-10-09T10:00:00+05:30", days: 1 }, NOW, "Asia/Kolkata").time_min).toBe("2026-10-09T04:30:00.000Z");
  });
  it("clamps days to 1..31 and ignores an unparseable start", () => {
    expect(calendarWindow({ days: 400 }, NOW, "Asia/Kolkata").time_max).toBe("2026-11-08T18:30:00.000Z");
    expect(calendarWindow({ from: "soon", days: 0 }, NOW, "Asia/Kolkata").time_min).toBe("2026-10-08T18:30:00.000Z");
  });
});

describe("list_calendar_events wiring", () => {
  it("is a comms tool, read-only (no approval)", () => {
    expect(DEPARTMENT_TOOLS["comms"]!.map((t: { name: string }) => t.name)).toContain("list_calendar_events");
    expect(listCalendarEvents.name).toBe("list_calendar_events");
    expect(HITL_GATED_TOOLS.has("list_calendar_events")).toBe(false);
  });
});
