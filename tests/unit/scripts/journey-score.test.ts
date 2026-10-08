import { describe, expect, it } from "vitest";
import {
  A_LOG_MAX_AGE_H,
  istDayWindow,
  parseJourneyALog,
  REMINDER_FIRE_LIMIT_MS,
  saysNothing,
  scoreCalendar,
  scoreInbox,
  scorePrs,
  scoreReminder,
} from "../../../scripts/lib/journey-score.js";

const NOW = Date.parse("2026-10-09T02:30:00Z");

describe("saysNothing", () => {
  it("reads an empty answer as empty", () => {
    expect(saysNothing("Nothing important in your work inbox since yesterday.")).toBe(true);
    expect(saysNothing("Your calendar is clear today, no events.")).toBe(true);
  });
  it("does not read a list as empty", () => {
    expect(saysNothing("3 emails: Invoice 42, Standup notes, Offer letter")).toBe(false);
  });
});

describe("scoreInbox (J1)", () => {
  const subjects = ["Re: Q4 invoice from Acme", "Standup notes 08 Oct"];
  it("passes when the reply names one real subject", () => {
    const v = scoreInbox("Two things: the Q4 invoice from Acme needs a reply, and a newsletter.", subjects);
    expect(v.ok).toBe(true);
    expect(v.detail).toContain("Q4 invoice from Acme");
  });
  it("fails when the reply names none of the real subjects and lists them", () => {
    const v = scoreInbox("You have a message about a dentist appointment.", subjects);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("Standup notes 08 Oct");
  });
  it("passes on 'nothing' when gws found nothing", () => {
    expect(scoreInbox("Nothing new in your work inbox since yesterday.", []).ok).toBe(true);
  });
  it("fails when gws found nothing but the bot invents mail", () => {
    expect(scoreInbox("You got an email from Priya about the launch.", []).ok).toBe(false);
  });
});

describe("scoreCalendar (J2)", () => {
  const events = ["Dentist", "Oplify sync"];
  it("passes when every event is named", () => {
    expect(scoreCalendar("Today: 10:00 Dentist, 15:00 Oplify sync.", events).ok).toBe(true);
  });
  it("fails and names the missing event", () => {
    const v = scoreCalendar("Today you have the dentist at 10.", events);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("Oplify sync");
  });
  it("passes on an empty day when gws has no events", () => {
    expect(scoreCalendar("Your calendar is empty today.", []).ok).toBe(true);
  });
  it("fails when gws has no events but the bot lists one", () => {
    expect(scoreCalendar("You have a 1:1 with Sam at 11.", []).ok).toBe(false);
  });
});

describe("scorePrs (J3)", () => {
  const prs = [
    { number: 1036, ci: "green", createdAt: "2026-10-08T10:00:00Z" },
    { number: 1002, ci: "red", createdAt: "2026-10-05T10:00:00Z" },
  ];
  const good = "Open PRs on FounderOS:\n• #1036 daily journeys: CI green\n• #1002 probe fix: CI failing (lint)";
  it("passes when every number and verdict matches and the follow-up names the oldest", () => {
    expect(scorePrs(good, "The oldest is #1002; lint is failing.", prs).ok).toBe(true);
  });
  it("fails when a PR is missing", () => {
    const v = scorePrs("• #1036 CI green", "#1002 is oldest", prs);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("#1002 not named");
  });
  it("fails when a CI verdict is wrong", () => {
    const v = scorePrs("• #1036 CI green\n• #1002 CI green", "#1002", prs);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("#1002: GitHub says red");
  });
  it("fails when the follow-up names the wrong PR", () => {
    const v = scorePrs(good, "The oldest is #1036.", prs);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("follow-up did not name the oldest PR #1002");
  });
  it("does not read 'required' as a red verdict", () => {
    expect(scorePrs("• #1036 CI green\n• #1002 required checks", "#1002", prs).ok).toBe(false);
  });
  it("passes when there are no open PRs and the bot says so", () => {
    expect(scorePrs("There are no open PRs on FounderOS.", "", []).ok).toBe(true);
  });
});

describe("scoreReminder (J5)", () => {
  const askedAt = "2026-10-09T02:31:00Z";
  const created = { text: "check the journeys", firedAt: "2026-10-09T02:33:05Z" };
  const list = "You have 2 reminders: check the journeys (02:33 UTC) and call the bank (Friday).";
  const scheduled = ["check the journeys", "Call the bank"];
  it("passes when it fired within the limit and the list matches the table", () => {
    expect(scoreReminder({ askedAt, created, listReply: list, scheduled }).ok).toBe(true);
  });
  it("fails when no reminder row was created", () => {
    const v = scoreReminder({ askedAt, created: undefined, listReply: list, scheduled });
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("no reminder row");
  });
  it("fails when it fired late", () => {
    const late = new Date(Date.parse(askedAt) + REMINDER_FIRE_LIMIT_MS + 60_000).toISOString();
    const v = scoreReminder({ askedAt, created: { ...created, firedAt: late }, listReply: list, scheduled });
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("fired after");
  });
  it("fails when it never fired", () => {
    expect(scoreReminder({ askedAt, created: { ...created, firedAt: null }, listReply: list, scheduled }).ok).toBe(false);
  });
  it("fails when the list leaves out a scheduled reminder", () => {
    const v = scoreReminder({ askedAt, created, listReply: "You have one reminder: check the journeys.", scheduled });
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("Call the bank");
  });
});

describe("parseJourneyALog", () => {
  const log =
    "GREEN journey A (o/r): PR a opened in 2 min with green CI\n" +
    "RED journey A (o/r): no PR in 45 min\n" +
    "GREEN journey A (o/r): PR task/issue-3 opened in 3 min with green CI\n";
  it("takes the last result line", () => {
    const r = parseJourneyALog(log, NOW - 3_600_000, NOW);
    expect(r.status).toBe("green");
    expect(r.detail).toContain("opened in 3 min");
  });
  it("is red when the last line is red", () => {
    expect(parseJourneyALog("GREEN journey A (o/r): ok\nRED journey A: no PR in 45 min\n", NOW, NOW).status).toBe("red");
  });
  it("is red when the log is stale", () => {
    const r = parseJourneyALog(log, NOW - (A_LOG_MAX_AGE_H + 1) * 3_600_000, NOW);
    expect(r.status).toBe("red");
    expect(r.detail).toContain("old");
  });
  it("is red when there is no log", () => {
    expect(parseJourneyALog(undefined, undefined, NOW).status).toBe("red");
  });
});

describe("istDayWindow", () => {
  it("returns an IST day as UTC instants", () => {
    // 08:00 IST on 10-09: yesterday is 10-08 00:00 IST (10-07 18:30Z) to 10-09 00:00 IST (10-08 18:30Z).
    expect(istDayWindow(NOW, -1)).toEqual({ start: "2026-10-07T18:30:00.000Z", end: "2026-10-08T18:30:00.000Z" });
    expect(istDayWindow(NOW, 0)).toEqual({ start: "2026-10-08T18:30:00.000Z", end: "2026-10-09T18:30:00.000Z" });
  });
});
